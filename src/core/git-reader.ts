// A deliberately small Git boundary for untrusted project folders. Ref and index reads
// need no working-tree conversion, signature verifier, pager, hook or remote helper.
// Do not add status/diff/log/cat-file here without reviewing their configurable helpers.
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { systemErrorCode } from './errors.ts';
import { attempt } from './files.ts';

const execFileAsync = promisify(execFile);
const TIMEOUT_MS = 5000;
const MAX_BYTES = 1024 * 1024;
// Git for Windows rejects Node's device path for the null device; it accepts NUL.
const NULL_DEVICE = process.platform === 'win32' ? 'NUL' : os.devNull;

// No shell lookup and no empty/relative PATH entry: on Windows a bare executable name
// would search the selected project before PATH, even with shell:false.
export function gitExecutableCandidates(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string[] {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const value = Object.entries(env).find(([name]) => (platform === 'win32' ? name.toUpperCase() === 'PATH' : name === 'PATH'))?.[1] ?? '';
  const directories = value
    .split(paths.delimiter)
    .filter(
      directory =>
        paths.isAbsolute(directory) &&
        (platform !== 'win32' || /^(?:[a-z]:[\\/]|\\\\[^\\]+\\[^\\]+)/i.test(directory)) &&
        !/[\r\n\0]/.test(directory)
    );
  // Finder does not normally inherit the user's shell PATH.
  if (platform === 'darwin') directories.push('/usr/bin', '/opt/homebrew/bin', '/usr/local/bin');
  return [...new Set(directories.map(directory => paths.join(directory, platform === 'win32' ? 'git.exe' : 'git')))];
}

const inside = (parent: string, file: string): boolean => {
  const relative = path.relative(parent, file);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
};

export async function resolveGitExecutable(projectRoot: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const root = await fsp.realpath(projectRoot);
  for (const candidate of gitExecutableCandidates(env)) {
    const resolved = await attempt(() => fsp.realpath(candidate));
    if (!resolved || inside(root, resolved)) continue;
    const usable = await attempt(async () => {
      await fsp.access(resolved, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
      return (await fsp.stat(resolved)).isFile();
    });
    if (usable) return resolved;
  }
  throw new Error('No trusted Git executable is available outside the project.');
}

// Ignore inherited repository/config redirects and global helpers. Local repository
// config is still read, so only helper-free commands are exposed below.
export function gitReadEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const environment = Object.fromEntries(Object.entries(source).filter(([name]) => !/^GIT_/i.test(name)));
  return {
    ...environment,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: NULL_DEVICE,
    GIT_CONFIG_SYSTEM: NULL_DEVICE,
    GIT_OPTIONAL_LOCKS: '0',
    GIT_NO_LAZY_FETCH: '1',
    GIT_TERMINAL_PROMPT: '0'
  };
}

// Absence is distinct from an unreadable/broken repository: the latter must not be
// mistaken for a plain folder when deciding whether a brief can safely be written.
async function repositoryRoot(directory: string): Promise<string | null> {
  let current = await fsp.realpath(directory);
  for (;;) {
    const marker = await fsp.lstat(path.join(current, '.git')).catch((error: unknown) => {
      if (systemErrorCode(error) === 'ENOENT') return null;
      throw error;
    });
    if (marker) {
      if (marker.isSymbolicLink() || (!marker.isDirectory() && !marker.isFile())) throw new Error('Unsupported Git directory.');
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export interface GitRepository {
  metadata(): Promise<{ branch: string; lastCommit: string }>;
  isTracked(file: string): Promise<boolean>;
  isIgnored(file: string): Promise<boolean>;
  exclusion(): Promise<{ directory: string; prefix: string }>;
}

export async function openGitRepository(projectDir: string, env: NodeJS.ProcessEnv = process.env): Promise<GitRepository | null> {
  const root = await repositoryRoot(projectDir);
  if (!root) return null;
  const binary = await resolveGitExecutable(root, env);
  const directory = await fsp.realpath(projectDir);
  const environment = gitReadEnvironment(env);
  const run = async (...args: string[]): Promise<string> => {
    const { stdout } = await execFileAsync(
      binary,
      [
        '--no-pager',
        '--no-optional-locks',
        '-c',
        'core.fsmonitor=false',
        '-c',
        `core.hooksPath=${NULL_DEVICE}`,
        '-c',
        'core.untrackedCache=false',
        '-c',
        'log.showSignature=false',
        '-C',
        directory,
        ...args
      ],
      {
        cwd: path.dirname(binary),
        env: environment,
        shell: false,
        encoding: 'utf8',
        timeout: TIMEOUT_MS,
        maxBuffer: MAX_BYTES,
        windowsHide: true
      }
    );
    return stdout;
  };
  if ((await run('rev-parse', '--is-inside-work-tree')).trim() !== 'true') throw new Error('Not a Git working tree.');
  return {
    async metadata() {
      const [branch, head] = await Promise.all([
        attempt(() => run('symbolic-ref', '--quiet', '--short', 'HEAD')),
        attempt(() => run('rev-parse', '--verify', 'HEAD'))
      ]);
      // Ref resolution does not open commit objects or fetch missing promisor objects.
      const id = head?.trim() ?? '';
      return { branch: branch?.trim() ?? '', lastCommit: /^[a-f0-9]{40,64}$/i.test(id) ? id.slice(0, 12) : '' };
    },
    async isTracked(file) {
      return (await run('ls-files', '--cached', '-z', '--', `:(literal)${file}`)).split('\0').some(Boolean);
    },
    async isIgnored(file) {
      // A nonzero result is a failed protection check, not permission to write anyway.
      await run('check-ignore', '--no-index', '--quiet', '--', file);
      return true;
    },
    async exclusion() {
      const [common, prefix] = await Promise.all([
        run('rev-parse', '--path-format=absolute', '--git-common-dir'),
        run('rev-parse', '--show-prefix')
      ]);
      const commonDir = common.replace(/\r?\n$/, '');
      const relative = prefix.replace(/\r?\n$/, '');
      if (!path.isAbsolute(commonDir) || /[\r\n\0]/.test(commonDir + relative)) throw new Error('Invalid Git metadata path.');
      return { directory: path.join(await fsp.realpath(commonDir), 'info'), prefix: relative };
    }
  };
}
