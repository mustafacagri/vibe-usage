'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  isAccountEligible,
  headroomPercent,
  selectAccount,
  selectProvider,
  claudeLaunchWarnings,
  QUOTA_FLOOR_PERCENT
} = require('../src/core/selection.cjs');
const { loadClaudeSettingsFiles } = require('../src/core/launch.cjs');

const NOW = Date.parse('2026-10-16T20:00:00Z');
const fresh = new Date(NOW - 60 * 1000).toISOString();
const general = (five, week) => [
  { id: 'five_hour', remainingPercent: five },
  { id: 'seven_day', remainingPercent: week }
];

function measured(id, windows, { status = 'ok', fetchedAt = fresh } = {}) {
  return { id, status, fetchedAt, windows };
}

// accounts: [{ id, providerId, primary, windows, status?, fetchedAt? }]
function snapshot(accounts, providerOrder) {
  const byProvider = new Map();
  for (const a of accounts) byProvider.set(a.providerId, [...(byProvider.get(a.providerId) || []), measured(a.id, a.windows, a)]);
  return {
    settings: { providerOrder, accounts: accounts.map(({ id, providerId, primary }) => ({ id, providerId, primary, enabled: true })) },
    providers: [...byProvider].map(([id, list]) => ({ id, accounts: list }))
  };
}

test('eligibility needs a fresh, complete measurement above the floor', () => {
  const ok = measured('a', general(40, 60));
  assert.equal(isAccountEligible(ok, { now: NOW }), true);
  assert.equal(isAccountEligible({ ...ok, status: 'stale' }, { now: NOW }), false);
  assert.equal(isAccountEligible({ ...ok, fetchedAt: new Date(NOW - 10 * 60 * 1000).toISOString() }, { now: NOW }), false, 'too old');
  assert.equal(isAccountEligible(measured('a', general(40, null)), { now: NOW }), false, 'unknown weekly');
  assert.equal(isAccountEligible(measured('a', general(QUOTA_FLOOR_PERCENT, 60)), { now: NOW }), false, 'at the floor');
  assert.equal(isAccountEligible(measured('a', []), { now: NOW }), false);
  assert.equal(isAccountEligible(measured('a', [...general(40, 60), { id: 'w', remainingPercent: 50, stale: true }]), { now: NOW }), false);
});

test('model scopes: unknown or inactive scoped limits are never assumed available', () => {
  const withScope = scope => measured('a', [...general(40, 60), scope]);
  assert.equal(isAccountEligible(measured('a', general(40, 60)), { model: 'fable', now: NOW }), false, 'Fable needs its own scope');
  assert.equal(
    isAccountEligible(withScope({ id: 's', scope: 'Fable', active: false, remainingPercent: 100 }), { model: 'fable', now: NOW }),
    false
  );
  assert.equal(
    isAccountEligible(withScope({ id: 's', scope: 'Sonnet', remainingPercent: 0 }), { now: NOW }),
    false,
    'no model: every scope counts'
  );
  assert.equal(
    isAccountEligible(withScope({ id: 's', scope: 'Sonnet', remainingPercent: null }), { model: 'custom-model', now: NOW }),
    false
  );
  assert.equal(
    isAccountEligible(withScope({ id: 's', scope: 'Sonnet', remainingPercent: 0 }), { model: 'opus', now: NOW }),
    true,
    'other families do not matter'
  );
});

test('account selection prefers the primary, skips exhausted ones and honours an explicit choice', () => {
  const accounts = primaryWindows =>
    snapshot([
      { id: 'claude:a', providerId: 'claude', primary: true, windows: primaryWindows },
      { id: 'claude:b', providerId: 'claude', primary: false, windows: general(30, 30) }
    ]);
  assert.equal(selectAccount(accounts(general(20, 40)), 'claude', { now: NOW }).id, 'claude:a');
  assert.equal(selectAccount(accounts(general(0, 40)), 'claude', { now: NOW }).id, 'claude:b');
  assert.equal(selectAccount(accounts(general(0, 40)), 'claude', { accountId: 'claude:a', now: NOW }).id, 'claude:a');
  assert.throws(() => selectAccount(accounts(general(20, 40)), 'claude', { accountId: 'claude:x', now: NOW }), /account_not_found/);
  assert.equal(
    selectAccount(snapshot([{ id: 'claude:a', providerId: 'claude', primary: true, windows: general(0, 0) }]), 'claude', { now: NOW }),
    null
  );
});

test('provider selection follows the user order and never fabricates quota', () => {
  const accounts = [
    { id: 'claude:a', providerId: 'claude', primary: true, windows: general(45, 80) },
    { id: 'codex:default', providerId: 'codex', primary: true, windows: [{ id: 'codex:primary', remainingPercent: 90 }] }
  ];
  const first = selectProvider(snapshot(accounts, ['claude', 'codex', 'cursor', 'antigravity']), { now: NOW });
  assert.deepEqual([first.providerId, first.verified, first.isFallback, first.headroomPercent], ['claude', true, false, 45]);

  const userOrder = selectProvider(snapshot(accounts, ['codex', 'claude', 'cursor', 'antigravity']), { now: NOW });
  assert.deepEqual([userOrder.providerId, userOrder.isFallback], ['codex', false]);

  const exhausted = selectProvider(
    snapshot([{ ...accounts[0], windows: general(0, 80) }, accounts[1]], ['claude', 'codex', 'cursor', 'antigravity']),
    { now: NOW }
  );
  assert.deepEqual([exhausted.providerId, exhausted.isFallback], ['codex', true]);

  // A provider that reads "ok" but has no measured account is not evidence of quota.
  const none = selectProvider(
    {
      settings: {
        providerOrder: ['cursor', 'claude'],
        accounts: [{ id: 'cursor:default', providerId: 'cursor', primary: true, enabled: true }]
      },
      providers: [{ id: 'cursor', status: 'ok', accounts: [] }]
    },
    { now: NOW }
  );
  assert.deepEqual([none.providerId, none.verified, none.headroomPercent, none.account.id], ['cursor', false, null, 'cursor:default']);

  assert.equal(selectProvider(snapshot(accounts, ['claude', 'codex']), { exclude: 'claude', now: NOW }).providerId, 'codex');
});

test('headroom is the tightest relevant limit', () => {
  assert.equal(headroomPercent(measured('a', [...general(45, 30), { id: 's', scope: 'Opus', remainingPercent: 10 }])), 10);
  assert.equal(headroomPercent(measured('a', [{ id: 'w', remainingPercent: null }])), null);
});

test('Claude launch warnings flag credential overrides and unverified or exhausted quota', () => {
  const state = snapshot([{ id: 'claude:a', providerId: 'claude', primary: true, windows: general(50, 50) }]);
  const account = state.settings.accounts[0];
  assert.deepEqual(claudeLaunchWarnings(state, account, { settingsFiles: { 'p.json': {} }, now: NOW }), []);
  const keys = (files, model, s = state) => claudeLaunchWarnings(s, account, { settingsFiles: files, model, now: NOW }).map(w => w.key);
  assert.deepEqual(keys({ 'p.json': { env: { ANTHROPIC_API_KEY: 'x' } } }), ['warnSettingsEnvOverride']);
  assert.deepEqual(keys({ 'p.json': { env: { UNRELATED: 'x' } }, 'u.json': { apiKeyHelper: '/bin/helper' } }), ['warnApiKeyHelper']);
  assert.deepEqual(keys({}, 'fable'), ['warnQuotaUnverified']);
  const exhausted = snapshot([{ id: 'claude:a', providerId: 'claude', primary: true, windows: general(0, 50) }]);
  assert.deepEqual(keys({}, undefined, exhausted), ['warnQuotaUnverified', 'warnQuotaExhausted']);
});

test('Claude settings files are read from disk and named for the warning', async t => {
  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-warn-proj-'));
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-warn-cfg-'));
  t.after(() => Promise.all([projectDir, configDir].map(d => fs.rm(d, { recursive: true, force: true }))));
  await fs.mkdir(path.join(projectDir, '.claude'));
  await fs.writeFile(path.join(projectDir, '.claude', 'settings.json'), JSON.stringify({ env: { AWS_ACCESS_KEY_ID: 'x' } }));
  await fs.writeFile(path.join(configDir, 'settings.json'), JSON.stringify({ apiKeyHelper: '/usr/local/bin/helper' }));
  const files = await loadClaudeSettingsFiles(projectDir, configDir);
  assert.equal(files['.claude/settings.json'].env.AWS_ACCESS_KEY_ID, 'x');
  assert.equal(files['.claude/settings.local.json'], null);
  const state = snapshot([{ id: 'claude:a', providerId: 'claude', primary: true, windows: general(50, 50) }]);
  const warnings = claudeLaunchWarnings(state, state.settings.accounts[0], { settingsFiles: files, now: NOW });
  assert.deepEqual(
    warnings.map(w => [w.key, w.params.file]),
    [
      ['warnSettingsEnvOverride', '.claude/settings.json'],
      ['warnApiKeyHelper', path.join(path.basename(configDir), 'settings.json')]
    ]
  );
});
