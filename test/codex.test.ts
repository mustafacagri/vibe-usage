import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { createCodexProvider, resetCodexQuota, type CodexProviderOptions } from '../src/providers/codex.ts';
import { account, tempDir, windowsOf } from './helpers/fixtures.ts';

// A stand-in for `codex app-server --listen stdio://`: answers JSON-RPC requests line by line.
// FAKE_CODEX selects the account state it reports.
const APP_SERVER = `#!/usr/bin/env node
const readline = require('node:readline');
const mode = process.env.FAKE_CODEX;
const answers = {
  initialize: () => ({}),
  'account/read': () => ({ account: mode === 'signed-out' ? null : { planType: 'plus', email: mode === 'wrong-account' ? 'wrong@example.com' : 'work@example.com' } }),
  'account/rateLimits/read': () =>
    mode === 'rpc-error' ? undefined : { rateLimits: { primary: { usedPercent: 30, windowDurationMins: 300, resetsAt: 1792150000 } }, rateLimitResetCredits: { availableCount: 2 } },
  'account/rateLimitResetCredit/consume': params => params.idempotencyKey === 'fixture-key' ? { outcome: 'reset' } : undefined
};
readline.createInterface({ input: process.stdin }).on('line', line => {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) return;
  const result = answers[method]?.(params);
  const reply = result === undefined ? { id, error: { code: -1, message: 'private detail' } } : { id, result };
  process.stdout.write('noise that is not JSON\\n' + JSON.stringify({ jsonrpc: '2.0', ...reply }) + '\\n');
});
`;

const jwt = (claims: object): string => ['header', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'signature'].join('.');

async function setup(t: TestContext, mode: string) {
  const dir = await tempDir(t, 'vibe-codex-');
  const binary = path.join(dir, 'app-server.cjs');
  await fs.writeFile(binary, APP_SERVER, { mode: 0o755 });
  const configDir = path.join(dir, 'home');
  await fs.mkdir(configDir);
  process.env.FAKE_CODEX = mode;
  t.after(() => {
    delete process.env.FAKE_CODEX;
  });
  const providerOptions: CodexProviderOptions = {
    home: dir,
    env: { VIBE_CODEX_BINARY: process.execPath },
    spawnProcess: (_binary, args, options) => {
      assert.deepEqual(args.slice(0, 3), ['app-server', '--listen', 'stdio://']);
      assert.equal(options.shell, false);
      assert.equal(options.env?.CODEX_HOME, configDir);
      return spawn(process.execPath, [binary, ...args], { ...options, stdio: ['pipe', 'pipe', 'ignore'] });
    }
  };
  return {
    provider: createCodexProvider(providerOptions),
    providerOptions,
    codexAccount: account({ id: 'codex:default', providerId: 'codex', configDir }),
    configDir
  };
}

test('the app server reports the plan and the rate limits of the signed-in account', async t => {
  const { provider, providerOptions, codexAccount, configDir } = await setup(t, 'ok');
  assert.equal((await provider.fetch(codexAccount)).accountKey, undefined, 'no auth file, no binding');
  const idToken = jwt({ email: ' Work@Example.com ', sub: 'user' });
  await fs.writeFile(
    path.join(configDir, 'auth.json'),
    JSON.stringify({ tokens: { account_id: 'account', id_token: idToken, access_token: jwt({ exp: 4102444800 }) } })
  );
  const result = await provider.fetch(codexAccount);
  assert.equal(result.plan, 'plus');
  assert.equal(result.signedInAs, 'work@example.com', 'the e-mail is read from the local sign-in');
  assert.ok(result.accountKey);
  assert.match(result.accountKey, /^[a-f0-9]{64}$/);
  assert.equal(result.resetCredits, 2);
  await assert.rejects(resetCodexQuota(configDir, 'different-account', 'fixture-key', providerOptions), /auth_invalid/);
  assert.equal(await resetCodexQuota(configDir, result.accountKey, 'fixture-key', providerOptions), true);
  process.env.FAKE_CODEX = 'wrong-account';
  await assert.rejects(provider.fetch(codexAccount), /auth_invalid/);
  const [window] = windowsOf(result);
  assert.deepEqual([window?.remainingPercent, window?.labelKey, window?.resetsAt], [70, 'labelNHours', '2026-10-16T11:26:40.000Z']);
});

test('a signed-out account and a failing method are reported as codes, never as server text', async t => {
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

test('aborting a quota refresh terminates the owned app-server process and settles its pending RPC', async t => {
  const dir = await tempDir(t, 'vibe-codex-cancel-');
  let started: () => void = () => undefined;
  const began = new Promise<void>(resolve => {
    started = resolve;
  });
  let child: ReturnType<typeof spawn> | undefined;
  const provider = createCodexProvider({
    home: dir,
    env: { VIBE_CODEX_BINARY: process.execPath },
    spawnProcess: (_binary, _args, options) => {
      const owned = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        ...options,
        stdio: ['pipe', 'pipe', 'ignore']
      });
      child = owned;
      owned.once('spawn', started);
      return owned;
    }
  });
  const controller = new AbortController();
  const result = provider.fetch(account({ providerId: 'codex', configDir: dir }), {
    signal: controller.signal,
    deadline: Date.now() + 5000
  });
  await began;
  controller.abort();
  await assert.rejects(result, /request_timeout/);
  assert.ok(child && (child.exitCode !== null || child.signalCode !== null), 'the child is gone before the adapter finishes');
});
