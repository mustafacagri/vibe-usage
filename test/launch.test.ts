import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { applyEnvironment, cleanEnvironment, environmentChanges } from '../src/core/environment.ts';
import {
  CLAUDE_RESUME_THRESHOLD_ENV,
  launchPlan,
  launchTool,
  openDesktopApp,
  openInTerminal,
  openSignIn,
  profileEnvironment,
  RESUME_WITHOUT_QUESTION,
  shellQuote,
  type SpawnProcess
} from '../src/core/launch.ts';
import { CREDENTIAL_ENV_KEYS } from '../src/shared/catalog.ts';
import { account, fakeSpawn, tempDir } from './helpers/fixtures.ts';

// Windows forbids double quotes in file names; pure quoting tests still cover them.
const HOSTILE_DIR_NAME = process.platform === 'win32' ? `it's x & calc & $(touch pwned)` : `it's "x" & calc & $(touch pwned)`;

test('credential overrides are removed case-insensitively on Windows; explicit values win', () => {
  const source = {
    anthropic_api_key: 'x',
    Anthropic_Base_Url: 'x',
    cursor_api_key: 'x',
    aws_secret_access_key: 'x',
    openai_base_url: 'x',
    CODEX_HOME: '/opt',
    SAFE_VAR: 'keep'
  };
  assert.deepEqual(cleanEnvironment({}, 'win32', source), { SAFE_VAR: 'keep' });
  assert.equal(cleanEnvironment({ CODEX_HOME: '/explicit' }, 'win32', source).CODEX_HOME, '/explicit');
  assert.equal(cleanEnvironment({}, 'darwin', { anthropic_api_key: 'x' }).anthropic_api_key, 'x', 'POSIX names are case-sensitive');
});

test('the default Claude profile runs with CLAUDE_CONFIG_DIR unset; others set it; Codex gets its CODEX_HOME', () => {
  const source = {
    CLAUDE_CONFIG_DIR: '/wrong',
    claude_config_dir: '/wrong-lower',
    CLAUDE_SECURESTORAGE_CONFIG_DIR: '/store',
    ANTHROPIC_API_KEY: 'x',
    SAFE: '1'
  };
  const environment = (fields: Parameters<typeof account>[0], platform: NodeJS.Platform) =>
    applyEnvironment(environmentChanges(profileEnvironment(account(fields))), source, platform);
  assert.deepEqual(environment({ id: 'claude:default', configDir: '/home/me/.claude' }, 'win32'), { SAFE: '1' });
  assert.deepEqual(environment({ id: 'claude:custom', configDir: '/some/dir', configDirExplicit: false }, 'darwin'), {
    claude_config_dir: '/wrong-lower',
    SAFE: '1'
  });
  assert.deepEqual(environment({ id: 'claude:secondary', configDir: path.resolve('/home/me/.claude-secondary') }, 'win32'), {
    SAFE: '1',
    CLAUDE_CONFIG_DIR: path.resolve('/home/me/.claude-secondary')
  });
  assert.equal(source.CLAUDE_CONFIG_DIR, '/wrong', 'the source environment is not mutated');
  assert.deepEqual(
    profileEnvironment(account({ id: 'codex:work', providerId: 'codex', configDir: path.resolve('/home/me/.codex-work') })),
    {
      set: { CODEX_HOME: path.resolve('/home/me/.codex-work') }
    }
  );
  assert.deepEqual(profileEnvironment(account({ id: 'cursor:default', providerId: 'cursor' })), {});
});

test('environment changes reject names that are not variable names', () => {
  assert.throws(() => environmentChanges({ set: { 'A;rm -rf': '1' } }), /invalid_argument/);
  assert.deepEqual(applyEnvironment(environmentChanges({ set: { CODEX_HOME: '/c' } }), { CODEX_HOME: '/old', KEEP: '1' }, 'darwin'), {
    KEEP: '1',
    CODEX_HOME: '/c'
  });
});

test('POSIX quoting keeps shell metacharacters literal', () => {
  assert.equal(shellQuote("a'b;$(touch nope)"), "'a'\\''b;$(touch nope)'");
  assert.throws(() => shellQuote('x\ncommand'), /invalid_argument/);
});

test('macOS terminal launch writes a script that unsets every credential override', async t => {
  const cwd = path.join(await tempDir(t, 'vibe-cwd-'), HOSTILE_DIR_NAME);
  const dataDir = await tempDir(t, 'vibe-data-');
  await fs.mkdir(cwd);
  const calls: string[][] = [];
  await openInTerminal({
    cwd,
    binary: '/usr/local/bin/codex',
    args: ['-m', 'gpt-6-luna', 'Read the brief; then $(go)'],
    env: { set: { CODEX_HOME: '/home/me/.codex' } },
    title: 'Vibe',
    dataDir,
    platform: 'darwin',
    spawnProcess: fakeSpawn(calls)
  });
  const [command, flag, app, script = ''] = calls[0] ?? [];
  assert.deepEqual([command, flag, app], ['/usr/bin/open', '-a', 'Terminal']);
  const content = await fs.readFile(script, 'utf8');
  assert.ok(content.includes(`cd -- ${shellQuote(cwd)} || exit 1`));
  assert.ok(content.includes(`unset ${CREDENTIAL_ENV_KEYS.filter(k => k !== 'CODEX_HOME').join(' ')}`));
  assert.ok(content.includes("export CODEX_HOME='/home/me/.codex'"));
  assert.ok(content.endsWith(`exec '/usr/local/bin/codex' '-m' 'gpt-6-luna' 'Read the brief; then $(go)'\n`));
  if (process.platform !== 'win32') assert.equal((await fs.stat(script)).mode & 0o777, 0o700);
});

test('a macOS launcher script removes itself when it runs', { skip: process.platform !== 'darwin' && 'needs zsh' }, async t => {
  const cwd = await tempDir(t, 'vibe-cwd-');
  const dataDir = await tempDir(t, 'vibe-data-');
  const calls: string[][] = [];
  await openInTerminal({ cwd, binary: '/usr/bin/true', args: [], env: {}, dataDir, platform: 'darwin', spawnProcess: fakeSpawn(calls) });
  const script = calls[0]?.at(-1) ?? '';
  execFileSync('/bin/zsh', [script]);
  assert.deepEqual(await fs.readdir(path.dirname(script)), []);
});

test('Windows terminal launch passes arguments without any shell re-parsing them', async t => {
  const cwd = await tempDir(t, 'vibe-cwd-');
  const dataDir = await tempDir(t, 'vibe-data-');
  const calls: string[][] = [];
  const environments: (NodeJS.ProcessEnv | undefined)[] = [];
  const shells: unknown[] = [];
  const spawnProcess: SpawnProcess = (command, args, options) => {
    environments.push(options.env);
    shells.push([options.shell, options.detached, options.windowsHide]);
    return fakeSpawn(calls)(command, args, options);
  };
  const args = ['--model', 'opus', `prompt with "quotes" & ${HOSTILE_DIR_NAME}`];
  await openInTerminal({
    cwd,
    binary: 'C:\\Tools\\claude.exe',
    args,
    env: { unset: ['CLAUDE_CONFIG_DIR'] },
    dataDir,
    platform: 'win32',
    spawnProcess
  });
  const [command = '', ...psArgs] = calls[0] ?? [];
  assert.match(command, /powershell\.exe$/i);
  assert.ok(!calls.flat().some(part => /cmd\.exe/i.test(part)), 'cmd.exe never parses user input');
  assert.equal(psArgs[psArgs.indexOf('-WorkingDirectory') + 1], cwd);
  const encoded = psArgs[psArgs.indexOf('-ArgumentsBase64') + 1] ?? '';
  assert.deepEqual(Buffer.from(encoded, 'base64').toString('utf8').split('\0'), args);
  // A detached PowerShell has no console and exits; the hidden one opens the window itself.
  assert.deepEqual(shells, [[false, undefined, true]]);
  assert.equal(psArgs.at(-1), '-NewWindow');
  const names = Object.keys(environments[0] ?? {}).map(name => name.toUpperCase());
  assert.equal(
    names.some(name => name === 'CLAUDE_CONFIG_DIR' || CREDENTIAL_ENV_KEYS.includes(name)),
    false
  );
});

// Windows PowerShell's own `& tool @args` does not escape quotes inside an argument: a prompt
// with quotes (a background command it names) came out as several arguments, some of them
// options. The script builds the command line itself; the tool gets each argument as sent.
test('the Windows terminal script hands the tool its arguments exactly', { skip: process.platform !== 'win32' }, async t => {
  const dir = await tempDir(t, 'vibe-terminal-');
  const printer = path.join(dir, 'print.js');
  await fs.writeFile(printer, 'console.log(JSON.stringify(process.argv.slice(2)));\n');
  const args = [
    'Tasks: b1 (echo " --dangerously-skip-permissions "). Read.',
    'npm run "build"',
    String.raw`a\" b`,
    'ends with a backslash\\',
    `it's & $(calc)`,
    ''
  ];
  const script = path.resolve(import.meta.dirname, '../src/launchers/terminal.ps1');
  const output = execFileSync(
    'powershell.exe',
    [
      ...['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
      ...['-WorkingDirectory', dir, '-Executable', process.execPath],
      ...['-ArgumentsBase64', Buffer.from([printer, ...args].join('\0'), 'utf8').toString('base64')]
    ],
    { encoding: 'utf8' }
  );
  assert.deepEqual(JSON.parse(output.trim().split('\n').at(-1) ?? 'null'), args);
});

test('desktop apps open the project; a missing Windows install is reported', async t => {
  const cwd = await tempDir(t, 'vibe-cwd-');
  const calls: string[][] = [];
  await openDesktopApp({ providerId: 'antigravity', cwd, platform: 'darwin', spawnProcess: fakeSpawn(calls) });
  assert.deepEqual(calls, [['/usr/bin/open', '-a', 'Antigravity', cwd]]);
  await assert.rejects(
    openDesktopApp({ providerId: 'cursor', cwd, platform: 'win32', env: { LOCALAPPDATA: cwd }, spawnProcess: fakeSpawn(calls) }),
    /app_not_found/
  );
  await assert.rejects(
    openDesktopApp({ providerId: 'cursor', cwd, platform: 'linux', spawnProcess: fakeSpawn(calls) }),
    /unsupported_platform/
  );
});

test('Claude signs in with `claude auth login`, which works even over expired credentials', async t => {
  const binary = path.join(await tempDir(t, 'vibe-bin-'), 'claude');
  await fs.writeFile(binary, '');
  process.env.VIBE_CLAUDE_BINARY = binary;
  t.after(() => {
    delete process.env.VIBE_CLAUDE_BINARY;
  });
  const dataDir = await tempDir(t, 'vibe-data-');
  const calls: string[][] = [];
  const configDir = await tempDir(t, 'vibe-claude-secondary-');
  const secondary = account({ id: 'claude:secondary', configDir });
  await openSignIn({ providerId: 'claude', account: secondary, dataDir, cwd: dataDir, platform: 'darwin', spawnProcess: fakeSpawn(calls) });
  const content = await fs.readFile(calls[0]?.at(-1) ?? '', 'utf8');
  assert.ok(content.includes(`export CLAUDE_CONFIG_DIR=${shellQuote(configDir)}`));
  assert.ok(content.endsWith(`exec '${binary}' 'auth' 'login'\n`));
});

test('launching requires an existing folder and an account for Claude', async t => {
  const dataDir = await tempDir(t, 'vibe-data-');
  const options = { dataDir, platform: 'darwin' as const, spawnProcess: fakeSpawn([]) };
  await assert.rejects(launchTool({ ...options, providerId: 'antigravity', cwd: path.join(dataDir, 'missing') }), /folder_not_found/);
  await assert.rejects(launchTool({ ...options, providerId: 'claude', account: null, cwd: dataDir }), /account_not_found/);
  assert.deepEqual(await launchTool({ ...options, providerId: 'antigravity', cwd: dataDir }), { mode: 'app' });
});

test('model ids are validated before they reach a command line', async () => {
  for (const model of ['--dangerously-skip-permissions', '-m', 'a b', 'x;rm']) {
    assert.throws(() => launchPlan('codex', { model }), /invalid_argument/, model);
  }
  assert.equal(await launchPlan('antigravity', { model: 'sonnet[1m]' }), null, 'well-formed ids pass the check');
});

test('Cursor launch leaves the project trust decision to Cursor', async t => {
  const binary = path.join(await tempDir(t, 'vibe-cursor-bin-'), process.platform === 'win32' ? 'agent.exe' : 'agent');
  await fs.writeFile(binary, '');
  const previous = process.env.VIBE_AGENT_BINARY;
  process.env.VIBE_AGENT_BINARY = binary;
  t.after(() => {
    if (previous === undefined) delete process.env.VIBE_AGENT_BINARY;
    else process.env.VIBE_AGENT_BINARY = previous;
  });
  const plan = await launchPlan('cursor', { model: 'auto', prompt: 'Read the brief.' });
  assert.ok(plan);
  assert.equal(plan.binary, binary);
  assert.deepEqual(plan.args, ['--model', 'auto', 'Read the brief.']);
  assert.equal(plan.args.includes('--trust'), false);
});

test('a session the app resumes gets no resume question; a fresh start keeps Claude Code’s defaults', async t => {
  const root = await tempDir(t, 'vibe-resume-env-');
  const binary = path.join(root, 'claude');
  await fs.writeFile(binary, '');
  process.env.VIBE_CLAUDE_BINARY = binary;
  t.after(() => {
    delete process.env.VIBE_CLAUDE_BINARY;
  });
  const second = account({ id: 'claude:b', configDir: path.join(root, '.claude-2'), primary: false });
  const resumed = await launchPlan('claude', { account: second, resume: 'session-1' });
  assert.deepEqual(resumed?.env.set, { CLAUDE_CONFIG_DIR: second.configDir, [CLAUDE_RESUME_THRESHOLD_ENV]: RESUME_WITHOUT_QUESTION });
  const started = await launchPlan('claude', { account: second });
  assert.deepEqual(started?.env.set, { CLAUDE_CONFIG_DIR: second.configDir });
});

test('on Windows, Cursor signs in through the Agent CLI, and says so when it is missing', async t => {
  const dataDir = await tempDir(t, 'vibe-data-');
  const binary = path.join(await tempDir(t, 'vibe-cursor-bin-'), 'cursor-agent.exe');
  await fs.writeFile(binary, '');
  const saved = {
    agent: process.env.VIBE_CURSOR_AGENT_BINARY,
    other: process.env.VIBE_AGENT_BINARY,
    local: process.env.LOCALAPPDATA,
    path: process.env.PATH,
    Path: process.env.Path
  };
  t.after(() => {
    for (const [key, value] of [
      ['VIBE_CURSOR_AGENT_BINARY', saved.agent],
      ['VIBE_AGENT_BINARY', saved.other],
      ['LOCALAPPDATA', saved.local],
      ['PATH', saved.path],
      ['Path', saved.Path]
    ] as const) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
  });
  process.env.VIBE_CURSOR_AGENT_BINARY = binary;
  const calls: string[][] = [];
  await openSignIn({ providerId: 'cursor', dataDir, cwd: dataDir, platform: 'win32', spawnProcess: fakeSpawn(calls) });
  const args = calls[0] ?? [];
  assert.equal(args[args.indexOf('-Executable') + 1], binary);
  const encoded = args[args.indexOf('-ArgumentsBase64') + 1] ?? '';
  assert.equal(Buffer.from(encoded, 'base64').toString('utf8'), 'login');
  delete process.env.VIBE_CURSOR_AGENT_BINARY;
  delete process.env.VIBE_AGENT_BINARY;
  process.env.LOCALAPPDATA = dataDir;
  process.env.PATH = '';
  delete process.env.Path;
  await assert.rejects(
    openSignIn({ providerId: 'cursor', dataDir, cwd: dataDir, platform: 'win32', spawnProcess: fakeSpawn([]) }),
    /cursor_agent_missing/
  );
});
