import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { defaultSettings } from '../src/core/settings.ts';
import { createHistory, forecastExhaustion, HISTORY_RETENTION_MS, type Sample } from '../src/core/history.ts';
import type { MeasuredAccount, Snapshot } from '../src/shared/types.ts';
import { measuredAccount, quotaWindow, tempDir } from './helpers/fixtures.ts';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const NOW = Date.parse('2026-10-17T12:00:00.000Z');

const fiveHour = (used: number, resetsInMs = 3 * HOUR) =>
  quotaWindow({ id: 'five_hour', usedPercent: used, remainingPercent: 100 - used, resetsAt: new Date(NOW + resetsInMs).toISOString() });

function snapshot(accounts: MeasuredAccount[]): Snapshot {
  return { refreshing: false, settings: defaultSettings(), providers: [{ id: 'claude', status: 'ok', accounts }] };
}

test('the forecast follows the pace of the last hour and stays quiet when the window resets first', () => {
  // 10 points in the last 30 minutes: 60 more points take 3 hours, after the reset in 3 hours.
  const slow: Sample[] = [[NOW - 30 * MINUTE, 30]];
  assert.equal(forecastExhaustion(slow, fiveHour(40), NOW), null);
  // 30 points in 30 minutes: the remaining 40 run out in 40 minutes, before the reset.
  const fast: Sample[] = [[NOW - 30 * MINUTE, 30]];
  assert.equal(forecastExhaustion(fast, fiveHour(60), NOW), NOW + 40 * MINUTE);
  // Readings before the last reset (the drop from 90 to 5) do not count.
  const reset: Sample[] = [
    [NOW - 4 * HOUR, 80],
    [NOW - 3 * HOUR, 90],
    [NOW - 30 * MINUTE, 5]
  ];
  assert.equal(forecastExhaustion(reset, fiveHour(35), NOW), NOW + 65 * MINUTE);
  // Too little to tell, no growth, nothing left, or no percentage at all: no forecast.
  assert.equal(forecastExhaustion([[NOW - 2 * MINUTE, 10]], fiveHour(50), NOW), null);
  assert.equal(forecastExhaustion([[NOW - HOUR, 50]], fiveHour(50), NOW), null);
  assert.equal(forecastExhaustion([[NOW - HOUR, 50]], fiveHour(100), NOW), null);
  assert.equal(forecastExhaustion([[NOW - HOUR, 50]], { ...fiveHour(60), stale: true }, NOW), null);
});

test('history keeps changed readings, survives a restart and forgets what is older than a week', async t => {
  const dataDir = await tempDir(t, 'vibe-history-');
  let now = NOW - 30 * MINUTE;
  const clock = () => now;
  const history = await createHistory({ dataDir, clock });
  const reading = (used: number) =>
    snapshot([measuredAccount({ id: 'claude:a', fetchedAt: new Date(now).toISOString(), windows: [fiveHour(used)] })]);
  history.record(reading(30));
  now += MINUTE;
  history.record(reading(30));
  history.record(snapshot([measuredAccount({ id: 'claude:x', status: 'auth_expired', windows: [fiveHour(10)] })]));
  now = NOW;
  history.record(reading(60));
  assert.deepEqual(history.series(['claude:a', 'claude:x']), [
    {
      accountId: 'claude:a',
      windowId: 'five_hour',
      samples: [
        [NOW - 30 * MINUTE, 30],
        [NOW, 60]
      ]
    }
  ]);

  const annotated = history.annotate(reading(60));
  assert.equal(annotated.providers[0]?.accounts[0]?.windows[0]?.exhaustsAt, new Date(NOW + 40 * MINUTE).toISOString());

  await history.flush();
  const stored = JSON.parse(await fs.readFile(path.join(dataDir, 'history.json'), 'utf8')) as unknown;
  assert.equal(JSON.stringify(stored).includes('claude:a'), true);
  now = NOW + HISTORY_RETENTION_MS + 20 * MINUTE;
  assert.deepEqual((await createHistory({ dataDir, clock })).series(['claude:a']), [], 'a week later it is gone');
});

test('an unreadable history file starts an empty history', async t => {
  const dataDir = await tempDir(t, 'vibe-history-');
  await fs.writeFile(path.join(dataDir, 'history.json'), '{ not json');
  assert.deepEqual((await createHistory({ dataDir })).series(['claude:a']), []);
  await fs.writeFile(
    path.join(dataDir, 'history.json'),
    JSON.stringify({
      accounts: {
        'claude:a': {
          w: [
            ['x', 1],
            [1, 2, 3]
          ]
        }
      }
    })
  );
  assert.deepEqual((await createHistory({ dataDir })).series(['claude:a']), []);
});

test('Codex aliases share one forecast and a replacement login does not inherit it', async t => {
  const history = await createHistory({ dataDir: await tempDir(t, 'vibe-codex-history-'), clock: () => NOW });
  const codex = (id: string, key: string, used: number, time: number) =>
    measuredAccount({ providerId: 'codex', id, accountKey: key, fetchedAt: new Date(time).toISOString(), windows: [fiveHour(used)] });
  history.record(snapshot([codex('codex:default', 'old', 30, NOW - 30 * MINUTE)]));
  const aliases = [codex('codex:default', 'old', 60, NOW), codex('codex:2', 'old', 60, NOW)];
  const forecast = history.annotate(snapshot(aliases)).providers[0]?.accounts.map(a => a.windows[0]?.exhaustsAt);
  assert.deepEqual(forecast, [new Date(NOW + 40 * MINUTE).toISOString(), new Date(NOW + 40 * MINUTE).toISOString()]);
  const replacement = codex('codex:default', 'new', 60, NOW);
  assert.equal(history.annotate(snapshot([replacement])).providers[0]?.accounts[0]?.windows[0]?.exhaustsAt, undefined);
  assert.deepEqual(history.series([replacement.id], [replacement]), []);
});
