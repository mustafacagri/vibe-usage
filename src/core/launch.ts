// Starts provider tools for the user: a CLI in a new terminal window, or a desktop app.
// Arguments are always passed as arrays; nothing is concatenated into a shell command line.
import { spawn, type SpawnOptions } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { findBinary, TOOL_INSTALLS, unpackedPath, windowsAppPath, windowsPowerShell } from '../providers/common.ts';
import { CLAUDE_FILES, DEFAULT_ACCOUNT_ID as CLAUDE_DEFAULT_ACCOUNT_ID } from '../providers/claude.ts';
import { findCursorAgent } from '../providers/cursor.ts';
import {
  CLAUDE_EFFORT_LEVELS,
  CLAUDE_PERMISSION_MODES,
  isOneOf,
  MODEL_ID_PATTERN,
  PROFILE_DIRS,
  PROFILE_ENV,
  type ClaudeEffortLevel,
  type ClaudePermissionMode,
  type ProviderId
} from '../shared/catalog.ts';
import type { LaunchMode } from '../shared/ipc.ts';
import type { Account, Snapshot } from '../shared/types.ts';
import { prepareClaudeProfile } from './claude-profile.ts';
import { applyEnvironment, environmentChanges, type Environment, type EnvironmentChanges, type EnvironmentRequest } from './environment.ts';
import { AppError } from './errors.ts';
import { claudeLaunchWarnings, type LaunchWarning } from './selection.ts';
import { isDirectory, isFile, readJson, writeFileAtomic } from './files.ts';
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

// A one-off script Terminal runs; it removes itself once started, so none accumulate.
async function writeMacLauncher({ cwd, command, changes, title, dataDir }: MacLauncher): Promise<string> {
  const dir = path.join(dataDir, LAUNCHER_DIR);
  const script = path.join(dir, `${path.basename(command[0])}-${randomBytes(6).toString('hex')}.command`);
  const lines = [
    '#!/bin/zsh',
    `rm -f -- ${shellQuote(script)}`,
    `cd -- ${shellQuote(cwd)} || exit 1`,
    changes.unset.length ? `unset ${changes.unset.join(' ')}` : '',
    ...Object.entries(changes.set).map(([name, value]) => `export ${name}=${shellQuote(value)}`),
    title ? `printf '%s\\n' ${shellQuote(title)}` : '',
    `exec ${command.map(shellQuote).join(' ')}`
  ].filter(Boolean);
  await fsp.mkdir(dir, { recursive: true });
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
  // A file the tab watches for its next command (Windows): the tab stays with the session.
  handoff?: string | undefined;
  dataDir: string;
  platform?: NodeJS.Platform | undefined;
  spawnProcess?: SpawnProcess | undefined;
}

// NUL cannot occur inside an argument, so it separates them unambiguously.
const encodeArguments = (args: readonly string[]): string => Buffer.from(args.join('\0'), 'utf8').toString('base64');

// Opens `binary args…` in a new terminal window inside `cwd`.
export async function openInTerminal({
  cwd,
  binary,
  args,
  env,
  title,
  handoff,
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
    // A detached process gets no console, and PowerShell exits without one; the hidden
    // script opens the tool's window itself (see terminal.ps1 -NewWindow).
    const psArgs = [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      TERMINAL_SCRIPT,
      '-WorkingDirectory',
      cwd,
      '-Executable',
      binary,
      ...(title ? ['-Title', title] : []),
      ...(args.length ? ['-ArgumentsBase64', encodeArguments(args)] : []),
      ...(handoff ? ['-Handoff', handoff] : []),
      '-NewWindow'
    ];
    return waitForSpawn(
      spawnProcess(windowsPowerShell(), psArgs, {
        shell: false,
        stdio: 'ignore',
        windowsHide: true,
        env: applyEnvironment(changes, process.env, platform)
      })
    );
  }
  throw new AppError('unsupported_platform');
}

export interface AppLaunch {
  providerId: ProviderId;
  cwd?: string;
  platform?: NodeJS.Platform | undefined;
  env?: Environment;
  home?: string;
  spawnProcess?: SpawnProcess | undefined;
}

// Opens the tool's desktop app, on the project folder when there is one.
export async function openDesktopApp({
  providerId,
  cwd,
  platform = process.platform,
  env = process.env,
  home = os.homedir(),
  spawnProcess = spawn
}: AppLaunch): Promise<void> {
  const { app } = TOOL_INSTALLS[providerId];
  if (!app) throw new AppError('unsupported_platform');
  const project = cwd ? [cwd] : [];
  if (platform === 'darwin') return waitForSpawn(spawnProcess(MAC_OPEN, ['-a', app.mac, ...project], DETACHED));
  if (platform === 'win32') {
    const executable = windowsAppPath(app, env, home);
    if (!(await isFile(executable))) throw new AppError('app_not_found', { app: app.mac });
    return waitForSpawn(spawnProcess(executable, project, DETACHED));
  }
  throw new AppError('unsupported_platform');
}

// The environment that points a tool at the account's profile folder, for launches and
// sign-ins alike. The default Claude profile must run with CLAUDE_CONFIG_DIR unset: setting
// it, even to the default directory, selects a different Keychain entry on macOS.
// Resuming a long session idle for over an hour, Claude Code asks whether to compact it or go
// on. A session the app resumes may do so unattended, so for it that threshold is moved out
// of reach (ten years). The user's own resumes keep the question.
export const CLAUDE_RESUME_THRESHOLD_ENV = 'CLAUDE_CODE_RESUME_THRESHOLD_MINUTES';
export const RESUME_WITHOUT_QUESTION = String(10 * 365 * 24 * 60);

export function profileEnvironment(account: Account): EnvironmentRequest {
  if (account.providerId === 'claude') {
    const isDefault = account.id === CLAUDE_DEFAULT_ACCOUNT_ID || account.configDirExplicit === false;
    return isDefault ? { unset: [PROFILE_ENV.claude] } : { set: { [PROFILE_ENV.claude]: validateConfigDir(account.configDir) } };
  }
  if (account.providerId === 'codex' && account.configDir) return { set: { [PROFILE_ENV.codex]: validateConfigDir(account.configDir) } };
  return {};
}

export interface LaunchOptions {
  account?: Account | null | undefined;
  model?: string | null | undefined;
  prompt?: string | undefined;
  // A session of the tool to continue instead of starting a new one (Claude Code only).
  resume?: string | undefined;
  // How a continued Claude Code session was running: its permission mode and effort level.
  permissionMode?: ClaudePermissionMode | undefined;
  effort?: ClaudeEffortLevel | undefined;
}

// Session ids are UUIDs; anything else (a flag, say) never reaches the command line.
const SESSION_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,127}$/;

const optional = (flag: string, value: string | null | undefined): string[] => (value ? [flag, value] : []);
const trailing = (value: string | undefined): string[] => (value ? [value] : []);

// How each provider's CLI starts with an optional model and initial prompt; null when the
// provider only exists as a desktop app.
const LAUNCHERS: Record<ProviderId, (options: LaunchOptions) => Promise<TerminalCommand | null>> = {
  async claude({ account, model, prompt, resume, permissionMode, effort }) {
    if (!account?.configDir) throw new AppError('account_not_found');
    const env = profileEnvironment(account);
    return {
      binary: await findBinary('claude'),
      args: [
        ...optional('--resume', resume),
        ...optional('--model', model),
        ...optional('--permission-mode', permissionMode),
        ...optional('--effort', effort),
        ...trailing(prompt)
      ],
      env: resume ? { ...env, set: { ...env.set, [CLAUDE_RESUME_THRESHOLD_ENV]: RESUME_WITHOUT_QUESTION } } : env
    };
  },
  async codex({ account, model, prompt }) {
    return {
      binary: await findBinary('codex'),
      args: [...optional('-m', model), ...trailing(prompt)],
      env: account ? profileEnvironment(account) : {}
    };
  },
  async cursor({ model, prompt }) {
    // Only the Cursor Agent CLI runs a task in a terminal; without it the app is opened.
    const agent = await findCursorAgent();
    // Selecting a folder does not grant trust to its code. Cursor asks the user itself.
    return agent ? { binary: agent.binary, args: [...agent.args, ...optional('--model', model), ...trailing(prompt)], env: {} } : null;
  },
  antigravity: () => Promise.resolve(null),
  copilot: () => Promise.resolve(null)
};

// Model ids come from settings, the UI or the command line, so they are checked here,
// synchronously, before anything is looked up.
export function launchPlan(providerId: ProviderId, options: LaunchOptions): Promise<TerminalCommand | null> {
  if (options.model && !MODEL_ID_PATTERN.test(options.model)) throw new AppError('invalid_argument');
  if (options.resume !== undefined && (providerId !== 'claude' || !SESSION_ID_PATTERN.test(options.resume)))
    throw new AppError('invalid_argument');
  if (options.permissionMode !== undefined && (providerId !== 'claude' || !isOneOf(CLAUDE_PERMISSION_MODES, options.permissionMode)))
    throw new AppError('invalid_argument');
  if (options.effort !== undefined && (providerId !== 'claude' || !isOneOf(CLAUDE_EFFORT_LEVELS, options.effort)))
    throw new AppError('invalid_argument');
  return LAUNCHERS[providerId](options);
}

export interface ToolLaunch extends LaunchOptions {
  providerId: ProviderId;
  cwd: string;
  dataDir: string;
  title?: string;
  platform?: NodeJS.Platform | undefined;
  spawnProcess?: SpawnProcess | undefined;
  // The user's accounts: what the user answered in one Claude Code profile (folder trust,
  // first-run setup) is carried into the one launched.
  accounts?: readonly Account[] | undefined;
  homeDir?: string | undefined;
  handoff?: string | undefined;
}

// A project folder from the user: a valid local path to an existing directory.
export async function projectDirectory(dir: string): Promise<string> {
  const directory = validateConfigDir(dir);
  if (!(await isDirectory(directory))) throw new AppError('folder_not_found');
  return directory;
}

async function preparedLaunch({ providerId, account, cwd, model, prompt, resume, permissionMode, effort, accounts, homeDir }: ToolLaunch) {
  const directory = await projectDirectory(cwd);
  const plan = await launchPlan(providerId, { account, model, prompt, resume, permissionMode, effort });
  // Unprepared, the session would wait at Claude Code's first-run questions; they can still
  // be answered there, so a failure to prepare it does not stop the launch.
  if (plan && providerId === 'claude' && account && accounts)
    await prepareClaudeProfile(account, accounts, directory, homeDir).catch(() => undefined);
  return { directory, plan };
}

export async function launchTool(launch: ToolLaunch): Promise<{ mode: LaunchMode }> {
  const { providerId, dataDir, title, platform, spawnProcess, handoff } = launch;
  const { directory, plan } = await preparedLaunch(launch);
  if (!plan) {
    await openDesktopApp({ providerId, cwd: directory, platform, spawnProcess });
    return { mode: 'app' };
  }
  await openInTerminal({ cwd: directory, ...plan, title, handoff, dataDir, platform, spawnProcess });
  return { mode: 'terminal' };
}

// Writes the command a tab opened with `handoff` runs next, once its tool exits (see
// terminal.ps1). False when the tool has no command line to run there.
export async function writeHandoff(file: string, launch: ToolLaunch): Promise<boolean> {
  const { directory, plan } = await preparedLaunch(launch);
  if (!plan) return false;
  if (plan.args.some(arg => arg.includes('\0'))) throw new AppError('invalid_argument');
  const { set, unset } = environmentChanges(plan.env);
  const next = {
    workingDirectory: directory,
    executable: plan.binary,
    title: launch.title,
    argumentsBase64: encodeArguments(plan.args),
    set,
    unset
  };
  await writeFileAtomic(file, JSON.stringify(next));
  return true;
}

// Sign-in flows: each CLI handles its own login; desktop apps sign in inside the app.
// Plain `claude` only asks to sign in when no credentials exist; expired ones open a session.
const LOGIN_ARGS: Partial<Record<ProviderId, readonly string[]>> = {
  claude: ['auth', 'login'],
  codex: ['login'],
  copilot: ['auth', 'login']
};

export interface SignIn {
  providerId: ProviderId;
  // The account to sign in; without one the tool's default profile.
  account?: Account | undefined;
  dataDir: string;
  cwd: string;
  platform?: NodeJS.Platform | undefined;
  spawnProcess?: SpawnProcess | undefined;
}

export async function openSignIn({ providerId, account, dataDir, cwd, platform = process.platform, spawnProcess }: SignIn): Promise<void> {
  // Cursor's quota is read from the app's sign-in, which signing in to the app updates. A Windows
  // machine that has only the Agent CLI signs in through it (its sign-in is read as well).
  if (providerId === 'cursor' && platform === 'win32') {
    const opened = await openDesktopApp({ providerId, platform, spawnProcess }).then(
      () => true,
      (error: unknown) => {
        if (error instanceof AppError && error.code === 'app_not_found') return false;
        throw error;
      }
    );
    if (opened) return;
    const agent = await findCursorAgent();
    if (!agent) throw new AppError('app_not_found', { app: 'Cursor' });
    return openInTerminal({ cwd, binary: agent.binary, args: [...agent.args, 'login'], env: {}, dataDir, platform, spawnProcess });
  }
  const args = LOGIN_ARGS[providerId];
  if (!args) return openDesktopApp({ providerId, platform, spawnProcess });
  const env = account ? profileEnvironment(account) : {};
  return openInTerminal({
    cwd,
    binary: await findBinary(TOOL_INSTALLS[providerId].binaries[0] ?? providerId),
    args,
    env,
    dataDir,
    platform,
    spawnProcess
  });
}

// Claude settings files that can override the selected profile's identity, keyed by name.
export async function loadClaudeSettingsFiles(
  projectDir: string | undefined,
  configDir: string | undefined
): Promise<Record<string, unknown>> {
  const files: Record<string, unknown> = {};
  const read = async (dir: string, file: string): Promise<void> => {
    files[`${path.basename(dir)}/${file}`] = await readJson(path.join(dir, file));
  };
  if (projectDir) {
    const projectSettings = path.join(projectDir, PROFILE_DIRS.claude);
    await read(projectSettings, CLAUDE_FILES.settings);
    await read(projectSettings, CLAUDE_FILES.localSettings);
  }
  if (configDir) await read(configDir, CLAUDE_FILES.settings);
  return files;
}

// What to warn about before starting the tool signed in as `account` in `projectDir`. Only
// Claude Code has settings that can override the chosen profile.
export async function launchWarnings(
  snapshot: Snapshot,
  account: Account,
  { projectDir, model }: { projectDir: string; model?: string | undefined }
): Promise<LaunchWarning[]> {
  if (account.providerId !== 'claude') return [];
  return claudeLaunchWarnings(snapshot, account, { model, settingsFiles: await loadClaudeSettingsFiles(projectDir, account.configDir) });
}
