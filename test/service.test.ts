import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { ProviderError } from '../src/core/errors.ts';
import { createService, type Service } from '../src/core/service.ts';
import { antigravityAccountId, createAntigravityProvider, type LanguageServer } from '../src/providers/antigravity.ts';
import { createClaudeProvider } from '../src/providers/claude.ts';
import type { Clock } from '../src/providers/common.ts';
import type { DiscoveredAccount, FetchResult, ProviderAdapter } from '../src/providers/types.ts';
import type { ProviderId } from '../src/shared/catalog.ts';
import type { Account, MeasuredAccount } from '../src/shared/types.ts';
import { account, tempDir } from './helpers/fixtures.ts';

const window = (id: string, fields: { remainingPercent?: number; usedPercent?: number } = {}) => ({ id, ...fields });
const healthy = (): Promise<FetchResult> => Promise.resolve({ windows: [window('5h', { remainingPercent: 90 })] });

function adapter(
  id: ProviderId,
  discover: () => DiscoveredAccount[] | Promise<DiscoveredAccount[]>,
  fetch: (account: Account) => Promise<FetchResult> = healthy
): ProviderAdapter {
  return { id, discover: async () => discover(), fetch };
}

const found = (id: string, fields: Partial<DiscoveredAccount> = {}): DiscoveredAccount =>
  account({ id, providerId: 'claude', label: id, primary: false, ...fields });

interface Setup {
  providers: ProviderAdapter[];
  stored?: object;
  clock?: Clock;
  file?: string;
}

async function start(
  t: TestContext,
  { providers, stored, clock, file = 'settings.json' }: Setup
): Promise<{ service: Service; settingsPath: string }> {
  const settingsPath = path.join(await tempDir(t, 'vibe-service-'), file);
  if (stored) await fs.writeFile(settingsPath, JSON.stringify({ pinned: false, intervalSeconds: 120, ...stored }));
  return { service: await createService({ settingsPath, providers, ...(clock ? { clock } : {}) }), settingsPath };
}

const ids = (service: Service): string[] => service.snapshot().settings.accounts.map(a => a.id);
const settingsAccount = (service: Service, id: string): Account | undefined => service.snapshot().settings.accounts.find(a => a.id === id);
function measured(service: Service, providerId: ProviderId, index = 0): MeasuredAccount {
  const result = service.snapshot().providers.find(p => p.id === providerId)?.accounts[index];
  assert.ok(result, `${providerId} account ${index} measured`);
  return result;
}
async function discoverTimes(service: Service, times: number): Promise<void> {
  for (let i = 0; i < times; i++) await service.reconcileDiscovery();
}

test('a single-provider refresh never makes a concurrent full refresh skip providers', async t => {
  const fetched = new Set<ProviderId>();
  const { service } = await start(t, {
    providers: [
      adapter(
        'claude',
        () => [found('claude:default', { primary: true })],
        async () => {
          await new Promise(resolve => setTimeout(resolve, 20));
          fetched.add('claude');
          return { windows: [window('five_hour', { remainingPercent: 80 })] };
        }
      ),
      adapter(
        'codex',
        () => [found('codex:default', { providerId: 'codex', primary: true })],
        () => {
          fetched.add('codex');
          return Promise.resolve({ windows: [window('primary', { remainingPercent: 70 })] });
        }
      )
    ]
  });
  await Promise.all([service.refresh('claude'), service.refresh()]);
  assert.deepEqual([...fetched].sort(), ['claude', 'codex']);
  assert.equal(measured(service, 'codex').status, 'ok');
  assert.equal(measured(service, 'claude').status, 'ok');
});

test('discovery adds new profiles and removes a vanished one only after repeated misses', async t => {
  let discovered = [found('claude:default', { primary: true }), found('claude:secondary')];
  const { service } = await start(t, { providers: [adapter('claude', () => discovered)] });
  assert.equal(ids(service).length, 2);
  discovered = [found('claude:default', { primary: true })];
  await discoverTimes(service, 2);
  assert.equal(ids(service).length, 2, 'two misses keep the account');
  await service.reconcileDiscovery();
  assert.deepEqual(ids(service), ['claude:default']);
});

test('provider-scoped generations keep concurrent refresh results', async t => {
  const claude = Promise.withResolvers<FetchResult>();
  const codex = Promise.withResolvers<FetchResult>();
  const { service } = await start(t, {
    providers: [
      adapter(
        'claude',
        () => [found('claude:default', { primary: true })],
        () => claude.promise
      ),
      adapter(
        'codex',
        () => [found('codex:default', { providerId: 'codex', primary: true })],
        () => codex.promise
      )
    ]
  });
  const claudeRefresh = service.refresh('claude');
  const codexRefresh = service.refresh('codex');
  claude.resolve({ windows: [window('five_hour', { remainingPercent: 88 })] });
  await claudeRefresh;
  assert.deepEqual([measured(service, 'claude').status, measured(service, 'claude').windows[0]?.remainingPercent], ['ok', 88]);
  codex.resolve({ windows: [window('primary', { remainingPercent: 72 })] });
  await codexRefresh;
  assert.deepEqual([measured(service, 'codex').status, measured(service, 'codex').windows[0]?.remainingPercent], ['ok', 72]);
});

test('a fetch finishing after the account was removed does not resurrect it', async t => {
  const reads = new Map([
    ['claude:a', Promise.withResolvers<FetchResult>()],
    ['claude:b', Promise.withResolvers<FetchResult>()]
  ]);
  const a = found('claude:a', { configDir: '/dir/a', primary: true });
  const { service } = await start(t, {
    providers: [
      adapter(
        'claude',
        () => [a, found('claude:b', { configDir: '/dir/b' })],
        target => reads.get(target.id)?.promise ?? Promise.reject(new Error('unknown'))
      )
    ]
  });
  const refresh = service.refresh('claude');
  await service.updateSettings({ accounts: [a] });
  assert.deepEqual(ids(service), ['claude:a']);
  reads.get('claude:a')?.resolve({ windows: [window('five_hour', { remainingPercent: 95 })] });
  reads.get('claude:b')?.resolve({ windows: [window('five_hour', { remainingPercent: 10 })] });
  await refresh;
  assert.deepEqual(ids(service), ['claude:a']);
  const accounts = service.snapshot().providers.find(p => p.id === 'claude')?.accounts ?? [];
  assert.deepEqual(
    accounts.map(m => [m.id, m.status]),
    [['claude:a', 'ok']]
  );
});

test('failed discovery never counts as a miss and keeps user customizations', async t => {
  let failing = false;
  let discovered = [found('claude:a', { primary: true }), found('claude:b')];
  const { service } = await start(t, {
    providers: [
      adapter('claude', () => {
        if (failing) throw new Error('EACCES: keychain locked');
        return discovered;
      })
    ]
  });
  await service.updateSettings({ accounts: [found('claude:a', { primary: true }), found('claude:b', { label: 'Custom User Label B' })] });
  assert.equal(settingsAccount(service, 'claude:b')?.origin, 'user', 'renaming makes an account user-managed');

  failing = true;
  await discoverTimes(service, 5);
  assert.equal(ids(service).length, 2, 'failed discoveries delete nothing');

  failing = false;
  discovered = [];
  await discoverTimes(service, 2);
  assert.equal(ids(service).length, 2);
  await service.reconcileDiscovery();
  assert.deepEqual(ids(service), ['claude:b'], 'only the untouched discovered account goes');
  assert.equal(settingsAccount(service, 'claude:b')?.label, 'Custom User Label B');
});

test('quota monitoring writes nothing to provider files', async t => {
  const writes: string[] = [];
  t.mock.method(fs, 'writeFile', (file: string) => {
    writes.push(file);
    return Promise.resolve();
  });
  t.mock.method(fs, 'appendFile', (file: string) => {
    writes.push(file);
    return Promise.resolve();
  });
  const provider = createClaudeProvider({
    platform: 'darwin',
    readCredentials: () => Promise.resolve({ claudeAiOauth: { accessToken: 'mock-token', expiresAt: Date.now() + 3600000 } }),
    getJson: () => Promise.resolve({ five_hour: { utilization: 10 } })
  });
  const result = await provider.fetch(account({ id: 'claude:default', configDir: '/tmp/.claude' }));
  assert.equal(result.windows.length, 2);
  assert.deepEqual(writes, []);
});

test('a closed Antigravity app never deletes its account', async t => {
  let running = true;
  const { service } = await start(t, {
    providers: [
      adapter('antigravity', () => {
        if (!running) throw new ProviderError('app_closed');
        return [found('antigravity:a1b2', { providerId: 'antigravity', label: 'work@corp.com', email: 'work@corp.com', primary: true })];
      })
    ]
  });
  assert.deepEqual(ids(service), ['antigravity:a1b2']);
  running = false;
  await discoverTimes(service, 5);
  assert.deepEqual(ids(service), ['antigravity:a1b2']);
});

test('discovery and settings updates are serialized and dismissals hold', async t => {
  const { service } = await start(t, { providers: [adapter('claude', () => [found('claude:a', { primary: true }), found('claude:b')])] });
  await Promise.all([service.dismissAccount('claude:b'), service.reconcileDiscovery()]);
  assert.deepEqual(ids(service), ['claude:a']);
  assert.ok(service.snapshot().settings.dismissedAccountIds.includes('claude:b'));
  await service.reconcileDiscovery();
  assert.deepEqual(ids(service), ['claude:a'], 'a dismissed account is not discovered again');
});

test('user-managed and disabled accounts survive restarts and discovery', async t => {
  let discovered = [found('claude:a', { primary: true }), found('claude:b')];
  const provider = adapter('claude', () => discovered);
  const { service, settingsPath } = await start(t, { providers: [provider] });
  await service.updateSettings({
    accounts: [found('claude:a', { primary: true }), found('claude:b', { label: 'My Disabled Account B', enabled: false })]
  });
  assert.deepEqual([settingsAccount(service, 'claude:b')?.origin, settingsAccount(service, 'claude:b')?.enabled], ['user', false]);

  discovered = [];
  const restarted = await createService({ settingsPath, providers: [provider] });
  const b = settingsAccount(restarted, 'claude:b');
  assert.deepEqual([b?.origin, b?.enabled, b?.label], ['user', false, 'My Disabled Account B']);
  await discoverTimes(restarted, 3);
  assert.deepEqual(ids(restarted), ['claude:b']);
});

test('the legacy single Antigravity account migrates to its e-mail account', async t => {
  const targetId = antigravityAccountId('dev@company.com');
  const { service } = await start(t, {
    stored: {
      intervalSeconds: 60,
      accounts: [
        { id: 'antigravity:current', providerId: 'antigravity', label: 'My Work Antigravity', origin: 'user', primary: true, enabled: true }
      ]
    },
    providers: [
      adapter('antigravity', () => [found(targetId, { providerId: 'antigravity', email: 'dev@company.com', label: 'dev@company.com' })])
    ]
  });
  const migrated = service.snapshot().settings.accounts;
  assert.equal(migrated.length, 1);
  assert.deepEqual(migrated[0], {
    id: targetId,
    providerId: 'antigravity',
    label: 'My Work Antigravity',
    email: 'dev@company.com',
    origin: 'user',
    primary: true,
    enabled: true
  });
  await service.reconcileDiscovery();
  assert.deepEqual(ids(service), [targetId]);
  assert.equal(settingsAccount(service, targetId)?.label, 'My Work Antigravity', 'a name the user typed is kept');
});

test('dismissed accounts stay dismissed across restarts', async t => {
  const provider = adapter('claude', () => [found('claude:acc1', { primary: true }), found('claude:acc2')]);
  const { service, settingsPath } = await start(t, { providers: [provider] });
  await service.dismissAccount('claude:acc2');
  assert.deepEqual(ids(service), ['claude:acc1']);
  const restarted = await createService({ settingsPath, providers: [provider] });
  assert.deepEqual(ids(restarted), ['claude:acc1']);
  assert.ok(restarted.snapshot().settings.dismissedAccountIds.includes('claude:acc2'));
  await discoverTimes(restarted, 3);
  assert.deepEqual(ids(restarted), ['claude:acc1']);
});

test('e-mail addresses with plus signs and long addresses are accepted', async t => {
  const plusEmail = 'user+tag@domain.com';
  const longEmail =
    'extremely.long.corporate.work.user.email.address.that.exceeds.sixty.seven.characters@very.long.subdomain.enterprise.company.com';
  const emails: Record<number, string> = { 701: plusEmail, 702: longEmail };
  const servers: LanguageServer[] = [
    { pid: 701, csrfToken: 'tok1', ports: [7101], sourceKind: 'ide' },
    { pid: 702, csrfToken: 'tok2', ports: [7102], sourceKind: 'app' }
  ];
  const provider = createAntigravityProvider({
    platform: 'darwin',
    discoverAntigravityServers: () => Promise.resolve(servers),
    requestLocalJson: target => Promise.resolve({ userStatus: { email: emails[target.pid] } })
  });
  const discovered = await provider.discover();
  assert.deepEqual(
    discovered.map(a => a.id),
    [antigravityAccountId(plusEmail), antigravityAccountId(longEmail)]
  );
  for (const entry of discovered) {
    assert.match(entry.id, /^antigravity:[0-9a-f]{16}$/);
    assert.ok((entry.label ?? '').length <= 80);
  }
  const { service } = await start(t, { providers: [provider] });
  assert.deepEqual(
    service.snapshot().settings.accounts.map(a => a.email),
    [plusEmail, longEmail]
  );
});

test('servers with unreadable identity never delete existing accounts', async t => {
  const targetId = antigravityAccountId('dev@company.com');
  const { service } = await start(t, {
    stored: {
      intervalSeconds: 60,
      accounts: [
        {
          id: targetId,
          providerId: 'antigravity',
          label: 'dev@company.com',
          email: 'dev@company.com',
          origin: 'discovered',
          primary: true,
          enabled: true
        }
      ]
    },
    providers: [
      adapter('antigravity', () => {
        throw new ProviderError('local_service_unavailable');
      })
    ]
  });
  await discoverTimes(service, 5);
  assert.deepEqual(ids(service), [targetId]);
});

test('settings updates never infer deletions; dismissal is explicit', async t => {
  const { service } = await start(t, { providers: [adapter('claude', () => [found('claude:a', { primary: true }), found('claude:b')])] });
  // The UI saves from an older snapshot that only had account A.
  await service.updateSettings({ accounts: [found('claude:a', { label: 'Claude A Custom Label', primary: true })] });
  assert.equal(service.snapshot().settings.dismissedAccountIds.includes('claude:b'), false);
  await service.reconcileDiscovery();
  assert.deepEqual(ids(service).sort(), ['claude:a', 'claude:b'], 'discovery attaches the account again');
  await service.dismissAccount('claude:b');
  await service.reconcileDiscovery();
  assert.deepEqual(ids(service), ['claude:a']);
});

test('Antigravity accounts are never removed for being absent', async t => {
  const { service } = await start(t, {
    stored: {
      accounts: [
        {
          id: 'antigravity:1234567890abcdef',
          providerId: 'antigravity',
          label: 'Antigravity IDE',
          primary: true,
          enabled: true,
          origin: 'discovered'
        },
        {
          id: 'claude:profile1',
          providerId: 'claude',
          configDir: '/missing/profile',
          label: 'Claude Old',
          primary: false,
          enabled: true,
          origin: 'discovered'
        }
      ]
    },
    providers: [adapter('antigravity', () => []), adapter('claude', () => [])]
  });
  await discoverTimes(service, 3);
  assert.deepEqual(ids(service), ['antigravity:1234567890abcdef']);
});

test('dismissal validates ids, caps the list and can be undone', async t => {
  const { service } = await start(t, { providers: [adapter('claude', () => [found('claude:valid1', { primary: true })])] });
  await assert.rejects(service.dismissAccount('invalid account with spaces!'), /invalid_argument/);
  await assert.rejects(service.dismissAccount('claude:unknown'), /account_not_found/);
  assert.equal(settingsAccount(service, 'claude:valid1')?.origin, 'discovered');

  await service.dismissAccount('claude:valid1');
  assert.ok(service.snapshot().settings.dismissedAccountIds.includes('claude:valid1'));
  assert.deepEqual(ids(service), []);

  await service.updateSettings({ dismissedAccountIds: Array.from({ length: 110 }, (_, i) => `claude:id_${i}`) });
  assert.equal(service.snapshot().settings.dismissedAccountIds.length, 100);

  // Adding a profile again takes it off the dismissal list.
  await service.updateSettings({
    dismissedAccountIds: service.snapshot().settings.dismissedAccountIds.filter(id => id !== 'claude:valid1'),
    accounts: [found('claude:valid1', { label: 'Valid 1 Restored', primary: true })]
  });
  assert.equal(service.snapshot().settings.dismissedAccountIds.includes('claude:valid1'), false);
  assert.deepEqual(ids(service), ['claude:valid1']);
});

test('saving settings without touching an account keeps it discovered', async t => {
  const { service } = await start(t, { providers: [adapter('claude', () => [found('claude:disc1', { label: 'D1', primary: true })])] });
  assert.equal(settingsAccount(service, 'claude:disc1')?.origin, 'discovered');
  await service.updateSettings({ accounts: [found('claude:disc1', { label: 'D1', primary: true })] });
  assert.equal(settingsAccount(service, 'claude:disc1')?.origin, 'discovered');
  await service.updateSettings({
    accounts: [{ ...found('claude:disc1', { label: 'D1', primary: true, configDirExplicit: true }), origin: 'user' }]
  });
  const account = settingsAccount(service, 'claude:disc1');
  assert.deepEqual(
    [account?.origin, account?.configDirExplicit],
    ['discovered', undefined],
    'origin and configDirExplicit never come from the client'
  );
});

test('dismissing the primary account promotes the next one', async t => {
  const { service } = await start(t, {
    stored: {
      accounts: [
        { id: 'claude:1', providerId: 'claude', label: 'Primary Claude', primary: true, enabled: true, origin: 'discovered' },
        { id: 'claude:2', providerId: 'claude', label: 'Backup Claude', primary: false, enabled: true, origin: 'discovered' }
      ]
    },
    providers: [adapter('claude', () => [])]
  });
  await service.dismissAccount('claude:1');
  assert.deepEqual(
    service.snapshot().settings.accounts.map(a => [a.id, a.primary]),
    [['claude:2', true]]
  );
});

test('clearing dismissals lets discovery restore accounts', async t => {
  const { service } = await start(t, {
    stored: { accounts: [], dismissedAccountIds: ['antigravity:test_account'] },
    providers: [adapter('antigravity', () => [found('antigravity:test_account', { providerId: 'antigravity', primary: true })])]
  });
  await service.reconcileDiscovery();
  assert.deepEqual(ids(service), []);
  await service.updateSettings({ dismissedAccountIds: [] });
  await service.reconcileDiscovery();
  assert.deepEqual(ids(service), ['antigravity:test_account']);
});

test('restoring dismissed accounts takes effect immediately', async t => {
  let now = 100000;
  const { service } = await start(t, {
    clock: () => now,
    stored: {
      accounts: [
        {
          id: 'antigravity:test_account',
          providerId: 'antigravity',
          label: 'Antigravity Dev',
          primary: true,
          enabled: true,
          origin: 'discovered'
        }
      ]
    },
    providers: [adapter('antigravity', () => [found('antigravity:test_account', { providerId: 'antigravity', primary: true })])]
  });
  await service.dismissAccount('antigravity:test_account');
  assert.deepEqual(service.snapshot().settings.dismissedAccountIds, ['antigravity:test_account']);
  now += 10000;
  await service.refresh();
  assert.deepEqual(ids(service), [], 'a refresh inside the discovery interval does not rediscover');
  await service.restoreDismissedAccounts();
  assert.deepEqual(ids(service), ['antigravity:test_account']);
  assert.deepEqual(service.snapshot().settings.dismissedAccountIds, []);
});

test('the dismissal list keeps the newest entries when full', async t => {
  const { service } = await start(t, {
    stored: {
      accounts: [{ id: 'claude:target', providerId: 'claude', label: 'Target', primary: true, enabled: true, origin: 'discovered' }],
      dismissedAccountIds: Array.from({ length: 100 }, (_, i) => `claude:old_${i}`)
    },
    providers: [adapter('claude', () => [])]
  });
  await service.dismissAccount('claude:target');
  const dismissed = service.snapshot().settings.dismissedAccountIds;
  assert.equal(dismissed.length, 100);
  assert.equal(dismissed.at(-1), 'claude:target');
  assert.equal(dismissed.includes('claude:old_0'), false);
});

test('a response without windows or status is invalid, not limit-free', async t => {
  const { service } = await start(t, {
    providers: [
      adapter(
        'claude',
        () => [found('claude:acc1', { primary: true })],
        () => Promise.resolve({ windows: [] })
      )
    ]
  });
  await service.refresh();
  assert.equal(measured(service, 'claude').status, 'invalid_response');
});

test('account status carries a code and clears after a successful read', async t => {
  let failing = true;
  const { service } = await start(t, {
    providers: [
      adapter(
        'codex',
        () => [found('codex:default', { providerId: 'codex', primary: true })],
        () =>
          failing
            ? Promise.reject(new ProviderError('transport_error'))
            : Promise.resolve({ windows: [window('w', { remainingPercent: 50 })] })
      )
    ]
  });
  await service.refresh();
  assert.equal(measured(service, 'codex').messageCode, 'transport_error');
  failing = false;
  await service.refresh();
  assert.equal(measured(service, 'codex').messageCode, undefined);
});

test('window settings saved during refresh do not detach accounts from results', async t => {
  const response = Promise.withResolvers<FetchResult>();
  const { service } = await start(t, {
    providers: [
      adapter(
        'claude',
        () => [found('claude:default', { primary: true })],
        () => response.promise
      )
    ]
  });
  const refresh = service.refresh();
  await service.updateSettings({ window: { x: 0, y: 0, width: 430, height: 800 } });
  response.resolve({ windows: [window('five_hour', { usedPercent: 20 })] });
  await refresh;
  assert.deepEqual([measured(service, 'claude').status, measured(service, 'claude').windows[0]?.remainingPercent], ['ok', 80]);
});

test('the service isolates accounts, deduplicates refresh, keeps the last good reading and hides raw errors', async t => {
  let failing = false;
  let calls = 0;
  let now = 100000;
  const { service } = await start(t, {
    clock: () => now,
    providers: [
      adapter(
        'claude',
        () => [found('claude:default', { primary: true }), found('claude:secondary')],
        async target => {
          calls++;
          await new Promise(resolve => setTimeout(resolve, 5));
          if (failing) throw new Error('secret-token-raw-response');
          return { plan: 'pro', windows: [{ id: 'session', label: '5 hours', usedPercent: target.primary ? 90 : 0 }] };
        }
      )
    ]
  });
  const [first] = await Promise.all([service.refresh(), service.refresh()]);
  assert.equal(calls, 2, 'concurrent refreshes share one read per account');
  const firstProvider = first.providers[0];
  assert.deepEqual(
    firstProvider?.accounts.map(a => a.windows[0]?.remainingPercent),
    [10, 100]
  );
  failing = true;
  now += 1000;
  const second = (await service.refresh()).providers[0];
  assert.equal(second?.status, 'stale');
  assert.equal(second.fetchedAt, firstProvider.fetchedAt);
  assert.deepEqual([second.accounts[0]?.status, second.accounts[0]?.windows[0]?.remainingPercent], ['stale', 10]);
  assert.equal(JSON.stringify(second).includes('secret-token'), false);

  const copy = service.snapshot();
  copy.settings.pinned = true;
  assert.equal(service.snapshot().settings.pinned, false, 'snapshots are copies');
  await service.updateSettings({ pinned: true, intervalSeconds: 60 });
  assert.equal(service.snapshot().settings.pinned, true);
  await assert.rejects(service.updateSettings({ intervalSeconds: 1 }), /invalid_interval/);
});

test('a rate-limited account waits for the bounded back-off without being called exhausted', async t => {
  let now = 100000;
  let calls = 0;
  const { service } = await start(t, {
    clock: () => now,
    providers: [
      adapter(
        'cursor',
        () => [found('cursor:default', { providerId: 'cursor', primary: true })],
        () => {
          calls++;
          return Promise.reject(new ProviderError('rate_limited', { retryAfterSeconds: 90 }));
        }
      )
    ]
  });
  await service.refresh();
  await service.refresh();
  assert.equal(calls, 1);
  assert.equal(measured(service, 'cursor').status, 'rate_limited');
  now += 91000;
  await service.refresh();
  assert.equal(calls, 2);
});

test('settings saved by earlier versions are completed and rewritten on start', async t => {
  const { service, settingsPath } = await start(t, {
    stored: { accounts: [{ id: 'claude:a', providerId: 'claude', label: 'A', primary: true, enabled: true }], providerOrder: ['codex'] },
    providers: [adapter('claude', () => [])]
  });
  assert.equal(settingsAccount(service, 'claude:a')?.origin, 'user', 'accounts without an origin are user-managed');
  assert.deepEqual(service.snapshot().settings.providerOrder, ['codex', 'claude', 'cursor', 'antigravity']);
  const saved = JSON.parse(await fs.readFile(settingsPath, 'utf8')) as { providerOrder: string[] };
  assert.deepEqual(saved.providerOrder, ['codex', 'claude', 'cursor', 'antigravity']);
  await assert.rejects(service.refresh('codex'), /invalid_provider/, 'only configured adapters can be refreshed');
});
