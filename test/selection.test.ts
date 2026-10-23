import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { loadClaudeSettingsFiles } from '../src/core/launch.ts';
import {
  chooseSuccessor,
  claudeLaunchWarnings,
  headroomPercent,
  isAccountEligible,
  QUOTA_FLOOR_PERCENT,
  selectAccount,
  selectProvider,
  tightestWindow,
  usableModel,
  type QuotaState
} from '../src/core/selection.ts';
import { PROVIDER_IDS, type ProviderId } from '../src/shared/catalog.ts';
import type { AccountStatus, MeasuredAccount, QuotaWindow } from '../src/shared/types.ts';
import { account, measuredAccount, quotaWindow, tempDir } from './helpers/fixtures.ts';

const NOW = Date.parse('2026-10-16T20:00:00Z');
const fresh = new Date(NOW - 60 * 1000).toISOString();
const general = (five: number | null, week: number | null): QuotaWindow[] => [
  quotaWindow({ id: 'five_hour', remainingPercent: five }),
  quotaWindow({ id: 'seven_day', remainingPercent: week })
];

function measured(
  windows: QuotaWindow[],
  { status = 'ok', fetchedAt = fresh }: { status?: AccountStatus; fetchedAt?: string } = {}
): MeasuredAccount {
  return measuredAccount({ status, fetchedAt, windows });
}

interface Fixture {
  id: string;
  providerId: ProviderId;
  primary: boolean;
  windows: QuotaWindow[];
}

function snapshot(fixtures: Fixture[], providerOrder: ProviderId[] = [...PROVIDER_IDS]): QuotaState {
  const accounts = fixtures.map(({ id, providerId, primary }) => account({ id, providerId, primary }));
  const providers = [...new Set(fixtures.map(f => f.providerId))].map(id => ({
    id,
    status: 'ok' as const,
    accounts: fixtures.filter(f => f.providerId === id).map(f => ({ ...measured(f.windows), id: f.id, providerId: id, primary: f.primary }))
  }));
  return { settings: { providerOrder, accounts }, providers };
}

test('eligibility needs a fresh, complete measurement above the floor', () => {
  const ok = measured(general(40, 60));
  const eligible = (a: MeasuredAccount): boolean => isAccountEligible(a, { now: NOW });
  assert.equal(eligible(ok), true);
  assert.equal(eligible({ ...ok, status: 'stale' }), false);
  assert.equal(eligible({ ...ok, fetchedAt: new Date(NOW - 10 * 60 * 1000).toISOString() }), false, 'too old');
  assert.equal(eligible({ ...ok, fetchedAt: new Date(NOW + 1).toISOString() }), false, 'a future reading is not fresh');
  assert.equal(eligible({ ...ok, fetchedAt: new Date(NOW).toISOString() }), true, 'a reading from now is fresh');
  assert.equal(eligible(measured(general(40, null))), false, 'unknown weekly');
  assert.equal(eligible(measured(general(QUOTA_FLOOR_PERCENT, 60))), false, 'at the floor');
  assert.equal(eligible(measured([])), false);
  assert.equal(eligible(measured([...general(40, 60), quotaWindow({ remainingPercent: 50, stale: true })])), false);
  assert.equal(isAccountEligible(null, { now: NOW }), false);
});

test('model scopes: an unknown scoped limit is never assumed available; `active` is a headline mark, not a limit', () => {
  const withScope = (scope: Partial<QuotaWindow>): MeasuredAccount => measured([...general(40, 60), quotaWindow({ id: 's', ...scope })]);
  assert.equal(isAccountEligible(measured(general(40, 60)), { model: 'fable', now: NOW }), false, 'Fable needs its own scope');
  // Claude reports its weekly rows inactive (not the headline) while they still bind.
  assert.equal(
    isAccountEligible(withScope({ scope: 'Fable', active: false, remainingPercent: 100 }), { model: 'fable', now: NOW }),
    true,
    'a scope reported inactive still says what is left'
  );
  assert.equal(isAccountEligible(withScope({ scope: 'Fable', active: false, remainingPercent: 0 }), { model: 'fable', now: NOW }), false);
  assert.equal(isAccountEligible(withScope({ scope: 'Sonnet', remainingPercent: 0 }), { now: NOW }), false, 'no model: every scope counts');
  assert.equal(
    isAccountEligible(withScope({ scope: 'Fable', active: false, remainingPercent: 0 }), { now: NOW }),
    false,
    'no model: a spent inactive scope counts too'
  );
  assert.equal(isAccountEligible(withScope({ scope: 'Sonnet', remainingPercent: null }), { model: 'custom-model', now: NOW }), false);
  assert.equal(
    isAccountEligible(withScope({ scope: 'Sonnet', remainingPercent: 0 }), { model: 'opus', now: NOW }),
    true,
    'other families do not matter'
  );
});

test('account selection prefers the primary, skips exhausted ones and honours an explicit choice', () => {
  const accounts = (primaryWindows: QuotaWindow[]): QuotaState =>
    snapshot([
      { id: 'claude:a', providerId: 'claude', primary: true, windows: primaryWindows },
      { id: 'claude:b', providerId: 'claude', primary: false, windows: general(30, 30) }
    ]);
  assert.equal(selectAccount(accounts(general(20, 40)), 'claude', { now: NOW })?.id, 'claude:a');
  assert.equal(selectAccount(accounts(general(0, 40)), 'claude', { now: NOW })?.id, 'claude:b');
  assert.equal(selectAccount(accounts(general(0, 40)), 'claude', { accountId: 'claude:a', now: NOW })?.id, 'claude:a');
  assert.throws(() => selectAccount(accounts(general(20, 40)), 'claude', { accountId: 'claude:x', now: NOW }), /account_not_found/);
  const exhausted = snapshot([{ id: 'claude:a', providerId: 'claude', primary: true, windows: general(0, 0) }]);
  assert.equal(selectAccount(exhausted, 'claude', { now: NOW }), null);
});

test('provider selection follows the user order and never fabricates quota', () => {
  const claude: Fixture = { id: 'claude:a', providerId: 'claude', primary: true, windows: general(45, 80) };
  const codex: Fixture = {
    id: 'codex:default',
    providerId: 'codex',
    primary: true,
    windows: [quotaWindow({ id: 'codex:primary', remainingPercent: 90 })]
  };
  const first = selectProvider(snapshot([claude, codex]), { now: NOW });
  assert.deepEqual([first.providerId, first.verified, first.isFallback, first.headroomPercent], ['claude', true, false, 45]);

  const userOrder = selectProvider(snapshot([claude, codex], ['codex', 'claude', 'cursor', 'antigravity']), { now: NOW });
  assert.deepEqual([userOrder.providerId, userOrder.isFallback], ['codex', false]);

  const exhausted = selectProvider(snapshot([{ ...claude, windows: general(0, 80) }, codex]), { now: NOW });
  assert.deepEqual([exhausted.providerId, exhausted.isFallback], ['codex', true]);

  // A provider that reads "ok" but has no measured account is not evidence of quota.
  const none = selectProvider(
    {
      settings: { providerOrder: ['cursor', 'claude'], accounts: [account({ id: 'cursor:default', providerId: 'cursor' })] },
      providers: [{ id: 'cursor', status: 'ok', accounts: [] }]
    },
    { now: NOW }
  );
  assert.deepEqual([none.providerId, none.verified, none.headroomPercent, none.account?.id], ['cursor', false, null, 'cursor:default']);

  assert.equal(selectProvider(snapshot([claude, codex], ['claude', 'codex']), { exclude: 'claude', now: NOW }).providerId, 'codex');
});

test('provider selection says why each tool ahead of the choice was passed over', () => {
  const order: ProviderId[] = ['claude', 'codex', 'cursor', 'antigravity', 'copilot'];
  const state = snapshot(
    [
      { id: 'claude:a', providerId: 'claude', primary: true, windows: [] },
      { id: 'codex:a', providerId: 'codex', primary: true, windows: general(3, 80) },
      { id: 'antigravity:a', providerId: 'antigravity', primary: true, windows: general(70, 70) }
    ],
    order
  );
  const claude = state.providers.find(p => p.id === 'claude')?.accounts[0];
  assert.ok(claude);
  Object.assign(claude, { status: 'auth_missing', messageCode: 'auth_missing' });
  const choice = selectProvider(state, { now: NOW });
  assert.deepEqual([choice.providerId, choice.isFallback], ['antigravity', true]);
  assert.deepEqual(choice.passedOver, [
    { providerId: 'claude', reason: { kind: 'status', code: 'auth_missing' } },
    { providerId: 'codex', reason: { kind: 'low', percent: 3 } },
    { providerId: 'cursor', reason: { kind: 'no_account' } }
  ]);

  // A reading older than a few minutes verifies nothing, so every tool is passed over.
  const old = new Date(NOW - 10 * 60 * 1000).toISOString();
  for (const provider of state.providers) for (const account of provider.accounts) if (account.status === 'ok') account.fetchedAt = old;
  const none = selectProvider(state, { now: NOW });
  assert.equal(none.verified, false);
  assert.deepEqual(
    none.passedOver.map(p => [p.providerId, p.reason.kind]),
    [
      ['claude', 'status'],
      ['codex', 'unverified'],
      ['cursor', 'no_account'],
      ['antigravity', 'unverified']
    ]
  );
});

test('headroom is the tightest relevant limit', () => {
  assert.equal(headroomPercent(measured([...general(45, 30), quotaWindow({ id: 's', scope: 'Opus', remainingPercent: 10 })])), 10);
  assert.equal(headroomPercent(measured([quotaWindow()])), null);
  assert.equal(tightestWindow(measured([...general(45, 30), quotaWindow({ id: 's', scope: 'Opus', remainingPercent: 10 })]))?.id, 's');
  assert.equal(tightestWindow(measured(general(30, 30)))?.id, 'five_hour', 'the first of equally tight windows');
});

test('Claude launch warnings flag credential overrides and unverified or exhausted quota', () => {
  const state = snapshot([{ id: 'claude:a', providerId: 'claude', primary: true, windows: general(50, 50) }]);
  const chosen = account({ id: 'claude:a' });
  assert.deepEqual(claudeLaunchWarnings(state, chosen, { settingsFiles: { 'p.json': {} }, now: NOW }), []);
  const keys = (files: Record<string, unknown>, model?: string, s = state): string[] =>
    claudeLaunchWarnings(s, chosen, { settingsFiles: files, model, now: NOW }).map(w => w.key);
  assert.deepEqual(keys({ 'p.json': { env: { ANTHROPIC_API_KEY: 'x' } } }), ['warnSettingsEnvOverride']);
  assert.deepEqual(keys({ 'p.json': { env: { UNRELATED: 'x' } }, 'u.json': { apiKeyHelper: '/bin/helper' } }), ['warnApiKeyHelper']);
  assert.deepEqual(keys({}, 'fable'), ['warnQuotaUnverified']);
  const exhausted = snapshot([{ id: 'claude:a', providerId: 'claude', primary: true, windows: general(0, 50) }]);
  assert.deepEqual(keys({}, undefined, exhausted), ['warnQuotaUnverified', 'warnQuotaExhausted']);
});

test('Claude settings files are read from disk and named for the warning', async t => {
  const projectDir = await tempDir(t, 'vibe-warn-proj-');
  const configDir = await tempDir(t, 'vibe-warn-cfg-');
  await fs.mkdir(path.join(projectDir, '.claude'));
  await fs.writeFile(path.join(projectDir, '.claude', 'settings.json'), JSON.stringify({ env: { AWS_ACCESS_KEY_ID: 'x' } }));
  await fs.writeFile(path.join(configDir, 'settings.json'), JSON.stringify({ apiKeyHelper: '/usr/local/bin/helper' }));
  const files = await loadClaudeSettingsFiles(projectDir, configDir);
  assert.deepEqual(files['.claude/settings.json'], { env: { AWS_ACCESS_KEY_ID: 'x' } });
  assert.equal(files['.claude/settings.local.json'], null);
  const state = snapshot([{ id: 'claude:a', providerId: 'claude', primary: true, windows: general(50, 50) }]);
  const warnings = claudeLaunchWarnings(state, account({ id: 'claude:a' }), { settingsFiles: files, now: NOW });
  assert.deepEqual(
    warnings.map(w => [w.key, w.params.file]),
    [
      ['warnSettingsEnvOverride', '.claude/settings.json'],
      ['warnApiKeyHelper', `${path.basename(configDir)}/settings.json`]
    ]
  );
});

test('a spent limit on part of the account stops only the models it covers; secondary totals never decide', () => {
  const cursor = (auto: number) =>
    measured([
      quotaWindow({ id: 'plan:auto', remainingPercent: auto }),
      quotaWindow({ id: 'plan:api', remainingPercent: 0, partial: true, except: ['auto'] }),
      quotaWindow({ id: 'plan:spend', remainingPercent: null, section: 'details' })
    ]);
  const eligible = (model?: string) => isAccountEligible(cursor(76), { now: NOW, model });
  assert.equal(eligible('auto'), true, 'Auto goes on with the API pool spent');
  assert.equal(eligible('AUTO'), true);
  assert.equal(eligible('gpt-5.6-sol'), false, 'an API-priced model is in the spent pool');
  assert.equal(eligible(), false, 'an unknown model may be one the pool covers');
  assert.deepEqual(usableModel(cursor(76), 'gpt-5.6-sol', NOW), { model: 'auto' }, 'Auto instead');
  assert.deepEqual(usableModel(cursor(76), undefined, NOW), { model: 'auto' });
  assert.equal(usableModel(cursor(3), 'gpt-5.6-sol', NOW), null, 'Auto itself spent');
  const unnamed = measured([
    quotaWindow({ id: 'plan:auto', remainingPercent: 76 }),
    quotaWindow({ id: 'plan:api', remainingPercent: 0, partial: true })
  ]);
  assert.equal(isAccountEligible(unnamed, { now: NOW, model: 'auto' }), false, 'a partial limit that names no models always counts');
});

test('choosing a tool with a spent partial pool moves to the model it does not cover, and says so', () => {
  const state = snapshot(
    [
      { id: 'claude:a', providerId: 'claude', primary: true, windows: general(0, 50) },
      {
        id: 'cursor:a',
        providerId: 'cursor',
        primary: true,
        windows: [
          quotaWindow({ id: 'plan:auto', remainingPercent: 76 }),
          quotaWindow({ id: 'plan:api', remainingPercent: 0, partial: true, except: ['auto'] })
        ]
      }
    ],
    ['claude', 'cursor', 'codex', 'antigravity']
  );
  const choice = selectProvider(state, { now: NOW, models: { cursor: 'gpt-5.6-sol' } });
  assert.deepEqual([choice.providerId, choice.model, choice.verified, choice.headroomPercent], ['cursor', 'auto', true, 76]);
  const claude = state.settings.accounts.find(a => a.id === 'claude:a');
  assert.ok(claude);
  assert.deepEqual(chooseSuccessor(state, claude, 'tools', { now: NOW, models: { cursor: 'gpt-5.6-sol' } }), {
    providerId: 'cursor',
    account: state.settings.accounts.find(a => a.id === 'cursor:a'),
    model: 'auto'
  });
  const planned = selectProvider(snapshot([{ id: 'codex:a', providerId: 'codex', primary: true, windows: general(60, 60) }]), {
    now: NOW,
    models: { codex: 'gpt-5.6-sol' }
  });
  assert.equal(planned.model, 'gpt-5.6-sol', 'a model with quota stays as planned');
});
