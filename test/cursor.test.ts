import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import type { ClientRequest, IncomingMessage } from 'node:http';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createService } from '../src/core/service.ts';
import { getJson, type GetJsonOptions, type RunProcess } from '../src/providers/common.ts';
import { createCursorProvider, type CursorProviderOptions } from '../src/providers/cursor.ts';
import { account, tempDir } from './helpers/fixtures.ts';

const NOW = 1_000_000_000_000;
const jwt = (claims: object): string => ['header', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'signature'].join('.');
const valid = jwt({ sub: 'auth0|user_123', exp: NOW / 1000 + 3600 });
const cursorAccount = account({ id: 'cursor:default', providerId: 'cursor' });
const summary = { membershipType: 'pro', individualUsage: { plan: { autoPercentUsed: 10, apiPercentUsed: 0, totalPercentUsed: 5 } } };

// The macOS token store answers through sqlite3; `token` is what the query prints.
function macProvider(token: string, requests: GetJsonOptions[] = [], extra: CursorProviderOptions = {}) {
  const runProcess: RunProcess = (binary, args) => {
    assert.equal(binary, '/usr/bin/sqlite3');
    assert.ok(args.includes('-readonly'), 'the database is opened read-only');
    assert.match(args[1] ?? '', /\?mode=ro$/);
    return Promise.resolve(`${token}\n`);
  };
  return createCursorProvider({
    platform: 'darwin',
    home: '/Users/me',
    clock: () => NOW,
    runProcess,
    getJson: (_endpoint, options = {}) => {
      requests.push(options);
      return Promise.resolve(summary);
    },
    ...extra
  });
}

test('the session cookie is built from the token subject and sent only to the usage summary', async () => {
  const requests: GetJsonOptions[] = [];
  const result = await macProvider(valid, requests).fetch(cursorAccount);
  assert.equal(result.plan, 'pro');
  assert.equal(requests[0]?.headers?.Cookie, `WorkosCursorSessionToken=user_123%3A%3A${valid}`);
});

test('missing, expired or malformed tokens fail before any request', async () => {
  const requests: GetJsonOptions[] = [];
  await assert.rejects(macProvider('', requests).fetch(cursorAccount), /auth_missing/);
  await assert.rejects(macProvider(jwt({ sub: 'auth0|user_123', exp: NOW / 1000 - 10 }), requests).fetch(cursorAccount), /auth_expired/);
  await assert.rejects(macProvider(jwt({ sub: 'auth0|user;evil', exp: NOW / 1000 + 3600 }), requests).fetch(cursorAccount), /auth_invalid/);
  await assert.rejects(macProvider(jwt({ sub: 'auth0|user_123' }), requests).fetch(cursorAccount), /auth_invalid/);
  await assert.rejects(macProvider('not-a-jwt', requests).fetch(cursorAccount), /auth_invalid/);
  assert.deepEqual(requests, []);
});

test('an unreadable token store is a failed read, not proof of a missing sign-in', async () => {
  const provider = macProvider(valid, [], { runProcess: () => Promise.reject(new Error('database is locked')) });
  await assert.rejects(provider.fetch(cursorAccount), /process_failed/);
});

test('Windows reads the token from the Cursor app data; other platforms and profiles are unsupported', async t => {
  const appData = await tempDir(t, 'vibe-cursor-appdata-');
  await fs.mkdir(path.join(appData, 'Cursor'));
  await fs.writeFile(path.join(appData, 'Cursor', 'auth.json'), JSON.stringify({ accessToken: valid }));
  const windows = createCursorProvider({
    platform: 'win32',
    env: { APPDATA: appData },
    clock: () => NOW,
    getJson: () => Promise.resolve(summary)
  });
  assert.equal((await windows.fetch(cursorAccount)).plan, 'pro');
  await assert.rejects(createCursorProvider({ platform: 'linux' }).fetch(cursorAccount), /unsupported_platform/);
  await assert.rejects(macProvider(valid).fetch(account({ id: 'cursor:x', providerId: 'cursor', configDir: '/x' })), /unsupported_profile/);
});

test('the macOS read-only URI sees a new token committed only to the live SQLite WAL', async t => {
  const home = await tempDir(t, 'vibe-cursor-wal-');
  const file = path.join(home, 'Library/Application Support/Cursor/User/globalStorage/state.vscdb');
  await fs.mkdir(path.dirname(file), { recursive: true });
  const writer = new DatabaseSync(file);
  writer.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT);');
  writer.prepare('INSERT INTO ItemTable VALUES (?, ?)').run('cursorAuth/accessToken', 'previous-account-token');
  writer.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;');
  writer.prepare('UPDATE ItemTable SET value = ?').run(valid);
  assert.ok((await fs.stat(`${file}-wal`)).size > 0);
  const requests: GetJsonOptions[] = [];
  const provider = macProvider(valid, requests, {
    home,
    runProcess: (_binary, args) => {
      const uri = new URL(args[1] ?? '');
      assert.equal(uri.searchParams.get('mode'), 'ro');
      assert.equal(uri.searchParams.has('immutable'), false, 'a mutable WAL database is never opened as immutable');
      const reader = new DatabaseSync(fileURLToPath(uri), { readOnly: true });
      try {
        const row = reader.prepare(args[2] ?? '').get();
        return Promise.resolve(String(row?.value ?? ''));
      } finally {
        reader.close();
      }
    }
  });
  try {
    assert.equal((await provider.fetch(cursorAccount)).plan, 'pro');
    assert.ok(requests[0]?.headers?.Cookie?.endsWith(valid));
  } finally {
    // Windows cannot remove the temporary directory while the WAL database is open, and
    // cleanup hooks run in registration order, so close before the test ends.
    writer.close();
  }
});

test('a Cursor HTTPS response at 13 seconds fits the shared 25 second refresh budget', async t => {
  const dir = await tempDir(t, 'vibe-cursor-budget-');
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: NOW });
  let answer: ((response: IncomingMessage) => void) | undefined;
  let announce: () => void = () => undefined;
  const requested = new Promise<void>(resolve => {
    announce = resolve;
  });
  let destroyed = false;
  const provider = macProvider(valid, [], {
    getJson: (endpoint, options) =>
      getJson(endpoint, {
        ...options,
        requestImpl: (_url, _options, callback) => {
          answer = callback;
          announce();
          return Object.assign(new EventEmitter(), {
            destroy: () => {
              destroyed = true;
            }
          }) as unknown as ClientRequest;
        }
      })
  });
  const service = await createService({ settingsPath: path.join(dir, 'settings.json'), providers: [provider] });
  const refresh = service.refresh();
  await requested;
  t.mock.timers.tick(13000);
  assert.equal(destroyed, false, 'the service does not cut short the adapter HTTP budget');
  const response = Object.assign(new EventEmitter(), { statusCode: 200, headers: {}, destroy: () => undefined });
  assert.ok(answer);
  answer(response as unknown as IncomingMessage);
  response.emit('data', Buffer.from(JSON.stringify(summary)));
  response.emit('end');
  await refresh;
  assert.equal(service.snapshot().providers[0]?.accounts[0]?.status, 'ok');
});
