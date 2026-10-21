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
import { createCursorProvider, findWindowsCursorAgent, type CursorProviderOptions } from '../src/providers/cursor.ts';
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

test('the Windows Cursor Agent CLI is its newest complete version, started through node.exe', async t => {
  const local = await tempDir(t, 'vibe-cursor-agent-');
  const env = { LOCALAPPDATA: local };
  assert.equal(await findWindowsCursorAgent(env, local), null, 'nothing installed');
  const install = async (directory: string, files: string[]): Promise<void> => {
    await fs.mkdir(directory, { recursive: true });
    for (const file of files) await fs.writeFile(path.join(directory, file), '');
  };
  const versions = path.join(local, 'cursor-agent', 'versions');
  await install(path.join(versions, '2026.9.30-aaaaaaa'), ['node.exe', 'index.js']);
  await install(path.join(versions, '2026.10.14-0f9edde'), ['node.exe', 'index.js']);
  await install(path.join(versions, '2026.10.20-bbbbbbb'), ['index.js']);
  await install(path.join(versions, '2026.10.16-ccccccc.previous'), ['node.exe', 'index.js']);
  const newest = path.join(versions, '2026.10.14-0f9edde');
  assert.deepEqual(await findWindowsCursorAgent(env, local), {
    binary: path.join(newest, 'node.exe'),
    args: [path.join(newest, 'index.js')]
  });
  await install(path.join(local, 'cursor-agent'), ['node.exe', 'index.js']);
  assert.equal(
    (await findWindowsCursorAgent(env, local))?.binary,
    path.join(local, 'cursor-agent', 'node.exe'),
    'an unpacked install wins'
  );
});

test('on Windows the Cursor app’s own sign-in is read, then the CLI’s, and the first one still valid is used', async t => {
  const expired = jwt({ sub: 'auth0|user_123', exp: NOW / 1000 - 10 });
  const appData = await tempDir(t, 'vibe-cursor-windows-');
  const cursor = path.join(appData, 'Cursor');
  const store = path.join(cursor, 'User/globalStorage/state.vscdb');
  const requests: GetJsonOptions[] = [];
  const read = (): Promise<unknown> =>
    createCursorProvider({
      platform: 'win32',
      env: { APPDATA: appData },
      clock: () => NOW,
      getJson: (_endpoint, options = {}) => {
        requests.push(options);
        return Promise.resolve(summary);
      }
    }).fetch(cursorAccount);
  await assert.rejects(read(), /auth_missing/, 'neither the app nor the CLI is signed in');
  await fs.mkdir(path.dirname(store), { recursive: true });
  // Committed only to the live WAL, as while the app is running.
  const writer = new DatabaseSync(store);
  try {
    writer.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT);');
    writer.prepare('INSERT INTO ItemTable VALUES (?, ?)').run('cursorAuth/accessToken', expired);
    await assert.rejects(read(), /auth_expired/, 'the app’s sign-in has run out and there is no other');
    await fs.writeFile(path.join(cursor, 'auth.json'), JSON.stringify({ accessToken: valid }));
    await read();
    assert.equal(requests.at(-1)?.headers?.Cookie, `WorkosCursorSessionToken=user_123%3A%3A${valid}`, 'the CLI’s sign-in stands in');
    writer.prepare('UPDATE ItemTable SET value = ?').run(valid);
    await read();
    assert.equal(requests.length, 2);
    writer.prepare('UPDATE ItemTable SET value = ?').run(expired);
    await fs.writeFile(path.join(cursor, 'auth.json'), JSON.stringify({ accessToken: expired }));
    await assert.rejects(read(), /auth_expired/, 'both have run out');
  } finally {
    writer.close();
  }
});
