import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { ProviderError } from '../src/core/errors.ts';
import {
  findBinary,
  findCommand,
  isExpired,
  processStartError,
  readCredentialFile,
  runProcess,
  unpackedPath,
  windowsPowerShell
} from '../src/providers/common.ts';
import { tempDir } from './helpers/fixtures.ts';

const node = (script: string): Promise<string> => runProcess(process.execPath, ['-e', script], { timeoutMs: 5000 });
const code = (expected: string) => (error: unknown) => error instanceof ProviderError && error.code === expected;

test('the process runner returns stdout and turns every failure into a code', async () => {
  assert.equal(await node("process.stdout.write('ok')"), 'ok');
  await assert.rejects(node('process.exit(2)'), code('process_failed'));
  await assert.rejects(runProcess(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { timeoutMs: 50 }), code('process_timeout'));
  await assert.rejects(
    runProcess(process.execPath, ['-e', "process.stdout.write('x'.repeat(4096))"], { maxBytes: 100 }),
    code('response_too_large')
  );
  await assert.rejects(runProcess(process.execPath, ['a\0b']), code('invalid_binary'), 'a NUL can never reach argv');
  await assert.rejects(runProcess(path.resolve('/no/such/binary'), []), code('binary_missing'), 'a program that is not there');
});

test('a program the system will not start is told apart from one that is missing or fails', () => {
  const systemError = (errorCode: string): Error => Object.assign(new Error(`spawn ${errorCode}`), { code: errorCode, syscall: 'spawn' });
  assert.equal(processStartError(systemError('EPERM')).code, 'process_blocked');
  assert.equal(processStartError(systemError('EACCES')).code, 'process_blocked');
  assert.equal(processStartError(systemError('ENOENT')).code, 'binary_missing');
  assert.equal(processStartError(systemError('UNKNOWN')).code, 'process_failed');
  assert.equal(processStartError(new Error('x'), 'server_closed').code, 'server_closed');
});

// Windows refuses to start a program its user may not execute, as a security policy or an
// antivirus program does; spawn throws that (EPERM) rather than emitting it.
test('a program Windows refuses to start reads as blocked', { skip: process.platform !== 'win32' && 'Windows only' }, async t => {
  const dir = await tempDir(t, 'vibe-refused-');
  const program = path.join(dir, 'refused.exe');
  await fs.copyFile(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'whoami.exe'), program);
  execFileSync('icacls', [program, '/deny', `${process.env.USERNAME ?? ''}:(X)`], { windowsHide: true });
  await assert.rejects(runProcess(program, []), code('process_blocked'));
});

test('the process runner hands the child no credential overrides unless asked to', async t => {
  process.env.ANTHROPIC_API_KEY = 'leak';
  t.after(() => {
    delete process.env.ANTHROPIC_API_KEY;
  });
  assert.equal(await node('process.stdout.write(String(process.env.ANTHROPIC_API_KEY))'), 'undefined');
});

test('binaries come from an explicit override, known install folders, then PATH', async t => {
  const home = await tempDir(t, 'vibe-binary-home-');
  const bin = await tempDir(t, 'vibe-binary-path-');
  const executable = (name: string): string => (process.platform === 'win32' ? `${name}.exe` : name);
  const tool = path.join(bin, executable('codex'));
  await fs.writeFile(tool, '');
  const location = { home, platform: process.platform };
  assert.equal(await findBinary('codex', { ...location, env: { PATH: bin } }), tool);
  assert.equal(await findBinary('codex', { ...location, env: { VIBE_CODEX_BINARY: tool, PATH: '' } }), tool);
  await assert.rejects(findBinary('codex', { ...location, env: { VIBE_CODEX_BINARY: 'relative/codex' } }), code('invalid_binary'));
  await assert.rejects(
    findBinary('codex', { ...location, env: { VIBE_CODEX_BINARY: '/x/codex.cmd' } }),
    code('invalid_binary'),
    'no batch files'
  );
  await assert.rejects(findBinary('codex', { ...location, env: { VIBE_CODEX_BINARY: path.join(bin, 'missing') } }), code('binary_missing'));

  // GUI apps miss the shell profile, so ~/.local/bin is searched for the agent CLIs.
  await fs.mkdir(path.join(home, '.local', 'bin'), { recursive: true });
  await fs.writeFile(path.join(home, '.local', 'bin', executable('codex')), '');
  assert.equal(await findBinary('codex', { ...location, env: { PATH: '' } }), path.join(home, '.local', 'bin', executable('codex')));
  await fs.writeFile(path.join(home, '.local', 'bin', executable('cursor-agent')), '');
  assert.equal(
    await findBinary('cursor-agent', { ...location, env: { PATH: '' } }),
    path.join(home, '.local', 'bin', executable('cursor-agent'))
  );
});

test('on macOS the Homebrew folder is searched, since a Dock-launched app has no shell profile', async () => {
  const brew = '/opt/homebrew/bin/gh';
  const present = await fs.stat(brew).then(
    () => true,
    () => false
  );
  if (!present) return;
  assert.equal(await findBinary('gh', { home: '/nonexistent', platform: 'darwin', env: { PATH: '/usr/bin:/bin' } }), brew);
});

// The shims npm's cmd-shim writes (as npm 11 did for Claude Code and Codex): a native program is
// run as itself, a script with node.
const SHIM_HEADER = ['@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0'];
const npmShim = (target: string): string => [...SHIM_HEADER, `"%dp0%\\${target}"   %*`].join('\r\n');
const npmNodeShim = (target: string): string =>
  [
    ...SHIM_HEADER,
    '',
    String.raw`IF EXIST "%dp0%\node.exe" (`,
    String.raw`  SET "_prog=%dp0%\node.exe"`,
    ') ELSE (',
    '  SET "_prog=node"',
    '  SET PATHEXT=%PATHEXT:;.JS;=;%',
    ')',
    '',
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${target}" %*`
  ].join('\r\n');

test('on Windows a tool installed with npm is run through what its shim runs, never the shim', async t => {
  const home = await tempDir(t, 'vibe-shim-home-');
  const npm = path.join(home, 'AppData', 'Roaming', 'npm');
  const nodeDir = await tempDir(t, 'vibe-shim-node-');
  const write = async (file: string, text = ''): Promise<string> => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text);
    return file;
  };
  const location = { home, platform: 'win32' as const };
  const claude = await write(path.join(npm, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'));
  await write(path.join(npm, 'claude.cmd'), npmShim(String.raw`node_modules\@anthropic-ai\claude-code\bin\claude.exe`));
  assert.deepEqual(await findCommand('claude', { ...location, env: { PATH: '' } }), { binary: claude, args: [] }, 'npm global folder');

  const codex = await write(path.join(npm, 'node_modules', '@openai', 'codex', 'bin', 'codex.js'));
  await write(path.join(npm, 'codex.cmd'), npmNodeShim(String.raw`node_modules\@openai\codex\bin\codex.js`));
  await assert.rejects(findCommand('codex', { ...location, env: { PATH: '' } }), code('binary_missing'), 'no node to run it with');
  const node = await write(path.join(nodeDir, 'node.exe'));
  assert.deepEqual(await findCommand('codex', { ...location, env: { PATH: nodeDir } }), { binary: node, args: [codex] });
  const besideShim = await write(path.join(npm, 'node.exe'));
  assert.deepEqual(await findCommand('codex', { ...location, env: { PATH: nodeDir } }), { binary: besideShim, args: [codex] });

  // pnpm writes its shims in a folder of its own, on PATH, relative to "%~dp0".
  const pnpm = path.join(home, 'pnpm');
  const gemini = await write(path.join(home, 'global', 'gemini', 'cli.js'));
  await write(path.join(pnpm, 'gemini.cmd'), `@SETLOCAL\r\n@"%~dp0\\node.exe" "%~dp0\\..\\global\\gemini\\cli.js" %*\r\n`);
  await write(path.join(pnpm, 'node.exe'));
  assert.deepEqual(await findCommand('gemini', { ...location, env: { PATH: pnpm } }), {
    binary: path.join(pnpm, 'node.exe'),
    args: [gemini]
  });

  await write(path.join(npm, 'gone.cmd'), npmShim(String.raw`node_modules\gone\gone.exe`));
  await assert.rejects(findCommand('gone', { ...location, env: { PATH: '' } }), code('binary_missing'), 'a shim of nothing');
  await assert.rejects(
    findCommand('claude', { ...location, env: { PATH: '', VIBE_CLAUDE_BINARY: path.join(home, 'missing.exe') } }),
    code('binary_missing'),
    'an override is not looked past'
  );
  const shimmed = await write(path.join(npm, 'node_modules', 'vibe-shimmed', 'vibe-shimmed.exe'));
  await write(path.join(npm, 'vibe-shimmed.cmd'), npmShim(String.raw`node_modules\vibe-shimmed\vibe-shimmed.exe`));
  assert.deepEqual(await findCommand('vibe-shimmed', { ...location, env: { PATH: '' } }), { binary: shimmed, args: [] });
  await assert.rejects(
    findCommand('vibe-shimmed', { home, platform: 'darwin', env: { PATH: npm } }),
    code('binary_missing'),
    'Windows only'
  );
});

test('credential files are bounded, must be objects, and a missing one means signed out', async t => {
  const dir = await tempDir(t, 'vibe-credentials-');
  const file = path.join(dir, 'auth.json');
  await assert.rejects(readCredentialFile(file), code('auth_missing'));
  await fs.writeFile(file, '[1, 2]');
  await assert.rejects(readCredentialFile(file), code('auth_invalid'));
  await fs.writeFile(file, ' '.repeat(1024 * 1024 + 1));
  await assert.rejects(readCredentialFile(file), code('invalid_response'));
  await fs.writeFile(file, '{"token":"x"}');
  assert.deepEqual(await readCredentialFile(file), { token: 'x' });
});

test('expiry includes a safety margin; Windows paths and PowerShell are fixed', () => {
  assert.equal(
    isExpired(100_000, () => 50_000),
    true,
    'a minute of margin'
  );
  assert.equal(
    isExpired(200_000, () => 50_000),
    false
  );
  assert.equal(
    isExpired('soon', () => 0),
    false,
    'an unknown expiry is not expired'
  );
  assert.equal(unpackedPath('C:\\app\\resources\\app.asar\\build\\x.ps1'), 'C:\\app\\resources\\app.asar.unpacked\\build\\x.ps1');
  assert.match(windowsPowerShell({ SystemRoot: 'D:\\Windows' }), /^D:\\Windows\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/);
  assert.throws(() => windowsPowerShell({ VIBE_POWERSHELL_BINARY: 'powershell' }), code('invalid_binary'));
});
