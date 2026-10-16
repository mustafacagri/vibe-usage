'use strict';
// Starts provider tools for the user: a CLI in a new terminal window, or a desktop app.
// Arguments are always passed as arrays; nothing is concatenated into a shell command line.
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { CREDENTIAL_ENV_KEYS, MODEL_ID_PATTERN } = require('../catalog.cjs');
const { findBinary, unpackedPath, windowsPowerShell } = require('../providers/common.cjs');
const { validateConfigDir } = require('./settings.cjs');
const { DEFAULT_ACCOUNT_ID: CLAUDE_DEFAULT_ACCOUNT_ID } = require('../providers/claude.cjs');
const { findCursorAgent } = require('../providers/cursor.cjs');
const { AppError } = require('./errors.cjs');
const { readJson } = require('./files.cjs');
const { hasControlChars } = require('./model.cjs');

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const LAUNCHER_DIR = 'launchers';
const CLAUDE_CONFIG_ENV = 'CLAUDE_CONFIG_DIR';
const CODEX_HOME_ENV = 'CODEX_HOME';

const TERMINAL_SCRIPT = unpackedPath(path.resolve(__dirname, '../launchers/terminal.ps1'));

function shellQuote(value) {
  if (typeof value !== 'string' || hasControlChars(value)) throw new AppError('invalid_argument');
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// Credential overrides are always removed so the tool uses the account the user picked.
function environmentChanges({ set = {}, unset = [] } = {}) {
  for (const name of [...Object.keys(set), ...unset]) if (!ENV_NAME.test(name)) throw new AppError('invalid_argument');
  return { set, unset: [...new Set([...CREDENTIAL_ENV_KEYS, ...unset])].filter(name => !(name in set)) };
}

// Applies environment changes to a copy of `source` (names are case-insensitive on Windows).
function applyEnvironment(changes, source = process.env, platform = process.platform) {
  const normalize = platform === 'win32' ? name => name.toLowerCase() : name => name;
  const removed = new Set([...changes.unset, ...Object.keys(changes.set)].map(normalize));
  const kept = Object.entries(source).filter(([name]) => !removed.has(normalize(name)));
  return { ...Object.fromEntries(kept), ...changes.set };
}

function waitForSpawn(child) {
  return new Promise((resolve, reject) => {
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
    child.once('error', () => reject(new AppError('launch_failed')));
  });
}

async function writeMacLauncher({ cwd, command, changes, title, dataDir }) {
  const lines = [
    '#!/bin/zsh',
    `cd -- ${shellQuote(cwd)} || exit 1`,
    changes.unset.length ? `unset ${changes.unset.join(' ')}` : '',
    ...Object.entries(changes.set).map(([name, value]) => `export ${name}=${shellQuote(value)}`),
    title ? `printf '%s\\n' ${shellQuote(title)}` : '',
    `exec ${command.map(shellQuote).join(' ')}`
  ].filter(Boolean);
  const dir = path.join(dataDir, LAUNCHER_DIR);
  await fs.mkdir(dir, { recursive: true });
  const script = path.join(dir, `${path.basename(command[0])}-${randomBytes(6).toString('hex')}.command`);
  await fs.writeFile(script, `${lines.join('\n')}\n`, { mode: 0o700 });
  return script;
}

// Opens `binary args…` in a new terminal window inside `cwd`.
async function openInTerminal({ cwd, binary, args = [], env, title, dataDir, platform = process.platform, spawnProcess = spawn }) {
  if (args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) throw new AppError('invalid_argument');
  const changes = environmentChanges(env);
  if (platform === 'darwin') {
    const script = await writeMacLauncher({ cwd, command: [binary, ...args], changes, title, dataDir });
    return waitForSpawn(spawnProcess('/usr/bin/open', ['-a', 'Terminal', script], { shell: false, detached: true, stdio: 'ignore' }));
  }
  if (platform === 'win32') {
    const encodedArgs = Buffer.from(args.join('\0'), 'utf8').toString('base64');
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
      ...(args.length ? ['-ArgumentsBase64', encodedArgs] : [])
    ];
    return waitForSpawn(
      spawnProcess(windowsPowerShell(), psArgs, {
        shell: false,
        detached: true,
        windowsHide: false,
        stdio: 'ignore',
        env: applyEnvironment(changes, process.env, platform)
      })
    );
  }
  throw new AppError('unsupported_platform');
}

// Desktop apps that open a project folder. Windows paths are the per-user installer defaults.
const DESKTOP_APPS = {
  cursor: { mac: 'Cursor', windows: ['cursor', 'Cursor.exe'] },
  antigravity: { mac: 'Antigravity', windows: ['Antigravity', 'Antigravity.exe'] }
};

async function openDesktopApp({ providerId, cwd, platform = process.platform, env = process.env, spawnProcess = spawn }) {
  const app = DESKTOP_APPS[providerId];
  if (!app) throw new AppError('unsupported_platform');
  if (platform === 'darwin') {
    return waitForSpawn(
      spawnProcess('/usr/bin/open', ['-a', app.mac, ...(cwd ? [cwd] : [])], { shell: false, detached: true, stdio: 'ignore' })
    );
  }
  if (platform === 'win32') {
    const executable = path.win32.join(env.LOCALAPPDATA || '', 'Programs', ...app.windows);
    if (
      !env.LOCALAPPDATA ||
      !(await fs
        .stat(executable)
        .then(s => s.isFile())
        .catch(() => false))
    )
      throw new AppError('app_not_found', { app: app.mac });
    return waitForSpawn(spawnProcess(executable, cwd ? [cwd] : [], { shell: false, detached: true, stdio: 'ignore' }));
  }
  throw new AppError('unsupported_platform');
}

function isDefaultClaudeProfile(account) {
  return account.id === CLAUDE_DEFAULT_ACCOUNT_ID || account.configDirExplicit === false;
}

// The default profile must run with CLAUDE_CONFIG_DIR unset: setting it, even to the default
// directory, selects a different Keychain entry on macOS.
function claudeEnvironment(account) {
  return isDefaultClaudeProfile(account)
    ? { unset: [CLAUDE_CONFIG_ENV] }
    : { set: { [CLAUDE_CONFIG_ENV]: validateConfigDir(account.configDir) } };
}

function launchEnvironment(account, source = process.env, platform = process.platform) {
  return applyEnvironment(environmentChanges(claudeEnvironment(account)), source, platform);
}

// How each provider starts with an optional model and initial prompt. Returns the launch
// mode: 'terminal' when the prompt runs, 'app' when only the app (and project) opens.
const LAUNCHERS = {
  async claude({ account, model, prompt }) {
    if (!account?.configDir) throw new AppError('account_not_found');
    return {
      binary: await findBinary('claude'),
      args: [...(model ? ['--model', model] : []), ...(prompt ? [prompt] : [])],
      env: claudeEnvironment(account)
    };
  },
  async codex({ account, model, prompt }) {
    const set = account?.configDir ? { [CODEX_HOME_ENV]: validateConfigDir(account.configDir) } : {};
    return { binary: await findBinary('codex'), args: [...(model ? ['-m', model] : []), ...(prompt ? [prompt] : [])], env: { set } };
  },
  async cursor({ model, prompt }) {
    // Only the Cursor Agent CLI runs a task in a terminal; without it the app is opened.
    const binary = await findCursorAgent();
    if (!binary) return null;
    return { binary, args: ['--trust', ...(model ? ['--model', model] : []), ...(prompt ? [prompt] : [])], env: {} };
  },
  async antigravity() {
    return null;
  }
};

// The command that starts a provider's CLI, or null when it only exists as a desktop app.
// Model ids come from settings, the UI or the command line, so they are checked here.
function launchPlan(providerId, options) {
  if (options.model && !MODEL_ID_PATTERN.test(options.model)) throw new AppError('invalid_argument');
  return LAUNCHERS[providerId](options);
}

async function launchTool({ providerId, account, cwd, dataDir, model, prompt, title, platform = process.platform, spawnProcess = spawn }) {
  const directory = validateConfigDir(cwd);
  if (
    !(await fs
      .stat(directory)
      .then(s => s.isDirectory())
      .catch(() => false))
  )
    throw new AppError('folder_not_found');
  const plan = await launchPlan(providerId, { account, model, prompt });
  if (!plan) {
    await openDesktopApp({ providerId, cwd: directory, platform, spawnProcess });
    return { mode: 'app' };
  }
  await openInTerminal({ cwd: directory, ...plan, title, dataDir, platform, spawnProcess });
  return { mode: 'terminal' };
}

// Sign-in flows: each CLI handles its own login; desktop apps sign in inside the app.
const LOGIN = {
  claude: async () => ({ binary: await findBinary('claude'), args: [] }),
  codex: async () => ({ binary: await findBinary('codex'), args: ['login'] })
};

async function openSignIn({ providerId, dataDir, cwd, spawnProcess = spawn }) {
  if (LOGIN[providerId]) {
    const plan = await LOGIN[providerId]();
    return openInTerminal({ cwd, ...plan, env: {}, dataDir, spawnProcess });
  }
  return openDesktopApp({ providerId, spawnProcess });
}

// Claude settings files that can override the selected profile's identity, keyed by name.
async function loadClaudeSettingsFiles(projectDir, configDir) {
  const files = {};
  if (projectDir) {
    files['.claude/settings.json'] = await readJson(path.join(projectDir, '.claude', 'settings.json'));
    files['.claude/settings.local.json'] = await readJson(path.join(projectDir, '.claude', 'settings.local.json'));
  }
  if (configDir) files[path.join(path.basename(configDir), 'settings.json')] = await readJson(path.join(configDir, 'settings.json'));
  return files;
}

module.exports = {
  shellQuote,
  environmentChanges,
  applyEnvironment,
  launchEnvironment,
  openInTerminal,
  openDesktopApp,
  launchPlan,
  launchTool,
  openSignIn,
  loadClaudeSettingsFiles
};
