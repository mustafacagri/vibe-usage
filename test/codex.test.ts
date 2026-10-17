import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { createCodexProvider } from '../src/providers/codex.ts';
import { account, tempDir, windowsOf } from './helpers/fixtures.ts';

// A stand-in for `codex app-server --listen stdio://`: answers JSON-RPC requests line by line.
// FAKE_CODEX selects the account state it reports.
const APP_SERVER = `#!/usr/bin/env node
const readline = require('node:readline');
const mode = process.env.FAKE_CODEX;
const answers = {
  initialize: () => ({}),
  'account/read': () => ({ account: mode === 'signed-out' ? null : { planType: 'plus' } }),
  'account/rateLimits/read': () =>
    mode === 'rpc-error' ? undefined : { rateLimits: { primary: { usedPercent: 30, windowDurationMins: 300, resetsAt: 1792150000 } } }
};
readline.createInterface({ input: process.stdin }).on('line', line => {
  const { id, method } = JSON.parse(line);
  if (id === undefined) return;
  const result = answers[method]?.();
  const reply = result === undefined ? { id, error: { code: -1, message: 'private detail' } } : { id, result };
  process.stdout.write('noise that is not JSON\\n' + JSON.stringify({ jsonrpc: '2.0', ...reply }) + '\\n');
});
`;

const jwt = (claims: object): string => ['header', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'signature'].join('.');

async function setup(t: TestContext, mode: string) {
  const dir = await tempDir(t, 'vibe-codex-');
  const binary = path.join(dir, 'codex');
  await fs.writeFile(binary, APP_SERVER, { mode: 0o755 });
  const configDir = path.join(dir, 'home');
  await fs.mkdir(configDir);
  process.env.FAKE_CODEX = mode;
  t.after(() => {
    delete process.env.FAKE_CODEX;
  });
  const provider = createCodexProvider({ home: dir, env: { VIBE_CODEX_BINARY: binary } });
  return { provider, codexAccount: account({ id: 'codex:default', providerId: 'codex', configDir }), configDir };
}

const posixOnly = { skip: process.platform === 'win32' ? 'the fake app server is a POSIX script' : false };

test('the app server reports the plan and the rate limits of the signed-in account', posixOnly, async t => {
  const { provider, codexAccount } = await setup(t, 'ok');
  const result = await provider.fetch(codexAccount);
  assert.equal(result.plan, 'plus');
  const [window] = windowsOf(result);
  assert.deepEqual([window?.remainingPercent, window?.labelKey, window?.resetsAt], [70, 'labelNHours', '2026-10-16T11:26:40.000Z']);
});

test('a signed-out account and a failing method are reported as codes, never as server text', posixOnly, async t => {
  const signedOut = await setup(t, 'signed-out');
  await assert.rejects(signedOut.provider.fetch(signedOut.codexAccount), /auth_missing/);
  const failing = await setup(t, 'rpc-error');
  await assert.rejects(failing.provider.fetch(failing.codexAccount), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, 'rpc_error');
    return true;
  });
});

test('a locally expired token fails before the app server is started', async t => {
  const dir = await tempDir(t, 'vibe-codex-expired-');
  await fs.writeFile(path.join(dir, 'auth.json'), JSON.stringify({ tokens: { access_token: jwt({ exp: 1000 }) } }));
  // The binary does not exist: reaching it would fail with binary_missing instead.
  const provider = createCodexProvider({ home: dir, env: { VIBE_CODEX_BINARY: path.join(dir, 'missing') }, clock: () => 2_000_000 });
  await assert.rejects(provider.fetch(account({ id: 'codex:default', providerId: 'codex', configDir: dir })), /auth_expired/);
  await fs.writeFile(path.join(dir, 'auth.json'), '{ broken');
  await assert.rejects(provider.fetch(account({ id: 'codex:default', providerId: 'codex', configDir: dir })), /auth_invalid/);
});

test('the default account points at the Codex home folder', async () => {
  const [discovered] = await createCodexProvider({ home: '/home/me' }).discover();
  assert.equal(discovered?.id, 'codex:default');
  assert.equal(discovered.configDir, process.env.CODEX_HOME ?? path.join('/home/me', '.codex'));
});
