'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { assertSender, validateRefresh, envelope } = require('../src/ipc-policy.cjs');
const { AppError } = require('../src/core/errors.cjs');
const { ProviderError } = require('../src/providers/common.cjs');

test('only the local main frame may invoke privileged actions', () => {
  const frame = { url: 'file:///app/index.html' };
  assert.doesNotThrow(() => assertSender({ senderFrame: frame, sender: { mainFrame: frame } }, frame.url));
  assert.throws(
    () => assertSender({ senderFrame: { url: 'https://evil.example' }, sender: { mainFrame: frame } }, frame.url),
    /sender_rejected/
  );
  assert.throws(
    () => assertSender({ senderFrame: { url: frame.url }, sender: { mainFrame: frame } }, frame.url),
    /sender_rejected/,
    'a subframe at the same URL is not the main frame'
  );
});

test('refresh accepts only known provider names', () => {
  assert.equal(validateRefresh('claude'), 'claude');
  assert.equal(validateRefresh(), undefined);
  assert.throws(() => validateRefresh('../private'), /invalid_provider/);
  assert.throws(() => validateRefresh({}), /invalid_provider/);
});

test('results cross IPC as envelopes; only known error codes are exposed', async () => {
  assert.deepEqual(await envelope(async () => 42), { ok: true, value: 42 });
  assert.deepEqual(
    await envelope(() => {
      throw new AppError('app_not_found', { app: 'Cursor' });
    }),
    { ok: false, error: { code: 'app_not_found', params: { app: 'Cursor' } } }
  );
  assert.deepEqual(
    await envelope(async () => {
      throw new ProviderError('rate_limited');
    }),
    { ok: false, error: { code: 'rate_limited', params: {} } }
  );
  assert.deepEqual(
    await envelope(async () => {
      throw new Error('ENOENT: /secret/path');
    }),
    { ok: false, error: { code: 'unexpected', params: {} } },
    'raw messages never reach the renderer'
  );
});
