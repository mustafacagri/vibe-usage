'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

test('fetch merges app and IDE servers without double-counting windows', async () => {
  const { createAntigravityProvider } = require('../src/providers/antigravity.cjs');

  const appServer = { pid: 101, csrfToken: 'app-token', ports: [3101], sourceKind: 'app' };
  const ideServer = { pid: 202, csrfToken: 'ide-token', ports: [3202], sourceKind: 'ide' };

  const provider = createAntigravityProvider({
    platform: 'darwin',
    runProcess: async (binary) => {
      if (binary === '/bin/ps') {
        return [
          '101 501 /Applications/Antigravity.app/Contents/Resources/bin/language_server --csrf_token=app-token',
          '202 501 /Applications/Antigravity IDE.app/Contents/Resources/extensions/antigravity/bin/language_server_macos --app_data_dir antigravity-ide --csrf_token=ide-token'
        ].join('\n');
      }
      if (binary === '/usr/sbin/lsof') {
        return 'COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\nlanguage 101 owner 8u IPv4 0t0 TCP 127.0.0.1:3101 (LISTEN)\nlanguage 202 owner 8u IPv4 0t0 TCP 127.0.0.1:3202 (LISTEN)';
      }
      throw new Error('unexpected_process');
    },
    requestLocalJson: async (server, port, method) => {
      if (method === 'GetUserStatus') {
        return { userStatus: { email: 'dev@company.com' } };
      }
      if (server.pid === 101) {
        // App only reports Claude and GPT models
        return {
          groups: [
            { id: 'claude-gpt', displayName: 'Claude and GPT models', buckets: [{ bucketId: 'session', window: '5h', remainingFraction: 1.0 }, { bucketId: 'weekly', window: 'weekly', remainingFraction: 1.0 }] }
          ]
        };
      }
      if (server.pid === 202) {
        // IDE reports both Claude and GPT models AND Gemini Models
        return {
          groups: [
            { id: 'claude-gpt', displayName: 'Claude and GPT models', buckets: [{ bucketId: 'session', window: '5h', remainingFraction: 0.9 }, { bucketId: 'weekly', window: 'weekly', remainingFraction: 0.95 }] },
            { id: 'gemini', displayName: 'Gemini Models', buckets: [{ bucketId: 'session', window: '5h', remainingFraction: 0.86 }, { bucketId: 'weekly', window: 'weekly', remainingFraction: 0.93 }] }
          ]
        };
      }
      throw new Error('unknown_server');
    }
  });

  const result = await provider.fetch({ id: 'antigravity:current' });

  // Both Gemini windows must be captured!
  assert.equal(result.windows.some(w => w.scope.includes('Gemini') && w.labelKey === 'labelNHours'), true);
  assert.equal(result.windows.some(w => w.scope.includes('Gemini') && w.labelKey === 'labelWeekly'), true);

  // Claude and GPT models must NOT be duplicated (only 1 session, 1 weekly for claude-gpt)
  const claudeSessionWindows = result.windows.filter(w => w.scope.includes('Claude and GPT') && w.labelKey === 'labelNHours');
  assert.equal(claudeSessionWindows.length, 1);
  // Conservative remaining percentage chosen (0.90 vs 1.0 -> 90%)
  assert.equal(claudeSessionWindows[0].remainingPercent, 90);

  // Total distinct windows: 2 for claude-gpt + 2 for gemini = 4
  assert.equal(result.windows.length, 4);
});

test('multiple servers split accounts by e-mail and merge windows by reset period', async () => {
  const { createAntigravityProvider } = require('../src/providers/antigravity.cjs');

  const serverWork = { pid: 1001, csrfToken: 'tok1', ports: [4001], sourceKind: 'app' };
  const serverPersonal = { pid: 1002, csrfToken: 'tok2', ports: [4002], sourceKind: 'app' };

  // 1. Multi-account discovery test with distinct emails
  const multiProvider = createAntigravityProvider({
    platform: 'darwin',
    discoverAntigravityServers: async () => [serverWork, serverPersonal],
    requestLocalJson: async (server) => {
      if (server.pid === 1001) {
        return {
          userStatus: { email: 'work@corp.com' },
          groups: [{ id: 'cg', displayName: 'Claude and GPT', buckets: [{ bucketId: 'session', window: '5h', remainingFraction: 0.85 }] }]
        };
      }
      return {
        userStatus: { email: 'personal@gmail.com' },
        groups: [{ id: 'cg', displayName: 'Claude and GPT', buckets: [{ bucketId: 'session', window: '5h', remainingFraction: 0.15 }] }]
      };
    }
  });

  const discovered = await multiProvider.discover();
  assert.equal(discovered.length, 2);
  assert.equal(discovered[0].email, 'work@corp.com');
  assert.equal(discovered[1].email, 'personal@gmail.com');

  // Fetch for work account only gets work server quota
  const workQuota = await multiProvider.fetch({ id: 'antigravity:work@corp.com', email: 'work@corp.com' });
  assert.equal(workQuota.windows[0].remainingPercent, 85);

  // 2. Atomic window merging test: server A has fresher resetTime (future period), server B has stale 5% cache
  const serverFresh = { pid: 2001, csrfToken: 'fresh', ports: [5001], sourceKind: 'ide' };
  const serverStale = { pid: 2002, csrfToken: 'stale', ports: [5002], sourceKind: 'app' };

  const mergeProvider = createAntigravityProvider({
    platform: 'darwin',
    discoverAntigravityServers: async () => [serverFresh, serverStale],
    requestLocalJson: async (server) => {
      if (server.pid === 2001) {
        // Fresh reset window: next week, 95% remaining
        return {
          userStatus: { email: 'same@user.com' },
          groups: [{
            id: 'cg',
            displayName: 'Claude and GPT',
            buckets: [{
              bucketId: 'session',
              window: '5h',
              remainingFraction: 0.95,
              resetTime: '2026-10-23T18:00:00Z'
            }]
          }]
        };
      }
      // Stale cache prior to reset: last week, 5% remaining
      return {
        userStatus: { email: 'same@user.com' },
        groups: [{
          id: 'cg',
          displayName: 'Claude and GPT',
          buckets: [{
            bucketId: 'session',
            window: '5h',
            remainingFraction: 0.05,
            resetTime: '2026-10-16T18:00:00Z'
          }]
        }]
      };
    }
  });

  const merged = await mergeProvider.fetch({ id: 'antigravity:current' });
  assert.equal(merged.windows.length, 1);
  // Must choose the fresher resetTime (2026-10-23) atomically with its 95% quota, NOT the stale 5%!
  assert.equal(merged.windows[0].remainingPercent, 95);
  assert.equal(merged.windows[0].resetsAt, new Date('2026-10-23T18:00:00Z').toISOString());
});

test('going from one to two accounts never mixes their quota', async () => {
  const { createAntigravityProvider, antigravityAccountId } = require('../src/providers/antigravity.cjs');

  const serverWork = { pid: 101, csrfToken: 'tok1', ports: [6101], sourceKind: 'ide' };
  const serverPersonal = { pid: 102, csrfToken: 'tok2', ports: [6102], sourceKind: 'app' };

  // 1. Initial state: only 1 server (work@corp.com) running
  const provider = createAntigravityProvider({
    platform: 'darwin',
    discoverAntigravityServers: async () => [serverWork, serverPersonal],
    requestLocalJson: async (server) => {
      if (server.pid === 101) {
        return {
          userStatus: { email: 'work@corp.com' },
          groups: [{ id: 'cg', displayName: 'Claude and GPT', buckets: [{ bucketId: 'session', window: '5h', remainingFraction: 0.90 }] }]
        };
      }
      return {
        userStatus: { email: 'personal@gmail.com' },
        groups: [{ id: 'cg', displayName: 'Claude and GPT', buckets: [{ bucketId: 'session', window: '5h', remainingFraction: 0.10 }] }]
      };
    }
  });

  // Discovery returns stable IDs with email
  const accounts = await provider.discover();
  assert.equal(accounts.length, 2);
  assert.equal(accounts[0].id, antigravityAccountId('work@corp.com'));
  assert.equal(accounts[1].id, antigravityAccountId('personal@gmail.com'));

  // Fetch for work account returns strictly work quota (90%), never polluted by personal (10%)
  const workQuota = await provider.fetch({ id: antigravityAccountId('work@corp.com'), email: 'work@corp.com' });
  assert.equal(workQuota.windows[0].remainingPercent, 90);

  // Ambiguity protection: fetching a legacy account without email refuses to merge multiple accounts
  await assert.rejects(
    () => provider.fetch({ id: 'antigravity:current' }),
    /unsupported_profile/
  );
});

test('a quota summary without identity is tied to its account through the status call', async () => {
  const { createAntigravityProvider, antigravityAccountId } = require('../src/providers/antigravity.cjs');

  const serverWork = { pid: 801, csrfToken: 'tok1', ports: [8101], sourceKind: 'ide' };
  const serverPersonal = { pid: 802, csrfToken: 'tok2', ports: [8102], sourceKind: 'app' };

  const provider = createAntigravityProvider({
    platform: 'darwin',
    discoverAntigravityServers: async () => [serverWork, serverPersonal],
    requestLocalJson: async (server, port, method) => {
      // GetUserStatus reports identity
      if (method === 'GetUserStatus') {
        if (server.pid === 801) return { code: 'ok', userStatus: { email: 'work@corp.com' } };
        if (server.pid === 802) return { code: 'ok', userStatus: { email: 'personal@gmail.com' } };
      }
      // RetrieveUserQuotaSummary has NO email field whatsoever ("summary without identity")
      if (method === 'RetrieveUserQuotaSummary') {
        if (server.pid === 801) {
          return { code: 'ok', groups: [{ id: 'cg', displayName: 'Claude and GPT', buckets: [{ bucketId: 'session', window: '5h', remainingFraction: 0.92 }] }] };
        }
        if (server.pid === 802) {
          return { code: 'ok', groups: [{ id: 'cg', displayName: 'Claude and GPT', buckets: [{ bucketId: 'session', window: '5h', remainingFraction: 0.22 }] }] };
        }
      }
      throw new Error('unexpected_method');
    }
  });

  const targetWorkId = antigravityAccountId('work@corp.com');
  const workQuota = await provider.fetch({ id: targetWorkId, email: 'work@corp.com' });
  assert.equal(workQuota.windows[0].remainingPercent, 92);

  const targetPersonalId = antigravityAccountId('personal@gmail.com');
  const personalQuota = await provider.fetch({ id: targetPersonalId, email: 'personal@gmail.com' });
  assert.equal(personalQuota.windows[0].remainingPercent, 22);

  // An account with nonexistent email correctly throws auth_missing
  await assert.rejects(
    () => provider.fetch({ id: antigravityAccountId('other@unknown.com'), email: 'other@unknown.com' }),
    /auth_missing/
  );
});

test('discovery fails closed when any server cannot be identified', async () => {
  const { createAntigravityProvider } = require('../src/providers/antigravity.cjs');
  const server1 = { pid: 101, csrfToken: 'tok1', ports: [3101], sourceKind: 'app' };
  const server2 = { pid: 202, csrfToken: 'tok2', ports: [3202], sourceKind: 'ide' };

  const provider = createAntigravityProvider({
    platform: 'darwin',
    discoverAntigravityServers: async () => [server1, server2],
    requestLocalJson: async (server, port, method) => {
      if (server.pid === 101) return { userStatus: { email: 'user1@company.com' } };
      // Server 2 fails transport or returns no email
      throw new Error('connection_refused');
    }
  });

  await assert.rejects(
    async () => await provider.discover(),
    { code: 'local_service_unavailable' }
  );
});

test('windows are not merged while any server lacks a verified identity', async () => {
  const { createAntigravityProvider } = require('../src/providers/antigravity.cjs');
  const server1 = { pid: 101, csrfToken: 'tok1', ports: [3101], sourceKind: 'app' };
  const server2 = { pid: 202, csrfToken: 'tok2', ports: [3202], sourceKind: 'ide' };

  const provider = createAntigravityProvider({
    platform: 'darwin',
    discoverAntigravityServers: async () => [server1, server2],
    requestLocalJson: async (server, port, method) => {
      if (server.pid === 101) {
        if (method === 'GetUserStatus') return { userStatus: { email: 'dev@company.com' } };
        return { groups: [{ id: 'claude-gpt', displayName: 'Claude and GPT', buckets: [{ bucketId: 'session', window: '5h', remainingFraction: 1.0 }] }] };
      }
      if (server.pid === 202) {
        // IDE responds with quota but GetUserStatus has no email
        if (method === 'GetUserStatus') return { userStatus: { email: null } };
        return { groups: [{ id: 'gemini', displayName: 'Gemini', buckets: [{ bucketId: 'weekly', window: 'weekly', remainingFraction: 0.9 }] }] };
      }
    }
  });

  // Multiple servers running, but one cannot resolve identity -> fail closed
  await assert.rejects(
    async () => await provider.fetch({ id: 'antigravity:current' }),
    { code: 'local_service_unavailable' }
  );
});

test('identity lookup continues on the next port', async () => {
  const { createAntigravityProvider } = require('../src/providers/antigravity.cjs');
  // Server with two ports: port 3101 has no email, port 3102 has email
  const server = { pid: 101, csrfToken: 'tok1', ports: [3101, 3102], sourceKind: 'app' };

  const provider = createAntigravityProvider({
    platform: 'darwin',
    discoverAntigravityServers: async () => [server],
    requestLocalJson: async (s, port, method) => {
      if (port === 3101) {
        if (method === 'GetUserStatus') return { userStatus: { email: null } };
        return { groups: [] };
      }
      if (port === 3102) {
        if (method === 'GetUserStatus') return { userStatus: { email: 'dev@test.com' } };
        return { groups: [{ id: 'claude-gpt', displayName: 'Claude and GPT', buckets: [{ bucketId: 'session', window: '5h', remainingFraction: 0.8 }] }] };
      }
    }
  });

  const result = await provider.fetch({ id: 'antigravity:current', email: 'dev@test.com' });
  assert.equal(result.windows.length, 1);
  assert.equal(result.windows[0].remainingPercent, 80);
});
