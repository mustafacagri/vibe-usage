import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import type { ClientRequest, IncomingMessage } from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { loadMeasurements } from '../src/core/measurements.ts';
import { isAccountEligible } from '../src/core/selection.ts';
import { createService } from '../src/core/service.ts';
import { antigravityAccountId, createAntigravityProvider } from '../src/providers/antigravity.ts';
import { createClaudeProvider, parseClaudeUsage } from '../src/providers/claude.ts';
import { createCodexProvider } from '../src/providers/codex.ts';
import { getJson, QUOTA_ENDPOINTS, runProcess } from '../src/providers/common.ts';
import type { FetchResult, ProviderAdapter, RefreshContext } from '../src/providers/types.ts';
import { account, tempDir } from './helpers/fixtures.ts';

test('Claude explicitly removed weekly limits disappear from memory and persisted measurements', async t => {
  const dir = await tempDir(t, 'vibe-retired-window-');
  let response: unknown = { five_hour: { utilization: 10 }, seven_day: { utilization: 20 } };
  const actual = createClaudeProvider({
    platform: 'win32',
    home: dir,
    readCredentials: () => Promise.resolve({ claudeAiOauth: { accessToken: 'synthetic-token' } }),
    getJson: () => Promise.resolve(response)
  });
  const settingsPath = path.join(dir, 'settings.json');
  const measurementsPath = path.join(dir, 'measurements.json');
  const service = await createService({ settingsPath, measurementsPath, providers: [actual] });
  await service.refresh();
  assert.equal(service.snapshot().providers[0]?.accounts[0]?.windows.length, 2);
  response = { five_hour: { utilization: 10 }, seven_day: null, limits: [{ kind: 'session', percent: 10 }] };
  assert.ok(parseClaudeUsage(response).removedWindowIds?.includes('seven_day'));
  for (let i = 0; i < 3; i++) await service.refresh();
  const measured = service.snapshot().providers[0]?.accounts[0];
  assert.ok(measured);
  assert.deepEqual(
    measured.windows.map(w => w.id),
    ['five_hour']
  );
  assert.equal(isAccountEligible(measured), true);
  const restarted = await createService({ settingsPath, measurementsPath, providers: [actual] });
  assert.deepEqual(
    restarted.snapshot().providers[0]?.accounts[0]?.windows.map(w => w.id),
    ['five_hour']
  );
});

test('partial readings stay conservative and no-limits responses remove the saved reading across restart', async t => {
  const dir = await tempDir(t, 'vibe-reading-outcomes-');
  let result: FetchResult = {
    completeness: 'complete',
    windows: [
      { id: 'five', remainingPercent: 80 },
      { id: 'weekly', remainingPercent: 70 }
    ]
  };
  const provider: ProviderAdapter = {
    id: 'claude',
    discover: () => Promise.resolve([account()]),
    fetch: () => Promise.resolve(result)
  };
  const settingsPath = path.join(dir, 'settings.json');
  const measurementsPath = path.join(dir, 'measurements.json');
  const service = await createService({ settingsPath, measurementsPath, providers: [provider] });
  await service.refresh();
  result = { completeness: 'partial', windows: [{ id: 'five', remainingPercent: 90 }] };
  await service.refresh();
  const partial = service.snapshot().providers[0]?.accounts[0];
  assert.ok(partial);
  assert.equal(partial.windows.find(w => w.id === 'weekly')?.stale, true);
  assert.equal(partial.status, 'stale');
  assert.equal(isAccountEligible(partial), false);
  const partialRestart = await createService({ settingsPath, measurementsPath, providers: [provider] });
  await partialRestart.refresh();
  assert.equal(
    isAccountEligible(partialRestart.snapshot().providers[0]?.accounts[0] ?? null),
    false,
    'partial data is never eligibility proof after restart'
  );
  result = { windows: [], status: 'no_limits_reported' };
  await service.refresh();
  assert.equal((await loadMeasurements(measurementsPath)).size, 0);
  const restarted = await createService({ settingsPath, measurementsPath, providers: [provider] });
  assert.deepEqual(restarted.snapshot().providers[0]?.accounts[0]?.windows, []);
  assert.equal(restarted.snapshot().providers[0]?.accounts[0]?.status, 'pending');
  assert.equal(isAccountEligible(restarted.snapshot().providers[0]?.accounts[0] ?? null), false);
});

test('transient profile directory errors never count as clean discovery misses', async t => {
  for (const providerId of ['claude', 'codex'] as const) {
    await t.test(providerId, async st => {
      const dir = await tempDir(st, 'vibe-unknown-discovery-');
      const home = path.join(dir, 'home');
      const profile = path.join(home, `.${providerId}-work`);
      const auth = path.join(profile, providerId === 'claude' ? '.credentials.json' : 'auth.json');
      await fs.mkdir(profile, { recursive: true });
      await fs.writeFile(auth, JSON.stringify({ claudeAiOauth: { accessToken: 'synthetic-token' } }));
      const provider = providerId === 'claude' ? createClaudeProvider({ home, platform: 'win32' }) : createCodexProvider({ home, env: {} });
      const service = await createService({ settingsPath: path.join(dir, 'settings.json'), providers: [provider] });
      const original = service.snapshot().settings.accounts.find(a => a.configDir === profile);
      assert.ok(original);
      await fs.rename(home, `${home}-saved`);
      await fs.writeFile(home, 'temporary non-directory');
      for (let i = 0; i < 4; i++) await service.reconcileDiscovery();
      assert.ok(service.snapshot().settings.accounts.some(a => a.id === original.id));
      await fs.rm(home);
      await fs.rename(`${home}-saved`, home);
      await fs.rm(auth);
      for (let i = 0; i < 3; i++) await service.reconcileDiscovery();
      assert.equal(
        service.snapshot().settings.accounts.some(a => a.id === original.id),
        false
      );
    });
  }
});

test('service deadlines, account removal and disposal abort active provider work', async t => {
  for (const reason of ['deadline', 'remove', 'dispose'] as const) {
    await t.test(reason, async st => {
      const dir = await tempDir(st, 'vibe-abort-refresh-');
      let started: () => void = () => undefined;
      const began = new Promise<void>(resolve => {
        started = resolve;
      });
      let context: RefreshContext | undefined;
      const provider: ProviderAdapter = {
        id: 'claude',
        fetchTimeoutMs: reason === 'deadline' ? 30 : 5000,
        discover: () => Promise.resolve([account()]),
        fetch: async (_account, current) => {
          context = current;
          started();
          return new Promise((_resolve, reject) => {
            current?.signal.addEventListener(
              'abort',
              () => {
                reject(new Error('cancelled'));
              },
              { once: true }
            );
          });
        }
      };
      const service = await createService({ settingsPath: path.join(dir, 'settings.json'), providers: [provider] });
      const pending = service.refresh();
      await began;
      assert.ok(context && context.deadline > Date.now());
      if (reason === 'remove') await service.dismissAccount('claude:a');
      if (reason === 'dispose') service.dispose();
      await pending;
      assert.equal(context.signal.aborted, true);
      if (reason === 'deadline') assert.equal(service.snapshot().providers[0]?.accounts[0]?.status, 'request_timeout');
      if (reason === 'remove') assert.deepEqual(service.snapshot().providers[0]?.accounts, []);
    });
  }
});

test('HTTP cancellation destroys the request and a pre-aborted process never starts', async () => {
  const controller = new AbortController();
  let destroyed = false;
  let started = false;
  const requestImpl = (_url: URL, _options: unknown, _callback: (response: IncomingMessage) => void): ClientRequest => {
    started = true;
    return Object.assign(new EventEmitter(), {
      destroy: () => {
        destroyed = true;
      }
    }) as unknown as ClientRequest;
  };
  const pending = getJson(QUOTA_ENDPOINTS.claude, { signal: controller.signal, requestImpl });
  controller.abort();
  await assert.rejects(pending, /request_timeout/);
  assert.equal(started, true);
  assert.equal(destroyed, true);
  await assert.rejects(runProcess(process.execPath, ['-e', 'process.exit(99)'], { signal: controller.signal }), /request_timeout/);
  const running = new AbortController();
  const processRead = runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { signal: running.signal });
  await delay(30);
  running.abort();
  await assert.rejects(processRead, /request_timeout/);
});

test('a fresh refresh waits for cancellation cleanup before opening another transport', async t => {
  const dir = await tempDir(t, 'vibe-refresh-cleanup-');
  let announce: () => void = () => undefined;
  const began = new Promise<void>(resolve => {
    announce = resolve;
  });
  let reads = 0;
  let active = 0;
  let mostActive = 0;
  const provider: ProviderAdapter = {
    id: 'claude',
    fetchTimeoutMs: 30,
    discover: () => Promise.resolve([account()]),
    fetch: (_account, context) => {
      active++;
      mostActive = Math.max(mostActive, active);
      if (reads++ > 0) {
        active--;
        return Promise.resolve({ windows: [{ id: 'five', remainingPercent: 90 }] });
      }
      announce();
      return new Promise((_resolve, reject) => {
        context?.signal.addEventListener(
          'abort',
          () => {
            setTimeout(() => {
              active--;
              reject(new Error('transport closed'));
            }, 40);
          },
          { once: true }
        );
      });
    }
  };
  const service = await createService({ settingsPath: path.join(dir, 'settings.json'), providers: [provider] });
  const first = service.refresh();
  await began;
  const next = service.refresh(undefined, { fresh: true });
  await Promise.all([first, next]);
  assert.equal(mostActive, 1);
  assert.equal(reads, 2);
  assert.equal(service.snapshot().providers[0]?.accounts[0]?.status, 'ok');
});

test('four Antigravity accounts share one server discovery and eight RPC calls per refresh', async t => {
  const dir = await tempDir(t, 'vibe-antigravity-batch-');
  let discoveries = 0;
  let calls = 0;
  const servers = Array.from({ length: 4 }, (_, i) => ({ pid: i + 1, csrfToken: `synthetic-${i}`, ports: [3001 + i] }));
  const provider = createAntigravityProvider({
    discoverAntigravityServers: () => {
      discoveries++;
      return Promise.resolve(servers);
    },
    requestLocalJson: (server, _port, method) => {
      calls++;
      return Promise.resolve(
        method === 'GetUserStatus'
          ? { userStatus: { email: `account${server.pid}@example.com` } }
          : { groups: [{ id: 'g', displayName: 'Models', buckets: [{ id: 'session', window: '5h', remainingFraction: server.pid / 10 }] }] }
      );
    }
  });
  const service = await createService({ settingsPath: path.join(dir, 'settings.json'), providers: [provider] });
  discoveries = 0;
  calls = 0;
  await service.refresh();
  assert.deepEqual([discoveries, calls], [1, 8]);
  for (const measured of service.snapshot().providers[0]?.accounts ?? []) {
    const number = Number(measured.email?.match(/account(\d)/)?.[1]);
    assert.equal(measured.id, antigravityAccountId(`account${number}@example.com`));
    assert.equal(measured.windows[0]?.remainingPercent, number * 10);
  }
  await service.refresh();
  assert.deepEqual([discoveries, calls], [2, 16], 'a later refresh does not reuse identity or quota data');
});
