import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import type { ClientRequest, IncomingMessage } from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { cleanEnvironment } from '../src/core/environment.ts';
import { readClaudeKeychain } from '../src/providers/claude-keychain.ts';
import { createClaudeProvider, discoverClaudeAccounts, parseClaudeUsage, profileAccount } from '../src/providers/claude.ts';
import { parseCodexRateLimits } from '../src/providers/codex.ts';
import { getJson, runProcess, type QuotaEndpoint, type RunProcess } from '../src/providers/common.ts';
import { parseCursorUsage } from '../src/providers/cursor.ts';
import type { QuotaWindow } from '../src/shared/types.ts';
import { account, tempDir } from './helpers/fixtures.ts';

function find(windows: readonly QuotaWindow[], predicate: (window: QuotaWindow) => boolean): QuotaWindow {
  const window = windows.find(predicate);
  assert.ok(window, 'window present');
  return window;
}
const byId = (windows: readonly QuotaWindow[], id: string): QuotaWindow => find(windows, w => w.id === id);
const byScope = (windows: readonly QuotaWindow[], scope: string): QuotaWindow => find(windows, w => w.scope === scope);

test('Claude scoped identity survives reorder and partial response', () => {
  const row = (name: string) => ({ kind: 'weekly_scoped', percent: 20, scope: { model: { id: name.toLowerCase(), display_name: name } } });
  const first = parseClaudeUsage({ limits: [row('Fable'), row('Sonnet')] }).windows;
  const second = parseClaudeUsage({ limits: [row('Sonnet')] }).windows;
  assert.equal(byScope(first, 'Sonnet').id, byScope(second, 'Sonnet').id);
  assert.notEqual(byScope(first, 'Fable').id, byScope(second, 'Sonnet').id);
});

test('transport enforces the total deadline even while the response keeps sending data', async () => {
  let destroyed = false;
  let interval: NodeJS.Timeout | undefined;
  const requestImpl = (_url: URL, _options: unknown, callback: (response: IncomingMessage) => void): ClientRequest => {
    const request = Object.assign(new EventEmitter(), {
      destroy: () => {
        destroyed = true;
        clearInterval(interval);
      }
    });
    const response = Object.assign(new EventEmitter(), {
      statusCode: 200,
      headers: {},
      destroy: () => {
        clearInterval(interval);
      }
    });
    queueMicrotask(() => {
      callback(response as unknown as IncomingMessage);
      interval = setInterval(() => response.emit('data', Buffer.from(' ')), 5);
    });
    return request as unknown as ClientRequest;
  };
  await assert.rejects(getJson('https://api.anthropic.com/api/oauth/usage', { timeoutMs: 30, requestImpl }), /request_timeout/);
  assert.equal(destroyed, true);
});

test('Claude dynamic kinds and inactive Fable survive with missing weekly/reset unknown', () => {
  const { windows } = parseClaudeUsage({
    five_hour: { utilization: 90, resets_at: null },
    seven_day: null,
    limits: [
      { kind: 'session', percent: 90, resets_at: null },
      {
        kind: 'weekly_scoped',
        percent: 0,
        is_active: false,
        resets_at: '2026-10-18T13:00:00Z',
        scope: { model: { id: 'fable', display_name: 'Fable' } }
      },
      { kind: 'new_daily_scoped', percent: 25, scope: { model: { display_name: 'Future' } } }
    ]
  });
  const fable = byScope(windows, 'Fable');
  assert.equal(fable.active, false);
  assert.equal(fable.remainingPercent, 100);
  assert.equal(byId(windows, 'five_hour').resetsAt, null);
  assert.equal(byId(windows, 'seven_day').remainingPercent, null);
  assert.equal(byScope(windows, 'Future').remainingPercent, 75);
});

test('Codex rate limit buckets derive their duration from the source and prefer the map', () => {
  const { windows } = parseCodexRateLimits({
    rateLimitsByLimitId: {
      codex: {
        primary: { usedPercent: 53, windowDurationMins: 300, resetsAt: 1792150000 },
        secondary: { usedPercent: null, windowDurationMins: 10080, resetsAt: null }
      },
      special: { primary: { usedPercent: 25, windowDurationMins: 60 } }
    },
    rateLimits: { primary: { usedPercent: 99 } }
  });
  const [primary, secondary, special] = windows;
  assert.equal(windows.length, 3);
  assert.equal(primary?.remainingPercent, 47);
  assert.deepEqual([primary.labelKey, primary.labelParams], ['labelNHours', { n: 5 }]);
  assert.equal(secondary?.labelKey, 'labelWeekly');
  assert.equal(secondary.remainingPercent, null);
  assert.equal(secondary.resetsAt, null);
  assert.equal(special?.scope, 'special');
});

test('Cursor auto/api/total pools remain distinct and cents have units', () => {
  const value = parseCursorUsage({
    membershipType: 'pro',
    billingCycleEnd: '2026-11-07T20:30:22Z',
    individualUsage: {
      plan: {
        used: 2000,
        limit: 2000,
        remaining: 0,
        autoPercentUsed: 14.54,
        apiPercentUsed: 100,
        totalPercentUsed: 22.37,
        breakdown: { bonus: 9075 }
      },
      onDemand: { enabled: false, used: 0, limit: null, remaining: null }
    }
  });
  assert.equal(value.plan, 'pro');
  assert.deepEqual(
    value.windows.filter(w => /^plan:(auto|api|total)$/.test(w.id)).map(w => w.usedPercent),
    [14.54, 100, 22.37]
  );
  assert.deepEqual(byId(value.windows, 'plan:spend').amounts, { used: 2000, limit: 2000, remaining: 0, bonus: 9075 });
  const onDemand = byId(value.windows, 'individual:onDemand');
  assert.deepEqual([onDemand.remainingPercent, onDemand.valueKey, onDemand.amounts], [null, 'disabled', { used: 0 }]);
});

test('Claude discovery reads immediate legitimate credential roots, excludes backups and symlinks', async t => {
  const dir = await tempDir(t, 'vibe-discovery-');
  for (const name of ['.claude', '.claude-secondary', '.claude-backup', '.claude-empty', '.claude-work']) {
    await fs.mkdir(path.join(dir, name));
    if (name !== '.claude-empty')
      await fs.writeFile(path.join(dir, name, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'fixture-token' } }));
  }
  const accounts = await discoverClaudeAccounts({ home: dir, platform: 'win32' });
  assert.deepEqual(accounts.map(a => a.id).slice(0, 2), ['claude:default', 'claude:secondary']);
  assert.equal(accounts.length, 3);
});

test('transport rejects hosts that are not allow-listed and the process runner uses no shell', async () => {
  await assert.rejects(getJson('https://evil.example/usage' as QuotaEndpoint), /endpoint_not_allowed/);
  await assert.rejects(getJson('https://api.anthropic.com.evil.example/api/oauth/usage' as QuotaEndpoint), /endpoint_not_allowed/);
  await assert.rejects(runProcess('node -e something', []), /invalid_binary/);
});

test('Claude adapter passes the existing token only to the usage GET and never refreshes an expired one', async t => {
  const dir = await tempDir(t, 'vibe-claude-');
  const credential = path.join(dir, '.credentials.json');
  await fs.writeFile(
    credential,
    JSON.stringify({ claudeAiOauth: { accessToken: 'fixture-token', subscriptionType: 'team', expiresAt: 200000 } })
  );
  let calls = 0;
  const provider = createClaudeProvider({
    platform: 'win32',
    clock: () => 100000,
    getJson: (url, options) => {
      calls++;
      assert.equal(url, 'https://api.anthropic.com/api/oauth/usage');
      assert.equal(options?.headers?.Authorization, 'Bearer fixture-token');
      return Promise.resolve({ five_hour: { utilization: 10 } });
    }
  });
  const value = await provider.fetch(account({ configDir: dir }));
  assert.equal(value.plan, 'team');
  assert.equal(JSON.stringify(value).includes('fixture-token'), false);
  await fs.writeFile(credential, JSON.stringify({ claudeAiOauth: { accessToken: 'fixture-token', expiresAt: 1 } }));
  await assert.rejects(provider.fetch(account({ configDir: dir })), /auth_expired/);
  assert.equal(calls, 1);
});

test('empty responses are invalid while limit-free schemas report no limits', () => {
  assert.throws(() => parseCursorUsage({}), /invalid_response/);
  assert.throws(() => parseCodexRateLimits(null), /invalid_response/);
  assert.throws(() => parseCodexRateLimits({}), /invalid_response/);

  const cursorNoLimits = parseCursorUsage({ membershipType: 'enterprise', individualUsage: {} });
  assert.equal(cursorNoLimits.status, 'no_limits_reported');
  assert.equal(cursorNoLimits.windows.length, 0);

  const codexNoLimits = parseCodexRateLimits({ rateLimitsByLimitId: {} });
  assert.equal(codexNoLimits.status, 'no_limits_reported');
  assert.equal(codexNoLimits.windows.length, 0);
});

test('explicit config dirs keep distinct Keychain services', async () => {
  const services: (string | undefined)[] = [];
  const runProcess: RunProcess = (_binary, args) => {
    services.push(args[2]);
    return Promise.resolve(JSON.stringify({ claudeAiOauth: { accessToken: 'fixture' } }));
  };
  await readClaudeKeychain({ platform: 'darwin', configDir: '/Users/example/.claude', configDirExplicit: false, runProcess });
  assert.equal(services.at(-1), 'Claude Code-credentials', 'an unset default selects the plain service');
  await readClaudeKeychain({ platform: 'darwin', configDir: '/Users/example/.claude', configDirExplicit: true, runProcess });
  assert.equal(services.at(-1), 'Claude Code-credentials-402b469b', 'an explicit default selects a suffixed service');
});

test('cleanEnvironment keeps explicit overrides such as CODEX_HOME', () => {
  assert.equal(cleanEnvironment({ CODEX_HOME: '/explicit/path' }, 'win32', { CODEX_HOME: '/inherited/path' }).CODEX_HOME, '/explicit/path');
  assert.equal(cleanEnvironment({ CODEX_HOME: '/x' }).CODEX_HOME, '/x');
});

test('Claude profiles resolve to stable ids and names', () => {
  const home = '/fake/home/user';
  const defaultDir = path.join(home, '.claude');
  const fallback = profileAccount(defaultDir, defaultDir, false);
  assert.deepEqual(
    [fallback.id, fallback.labelKey, fallback.primary, fallback.configDirExplicit],
    ['claude:default', 'accountA', true, false]
  );
  assert.notEqual(
    profileAccount(defaultDir, defaultDir, true).id,
    'claude:default',
    'an explicit default dir is a different Keychain item'
  );
  const secondary = profileAccount(path.join(home, '.claude-secondary'), defaultDir, true);
  assert.deepEqual([secondary.id, secondary.labelKey, secondary.primary], ['claude:secondary', 'accountB', false]);
  const custom = profileAccount(path.join(home, 'my-claude-profile'), defaultDir, true);
  assert.match(custom.id, /^claude:[0-9a-f]{12}$/);
  assert.equal(custom.label, 'my-claude-profile');
  assert.equal(profileAccount(path.join(home, '.claude-work'), defaultDir, true).label, 'work');
  assert.equal(profileAccount('/', defaultDir, true).label, '/', 'a folder without a name is shown by its path');
});

test('provider data is language-neutral', () => {
  const cursor = parseCursorUsage({
    individualUsage: { plan: { autoPercentUsed: 50, apiPercentUsed: 0, totalPercentUsed: 25, used: 750, limit: 2000, remaining: 1250 } },
    teamUsage: { onDemand: { enabled: false } }
  }).windows;
  assert.equal(byId(cursor, 'plan:auto').labelKey, 'labelAutoScope');
  assert.deepEqual([byId(cursor, 'plan:api').labelKey, byId(cursor, 'plan:api').detailKey], ['labelApiScope', 'cursorApiLimitNote']);
  const spend = byId(cursor, 'plan:spend');
  assert.deepEqual(spend.amounts, { used: 750, limit: 2000, remaining: 1250 });
  assert.equal(spend.valueKey, undefined, 'the UI words the remaining amount itself');
  const team = byId(cursor, 'team:onDemand');
  assert.deepEqual([team.group, team.labelKey, team.valueKey], ['team', 'labelOnDemandSpend', 'disabled']);

  const [fiveHours] = parseCodexRateLimits({
    rateLimits: { primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 1780000000 } }
  }).windows;
  assert.deepEqual([fiveHours?.labelKey, fiveHours?.labelParams, fiveHours?.durationMinutes], ['labelNHours', { n: 5 }, 300]);
  const [month] = parseCodexRateLimits({
    rateLimits: { primary: { usedPercent: 11, windowDurationMins: 43200, resetsAt: 1780000000 } }
  }).windows;
  assert.deepEqual([month?.labelKey, month?.labelParams], ['labelNDays', { n: 30 }]);
});
