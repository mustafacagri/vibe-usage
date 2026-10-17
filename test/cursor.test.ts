import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import type { GetJsonOptions, RunProcess } from '../src/providers/common.ts';
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
    assert.match(args[1] ?? '', /\?immutable=1$/);
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

test('an unreadable token store is reported as signed out', async () => {
  const provider = macProvider(valid, [], { runProcess: () => Promise.reject(new Error('database is locked')) });
  await assert.rejects(provider.fetch(cursorAccount), /auth_missing/);
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
