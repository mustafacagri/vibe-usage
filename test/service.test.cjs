'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createDeferred } = require('./helpers/fixtures.cjs');

test('a single-provider refresh never makes a concurrent full refresh skip providers', async t => {
  const { createService } = require('../src/core/service.cjs');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-race-scope-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  let codexFetched = false;
  let claudeFetched = false;

  const claudeProvider = {
    id: 'claude',
    name: 'Claude',
    discover: async () => [{ id: 'claude:default', providerId: 'claude', label: 'Claude A', primary: true, enabled: true }],
    fetch: async () => {
      await new Promise(r => setTimeout(r, 20));
      claudeFetched = true;
      return { windows: [{ id: 'five_hour', remainingPercent: 80 }] };
    }
  };

  const codexProvider = {
    id: 'codex',
    name: 'Codex',
    discover: async () => [{ id: 'codex:default', providerId: 'codex', label: 'Codex A', primary: true, enabled: true }],
    fetch: async () => {
      codexFetched = true;
      return { windows: [{ id: 'primary', remainingPercent: 70 }] };
    }
  };

  const svc = await createService({
    settingsPath: path.join(dir, 'settings.json'),
    providers: [claudeProvider, codexProvider]
  });

  // Start narrow refresh('claude')
  const p1 = svc.refresh('claude');
  // Immediately call full refresh() concurrently
  const p2 = svc.refresh();

  await Promise.all([p1, p2]);

  // Codex MUST NOT have been skipped!
  assert.equal(claudeFetched, true);
  assert.equal(codexFetched, true);
  const snap = svc.snapshot();
  assert.equal(snap.providers.find(p => p.id === 'codex').accounts[0].status, 'ok');
  assert.equal(snap.providers.find(p => p.id === 'claude').accounts[0].status, 'ok');
});

test('discovery adds new profiles and removes a vanished one only after repeated misses', async t => {
  const { createService } = require('../src/core/service.cjs');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-lifecycle-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  let discovered = [
    { id: 'claude:default', providerId: 'claude', label: 'A', primary: true, enabled: true },
    { id: 'claude:secondary', providerId: 'claude', label: 'B', primary: false, enabled: true }
  ];

  const provider = {
    id: 'claude',
    name: 'Claude',
    discover: async () => discovered,
    fetch: async () => ({ windows: [{ id: '5h', remainingPercent: 90 }] })
  };

  const svc = await createService({
    settingsPath: path.join(dir, 'settings.json'),
    providers: [provider]
  });

  assert.equal(svc.snapshot().settings.accounts.length, 2);

  // Simulate secondary profile deletion from disk
  discovered = [{ id: 'claude:default', providerId: 'claude', label: 'A', primary: true, enabled: true }];

  // Miss 1
  await svc.reconcileDiscovery();
  assert.equal(svc.snapshot().settings.accounts.length, 2); // Tombstone: still retained

  // Miss 2
  await svc.reconcileDiscovery();
  assert.equal(svc.snapshot().settings.accounts.length, 2); // Tombstone: still retained

  // Miss 3: Now removed
  await svc.reconcileDiscovery();
  assert.equal(svc.snapshot().settings.accounts.length, 1);
  assert.equal(svc.snapshot().settings.accounts[0].id, 'claude:default');
});

test('provider-scoped generations keep concurrent refresh results', async t => {
  const { createService } = require('../src/core/service.cjs');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-b1-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const defClaude = createDeferred();
  const defCodex = createDeferred();

  const claudeProvider = {
    id: 'claude',
    name: 'Claude',
    discover: async () => [{ id: 'claude:default', providerId: 'claude', label: 'Claude', primary: true, enabled: true }],
    fetch: () => defClaude.promise
  };

  const codexProvider = {
    id: 'codex',
    name: 'Codex',
    discover: async () => [{ id: 'codex:default', providerId: 'codex', label: 'Codex', primary: true, enabled: true }],
    fetch: () => defCodex.promise
  };

  const svc = await createService({
    settingsPath: path.join(dir, 'settings.json'),
    providers: [claudeProvider, codexProvider]
  });

  // Start Claude refresh first (in-flight)
  const pClaude = svc.refresh('claude');

  // Start Codex refresh while Claude is in-flight (bumps global or codex gen)
  const pCodex = svc.refresh('codex');

  // Resolve Claude first
  defClaude.resolve({ windows: [{ id: 'five_hour', remainingPercent: 88 }] });
  await pClaude;

  // Claude result MUST NOT have been discarded by Codex starting!
  const snap1 = svc.snapshot();
  const claudeAcc = snap1.providers.find(p => p.id === 'claude').accounts[0];
  assert.equal(claudeAcc.status, 'ok');
  assert.equal(claudeAcc.windows[0].remainingPercent, 88);

  // Resolve Codex
  defCodex.resolve({ windows: [{ id: 'primary', remainingPercent: 72 }] });
  await pCodex;

  const snap2 = svc.snapshot();
  const codexAcc = snap2.providers.find(p => p.id === 'codex').accounts[0];
  assert.equal(codexAcc.status, 'ok');
  assert.equal(codexAcc.windows[0].remainingPercent, 72);
});

test('a fetch finishing after the account was removed does not resurrect it', async t => {
  const { createService } = require('../src/core/service.cjs');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-b4-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const defA = createDeferred();
  const defB = createDeferred();

  const provider = {
    id: 'claude',
    name: 'Claude',
    discover: async () => [
      { id: 'claude:a', providerId: 'claude', label: 'Account A', configDir: '/dir/a', primary: true, enabled: true },
      { id: 'claude:b', providerId: 'claude', label: 'Account B', configDir: '/dir/b', primary: false, enabled: true }
    ],
    fetch: async acc => {
      if (acc.id === 'claude:a') return defA.promise;
      if (acc.id === 'claude:b') return defB.promise;
      throw new Error('unknown_account');
    }
  };

  const svc = await createService({
    settingsPath: path.join(dir, 'settings.json'),
    providers: [provider]
  });

  assert.equal(svc.snapshot().settings.accounts.length, 2);

  // Start refresh for claude (both A and B are in-flight)
  const pRefresh = svc.refresh('claude');

  // User deletes Account B during in-flight fetch
  await svc.updateSettings({
    accounts: [{ id: 'claude:a', providerId: 'claude', label: 'Account A', configDir: '/dir/a', primary: true, enabled: true }]
  });

  // Verify settings has only A
  assert.equal(svc.snapshot().settings.accounts.length, 1);

  // Now resolve both fetches
  defA.resolve({ windows: [{ id: 'five_hour', remainingPercent: 95 }] });
  defB.resolve({ windows: [{ id: 'five_hour', remainingPercent: 10 }] });
  await pRefresh;

  // Account B MUST NOT be resurrected in settings or provider accounts!
  const finalSnap = svc.snapshot();
  assert.equal(finalSnap.settings.accounts.length, 1);
  assert.equal(finalSnap.settings.accounts[0].id, 'claude:a');
  const providerAccounts = finalSnap.providers.find(p => p.id === 'claude').accounts;
  assert.equal(providerAccounts.length, 1);
  assert.equal(providerAccounts[0].id, 'claude:a');
  assert.equal(providerAccounts[0].status, 'ok');
});

test('failed discovery never counts as a miss and keeps user customizations', async t => {
  const { createService } = require('../src/core/service.cjs');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-b5-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  let failDiscovery = false;
  let discovered = [
    { id: 'claude:a', providerId: 'claude', label: 'Discovered A', primary: true, enabled: true },
    { id: 'claude:b', providerId: 'claude', label: 'Discovered B', primary: false, enabled: true }
  ];

  const provider = {
    id: 'claude',
    name: 'Claude',
    discover: async () => {
      if (failDiscovery) throw new Error('EACCES: keychain locked');
      return discovered;
    },
    fetch: async () => ({ windows: [{ id: 'five_hour', remainingPercent: 90 }] })
  };

  const svc = await createService({
    settingsPath: path.join(dir, 'settings.json'),
    providers: [provider]
  });

  assert.equal(svc.snapshot().settings.accounts.length, 2);

  // User customizes label of Account B -> origin becomes 'user'
  await svc.updateSettings({
    accounts: [
      { id: 'claude:a', providerId: 'claude', label: 'Discovered A', primary: true, enabled: true },
      { id: 'claude:b', providerId: 'claude', label: 'Custom User Label B', primary: false, enabled: true }
    ]
  });

  const customizedAcc = svc.snapshot().settings.accounts.find(a => a.id === 'claude:b');
  assert.equal(customizedAcc.origin, 'user');

  // Simulate 5 transient discovery failures (e.g. keychain locked for 5 minutes)
  failDiscovery = true;
  for (let i = 0; i < 5; i++) {
    await svc.reconcileDiscovery();
  }
  // No accounts should have been deleted because discovery errored!
  assert.equal(svc.snapshot().settings.accounts.length, 2);

  // Now discovery succeeds, but neither account is reported by discover()
  failDiscovery = false;
  discovered = [];

  // Run 3 clean discovery cycles
  await svc.reconcileDiscovery(); // miss 1
  assert.equal(svc.snapshot().settings.accounts.length, 2);
  await svc.reconcileDiscovery(); // miss 2
  assert.equal(svc.snapshot().settings.accounts.length, 2);
  await svc.reconcileDiscovery(); // miss 3

  // Account A (origin: 'discovered') is removed after 3 misses
  // Account B (origin: 'user') is PROTECTED and retained!
  const finalAccounts = svc.snapshot().settings.accounts;
  assert.equal(finalAccounts.length, 1);
  assert.equal(finalAccounts[0].id, 'claude:b');
  assert.equal(finalAccounts[0].label, 'Custom User Label B');
});

test('quota monitoring writes nothing to provider files', async t => {
  const { createClaudeProvider } = require('../src/providers/claude.cjs');
  let writeCount = 0;

  // Intercept write calls
  const originalWriteFile = fs.writeFile;
  const originalAppendFile = fs.appendFile;
  fs.writeFile = async (...args) => {
    writeCount++;
    return originalWriteFile.apply(fs, args);
  };
  fs.appendFile = async (...args) => {
    writeCount++;
    return originalAppendFile.apply(fs, args);
  };
  t.after(() => {
    fs.writeFile = originalWriteFile;
    fs.appendFile = originalAppendFile;
  });

  const provider = createClaudeProvider({
    platform: 'darwin',
    readCredentials: async () => ({ claudeAiOauth: { accessToken: 'mock-token', expiresAt: Date.now() + 3600000 } }),
    getJson: async () => ({ five_hour: { remaining_fraction: 0.9 } })
  });

  const result = await provider.fetch({ id: 'claude:default', configDir: '/tmp/.claude' });
  assert.equal(result.windows.length, 2);
  assert.equal(writeCount, 0, 'Quota fetch must NEVER write to filesystem or credentials store!');
});

test('a closed Antigravity app never deletes its account', async t => {
  const { createService } = require('../src/core/service.cjs');
  const { ProviderError } = require('../src/providers/common.cjs');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-r1-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  let appRunning = true;
  const antigravityProvider = {
    id: 'antigravity',
    name: 'Antigravity',
    discover: async () => {
      if (!appRunning) throw new ProviderError('app_closed');
      return [
        {
          id: 'antigravity:work@corp.com',
          providerId: 'antigravity',
          label: 'Antigravity (work@corp.com)',
          email: 'work@corp.com',
          primary: true,
          enabled: true
        }
      ];
    },
    fetch: async () => ({ windows: [{ id: '5h', remainingPercent: 90 }] })
  };

  const svc = await createService({
    settingsPath: path.join(dir, 'settings.json'),
    providers: [antigravityProvider]
  });

  assert.equal(svc.snapshot().settings.accounts.length, 1);
  assert.equal(svc.snapshot().settings.accounts[0].id, 'antigravity:work@corp.com');

  // App is now closed for 5 consecutive discovery cycles
  appRunning = false;
  for (let i = 0; i < 5; i++) {
    await svc.reconcileDiscovery();
  }

  // Account MUST NOT have been deleted after 5 cycles with app closed!
  const finalAccounts = svc.snapshot().settings.accounts;
  assert.equal(finalAccounts.length, 1);
  assert.equal(finalAccounts[0].id, 'antigravity:work@corp.com');
});

test('discovery and settings updates are serialized and dismissals hold', async t => {
  const { createService } = require('../src/core/service.cjs');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-r3-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const discovered = [
    { id: 'claude:a', providerId: 'claude', label: 'Discovered A', primary: true, enabled: true },
    { id: 'claude:b', providerId: 'claude', label: 'Discovered B', primary: false, enabled: true }
  ];

  const provider = {
    id: 'claude',
    name: 'Claude',
    discover: async () => discovered,
    fetch: async () => ({ windows: [{ id: '5h', remainingPercent: 90 }] })
  };

  const svc = await createService({
    settingsPath: path.join(dir, 'settings.json'),
    providers: [provider]
  });

  assert.equal(svc.snapshot().settings.accounts.length, 2);

  // User deletes Account B via dismissAccount concurrently with reconcileDiscovery
  const p1 = svc.dismissAccount('claude:b');
  const p2 = svc.reconcileDiscovery();

  await Promise.all([p1, p2]);

  // Account B must be in dismissedAccountIds and NOT resurrected in settings.accounts!
  const snap = svc.snapshot();
  assert.equal(snap.settings.accounts.length, 1);
  assert.equal(snap.settings.accounts[0].id, 'claude:a');
  assert.equal(snap.settings.dismissedAccountIds.includes('claude:b'), true);

  // Run another discovery cycle where discover() still sees Account B on disk
  await svc.reconcileDiscovery();
  const snapAfter = svc.snapshot();
  assert.equal(snapAfter.settings.accounts.length, 1);
  assert.equal(snapAfter.settings.accounts[0].id, 'claude:a');
});

test('user-managed and disabled accounts survive restarts and discovery', async t => {
  const { createService } = require('../src/core/service.cjs');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-r4-'));
  const settingsPath = path.join(dir, 'settings.json');
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  let discovered = [
    { id: 'claude:a', providerId: 'claude', label: 'Discovered A', primary: true, enabled: true },
    { id: 'claude:b', providerId: 'claude', label: 'Discovered B', primary: false, enabled: true }
  ];

  const provider = {
    id: 'claude',
    name: 'Claude',
    discover: async () => discovered,
    fetch: async () => ({ windows: [{ id: '5h', remainingPercent: 90 }] })
  };

  const svc1 = await createService({ settingsPath, providers: [provider] });

  // User customizes: disables account B and changes label
  await svc1.updateSettings({
    accounts: [
      { id: 'claude:a', providerId: 'claude', label: 'Discovered A', primary: true, enabled: true },
      { id: 'claude:b', providerId: 'claude', label: 'My Disabled Account B', primary: false, enabled: false }
    ]
  });

  const snap1 = svc1.snapshot();
  const accB1 = snap1.settings.accounts.find(a => a.id === 'claude:b');
  assert.equal(accB1.origin, 'user');
  assert.equal(accB1.enabled, false);

  // Cold restart: create brand new service loading from the same settingsPath
  discovered = []; // No accounts discovered on disk
  const svc2 = await createService({ settingsPath, providers: [provider] });

  const snap2 = svc2.snapshot();
  const accB2 = snap2.settings.accounts.find(a => a.id === 'claude:b');
  assert.equal(accB2.origin, 'user');
  assert.equal(accB2.enabled, false);
  assert.equal(accB2.label, 'My Disabled Account B');

  // Run 3 clean misses of discovery where discover() returns empty
  await svc2.reconcileDiscovery(); // miss 1
  await svc2.reconcileDiscovery(); // miss 2
  await svc2.reconcileDiscovery(); // miss 3

  // Account A (discovered) was deleted after 3 misses
  // Account B (user + disabled) is 100% retained!
  const finalAccounts = svc2.snapshot().settings.accounts;
  assert.equal(finalAccounts.length, 1);
  assert.equal(finalAccounts[0].id, 'claude:b');
  assert.equal(finalAccounts[0].enabled, false);
});

test('the legacy single Antigravity account migrates to its e-mail account', async t => {
  const { createService } = require('../src/core/service.cjs');
  const { antigravityAccountId } = require('../src/providers/antigravity.cjs');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-r2-migration-'));
  const settingsPath = path.join(dir, 'settings.json');
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  // Existing settings file with legacy antigravity:current customized by user
  const initialSettings = {
    pinned: false,
    intervalSeconds: 60,
    accounts: [
      {
        id: 'antigravity:current',
        providerId: 'antigravity',
        label: 'My Work Antigravity',
        origin: 'user',
        primary: true,
        enabled: true
      }
    ],
    dismissedAccountIds: []
  };
  await fs.writeFile(settingsPath, JSON.stringify(initialSettings, null, 2), 'utf-8');

  const targetId = antigravityAccountId('dev@company.com');
  const provider = {
    id: 'antigravity',
    name: 'Antigravity',
    discover: async () => [
      {
        id: targetId,
        providerId: 'antigravity',
        email: 'dev@company.com',
        label: 'dev@company.com',
        primary: false,
        enabled: true
      }
    ],
    fetch: async () => ({ windows: [{ id: 'gemini-session', remainingPercent: 85 }] })
  };

  const svc = await createService({ settingsPath, providers: [provider] });

  const snap1 = svc.snapshot();
  assert.equal(snap1.settings.accounts.length, 1);
  const migrated = snap1.settings.accounts[0];
  assert.equal(migrated.id, targetId);
  assert.equal(migrated.email, 'dev@company.com');
  assert.equal(migrated.label, 'My Work Antigravity'); // User custom label preserved!
  assert.equal(migrated.origin, 'user'); // User origin preserved!
  assert.equal(migrated.primary, true); // User primary preserved!
  assert.equal(migrated.enabled, true);

  // Subsequent reconciliation keeps migrated account stable
  await svc.reconcileDiscovery();
  const snap2 = svc.snapshot();
  assert.equal(snap2.settings.accounts.length, 1);
  assert.equal(snap2.settings.accounts[0].id, targetId);
  assert.equal(snap2.settings.accounts[0].label, 'My Work Antigravity');
});

test('dismissed accounts stay dismissed across restarts', async t => {
  const { createService } = require('../src/core/service.cjs');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-e1-'));
  const settingsPath = path.join(dir, 'settings.json');
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const discovered = [
    { id: 'claude:acc1', providerId: 'claude', label: 'Claude Account 1', primary: true, enabled: true },
    { id: 'claude:acc2', providerId: 'claude', label: 'Claude Account 2', primary: false, enabled: true }
  ];

  const provider = {
    id: 'claude',
    name: 'Claude',
    discover: async () => discovered,
    fetch: async () => ({ windows: [{ id: '5h', remainingPercent: 90 }] })
  };

  // 1. Initial service start discovers 2 accounts
  const svc1 = await createService({ settingsPath, providers: [provider] });
  assert.equal(svc1.snapshot().settings.accounts.length, 2);

  // User dismisses Account 2
  await svc1.dismissAccount('claude:acc2');
  assert.equal(svc1.snapshot().settings.accounts.length, 1);
  assert.equal(svc1.snapshot().settings.accounts[0].id, 'claude:acc1');

  // 2. Cold restart: instantiate brand-new service loading from the exact same settingsPath
  // Even though discover() still returns Account 2 on disk:
  const svc2 = await createService({ settingsPath, providers: [provider] });
  const snapAfterRestart = svc2.snapshot();
  assert.equal(snapAfterRestart.settings.accounts.length, 1);
  assert.equal(snapAfterRestart.settings.accounts[0].id, 'claude:acc1');
  assert.equal(snapAfterRestart.settings.dismissedAccountIds.includes('claude:acc2'), true);

  // Run 3 consecutive reconciliation cycles
  await svc2.reconcileDiscovery();
  await svc2.reconcileDiscovery();
  await svc2.reconcileDiscovery();

  const finalSnap = svc2.snapshot();
  assert.equal(finalSnap.settings.accounts.length, 1);
  assert.equal(finalSnap.settings.accounts[0].id, 'claude:acc1');
});

test('e-mail addresses with plus signs and long addresses are accepted', async t => {
  const { createService } = require('../src/core/service.cjs');
  const { createAntigravityProvider, antigravityAccountId } = require('../src/providers/antigravity.cjs');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-e2-'));
  const settingsPath = path.join(dir, 'settings.json');
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const plusEmail = 'user+tag@domain.com';
  const longEmail =
    'extremely.long.corporate.work.user.email.address.that.exceeds.sixty.seven.characters@very.long.subdomain.enterprise.company.com';

  const server1 = { pid: 701, csrfToken: 'tok1', ports: [7101], sourceKind: 'ide' };
  const server2 = { pid: 702, csrfToken: 'tok2', ports: [7102], sourceKind: 'app' };

  const provider = createAntigravityProvider({
    platform: 'darwin',
    discoverAntigravityServers: async () => [server1, server2],
    requestLocalJson: async server => {
      if (server.pid === 701) {
        return {
          userStatus: { email: plusEmail },
          groups: [{ id: 'cg', displayName: 'Claude and GPT', buckets: [{ bucketId: 'session', window: '5h', remainingFraction: 0.9 }] }]
        };
      }
      return {
        userStatus: { email: longEmail },
        groups: [{ id: 'cg', displayName: 'Claude and GPT', buckets: [{ bucketId: 'session', window: '5h', remainingFraction: 0.8 }] }]
      };
    }
  });

  // Verify discover() returns sanitized 28-char IDs matching regex and labels clamped to <= 80 chars
  const discovered = await provider.discover();
  assert.equal(discovered.length, 2);
  for (const acc of discovered) {
    assert.match(acc.id, /^antigravity:[0-9a-f]{16}$/);
    assert.ok(acc.label.length <= 80);
  }
  assert.equal(discovered[0].id, antigravityAccountId(plusEmail));
  assert.equal(discovered[1].id, antigravityAccountId(longEmail));

  // Service initializes cleanly with these accounts and validates settings without crash
  const svc = await createService({ settingsPath, providers: [provider] });
  const accounts = svc.snapshot().settings.accounts;
  assert.equal(accounts.length, 2);
  assert.equal(accounts[0].id, antigravityAccountId(plusEmail));
  assert.equal(accounts[0].email, plusEmail.toLowerCase());
  assert.equal(accounts[1].id, antigravityAccountId(longEmail));
  assert.equal(accounts[1].email, longEmail.toLowerCase());
});

test('servers with unreadable identity never delete existing accounts', async t => {
  const { createService } = require('../src/core/service.cjs');
  const { antigravityAccountId } = require('../src/providers/antigravity.cjs');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-e4-'));
  const settingsPath = path.join(dir, 'settings.json');
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const targetId = antigravityAccountId('dev@company.com');
  // Initial settings with dev@company.com configured
  const initialSettings = {
    pinned: false,
    intervalSeconds: 60,
    accounts: [
      {
        id: targetId,
        providerId: 'antigravity',
        label: 'Antigravity (dev@company.com)',
        email: 'dev@company.com',
        origin: 'discovered',
        primary: true,
        enabled: true
      }
    ],
    dismissedAccountIds: []
  };
  await fs.writeFile(settingsPath, JSON.stringify(initialSettings, null, 2), 'utf-8');

  // Server is running (pid 901) but GetUserStatus fails (rate limited or server startup)
  const statusFails = true;
  const provider = {
    id: 'antigravity',
    name: 'Antigravity',
    discover: async () => {
      if (statusFails) {
        // Servers were found but none could be identified, so discovery fails closed and local_service_unavailable
        const { ProviderError } = require('../src/providers/common.cjs');
        throw new ProviderError('local_service_unavailable');
      }
      return [
        {
          id: targetId,
          providerId: 'antigravity',
          email: 'dev@company.com',
          label: 'Antigravity (dev@company.com)',
          primary: true,
          enabled: true
        }
      ];
    },
    fetch: async () => ({ windows: [{ id: '5h', remainingPercent: 90 }] })
  };

  const svc = await createService({ settingsPath, providers: [provider] });

  // Run 5 consecutive discovery reconciliation cycles while identity reading is failing
  for (let i = 0; i < 5; i++) {
    await svc.reconcileDiscovery();
  }

  // dev@company.com account MUST NOT have been deleted, and no zombie antigravity:current was added!
  const snap = svc.snapshot();
  assert.equal(snap.settings.accounts.length, 1);
  assert.equal(snap.settings.accounts[0].id, targetId);
  assert.equal(snap.settings.accounts[0].email, 'dev@company.com');
});

test('settings updates never infer deletions; dismissal is explicit', async t => {
  const { createService } = require('../src/core/service.cjs');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-y1-'));
  const settingsPath = path.join(dir, 'settings.json');
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const discovered = [
    { id: 'claude:a', providerId: 'claude', label: 'Claude A', primary: true, enabled: true },
    { id: 'claude:b', providerId: 'claude', label: 'Claude B', primary: false, enabled: true }
  ];

  const provider = {
    id: 'claude',
    name: 'Claude',
    discover: async () => discovered,
    fetch: async () => ({ windows: [{ id: '5h', remainingPercent: 90 }] })
  };

  const svc = await createService({ settingsPath, providers: [provider] });
  assert.equal(svc.snapshot().settings.accounts.length, 2);

  // UI saves settings from an older snapshot that only has Account A (e.g. user editing label)
  await svc.updateSettings({
    accounts: [{ id: 'claude:a', providerId: 'claude', label: 'Claude A Custom Label', primary: true, enabled: true }]
  });

  // Account B was NOT put into dismissedAccountIds!
  assert.equal(svc.snapshot().settings.dismissedAccountIds.includes('claude:b'), false);

  // Background discovery reconciles and safely re-attaches Account B
  await svc.reconcileDiscovery();
  const snap = svc.snapshot();
  assert.equal(snap.settings.accounts.length, 2);
  assert.equal(
    snap.settings.accounts.some(a => a.id === 'claude:b'),
    true
  );

  // Only explicit dismissAccount permanently dismisses Account B
  await svc.dismissAccount('claude:b');
  assert.equal(svc.snapshot().settings.dismissedAccountIds.includes('claude:b'), true);
  await svc.reconcileDiscovery();
  assert.equal(svc.snapshot().settings.accounts.length, 1);
  assert.equal(svc.snapshot().settings.accounts[0].id, 'claude:a');
});

test('Antigravity accounts are never removed for being absent', async t => {
  const { createService } = require('../src/core/service.cjs');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-f1-antigravity-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const settingsPath = path.join(dir, 'settings.json');
  // Seed settings with an Antigravity account and a Claude account (both discovered)
  const initialSettings = {
    pinned: false,
    intervalSeconds: 120,
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
        configDir: path.join(dir, 'nonexistent'),
        label: 'Claude Old',
        primary: false,
        enabled: true,
        origin: 'discovered'
      }
    ]
  };
  await fs.writeFile(settingsPath, JSON.stringify(initialSettings), 'utf-8');

  // Claude discovers empty list (clean miss), Antigravity discovers empty list
  const service = await createService({
    settingsPath,
    providers: [
      { id: 'antigravity', name: 'Antigravity', discover: async () => [], fetch: async () => ({ windows: [] }) },
      { id: 'claude', name: 'Claude', discover: async () => [], fetch: async () => ({ windows: [] }) }
    ]
  });

  // Run 3 reconcileDiscovery cycles so Claude accumulates 3 consecutive clean misses
  await service.reconcileDiscovery();
  await service.reconcileDiscovery();
  await service.reconcileDiscovery();
  const accountsAfter = service.snapshot().settings.accounts;

  // Claude account should have been removed after 3rd clean miss
  assert.equal(
    accountsAfter.some(a => a.id === 'claude:profile1'),
    false
  );
  // Antigravity account must be PRESERVED because processes being closed is normal lifetime
  assert.equal(
    accountsAfter.some(a => a.id === 'antigravity:1234567890abcdef'),
    true
  );
});

test('dismissal validates ids, caps the list and can be undone', async t => {
  const { createService } = require('../src/core/service.cjs');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-f3-dismiss-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const settingsPath = path.join(dir, 'settings.json');
  const service = await createService({
    settingsPath,
    providers: [
      {
        id: 'claude',
        name: 'Claude',
        discover: async () => [{ id: 'claude:valid1', providerId: 'claude', label: 'Valid 1', primary: true, enabled: true }],
        fetch: async () => ({ windows: [] })
      }
    ]
  });
  await service.reconcileDiscovery();

  // Test invalid account ID rejection in service
  await assert.rejects(service.dismissAccount('invalid account with spaces!'), /invalid_argument/);
  await assert.rejects(service.dismissAccount('claude:unknown'), /account_not_found/);

  // Verify account was discovered with origin: 'discovered'
  const beforeDismiss = service.snapshot().settings.accounts;
  assert.equal(beforeDismiss.find(a => a.id === 'claude:valid1')?.origin, 'discovered');

  // Dismiss valid account
  await service.dismissAccount('claude:valid1');
  let snapshot = service.snapshot();
  assert.ok(snapshot.settings.dismissedAccountIds.includes('claude:valid1'));
  assert.equal(
    snapshot.settings.accounts.some(a => a.id === 'claude:valid1'),
    false
  );

  // Dismissed accounts bounded to 100 entries
  const hundredIds = Array.from({ length: 110 }, (_, i) => `claude:id_${i}`);
  await service.updateSettings({ dismissedAccountIds: hundredIds });
  snapshot = service.snapshot();
  assert.equal(snapshot.settings.dismissedAccountIds.length, 100);

  // Un-dismiss testing: simulate add-profile re-adding a dismissed account
  const currentDismissed = service.snapshot().settings.dismissedAccountIds;
  const nextDismissed = currentDismissed.filter(id => id !== 'claude:valid1');
  await service.updateSettings({
    dismissedAccountIds: nextDismissed,
    accounts: [
      ...service.snapshot().settings.accounts,
      { id: 'claude:valid1', providerId: 'claude', label: 'Valid 1 Restored', primary: true, enabled: true }
    ]
  });
  snapshot = service.snapshot();
  assert.equal(snapshot.settings.dismissedAccountIds.includes('claude:valid1'), false);
  assert.equal(
    snapshot.settings.accounts.some(a => a.id === 'claude:valid1'),
    true
  );

  // Test updateSettings preserves account origin when untouched
  // Re-add an account via discovery
  const discService = await createService({
    settingsPath: path.join(dir, 'settings2.json'),
    providers: [
      {
        id: 'claude',
        name: 'Claude',
        discover: async () => [{ id: 'claude:disc1', providerId: 'claude', label: 'D1', primary: true, enabled: true }],
        fetch: async () => ({ windows: [{ id: '5h', remainingPercent: 50 }] })
      }
    ]
  });
  await discService.reconcileDiscovery();
  assert.equal(discService.snapshot().settings.accounts[0].origin, 'discovered');

  // Update settings without modifying label, primary, or position
  await discService.updateSettings({
    accounts: [{ id: 'claude:disc1', providerId: 'claude', label: 'D1', primary: true, enabled: true }]
  });
  assert.equal(discService.snapshot().settings.accounts[0].origin, 'discovered');
});

test('dismissing the primary account promotes the next one', async t => {
  const { createService } = require('../src/core/service.cjs');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-r7-o3-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const settingsPath = path.join(dir, 'settings.json');
  const initialSettings = {
    pinned: false,
    intervalSeconds: 120,
    accounts: [
      { id: 'claude:1', providerId: 'claude', label: 'Primary Claude', primary: true, enabled: true, origin: 'discovered' },
      { id: 'claude:2', providerId: 'claude', label: 'Backup Claude', primary: false, enabled: true, origin: 'discovered' }
    ]
  };
  await fs.writeFile(settingsPath, JSON.stringify(initialSettings), 'utf-8');

  const service = await createService({
    settingsPath,
    providers: [
      { id: 'claude', name: 'Claude', discover: async () => [], fetch: async () => ({ windows: [{ id: '5h', remainingPercent: 50 }] }) }
    ]
  });

  // Dismiss primary account claude:1
  await service.dismissAccount('claude:1');
  const accountsAfter = service.snapshot().settings.accounts;
  assert.equal(accountsAfter.length, 1);
  assert.equal(accountsAfter[0].id, 'claude:2');
  // claude:2 must have been promoted to primary: true!
  assert.equal(accountsAfter[0].primary, true);
});

test('clearing dismissals lets discovery restore accounts', async t => {
  const { createService } = require('../src/core/service.cjs');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-r7-o2-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const settingsPath = path.join(dir, 'settings.json');
  const initialSettings = {
    pinned: false,
    intervalSeconds: 120,
    accounts: [],
    dismissedAccountIds: ['antigravity:test_account']
  };
  await fs.writeFile(settingsPath, JSON.stringify(initialSettings), 'utf-8');

  const provider = {
    id: 'antigravity',
    name: 'Antigravity',
    discover: async () => [
      { id: 'antigravity:test_account', providerId: 'antigravity', label: 'Antigravity Dev', primary: true, enabled: true }
    ],
    fetch: async () => ({ windows: [] })
  };

  const service = await createService({ settingsPath, providers: [provider] });
  await service.reconcileDiscovery();
  // While dismissed, account is NOT in settings.accounts
  assert.equal(service.snapshot().settings.accounts.length, 0);

  // User clicks "Kaldırılan hesapları geri al" -> saveSettings({ dismissedAccountIds: [] })
  await service.updateSettings({ dismissedAccountIds: [] });
  await service.reconcileDiscovery();

  // Account is now restored!
  const restored = service.snapshot().settings.accounts;
  assert.equal(restored.length, 1);
  assert.equal(restored[0].id, 'antigravity:test_account');
});

test('restoring dismissed accounts takes effect immediately', async t => {
  const { createService } = require('../src/core/service.cjs');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-r8-o2-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const settingsPath = path.join(dir, 'settings.json');
  const initialSettings = {
    pinned: false,
    intervalSeconds: 120,
    accounts: [
      {
        id: 'antigravity:test_account',
        providerId: 'antigravity',
        label: 'Antigravity Dev',
        primary: true,
        enabled: true,
        origin: 'discovered'
      }
    ],
    dismissedAccountIds: []
  };
  await fs.writeFile(settingsPath, JSON.stringify(initialSettings), 'utf-8');

  let clockTime = 100000;
  const clock = () => clockTime;

  const provider = {
    id: 'antigravity',
    name: 'Antigravity',
    discover: async () => [
      { id: 'antigravity:test_account', providerId: 'antigravity', label: 'Antigravity Dev', primary: true, enabled: true }
    ],
    fetch: async () => ({ windows: [{ id: '5h', remainingPercent: 80 }] })
  };

  const service = await createService({ settingsPath, clock, providers: [provider] });

  // Dismiss account
  await service.dismissAccount('antigravity:test_account');
  assert.equal(service.snapshot().settings.accounts.length, 0);
  assert.deepEqual(service.snapshot().settings.dismissedAccountIds, ['antigravity:test_account']);

  // Advance time by only 10s (< 60s periodic discovery interval) and call refresh()
  clockTime += 10000;
  await service.refresh();
  // Within 60s, normal refresh does not trigger discovery reconciliation, so accounts remains 0
  assert.equal(service.snapshot().settings.accounts.length, 0);

  // Now invoke restoreDismissedAccounts directly (as triggered by IPC vibe:restore-dismissed-accounts)
  await service.restoreDismissedAccounts();

  // Account is immediately restored into settings.accounts without waiting for 60s!
  const restored = service.snapshot().settings.accounts;
  assert.equal(restored.length, 1);
  assert.equal(restored[0].id, 'antigravity:test_account');
  assert.deepEqual(service.snapshot().settings.dismissedAccountIds, []);
});

test('the dismissal list keeps the newest entries when full', async t => {
  const { createService } = require('../src/core/service.cjs');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-e5-dismiss-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const settingsPath = path.join(dir, 'settings.json');
  const initialDismissed = Array.from({ length: 100 }, (_, i) => `claude:old_${i}`);
  const initialSettings = {
    pinned: false,
    intervalSeconds: 120,
    accounts: [{ id: 'claude:target', providerId: 'claude', label: 'Target', primary: true, enabled: true, origin: 'discovered' }],
    dismissedAccountIds: initialDismissed
  };
  await fs.writeFile(settingsPath, JSON.stringify(initialSettings), 'utf-8');

  const service = await createService({
    settingsPath,
    providers: [{ id: 'claude', name: 'Claude', discover: async () => [], fetch: async () => ({ windows: [] }) }]
  });

  // Dismiss 101st account
  await service.dismissAccount('claude:target');
  const snap = service.snapshot();
  assert.equal(snap.settings.dismissedAccountIds.length, 100);
  // With slice(-100), newest account claude:target MUST be preserved, and oldest claude:old_0 dropped!
  assert.equal(snap.settings.dismissedAccountIds.includes('claude:target'), true);
  assert.equal(snap.settings.dismissedAccountIds.includes('claude:old_0'), false);
  assert.equal(snap.settings.dismissedAccountIds[99], 'claude:target');
});

test('a response without windows or status is invalid, not limit-free', async t => {
  const { createService } = require('../src/core/service.cjs');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-m5-empty-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const settingsPath = path.join(dir, 'settings.json');
  const service = await createService({
    settingsPath,
    providers: [
      {
        id: 'claude',
        name: 'Claude',
        discover: async () => [{ id: 'claude:acc1', providerId: 'claude', label: 'Acc 1', primary: true, enabled: true }],
        // Returns empty windows without status: 'no_limits_reported'
        fetch: async () => ({ windows: [] })
      }
    ]
  });

  await service.refresh();
  const acc = service.snapshot().providers.find(p => p.id === 'claude')?.accounts[0];
  // Must NOT be falsely labeled as no_limits_reported!
  assert.notEqual(acc.status, 'no_limits_reported');
  assert.equal(acc.status, 'invalid_response');
});

test('account status carries a code and clears after a successful read', async t => {
  const { createService } = require('../src/core/service.cjs');
  const { ProviderError } = require('../src/providers/common.cjs');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-msgcode-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  let fail = true;
  const provider = {
    id: 'codex',
    name: 'Codex',
    discover: async () => [{ id: 'codex:default', providerId: 'codex', label: 'Mevcut hesap', primary: true, enabled: true }],
    fetch: async () => {
      if (fail) throw new ProviderError('transport_error');
      return { windows: [{ id: 'w', remainingPercent: 50 }] };
    }
  };
  const svc = await createService({ settingsPath: path.join(dir, 'settings.json'), providers: [provider] });
  await svc.refresh();
  const failed = svc.snapshot().providers[0].accounts[0];
  assert.equal(failed.messageCode, 'transport_error');
  fail = false;
  await svc.refresh();
  assert.equal(svc.snapshot().providers[0].accounts[0].messageCode, undefined);
});

test('window settings saved during refresh do not detach accounts from results', async t => {
  const { createService } = require('../src/core/service.cjs');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-window-race-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  let complete;
  const response = new Promise(resolve => {
    complete = resolve;
  });
  const svc = await createService({
    settingsPath: path.join(dir, 's.json'),
    providers: [
      {
        id: 'claude',
        name: 'Claude',
        discover: async () => [{ id: 'claude:default', providerId: 'claude', label: 'A', primary: true, enabled: true }],
        fetch: () => response
      }
    ]
  });
  const refresh = svc.refresh();
  await svc.updateSettings({ window: { x: 0, y: 0, width: 430, height: 800 } });
  complete({ windows: [{ id: 'five_hour', usedPercent: 20 }] });
  await refresh;
  assert.equal(svc.snapshot().providers[0].accounts[0].status, 'ok');
  assert.equal(svc.snapshot().providers[0].accounts[0].windows[0].remainingPercent, 80);
});

test('service isolates accounts, deduplicates refresh, preserves last-good on failure and sanitizes errors', async t => {
  const { createService } = require('../src/core/service.cjs');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-service-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  let failed = false,
    calls = 0,
    time = 100000;
  const provider = {
    id: 'claude',
    name: 'Claude',
    discover: async () => [
      { id: 'claude:default', providerId: 'claude', label: 'Default', primary: true, enabled: true },
      { id: 'claude:secondary', providerId: 'claude', label: 'Secondary', primary: false, enabled: true }
    ],
    fetch: async account => {
      calls++;
      await new Promise(resolve => setTimeout(resolve, 5));
      if (failed) throw new Error('secret-token-raw-response');
      return { plan: 'pro', windows: [{ id: 'session', label: '5 hours', usedPercent: account.primary ? 90 : 0 }] };
    }
  };
  const svc = await createService({ settingsPath: path.join(dir, 'settings.json'), providers: [provider], clock: () => time });
  const [first] = await Promise.all([svc.refresh(), svc.refresh()]);
  assert.equal(calls, 2);
  assert.deepEqual(
    first.providers[0].accounts.map(a => a.windows[0].remainingPercent),
    [10, 100]
  );
  const fetchedAt = first.providers[0].fetchedAt;
  failed = true;
  time += 1000;
  const second = await svc.refresh();
  assert.equal(second.providers[0].status, 'stale');
  assert.equal(second.providers[0].fetchedAt, fetchedAt);
  assert.equal(second.providers[0].accounts[0].windows[0].remainingPercent, 10);
  assert.equal(second.providers[0].accounts[0].status, 'stale');
  assert.equal(JSON.stringify(second).includes('secret-token'), false);
  const copy = svc.snapshot();
  copy.settings.pinned = true;
  assert.equal(svc.snapshot().settings.pinned, false);
  await svc.updateSettings({ pinned: true, intervalSeconds: 60 });
  assert.equal(svc.snapshot().settings.pinned, true);
});

test('rate-limited account waits for bounded backoff without classifying exhaustion', async t => {
  const { createService } = require('../src/core/service.cjs');
  const { ProviderError } = require('../src/providers/common.cjs');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-backoff-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  let time = 100000,
    calls = 0;
  const svc = await createService({
    settingsPath: path.join(dir, 's.json'),
    clock: () => time,
    providers: [
      {
        id: 'cursor',
        name: 'Cursor',
        discover: async () => [{ id: 'cursor:default', providerId: 'cursor', label: 'Current', primary: true, enabled: true }],
        fetch: async () => {
          calls++;
          throw new ProviderError('rate_limited', { retryAfterSeconds: 90 });
        }
      }
    ]
  });
  await svc.refresh();
  await svc.refresh();
  assert.equal(calls, 1);
  assert.equal(svc.snapshot().providers[0].accounts[0].status, 'rate_limited');
  time += 91000;
  await svc.refresh();
  assert.equal(calls, 2);
});
