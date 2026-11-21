import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { renewAntigravitySignIn, type RunProcess } from '../src/core/antigravity-renew.ts';
import { ProviderError } from '../src/core/errors.ts';
import { createService } from '../src/core/service.ts';
import { antigravityTokenPath } from '../src/providers/antigravity.ts';
import type { FetchResult, ProviderAdapter } from '../src/providers/types.ts';
import { account, tempDir } from './helpers/fixtures.ts';

const NOW = Date.parse('2026-10-20T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;

test('an expired isolated Antigravity profile is renewed by agy models in its own profile directory', async t => {
  const dir = await tempDir(t, 'vibe-agy-renew-');
  const binary = path.join(dir, process.platform === 'win32' ? 'agy.exe' : 'agy');
  await fs.writeFile(binary, '');
  process.env.VIBE_AGY_BINARY = binary;
  t.after(() => {
    delete process.env.VIBE_AGY_BINARY;
  });
  const configDir = path.join(dir, '.antigravity-2');
  const target = account({ id: 'antigravity:profile-1', providerId: 'antigravity', configDir, primary: false });
  let expiry = new Date(NOW - HOUR).toISOString();
  let refreshToken: string | undefined = 'fixture-refresh';
  const runs: { binary: string; args: readonly string[]; wsl: unknown }[] = [];
  const runProcess: RunProcess = (file, args, options) => {
    runs.push({ binary: file, args, wsl: options.env?.WSL_INTEROP });
    expiry = new Date(NOW + HOUR).toISOString();
    return Promise.resolve();
  };
  const readToken = () => Promise.resolve({ token: { access_token: 'fixture-access', refresh_token: refreshToken, expiry } });

  assert.equal(await renewAntigravitySignIn(target, { clock: () => NOW, runProcess, readToken }), true);
  assert.deepEqual(runs, [{ binary, args: [`--gemini_dir=${configDir}`, 'models'], wsl: '1' }]);

  // An account without configDir (local hub account) is never renewed this way.
  assert.equal(await renewAntigravitySignIn(account({ id: 'antigravity:local', providerId: 'antigravity' })), false);

  // Without a refresh token, agy is not started.
  refreshToken = undefined;
  runs.length = 0;
  assert.equal(await renewAntigravitySignIn(target, { clock: () => NOW, runProcess, readToken }), false);
  assert.deepEqual(runs, []);

  // Reading straight from disk works when readToken is omitted.
  const diskToken = antigravityTokenPath(configDir);
  await fs.mkdir(path.dirname(diskToken), { recursive: true });
  await fs.writeFile(
    diskToken,
    JSON.stringify({ token: { access_token: 'old', refresh_token: 'r', expiry: new Date(NOW - HOUR).toISOString() } })
  );
  const renewDisk: RunProcess = async () => {
    await fs.writeFile(
      diskToken,
      JSON.stringify({ token: { access_token: 'new', refresh_token: 'r', expiry: new Date(NOW + HOUR).toISOString() } })
    );
  };
  assert.equal(await renewAntigravitySignIn(target, { clock: () => NOW, runProcess: renewDisk }), true);
});

test('the service renews an expired isolated Antigravity profile even when autoContinue is off', async t => {
  const dir = await tempDir(t, 'vibe-agy-renew-svc-');
  const settingsPath = path.join(dir, 'settings.json');
  const profile = account({ id: 'antigravity:profile-1', providerId: 'antigravity', configDir: path.join(dir, '.antigravity-2') });
  await fs.writeFile(settingsPath, JSON.stringify({ pinned: false, intervalSeconds: 120, autoContinue: 'off', accounts: [profile] }));
  let renewed = false;
  const calls: string[] = [];
  const adapter: ProviderAdapter = {
    id: 'antigravity',
    discover: () => Promise.resolve([]),
    fetch: (): Promise<FetchResult> =>
      renewed ? Promise.resolve({ windows: [{ id: '5h', remainingPercent: 95 }] }) : Promise.reject(new ProviderError('auth_expired'))
  };
  const service = await createService({
    settingsPath,
    providers: [adapter],
    clock: () => NOW,
    renewSignIn: {
      antigravity: target => {
        calls.push(target.id);
        renewed = true;
        return Promise.resolve(true);
      }
    }
  });
  await service.refresh('antigravity');
  for (let i = 0; i < 20 && service.snapshot().providers[0]?.accounts[0]?.status !== 'ok'; i++)
    await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(calls, [profile.id]);
  assert.equal(service.snapshot().providers[0]?.accounts[0]?.status, 'ok');
});
