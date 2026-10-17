import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { applyEnvironment, cleanEnvironment, environmentChanges } from '../src/core/environment.ts';
import {
  claudeEnvironment,
  launchPlan,
  launchTool,
  openDesktopApp,
  openInTerminal,
  shellQuote,
  type SpawnProcess
} from '../src/core/launch.ts';
import { CREDENTIAL_ENV_KEYS } from '../src/shared/catalog.ts';
import { account, fakeSpawn, tempDir } from './helpers/fixtures.ts';

const HOSTILE_DIR_NAME = `it's "x" & calc & $(touch pwned)`;

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

test('the default Claude profile runs with CLAUDE_CONFIG_DIR unset; others set it', () => {
  const source = {
    CLAUDE_CONFIG_DIR: '/wrong',
    claude_config_dir: '/wrong-lower',
    CLAUDE_SECURESTORAGE_CONFIG_DIR: '/store',
    ANTHROPIC_API_KEY: 'x',
    SAFE: '1'
  };
  const environment = (fields: Parameters<typeof account>[0], platform: NodeJS.Platform) =>
    applyEnvironment(environmentChanges(claudeEnvironment(account(fields))), source, platform);
  assert.deepEqual(environment({ id: 'claude:default', configDir: '/home/me/.claude' }, 'win32'), { SAFE: '1' });
  assert.deepEqual(environment({ id: 'claude:custom', configDir: '/some/dir', configDirExplicit: false }, 'darwin'), {
    claude_config_dir: '/wrong-lower',
    SAFE: '1'
  });
  assert.deepEqual(environment({ id: 'claude:secondary', configDir: '/home/me/.claude-secondary' }, 'win32'), {
    SAFE: '1',
    CLAUDE_CONFIG_DIR: '/home/me/.claude-secondary'
  });
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
  assert.equal((await fs.stat(script)).mode & 0o777, 0o700);
});

test('Windows terminal launch passes arguments without any shell re-parsing them', async t => {
  const cwd = await tempDir(t, 'vibe-cwd-');
  const dataDir = await tempDir(t, 'vibe-data-');
  const calls: string[][] = [];
  const environments: (NodeJS.ProcessEnv | undefined)[] = [];
  const shells: unknown[] = [];
  const spawnProcess: SpawnProcess = (command, args, options) => {
    environments.push(options.env);
    shells.push(options.shell);
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
  assert.deepEqual(shells, [false]);
  const names = Object.keys(environments[0] ?? {}).map(name => name.toUpperCase());
  assert.equal(
    names.some(name => name === 'CLAUDE_CONFIG_DIR' || CREDENTIAL_ENV_KEYS.includes(name)),
    false
  );
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
