import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { ProviderError } from '../src/core/errors.ts';
import {
  antigravityAccountId,
  antigravityProfile,
  antigravityProfileFolders,
  antigravityTokenPath,
  createAntigravityProfileFolder,
  createAntigravityProvider,
  isSignedInAntigravityProfile,
  parseAntigravityTokenDocument,
  type LanguageServer,
  type RequestLocalJson
} from '../src/providers/antigravity.ts';
import { QUOTA_ENDPOINTS, type PostJson, type RunProcess } from '../src/providers/common.ts';
import { account, tempDir, windowsOf } from './helpers/fixtures.ts';

const server = (pid: number, csrfToken: string, ports: number[]): LanguageServer => ({
  pid,
  csrfToken,
  ports
});
const bucket = (id: string, window: string, remainingFraction: number, resetTime?: string) => ({
  bucketId: id,
  window,
  remainingFraction,
  ...(resetTime ? { resetTime } : {})
});
const group = (id: string, displayName: string, buckets: object[]) => ({ id, displayName, buckets });
const status = (email: string | null) => ({ userStatus: { email } });
const accountWithoutEmail = account({ id: 'antigravity:current', providerId: 'antigravity' });
const emailAccount = (email: string) => account({ id: antigravityAccountId(email), providerId: 'antigravity', email });

function provider(servers: LanguageServer[], requestLocalJson: RequestLocalJson) {
  return createAntigravityProvider({ platform: 'darwin', discoverAntigravityServers: () => Promise.resolve(servers), requestLocalJson });
}

test('fetch merges app and IDE servers without double-counting windows', async () => {
  const runProcess: RunProcess = binary => {
    if (binary === '/bin/ps')
      return Promise.resolve(
        [
          '101 501 /Applications/Antigravity.app/Contents/Resources/bin/language_server --csrf_token=app-token',
          '202 501 /Applications/Antigravity IDE.app/Contents/Resources/extensions/antigravity/bin/language_server_macos --app_data_dir antigravity-ide --csrf_token=ide-token'
        ].join('\n')
      );
    if (binary === '/usr/sbin/lsof')
      return Promise.resolve(
        'COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\nlanguage 101 owner 8u IPv4 0t0 TCP 127.0.0.1:3101 (LISTEN)\nlanguage 202 owner 8u IPv4 0t0 TCP 127.0.0.1:3202 (LISTEN)'
      );
    return Promise.reject(new Error('unexpected_process'));
  };
  const claudeAndGpt = (session: number, weekly: number) =>
    group('claude-gpt', 'Claude and GPT models', [bucket('session', '5h', session), bucket('weekly', 'weekly', weekly)]);
  const adapter = createAntigravityProvider({
    platform: 'darwin',
    currentUid: 501,
    runProcess,
    requestLocalJson: (target, _port, method) => {
      if (method === 'GetUserStatus') return Promise.resolve(status('dev@company.com'));
      // The app reports only Claude and GPT models; the IDE reports Gemini as well.
      if (target.pid === 101) return Promise.resolve({ groups: [claudeAndGpt(1.0, 1.0)] });
      return Promise.resolve({
        groups: [
          claudeAndGpt(0.9, 0.95),
          group('gemini', 'Gemini Models', [bucket('session', '5h', 0.86), bucket('weekly', 'weekly', 0.93)])
        ]
      });
    }
  });

  const windows = windowsOf(await adapter.fetch(accountWithoutEmail));
  const gemini = windows.filter(w => w.scope?.includes('Gemini'));
  assert.deepEqual(gemini.map(w => w.labelKey).sort(), ['labelNHours', 'labelWeekly']);
  const claudeSessions = windows.filter(w => w.scope?.includes('Claude and GPT') && w.labelKey === 'labelNHours');
  assert.equal(claudeSessions.length, 1, 'a window both servers report is counted once');
  assert.equal(claudeSessions[0]?.remainingPercent, 90, 'the lower reading of the same period wins');
  assert.equal(windows.length, 4);
});

test('multiple servers split accounts by e-mail and merge windows by reset period', async () => {
  const quota = (remaining: number) => ({ groups: [group('cg', 'Claude and GPT', [bucket('session', '5h', remaining)])] });
  const accounts = provider([server(1001, 'tok1', [4001]), server(1002, 'tok2', [4002])], target =>
    Promise.resolve(
      target.pid === 1001 ? { ...status('work@corp.com'), ...quota(0.85) } : { ...status('personal@gmail.com'), ...quota(0.15) }
    )
  );
  const discovery = await accounts.discover();
  assert.ok(!Array.isArray(discovery) && discovery.kind === 'complete');
  const discovered = discovery.accounts;
  assert.deepEqual(
    discovered.map(a => a.email),
    ['work@corp.com', 'personal@gmail.com']
  );
  assert.equal(windowsOf(await accounts.fetch(emailAccount('work@corp.com')))[0]?.remainingPercent, 85);

  // One server reports the new period, the other a cached reading from the previous one.
  const fresh = { groups: [group('cg', 'Claude and GPT', [bucket('session', '5h', 0.95, '2026-10-23T18:00:00Z')])] };
  const cached = { groups: [group('cg', 'Claude and GPT', [bucket('session', '5h', 0.05, '2026-10-16T18:00:00Z')])] };
  const merging = provider([server(2001, 'fresh', [5001]), server(2002, 'stale', [5002])], target =>
    Promise.resolve({ ...status('same@user.com'), ...(target.pid === 2001 ? fresh : cached) })
  );
  const merged = windowsOf(await merging.fetch(accountWithoutEmail));
  assert.equal(merged.length, 1);
  assert.equal(merged[0]?.remainingPercent, 95, 'the newer period wins together with its value');
  assert.equal(merged[0].resetsAt, '2026-10-23T18:00:00.000Z');
});

test('going from one to two accounts never mixes their quota', async () => {
  const quota = (remaining: number) => ({ groups: [group('cg', 'Claude and GPT', [bucket('session', '5h', remaining)])] });
  const adapter = provider([server(101, 'tok1', [6101]), server(102, 'tok2', [6102])], target =>
    Promise.resolve(target.pid === 101 ? { ...status('work@corp.com'), ...quota(0.9) } : { ...status('personal@gmail.com'), ...quota(0.1) })
  );
  const discovery = await adapter.discover();
  assert.ok(!Array.isArray(discovery) && discovery.kind === 'complete');
  assert.deepEqual(
    discovery.accounts.map(a => a.id),
    [antigravityAccountId('work@corp.com'), antigravityAccountId('personal@gmail.com')]
  );
  assert.equal(windowsOf(await adapter.fetch(emailAccount('work@corp.com')))[0]?.remainingPercent, 90);
  await assert.rejects(adapter.fetch(accountWithoutEmail), /unsupported_profile/, 'an account without an e-mail never merges two accounts');
});

test('a quota summary without identity is tied to its account through the status call', async () => {
  const emails: Record<number, string> = { 801: 'work@corp.com', 802: ' Personal@Gmail.com ' };
  const remaining: Record<number, number> = { 801: 0.92, 802: 0.22 };
  const adapter = provider([server(801, 'tok1', [8101]), server(802, 'tok2', [8102])], (target, _port, method) =>
    Promise.resolve(
      method === 'GetUserStatus'
        ? { code: 'ok', ...status(emails[target.pid] ?? null) }
        : { code: 'ok', groups: [group('cg', 'Claude and GPT', [bucket('session', '5h', remaining[target.pid] ?? 0)])] }
    )
  );
  assert.equal(windowsOf(await adapter.fetch(emailAccount('work@corp.com')))[0]?.remainingPercent, 92);
  assert.equal(
    windowsOf(await adapter.fetch(emailAccount('personal@gmail.com')))[0]?.remainingPercent,
    22,
    'the reported address is matched case-insensitively'
  );
  await assert.rejects(adapter.fetch(emailAccount('other@unknown.com')), /auth_missing/);
});

test('conflicting status and quota identities fail closed even when status has valid fallback quota', async t => {
  const statusWithFallback = {
    userStatus: {
      email: ' First@Example.com ',
      cascadeModelConfigData: {
        clientModelConfigs: [{ modelId: 'model-a', label: 'Model A', quotaInfo: { remainingFraction: 0.8 } }]
      }
    }
  };
  for (const malformed of [false, true]) {
    await t.test(
      malformed ? 'malformed quota cannot hide the identity mismatch' : 'valid quota belongs to a different account',
      async () => {
        let calls = 0;
        const adapter = provider([server(101, 'synthetic-token', [3101, 3102])], (_server, _port, method) => {
          calls++;
          return Promise.resolve(
            method === 'GetUserStatus'
              ? statusWithFallback
              : {
                  email: 'second@example.com',
                  groups: malformed ? 'unsupported' : [group('models', 'Models', [bucket('session', '5h', 0.91)])]
                }
          );
        });
        await assert.rejects(adapter.fetch(emailAccount('first@example.com')), { code: 'invalid_response' });
        assert.equal(calls, 2, 'identity mismatch neither accepts cached status quota nor retries another port');
      }
    );
  }
  const matching = provider([server(101, 'synthetic-token', [3101])], (_server, _port, method) =>
    Promise.resolve(
      method === 'GetUserStatus'
        ? statusWithFallback
        : {
            email: 'FIRST@example.com',
            groups: [group('models', 'Models', [bucket('session', '5h', 0.91)])]
          }
    )
  );
  assert.equal(windowsOf(await matching.fetch(emailAccount('first@example.com')))[0]?.remainingPercent, 91);
});

test('discovery fails closed when any server cannot be identified', async () => {
  const adapter = provider([server(101, 'tok1', [3101]), server(202, 'tok2', [3202])], target =>
    target.pid === 101 ? Promise.resolve(status('user1@company.com')) : Promise.reject(new Error('connection_refused'))
  );
  assert.deepEqual(await adapter.discover(), { kind: 'unknown', accounts: [] });
});

test('windows are not merged while any server lacks a verified identity', async () => {
  const adapter = provider([server(101, 'tok1', [3101]), server(202, 'tok2', [3202])], (target, _port, method) => {
    if (method === 'GetUserStatus') return Promise.resolve(status(target.pid === 101 ? 'dev@company.com' : null));
    return Promise.resolve({ groups: [group('claude-gpt', 'Claude and GPT', [bucket('session', '5h', 1.0)])] });
  });
  await assert.rejects(adapter.fetch(accountWithoutEmail), { code: 'local_service_unavailable' });
});

test('identity lookup continues on the next port', async () => {
  const adapter = provider([server(101, 'tok1', [3101, 3102])], (_target, port, method) => {
    if (method === 'GetUserStatus') return Promise.resolve(status(port === 3102 ? 'dev@test.com' : null));
    return Promise.resolve({ groups: port === 3102 ? [group('claude-gpt', 'Claude and GPT', [bucket('session', '5h', 0.8)])] : [] });
  });
  const windows = windowsOf(await adapter.fetch(emailAccount('dev@test.com')));
  assert.equal(windows.length, 1);
  assert.equal(windows[0]?.remainingPercent, 80);
});

test('isolated Antigravity profiles discover, read quota from cloudcode-pa and stay isolated from closed local servers', async t => {
  const home = await tempDir(t, 'vibe-agy-profiles-');
  // Sibling backup folders are ignored; numbered profile folders are created and reused when free.
  await fs.mkdir(path.join(home, '.antigravity-backup'));
  const dir2 = await createAntigravityProfileFolder(home, () => Promise.resolve(true));
  assert.equal(path.basename(dir2), '.antigravity-2');
  assert.equal(await isSignedInAntigravityProfile(dir2), false);

  const now = Date.parse('2026-10-20T12:00:00Z');
  const tokenDoc = {
    token: {
      access_token: 'fixture-access-token',
      refresh_token: 'fixture-refresh-token',
      expiry: '2026-10-20T13:00:00Z'
    },
    id_token_email: 'Work@Example.com',
    auth_method: 'consumer'
  };
  await fs.writeFile(antigravityTokenPath(dir2), JSON.stringify(tokenDoc));
  assert.equal(await isSignedInAntigravityProfile(dir2), true);
  assert.equal(parseAntigravityTokenDocument(tokenDoc)?.email, 'work@example.com');
  assert.deepEqual(await antigravityProfileFolders(home), [dir2]);

  const dir3 = await createAntigravityProfileFolder(home, async d => !(await isSignedInAntigravityProfile(d)));
  assert.equal(path.basename(dir3), '.antigravity-3');

  const calls: { endpoint: string; body: unknown; headers?: Record<string, string> }[] = [];
  const postJson: PostJson = (endpoint, options) => {
    calls.push({ endpoint, body: options?.body, ...(options?.headers ? { headers: options.headers } : {}) });
    if (endpoint === QUOTA_ENDPOINTS.antigravityLoadCodeAssist)
      return Promise.resolve({ cloudaicompanionProject: 'proj-123', paidTier: { id: 'g1-pro-tier', name: 'Pro' } });
    if (endpoint === QUOTA_ENDPOINTS.antigravityQuotaSummary)
      return Promise.resolve({
        groups: [group('gemini', 'Gemini Models', [bucket('gemini-5h', '5h', 0.72), bucket('gemini-weekly', 'weekly', 0.88)])]
      });
    return Promise.reject(new Error('unexpected endpoint'));
  };

  // Even when the local app is closed, isolated profiles still discover and fetch quota.
  const adapter = createAntigravityProvider({
    home,
    clock: () => now,
    postJson,
    discoverAntigravityServers: () => Promise.reject(new ProviderError('app_closed'))
  });
  const discovery = await adapter.discover();
  assert.ok(!Array.isArray(discovery) && discovery.kind === 'complete');
  assert.equal(discovery.accounts.length, 1);
  const [discovered] = discovery.accounts;
  assert.ok(discovered);
  assert.equal(discovered.configDir, dir2);
  assert.equal(discovered.label, 'work@example.com');

  const profileAccount = antigravityProfile(dir2, 'work@example.com');
  const result = await adapter.fetch(profileAccount);
  assert.equal(result.plan, 'pro');
  assert.equal(result.signedInAs, 'work@example.com');
  assert.equal(result.windows.length, 2);
  const [firstWindow] = result.windows;
  assert.ok(firstWindow);
  assert.equal(firstWindow.remainingPercent, 72);
  assert.equal(firstWindow.detailKey, undefined, 'cloud readings do not claim local service');
  assert.deepEqual(
    calls.map(c => c.endpoint),
    [QUOTA_ENDPOINTS.antigravityLoadCodeAssist, QUOTA_ENDPOINTS.antigravityQuotaSummary]
  );
  assert.match(calls[0]?.headers?.['User-Agent'] ?? '', /^antigravity\//);
  assert.equal((calls[0]?.body as { metadata?: { ideType?: string } } | undefined)?.metadata?.ideType, 'ANTIGRAVITY');

  // When local server discovery fails transiently, isolated profiles are still returned as unknown (partial) discovery
  // so pending sign-ins still promote to user accounts without dropping vanished local accounts.
  const degradedLocal = createAntigravityProvider({
    home,
    clock: () => now,
    postJson,
    discoverAntigravityServers: () => Promise.reject(new ProviderError('local_service_unavailable'))
  });
  const degradedDiscovery = await degradedLocal.discover();
  assert.ok(!Array.isArray(degradedDiscovery) && degradedDiscovery.kind === 'unknown');
  assert.equal(degradedDiscovery.accounts.length, 1);
  assert.equal(degradedDiscovery.accounts[0]?.id, profileAccount.id);

  // Deduplicates a local server running the same e-mail as an isolated profile, and merges extra local quota groups.
  const mixed = createAntigravityProvider({
    home,
    clock: () => now,
    postJson,
    discoverAntigravityServers: () => Promise.resolve([server(501, 'tok', [5101])]),
    requestLocalJson: (_target, _port, method) =>
      Promise.resolve(
        method === 'GetUserStatus'
          ? status('work@example.com')
          : {
              groups: [
                group('claude-gpt', 'Claude and GPT models', [bucket('3p-weekly', 'weekly', 0.95)]),
                group('gemini', 'Gemini Models', [bucket('gemini-5h', '5h', 0.65)])
              ]
            }
      )
  });
  const mixedDiscovery = await mixed.discover();
  assert.ok(!Array.isArray(mixedDiscovery) && mixedDiscovery.kind === 'complete');
  assert.equal(mixedDiscovery.accounts.length, 1, 'does not duplicate the same e-mail across local and isolated');

  const mixedReadings = await mixed.fetchAll?.([profileAccount, emailAccount('other@example.com')], {
    deadline: Date.now() + 30_000,
    signal: new AbortController().signal
  });
  const enriched = mixedReadings?.get(profileAccount.id);
  assert.ok(enriched && enriched.kind !== 'failed');
  assert.equal(enriched.result.windows.length, 3, 'merges extra groups from a matching-email local hub');
  assert.equal(mixedReadings?.get(antigravityAccountId('other@example.com'))?.kind, 'failed');

  // Expired access tokens fail fast with auth_expired so background renewal can run.
  const expired = createAntigravityProvider({
    home,
    clock: () => Date.parse('2026-10-20T13:05:00Z'),
    postJson
  });
  await assert.rejects(expired.fetch(profileAccount), { code: 'auth_expired' });
});

test('an isolated profile is marked as the active login only when the local service runs with its sign-in', async t => {
  const home = await tempDir(t, 'vibe-agy-active-');
  const dir = await createAntigravityProfileFolder(home, () => Promise.resolve(true));
  const now = Date.parse('2026-10-20T12:00:00Z');
  await fs.writeFile(
    antigravityTokenPath(dir),
    JSON.stringify({
      token: { access_token: 'fixture-access-token', refresh_token: 'fixture-refresh-token', expiry: '2026-10-20T13:00:00Z' },
      id_token_email: 'work@example.com',
      auth_method: 'consumer'
    })
  );
  const postJson: PostJson = endpoint =>
    Promise.resolve(
      endpoint === QUOTA_ENDPOINTS.antigravityLoadCodeAssist
        ? { cloudaicompanionProject: 'proj-1' }
        : { groups: [group('gemini', 'Gemini Models', [bucket('gemini-5h', '5h', 0.5)])] }
    );
  const profile = antigravityProfile(dir, 'work@example.com');
  const context = { deadline: Date.now() + 30_000, signal: new AbortController().signal };
  const localAs = (email: string | null) =>
    createAntigravityProvider({
      home,
      clock: () => now,
      postJson,
      discoverAntigravityServers: () => Promise.resolve([server(501, 'tok', [5101])]),
      requestLocalJson: (_target, _port, method) =>
        Promise.resolve(
          method === 'GetUserStatus' ? status(email) : { groups: [group('gemini', 'Gemini Models', [bucket('gemini-5h', '5h', 0.4)])] }
        )
    });
  const readingOf = async (adapter: ReturnType<typeof createAntigravityProvider>) => {
    const reading = (await adapter.fetchAll?.([profile], context))?.get(profile.id);
    assert.ok(reading && reading.kind !== 'failed', 'the cloud reading of the profile still succeeds');
    // Asking the hub who it is never changes what the profile's quota says: that stays the cloud's 50%.
    assert.deepEqual(
      reading.result.windows.map(w => w.remainingPercent),
      [50]
    );
    return reading.result;
  };
  const activeOf = async (adapter: ReturnType<typeof createAntigravityProvider>) => (await readingOf(adapter)).activeLogin;

  // Only a profile: the hub is still asked who it is signed in as.
  assert.equal(await activeOf(localAs('Work@Example.com')), true);
  assert.equal(await activeOf(localAs('someone-else@example.com')), undefined, 'another login is running');
  assert.equal(await activeOf(localAs(null)), undefined, 'an unidentified service proves nothing');
  const closed = createAntigravityProvider({
    home,
    clock: () => now,
    postJson,
    discoverAntigravityServers: () => Promise.reject(new ProviderError('app_closed'))
  });
  assert.equal(await activeOf(closed), undefined, 'no running service, no active login');
  const broken = createAntigravityProvider({
    home,
    clock: () => now,
    postJson,
    discoverAntigravityServers: () => Promise.resolve([server(501, 'tok', [5101])]),
    requestLocalJson: () => Promise.reject(new ProviderError('local_service_unavailable'))
  });
  assert.equal(await activeOf(broken), undefined, 'a failing service leaves the profile reading as it was');
});
