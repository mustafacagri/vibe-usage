import assert from 'node:assert/strict';
import test from 'node:test';
import { ProviderError } from '../src/core/errors.ts';
import { type GetJson, type GetJsonOptions, type RunProcess } from '../src/providers/common.ts';
import { createCopilotProvider, type CopilotProviderOptions } from '../src/providers/copilot.ts';
import { account } from './helpers/fixtures.ts';

const copilotAccount = account({ id: 'copilot:default', providerId: 'copilot' });
const RESET = '2026-11-01T00:00:00.000Z';
const present: CopilotProviderOptions['findBinary'] = () => Promise.resolve('/usr/bin/gh');
const absent: CopilotProviderOptions['findBinary'] = () => Promise.reject(new ProviderError('binary_missing'));

const snapshot = (id: string, fields: object) => ({
  quota_id: id,
  unlimited: false,
  has_quota: true,
  entitlement: 100,
  remaining: 100,
  percent_remaining: 100,
  ...fields
});

// What the service answers for a free plan and for a paid one, with the account's own details
// left out.
const FREE = {
  login: 'octo-user',
  access_type_sku: 'free_limited_copilot',
  copilot_plan: 'individual',
  quota_reset_date_utc: RESET,
  quota_snapshots: {
    chat: snapshot('chat', { entitlement: 200, remaining: 150, percent_remaining: 75 }),
    completions: snapshot('completions', { entitlement: 2000, remaining: 2000, percent_remaining: 100 }),
    premium_interactions: snapshot('premium_interactions', { entitlement: 0, remaining: 0, percent_remaining: 0, has_quota: false })
  }
};
const PAID = {
  login: 'octo-user',
  access_type_sku: 'copilot_pro_subscriber',
  copilot_plan: 'individual_pro',
  quota_reset_date_utc: RESET,
  quota_snapshots: {
    chat: snapshot('chat', { unlimited: true }),
    premium_interactions: snapshot('premium_interactions', { entitlement: 300, remaining: 120, percent_remaining: 40 })
  }
};

interface Call {
  endpoint: string;
  options: GetJsonOptions;
}

function provider(answer: unknown, extra: CopilotProviderOptions = {}, calls: Call[] = []) {
  const getJson: GetJson = (endpoint, options = {}) => {
    calls.push({ endpoint, options });
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  };
  return createCopilotProvider({ env: { GH_TOKEN: 'token-from-env' }, getJson, ...extra });
}

test('a free plan reports what is left of chat and completions; a quota it has none of is left out', async () => {
  const result = await provider(FREE).fetch(copilotAccount);
  assert.deepEqual(result.windows, [
    { id: 'chat', usedPercent: 25, remainingPercent: 75, resetsAt: RESET, labelKey: 'copilotChat' },
    { id: 'completions', usedPercent: 0, remainingPercent: 100, resetsAt: RESET, labelKey: 'copilotCompletions' }
  ]);
  assert.deepEqual([result.completeness, result.plan, result.signedInAs], ['complete', 'free', 'octo-user']);
});

test('a paid plan reports premium requests, and an unlimited quota is no limit', async () => {
  const result = await provider(PAID).fetch(copilotAccount);
  assert.deepEqual(result.windows, [
    { id: 'premium_interactions', usedPercent: 60, remainingPercent: 40, resetsAt: RESET, labelKey: 'copilotPremium' }
  ]);
  assert.equal(result.plan, 'individual_pro');
});

test('a quota the app has no name for is shown under the id the service gives it', async () => {
  const result = await provider({ ...PAID, quota_snapshots: { agent_runs: snapshot('agent_runs', { percent_remaining: 10 }) } }).fetch(
    copilotAccount
  );
  assert.deepEqual(result.windows, [{ id: 'agent_runs', usedPercent: 90, remainingPercent: 10, resetsAt: RESET, label: 'agent_runs' }]);
});

test('an account with nothing limited reports no limits, and an answer that is not a usage report is invalid', async () => {
  const none = await provider({ ...PAID, quota_snapshots: { chat: snapshot('chat', { unlimited: true }) } }).fetch(copilotAccount);
  assert.deepEqual([none.windows, none.status], [[], 'no_limits_reported']);
  for (const answer of ['text', {}, { quota_snapshots: 'x' }, { quota_snapshots: { chat: 7 } }])
    await assert.rejects(
      provider(answer).fetch(copilotAccount),
      (error: unknown) => error instanceof ProviderError && error.code === 'invalid_response'
    );
});

test('the token goes to the Copilot endpoint only, the environment first and the GitHub CLI otherwise', async () => {
  const calls: Call[] = [];
  await provider(FREE, {}, calls).fetch(copilotAccount);
  assert.deepEqual(
    calls.map(call => [call.endpoint, call.options.headers?.Authorization]),
    [['https://api.github.com/copilot_internal/user', 'token token-from-env']]
  );

  const ran: string[][] = [];
  const runProcess: RunProcess = (_binary, args) => {
    ran.push([...args]);
    return Promise.resolve('token-from-cli\n');
  };
  const viaCli: Call[] = [];
  await provider(FREE, { env: { GITHUB_TOKEN: '  ' }, runProcess, findBinary: present }, viaCli).fetch(copilotAccount);
  assert.deepEqual(ran, [['auth', 'token', '--hostname', 'github.com']]);
  assert.equal(viaCli[0]?.options.headers?.Authorization, 'token token-from-cli');
});

test('what stops a read is named: no GitHub CLI, no sign-in, a rejected token', async () => {
  const code = async (extra: CopilotProviderOptions, answer: unknown = FREE): Promise<unknown> =>
    provider(answer, extra)
      .fetch(copilotAccount)
      .then(
        () => null,
        (error: unknown) => (error instanceof ProviderError ? error.code : error)
      );
  assert.equal(await code({ env: {}, findBinary: absent }), 'binary_missing');
  const signedOut: RunProcess = () => Promise.reject(new ProviderError('process_failed'));
  assert.equal(await code({ env: {}, runProcess: signedOut, findBinary: present }), 'auth_missing');
  assert.equal(await code({}, new ProviderError('auth_rejected')), 'auth_rejected');
});

test('the account exists when a sign-in can be found: the environment or the GitHub CLI; otherwise none', async () => {
  const signedIn: RunProcess = () => Promise.resolve('token\n');
  const signedOut: RunProcess = () => Promise.reject(new ProviderError('process_failed'));
  const found = await provider(FREE).discover();
  assert.deepEqual(found, {
    kind: 'complete',
    accounts: [{ id: 'copilot:default', providerId: 'copilot', labelKey: 'defaultAccount', primary: true, enabled: true }]
  });
  assert.equal(
    ((await provider(FREE, { env: {}, runProcess: signedIn, findBinary: present }).discover()) as { accounts: unknown[] }).accounts.length,
    1
  );
  assert.deepEqual(await provider(FREE, { env: {}, runProcess: signedOut, findBinary: present }).discover(), {
    kind: 'complete',
    accounts: []
  });
  assert.deepEqual(await provider(FREE, { env: {}, findBinary: absent }).discover(), { kind: 'complete', accounts: [] });
  const timedOut: RunProcess = () => Promise.reject(new ProviderError('process_timeout'));
  assert.deepEqual(await provider(FREE, { env: {}, runProcess: timedOut, findBinary: present }).discover(), {
    kind: 'unknown',
    accounts: []
  });
});

test('a quota id that is a name every object has is still the service’s id, shown as it came', async () => {
  const result = await provider({ ...PAID, quota_snapshots: { constructor: snapshot('constructor', { percent_remaining: 10 }) } }).fetch(
    copilotAccount
  );
  assert.deepEqual(result.windows, [{ id: 'constructor', usedPercent: 90, remainingPercent: 10, resetsAt: RESET, label: 'constructor' }]);
});
