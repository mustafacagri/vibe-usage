import assert from 'node:assert/strict';
import test from 'node:test';
import {
  antigravityAccountId,
  createAntigravityProvider,
  type LanguageServer,
  type RequestLocalJson
} from '../src/providers/antigravity.ts';
import type { RunProcess } from '../src/providers/common.ts';
import { account, windowsOf } from './helpers/fixtures.ts';

const server = (pid: number, csrfToken: string, ports: number[], sourceKind: LanguageServer['sourceKind'] = 'app'): LanguageServer => ({
  pid,
  csrfToken,
  ports,
  sourceKind
});
const bucket = (id: string, window: string, remainingFraction: number, resetTime?: string) => ({
  bucketId: id,
  window,
  remainingFraction,
  ...(resetTime ? { resetTime } : {})
});
const group = (id: string, displayName: string, buckets: object[]) => ({ id, displayName, buckets });
const status = (email: string | null) => ({ userStatus: { email } });
const legacyAccount = account({ id: 'antigravity:current', providerId: 'antigravity' });
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

  const windows = windowsOf(await adapter.fetch(legacyAccount));
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
  const discovered = await accounts.discover();
  assert.deepEqual(
    discovered.map(a => a.email),
    ['work@corp.com', 'personal@gmail.com']
  );
  assert.equal(windowsOf(await accounts.fetch(emailAccount('work@corp.com')))[0]?.remainingPercent, 85);

  // One server reports the new period, the other a cached reading from the previous one.
  const fresh = { groups: [group('cg', 'Claude and GPT', [bucket('session', '5h', 0.95, '2026-10-23T18:00:00Z')])] };
  const cached = { groups: [group('cg', 'Claude and GPT', [bucket('session', '5h', 0.05, '2026-10-16T18:00:00Z')])] };
  const merging = provider([server(2001, 'fresh', [5001], 'ide'), server(2002, 'stale', [5002])], target =>
    Promise.resolve({ ...status('same@user.com'), ...(target.pid === 2001 ? fresh : cached) })
  );
  const merged = windowsOf(await merging.fetch(legacyAccount));
  assert.equal(merged.length, 1);
  assert.equal(merged[0]?.remainingPercent, 95, 'the newer period wins together with its value');
  assert.equal(merged[0].resetsAt, '2026-10-23T18:00:00.000Z');
});

test('going from one to two accounts never mixes their quota', async () => {
  const quota = (remaining: number) => ({ groups: [group('cg', 'Claude and GPT', [bucket('session', '5h', remaining)])] });
  const adapter = provider([server(101, 'tok1', [6101], 'ide'), server(102, 'tok2', [6102])], target =>
    Promise.resolve(target.pid === 101 ? { ...status('work@corp.com'), ...quota(0.9) } : { ...status('personal@gmail.com'), ...quota(0.1) })
  );
  assert.deepEqual(
    (await adapter.discover()).map(a => a.id),
    [antigravityAccountId('work@corp.com'), antigravityAccountId('personal@gmail.com')]
  );
  assert.equal(windowsOf(await adapter.fetch(emailAccount('work@corp.com')))[0]?.remainingPercent, 90);
  await assert.rejects(adapter.fetch(legacyAccount), /unsupported_profile/, 'an account without an e-mail never merges two accounts');
});

test('a quota summary without identity is tied to its account through the status call', async () => {
  const emails: Record<number, string> = { 801: 'work@corp.com', 802: 'personal@gmail.com' };
  const remaining: Record<number, number> = { 801: 0.92, 802: 0.22 };
  const adapter = provider([server(801, 'tok1', [8101], 'ide'), server(802, 'tok2', [8102])], (target, _port, method) =>
    Promise.resolve(
      method === 'GetUserStatus'
        ? { code: 'ok', ...status(emails[target.pid] ?? null) }
        : { code: 'ok', groups: [group('cg', 'Claude and GPT', [bucket('session', '5h', remaining[target.pid] ?? 0)])] }
    )
  );
  assert.equal(windowsOf(await adapter.fetch(emailAccount('work@corp.com')))[0]?.remainingPercent, 92);
  assert.equal(windowsOf(await adapter.fetch(emailAccount('personal@gmail.com')))[0]?.remainingPercent, 22);
  await assert.rejects(adapter.fetch(emailAccount('other@unknown.com')), /auth_missing/);
});

test('discovery fails closed when any server cannot be identified', async () => {
  const adapter = provider([server(101, 'tok1', [3101]), server(202, 'tok2', [3202], 'ide')], target =>
    target.pid === 101 ? Promise.resolve(status('user1@company.com')) : Promise.reject(new Error('connection_refused'))
  );
  await assert.rejects(adapter.discover(), { code: 'local_service_unavailable' });
});

test('windows are not merged while any server lacks a verified identity', async () => {
  const adapter = provider([server(101, 'tok1', [3101]), server(202, 'tok2', [3202], 'ide')], (target, _port, method) => {
    if (method === 'GetUserStatus') return Promise.resolve(status(target.pid === 101 ? 'dev@company.com' : null));
    return Promise.resolve({ groups: [group('claude-gpt', 'Claude and GPT', [bucket('session', '5h', 1.0)])] });
  });
  await assert.rejects(adapter.fetch(legacyAccount), { code: 'local_service_unavailable' });
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
