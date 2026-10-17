// Starts provider tools for the user: a CLI in a new terminal window, or a desktop app.
// Arguments are always passed as arrays; nothing is concatenated into a shell command line.
import { spawn, type SpawnOptions } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { findBinary, unpackedPath, windowsPowerShell } from '../providers/common.ts';
import { DEFAULT_ACCOUNT_ID as CLAUDE_DEFAULT_ACCOUNT_ID } from '../providers/claude.ts';
import { findCursorAgent } from '../providers/cursor.ts';
import { MODEL_ID_PATTERN, type ProviderId } from '../shared/catalog.ts';
import type { LaunchMode } from '../shared/ipc.ts';
import type { Account } from '../shared/types.ts';
import { applyEnvironment, environmentChanges, type Environment, type EnvironmentChanges, type EnvironmentRequest } from './environment.ts';
import { AppError } from './errors.ts';
import { isDirectory, isFile, readJson } from './files.ts';
import { hasControlChars } from './model.ts';
import { validateConfigDir } from './settings.ts';

// The part of a started process a launch waits on (a ChildProcess, or a fake in tests).
export interface SpawnedProcess {
  once(event: 'spawn', listener: () => void): unknown;
  once(event: 'error', listener: (error: Error) => void): unknown;
  unref(): void;
}
export type SpawnProcess = (command: string, args: readonly string[], options: SpawnOptions) => SpawnedProcess;

const LAUNCHER_DIR = 'launchers';
const CLAUDE_CONFIG_ENV = 'CLAUDE_CONFIG_DIR';
const CODEX_HOME_ENV = 'CODEX_HOME';
const MAC_OPEN = '/usr/bin/open';
const TERMINAL_SCRIPT = unpackedPath(path.resolve(import.meta.dirname, '../launchers/terminal.ps1'));
const DETACHED: SpawnOptions = { shell: false, detached: true, stdio: 'ignore' };

export function shellQuote(value: string): string {
  if (hasControlChars(value)) throw new AppError('invalid_argument');
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function waitForSpawn(child: SpawnedProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
    child.once('error', error => {
      reject(new AppError('launch_failed', {}, { cause: error }));
    });
  });
}

interface MacLauncher {
  cwd: string;
  command: readonly [string, ...string[]];
  changes: EnvironmentChanges;
  title: string | undefined;
  dataDir: string;
}

async function writeMacLauncher({ cwd, command, changes, title, dataDir }: MacLauncher): Promise<string> {
  const lines = [
    '#!/bin/zsh',
    `cd -- ${shellQuote(cwd)} || exit 1`,
    changes.unset.length ? `unset ${changes.unset.join(' ')}` : '',
    ...Object.entries(changes.set).map(([name, value]) => `export ${name}=${shellQuote(value)}`),
    title ? `printf '%s\\n' ${shellQuote(title)}` : '',
    `exec ${command.map(shellQuote).join(' ')}`
  ].filter(Boolean);
  const dir = path.join(dataDir, LAUNCHER_DIR);
  await fsp.mkdir(dir, { recursive: true });
  const script = path.join(dir, `${path.basename(command[0])}-${randomBytes(6).toString('hex')}.command`);
  await fsp.writeFile(script, `${lines.join('\n')}\n`, { mode: 0o700 });
  return script;
}

export interface TerminalCommand {
  binary: string;
  args: readonly string[];
  env: EnvironmentRequest;
}

export interface TerminalLaunch extends TerminalCommand {
  cwd: string;
  title?: string | undefined;
  dataDir: string;
  platform?: NodeJS.Platform | undefined;
  spawnProcess?: SpawnProcess | undefined;
}

// Opens `binary args…` in a new terminal window inside `cwd`.
export async function openInTerminal({
  cwd,
  binary,
  args,
  env,
  title,
  dataDir,
  platform = process.platform,
  spawnProcess = spawn
}: TerminalLaunch): Promise<void> {
  if (args.some(arg => arg.includes('\0'))) throw new AppError('invalid_argument');
  const changes = environmentChanges(env);
  if (platform === 'darwin') {
    const script = await writeMacLauncher({ cwd, command: [binary, ...args], changes, title, dataDir });
    return waitForSpawn(spawnProcess(MAC_OPEN, ['-a', 'Terminal', script], DETACHED));
  }
  if (platform === 'win32') {
    const psArgs = [
      '-NoLogo',
      '-NoProfile',
      '-NoExit',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      TERMINAL_SCRIPT,
      '-WorkingDirectory',
      cwd,
      '-Executable',
      binary,
      ...(title ? ['-Title', title] : []),
      // NUL cannot occur inside an argument, so it separates them unambiguously.
      ...(args.length ? ['-ArgumentsBase64', Buffer.from(args.join('\0'), 'utf8').toString('base64')] : [])
    ];
    return waitForSpawn(
      spawnProcess(windowsPowerShell(), psArgs, { ...DETACHED, windowsHide: false, env: applyEnvironment(changes, process.env, platform) })
    );
  }
  throw new AppError('unsupported_platform');
}

// Desktop apps that open a project folder. Windows paths are the per-user installer defaults.
const DESKTOP_APPS: Partial<Record<ProviderId, { mac: string; windows: readonly string[] }>> = {
  cursor: { mac: 'Cursor', windows: ['cursor', 'Cursor.exe'] },
  antigravity: { mac: 'Antigravity', windows: ['Antigravity', 'Antigravity.exe'] }
};

export interface AppLaunch {
  providerId: ProviderId;
  cwd?: string;
  platform?: NodeJS.Platform | undefined;
  env?: Environment;
  spawnProcess?: SpawnProcess | undefined;
}

export async function openDesktopApp({
  providerId,
  cwd,
  platform = process.platform,
  env = process.env,
  spawnProcess = spawn
}: AppLaunch): Promise<void> {
  const app = DESKTOP_APPS[providerId];
  if (!app) throw new AppError('unsupported_platform');
  const project = cwd ? [cwd] : [];
  if (platform === 'darwin') return waitForSpawn(spawnProcess(MAC_OPEN, ['-a', app.mac, ...project], DETACHED));
  if (platform === 'win32') {
    const executable = env.LOCALAPPDATA ? path.win32.join(env.LOCALAPPDATA, 'Programs', ...app.windows) : '';
    if (!executable || !(await isFile(executable))) throw new AppError('app_not_found', { app: app.mac });
    return waitForSpawn(spawnProcess(executable, project, DETACHED));
  }
  throw new AppError('unsupported_platform');
}

// The default profile must run with CLAUDE_CONFIG_DIR unset: setting it, even to the default
// directory, selects a different Keychain entry on macOS.
export function claudeEnvironment(account: Account): EnvironmentRequest {
  const isDefault = account.id === CLAUDE_DEFAULT_ACCOUNT_ID || account.configDirExplicit === false;
  return isDefault ? { unset: [CLAUDE_CONFIG_ENV] } : { set: { [CLAUDE_CONFIG_ENV]: validateConfigDir(account.configDir) } };
}

export interface LaunchOptions {
  account?: Account | null | undefined;
  model?: string | null | undefined;
  prompt?: string | undefined;
}

const optional = (flag: string, value: string | null | undefined): string[] => (value ? [flag, value] : []);
const trailing = (value: string | undefined): string[] => (value ? [value] : []);

// How each provider's CLI starts with an optional model and initial prompt; null when the
// provider only exists as a desktop app.
const LAUNCHERS: Record<ProviderId, (options: LaunchOptions) => Promise<TerminalCommand | null>> = {
  async claude({ account, model, prompt }) {
    if (!account?.configDir) throw new AppError('account_not_found');
    return {
      binary: await findBinary('claude'),
      args: [...optional('--model', model), ...trailing(prompt)],
      env: claudeEnvironment(account)
    };
  },
  async codex({ account, model, prompt }) {
    const set = account?.configDir ? { [CODEX_HOME_ENV]: validateConfigDir(account.configDir) } : {};
    return { binary: await findBinary('codex'), args: [...optional('-m', model), ...trailing(prompt)], env: { set } };
  },
  async cursor({ model, prompt }) {
    // Only the Cursor Agent CLI runs a task in a terminal; without it the app is opened.
    const binary = await findCursorAgent();
    return binary ? { binary, args: ['--trust', ...optional('--model', model), ...trailing(prompt)], env: {} } : null;
  },
  antigravity: () => Promise.resolve(null)
};

// Model ids come from settings, the UI or the command line, so they are checked here,
// synchronously, before anything is looked up.
export function launchPlan(providerId: ProviderId, options: LaunchOptions): Promise<TerminalCommand | null> {
  if (options.model && !MODEL_ID_PATTERN.test(options.model)) throw new AppError('invalid_argument');
  return LAUNCHERS[providerId](options);
}

export interface ToolLaunch extends LaunchOptions {
  providerId: ProviderId;
  cwd: string;
  dataDir: string;
  title?: string;
  platform?: NodeJS.Platform | undefined;
  spawnProcess?: SpawnProcess | undefined;
}

export async function launchTool({
  providerId,
  account,
  cwd,
  dataDir,
  model,
  prompt,
  title,
  platform,
  spawnProcess
}: ToolLaunch): Promise<{ mode: LaunchMode }> {
  const directory = validateConfigDir(cwd);
  if (!(await isDirectory(directory))) throw new AppError('folder_not_found');
  const plan = await launchPlan(providerId, { account, model, prompt });
  if (!plan) {
    await openDesktopApp({ providerId, cwd: directory, platform, spawnProcess });
    return { mode: 'app' };
  }
  await openInTerminal({ cwd: directory, ...plan, title, dataDir, platform, spawnProcess });
  return { mode: 'terminal' };
}

// Sign-in flows: each CLI handles its own login; desktop apps sign in inside the app.
const LOGIN_ARGS: Partial<Record<ProviderId, readonly string[]>> = { claude: [], codex: ['login'] };

export interface SignIn {
  providerId: ProviderId;
  dataDir: string;
  cwd: string;
  spawnProcess?: SpawnProcess | undefined;
}

export async function openSignIn({ providerId, dataDir, cwd, spawnProcess }: SignIn): Promise<void> {
  const args = LOGIN_ARGS[providerId];
  if (!args) return openDesktopApp({ providerId, spawnProcess });
  return openInTerminal({ cwd, binary: await findBinary(providerId), args, env: {}, dataDir, spawnProcess });
}

// Claude settings files that can override the selected profile's identity, keyed by name.
export async function loadClaudeSettingsFiles(
  projectDir: string | undefined,
  configDir: string | undefined
): Promise<Record<string, unknown>> {
  const files: Record<string, unknown> = {};
  if (projectDir) {
    files['.claude/settings.json'] = await readJson(path.join(projectDir, '.claude', 'settings.json'));
    files['.claude/settings.local.json'] = await readJson(path.join(projectDir, '.claude', 'settings.local.json'));
  }
  if (configDir) files[path.join(path.basename(configDir), 'settings.json')] = await readJson(path.join(configDir, 'settings.json'));
  return files;
}
