import assert from 'node:assert/strict';
import test from 'node:test';
import { AppError, ProviderError } from '../src/core/errors.ts';
import { assertSender, envelope, optionalProvider, options } from '../src/main/ipc-policy.ts';

test('only the local main frame may invoke privileged actions', () => {
  const frame = { url: 'file:///app/index.html' };
  assert.doesNotThrow(() => {
    assertSender({ senderFrame: frame, sender: { mainFrame: frame } }, frame.url);
  });
  assert.throws(() => {
    assertSender({ senderFrame: { url: 'https://evil.example' }, sender: { mainFrame: frame } }, frame.url);
  }, /sender_rejected/);
  assert.throws(
    () => {
      assertSender({ senderFrame: { url: frame.url }, sender: { mainFrame: frame } }, frame.url);
    },
    /sender_rejected/,
    'a subframe at the same URL is not the main frame'
  );
  assert.throws(() => {
    assertSender({ senderFrame: null, sender: { mainFrame: frame } }, frame.url);
  }, /sender_rejected/);
});

test('renderer arguments are narrowed or rejected', () => {
  assert.equal(optionalProvider('claude'), 'claude');
  assert.equal(optionalProvider(undefined), undefined);
  assert.throws(() => optionalProvider('../private'), /invalid_provider/);
  assert.throws(() => optionalProvider({}), /invalid_provider/);
  assert.deepEqual(options(undefined), {});
  assert.throws(() => options('x'), /invalid_argument/);
  assert.throws(() => options([]), /invalid_argument/);
});

test('results cross IPC as envelopes; only known error codes are exposed', async () => {
  assert.deepEqual(await envelope(() => 42), { ok: true, value: 42 });
  assert.deepEqual(
    await envelope(() => {
      throw new AppError('app_not_found', { app: 'Cursor' });
    }),
    { ok: false, error: { code: 'app_not_found', params: { app: 'Cursor' } } }
  );
  assert.deepEqual(await envelope(() => Promise.reject(new ProviderError('rate_limited'))), {
    ok: false,
    error: { code: 'rate_limited', params: {} }
  });
  assert.deepEqual(
    await envelope(() => {
      throw new Error('ENOENT: /secret/path');
    }),
    { ok: false, error: { code: 'unexpected', params: {} } },
    'raw messages never reach the renderer'
  );
});
