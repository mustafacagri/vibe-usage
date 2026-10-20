import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { ProviderError } from '../src/core/errors.ts';
import { loadMeasurements, measurementOf, saveMeasurements } from '../src/core/measurements.ts';
import { isAccountEligible } from '../src/core/selection.ts';
import { createService } from '../src/core/service.ts';
import type { FetchResult, ProviderAdapter } from '../src/providers/types.ts';
import { account, measuredAccount, quotaWindow, tempDir } from './helpers/fixtures.ts';

const NOW = Date.parse('2026-10-17T12:00:00.000Z');
const MINUTE = 60 * 1000;

function first<T>(items: readonly T[]): T {
  const [item] = items;
  assert.ok(item);
  return item;
}

test('saved readings are read back checked: unknown keys, old or future readings and junk are dropped', async t => {
  const file = path.join(await tempDir(t, 'vibe-measurements-'), 'measurements.json');
  const fresh = new Date(NOW - 5 * MINUTE).toISOString();
  await fs.writeFile(
    file,
    JSON.stringify({
      version: 1,
      accounts: {
        'claude:a': {
          configDir: 'C:\\profiles\\a',
          fetchedAt: fresh,
          plan: 'max',
          windows: [
            {
              id: 'five_hour',
              remainingPercent: 56,
              resetsAt: fresh,
              labelKey: 'labelNHours',
              labelParams: { n: 5 },
              durationMinutes: 300
            },
            { id: 'odd', remainingPercent: 10, labelKey: 'notAKey', detailKey: 'cursorApiLimitNote', partial: true },
            'junk'
          ]
        },
        'claude:old': { fetchedAt: new Date(NOW - 8 * 24 * 60 * MINUTE).toISOString(), windows: [{ id: 'w', remainingPercent: 1 }] },
        'claude:future': { fetchedAt: new Date(NOW + MINUTE).toISOString(), windows: [{ id: 'w', remainingPercent: 1 }] },
        'claude:empty': { fetchedAt: fresh, windows: ['junk'] },
        'claude:broken': 'nope'
      }
    })
  );
  const saved = await loadMeasurements(file, NOW);
  assert.deepEqual([...saved.keys()], ['claude:a']);
  assert.deepEqual(saved.get('claude:a'), {
    configDir: 'C:\\profiles\\a',
    fetchedAt: fresh,
    plan: 'max',
    windows: [
      {
        id: 'five_hour',
        usedPercent: 44,
        remainingPercent: 56,
        resetsAt: fresh,
        labelKey: 'labelNHours',
        labelParams: { n: 5 },
        durationMinutes: 300
      },
      { id: 'odd', usedPercent: 90, remainingPercent: 10, resetsAt: null, detailKey: 'cursorApiLimitNote', partial: true }
    ]
  });
  await fs.writeFile(file, '{ not json');
  assert.equal((await loadMeasurements(file, NOW)).size, 0);
  assert.equal((await loadMeasurements(path.join(path.dirname(file), 'missing.json'), NOW)).size, 0);
});

test('only a good reading is kept, without what was carried over or forecast', async t => {
  const reading = measuredAccount({
    id: 'claude:a',
    configDir: 'C:\\profiles\\a',
    status: 'ok',
    fetchedAt: new Date(NOW).toISOString(),
    signedInAs: 'me@example.com',
    email: 'private-account@example.com',
    windows: [
      quotaWindow({ id: 'five_hour', remainingPercent: 56, usedPercent: 44, exhaustsAt: new Date(NOW).toISOString() }),
      quotaWindow({ id: 'seven_day', remainingPercent: 34, usedPercent: 66, stale: true })
    ]
  });
  const kept = measurementOf(reading);
  assert.ok(kept);
  assert.deepEqual(
    kept.windows.map(w => w.id),
    ['five_hour']
  );
  assert.equal('exhaustsAt' in first(kept.windows), false);
  assert.equal(measurementOf({ ...reading, status: 'rate_limited' }), null);
  const file = path.join(await tempDir(t, 'vibe-measurements-save-'), 'measurements.json');
  await saveMeasurements(file, new Map([['claude:a', kept]]));
  const text = await fs.readFile(file, 'utf8');
  assert.ok(!text.includes('me@example.com'), 'no email on disk');
  assert.ok(!text.includes('private-account@example.com'), 'source binding adds no raw account email to disk');
  assert.match(kept.sourceKey ?? '', /^[a-f0-9]{64}$/);
  assert.deepEqual(
    (await loadMeasurements(file, NOW)).get('claude:a')?.windows.map(w => w.remainingPercent),
    [56]
  );
});

test('after a restart the last good reading shows as stale until a fresh one, and never counts as quota', async t => {
  const dir = await tempDir(t, 'vibe-measurements-service-');
  const settingsPath = path.join(dir, 'settings.json');
  const measurementsPath = path.join(dir, 'measurements.json');
  const configDir = path.resolve(dir, 'profile-a');
  const stored = {
    pinned: false,
    intervalSeconds: 120,
    accounts: [{ ...account({ id: 'claude:a', configDir, primary: true }), configDirExplicit: true }]
  };
  await fs.writeFile(settingsPath, JSON.stringify(stored));
  let result: () => Promise<FetchResult> = () => Promise.resolve({ windows: [{ id: 'five_hour', remainingPercent: 56 }] });
  const claude: ProviderAdapter = { id: 'claude', discover: () => Promise.resolve([]), fetch: () => result() };
  let now = NOW;
  const initial = await createService({ settingsPath, measurementsPath, providers: [claude], clock: () => now });
  await initial.refresh();
  const saved = JSON.parse(await fs.readFile(measurementsPath, 'utf8')) as { accounts: Record<string, unknown> };
  assert.ok(saved.accounts['claude:a'], 'kept after the read');

  now += 10 * MINUTE;
  result = () => Promise.reject(new ProviderError('rate_limited'));
  const restarted = await createService({ settingsPath, measurementsPath, providers: [claude], clock: () => now });
  const before = first(first(restarted.snapshot().providers).accounts);
  assert.equal(before.status, 'stale');
  assert.equal(first(before.windows).remainingPercent, 56);
  await restarted.refresh();
  const after = first(first(restarted.snapshot().providers).accounts);
  assert.equal(after.status, 'stale', 'still the last known reading');
  assert.equal(after.messageCode, 'rate_limited');
  assert.equal(first(after.windows).remainingPercent, 56);
  assert.equal(isAccountEligible(after, { now }), false, 'a remembered number is no quota to act on');

  const moved = { ...stored, accounts: [{ ...stored.accounts[0], configDir: path.resolve(dir, 'profile-b') }] };
  await fs.writeFile(settingsPath, JSON.stringify(moved));
  const otherFolder = await createService({ settingsPath, measurementsPath, providers: [claude], clock: () => now });
  assert.equal(first(first(otherFolder.snapshot().providers).accounts).status, 'pending', 'another folder is another account');
});

test('a legacy cached reading without source identity is not restored into an account', async t => {
  const dir = await tempDir(t, 'vibe-measurements-unbound-');
  const settingsPath = path.join(dir, 'settings.json');
  const measurementsPath = path.join(dir, 'measurements.json');
  await fs.writeFile(settingsPath, JSON.stringify({ pinned: false, intervalSeconds: 120, accounts: [account({ origin: 'user' })] }));
  await fs.writeFile(
    measurementsPath,
    JSON.stringify({
      version: 1,
      accounts: {
        'claude:a': { configDir: null, fetchedAt: new Date(NOW).toISOString(), windows: [{ id: 'five', remainingPercent: 91 }] }
      }
    })
  );
  const provider: ProviderAdapter = { id: 'claude', discover: () => Promise.resolve([]), fetch: () => Promise.resolve({ windows: [] }) };
  const service = await createService({ settingsPath, measurementsPath, providers: [provider], clock: () => NOW });
  assert.deepEqual(first(first(service.snapshot().providers).accounts).windows, []);
  assert.equal(first(first(service.snapshot().providers).accounts).status, 'pending');
});
