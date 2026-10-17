import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { ProviderError } from '../src/core/errors.ts';
import { findBinary, isExpired, readCredentialFile, runProcess, unpackedPath, windowsPowerShell } from '../src/providers/common.ts';
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
  await assert.rejects(runProcess('/no/such/binary', []), code('process_failed'));
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
  const tool = path.join(bin, 'codex');
  await fs.writeFile(tool, '');
  const location = { home, platform: 'darwin' as const };
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
  await fs.writeFile(path.join(home, '.local', 'bin', 'cursor-agent'), '');
  assert.equal(await findBinary('cursor-agent', { ...location, env: { PATH: '' } }), path.join(home, '.local', 'bin', 'cursor-agent'));
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
