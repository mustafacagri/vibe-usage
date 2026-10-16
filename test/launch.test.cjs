'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { fakeSpawn } = require('./helpers/fixtures.cjs');
const { CREDENTIAL_ENV_KEYS } = require('../src/catalog.cjs');
const { cleanEnvironment } = require('../src/providers/common.cjs');
const {
  shellQuote,
  environmentChanges,
  applyEnvironment,
  launchEnvironment,
  openInTerminal,
  openDesktopApp,
  launchTool
} = require('../src/core/launch.cjs');

const HOSTILE_DIR_NAME = `it's "x" & calc & $(touch pwned)`;

async function tempDirs(t, ...prefixes) {
  const dirs = await Promise.all(prefixes.map(p => fs.mkdtemp(path.join(os.tmpdir(), p))));
  t.after(() => Promise.all(dirs.map(d => fs.rm(d, { recursive: true, force: true }))));
  return dirs;
}

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
  const cleaned = cleanEnvironment({}, 'win32', source);
  assert.deepEqual(cleaned, { SAFE_VAR: 'keep' });
  assert.equal(cleanEnvironment({ CODEX_HOME: '/explicit' }, 'win32', source).CODEX_HOME, '/explicit');
  assert.equal(cleanEnvironment({}, 'darwin', { anthropic_api_key: 'x' }).anthropic_api_key, 'x', 'POSIX names are case-sensitive');
});

test('the default Claude profile runs with CLAUDE_CONFIG_DIR unset; others set it', () => {
  const source = {
    CLAUDE_CONFIG_DIR: '/wrong',
    claude_config_dir: '/wrong-lower',
    CLAUDE_SECURESTORAGE_CONFIG_DIR: '/store',
    ANTHROPIC_API_KEY: 'x',
    SAFE: '1'
  };
  assert.deepEqual(launchEnvironment({ id: 'claude:default', configDir: '/home/me/.claude' }, source, 'win32'), { SAFE: '1' });
  assert.deepEqual(launchEnvironment({ id: 'claude:custom', configDir: '/some/dir', configDirExplicit: false }, source, 'darwin'), {
    claude_config_dir: '/wrong-lower',
    SAFE: '1'
  });
  const secondary = launchEnvironment({ id: 'claude:secondary', configDir: '/home/me/.claude-secondary' }, source, 'win32');
  assert.deepEqual(secondary, { SAFE: '1', CLAUDE_CONFIG_DIR: '/home/me/.claude-secondary' });
  assert.equal(source.CLAUDE_CONFIG_DIR, '/wrong', 'the source environment is not mutated');
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
  const [parent, dataDir] = await tempDirs(t, 'vibe-cwd-', 'vibe-data-');
  const cwd = path.join(parent, HOSTILE_DIR_NAME);
  await fs.mkdir(cwd);
  const calls = [];
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
  const [[command, flag, app, script]] = calls;
  assert.deepEqual([command, flag, app], ['/usr/bin/open', '-a', 'Terminal']);
  const content = await fs.readFile(script, 'utf8');
  assert.ok(content.includes(`cd -- ${shellQuote(cwd)} || exit 1`));
  assert.ok(content.includes(`unset ${CREDENTIAL_ENV_KEYS.filter(k => k !== 'CODEX_HOME').join(' ')}`));
  assert.ok(content.includes("export CODEX_HOME='/home/me/.codex'"));
  assert.ok(content.endsWith(`exec '/usr/local/bin/codex' '-m' 'gpt-6-luna' 'Read the brief; then $(go)'\n`));
  assert.equal((await fs.stat(script)).mode & 0o777, 0o700);
});

test('Windows terminal launch passes arguments without any shell re-parsing them', async t => {
  const [cwd, dataDir] = await tempDirs(t, 'vibe-cwd-', 'vibe-data-');
  const calls = [];
  const options = [];
  const spawnProcess = (cmd, args, opts) => {
    options.push(opts);
    return fakeSpawn(calls)(cmd, args);
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
  const [[command, ...psArgs]] = calls;
  assert.match(command, /powershell\.exe$/i);
  assert.ok(!calls.flat().some(part => /cmd\.exe/i.test(part)), 'cmd.exe never parses user input');
  assert.equal(psArgs[psArgs.indexOf('-WorkingDirectory') + 1], cwd);
  const decoded = Buffer.from(psArgs[psArgs.indexOf('-ArgumentsBase64') + 1], 'base64')
    .toString('utf8')
    .split('\0');
  assert.deepEqual(decoded, args);
  assert.equal(options[0].shell, false);
  assert.equal(
    Object.keys(options[0].env).some(k => k.toUpperCase() === 'CLAUDE_CONFIG_DIR' || CREDENTIAL_ENV_KEYS.includes(k.toUpperCase())),
    false
  );
});

test('desktop apps open the project; a missing Windows install is reported', async t => {
  const [cwd] = await tempDirs(t, 'vibe-cwd-');
  const calls = [];
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

test('launching requires an existing folder and an account for Claude', async t => {
  const [dataDir] = await tempDirs(t, 'vibe-data-');
  await assert.rejects(
    launchTool({ providerId: 'antigravity', cwd: path.join(dataDir, 'missing'), dataDir, platform: 'darwin', spawnProcess: fakeSpawn([]) }),
    /folder_not_found/
  );
  await assert.rejects(
    launchTool({ providerId: 'claude', account: null, cwd: dataDir, dataDir, platform: 'darwin', spawnProcess: fakeSpawn([]) }),
    /account_not_found/
  );
  assert.deepEqual(
    await launchTool({ providerId: 'antigravity', cwd: dataDir, dataDir, platform: 'darwin', spawnProcess: fakeSpawn([]) }),
    { mode: 'app' }
  );
});

test('model ids are validated before they reach a command line', async () => {
  const { launchPlan } = require('../src/core/launch.cjs');
  for (const model of ['--dangerously-skip-permissions', '-m', 'a b', 'x;rm']) {
    assert.throws(() => launchPlan('codex', { model }), /invalid_argument/, model);
  }
  assert.equal(await launchPlan('antigravity', { model: 'sonnet[1m]' }), null, 'well-formed ids pass the check');
});
