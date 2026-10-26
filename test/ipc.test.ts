import assert from 'node:assert/strict';
import test from 'node:test';
import { AppError, ProviderError } from '../src/core/errors.ts';
import { createFaultLog } from '../src/core/faults.ts';
import { assertSender, envelope, optionalProvider, options } from '../src/main/ipc-policy.ts';

test('only the local main frame may invoke privileged actions', () => {
  const frame = { url: 'file:///app/index.html' };
  assert.doesNotThrow(() => {
    assertSender({ senderFrame: frame, sender: { mainFrame: frame } }, frame.url);
  });
  const navigatedAway = { url: 'https://evil.example' };
  assert.throws(
    () => {
      assertSender({ senderFrame: navigatedAway, sender: { mainFrame: navigatedAway } }, frame.url);
    },
    /sender_rejected/,
    'the main frame itself at a foreign URL'
  );
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

test('an unforeseen failure is handed to the fault log; a coded one is not', async () => {
  const seen: unknown[] = [];
  const unforeseen = Object.assign(new Error('spawn EPERM'), { code: 'EPERM', syscall: 'spawn' });
  await envelope(
    () => {
      throw unforeseen;
    },
    error => seen.push(error)
  );
  await envelope(
    () => {
      throw new AppError('account_not_found');
    },
    error => seen.push(error)
  );
  assert.deepEqual(seen, [unforeseen]);
});

test('the fault log keeps the latest few as type and system codes, never the message', () => {
  let now = 0;
  const log = createFaultLog(() => ++now);
  log.record('signIn', Object.assign(new Error('spawn EPERM C:\\Users\\jdoe\\secret'), { code: 'EPERM', syscall: 'spawn' }));
  log.record('a channel with spaces', new TypeError('x is not a function'));
  log.record('refresh', 'a thrown string');
  assert.deepEqual(log.list(), [
    { at: 3, action: 'refresh', error: 'non-error value' },
    { at: 2, action: 'unknown', error: 'TypeError' },
    { at: 1, action: 'signIn', error: 'Error EPERM spawn' }
  ]);
  const passedOn = new Error('handled twice');
  log.record('continuity', passedOn);
  log.record('continuity', passedOn);
  assert.equal(log.list().filter(fault => fault.action === 'continuity').length, 1, 'one failure is kept once');
  log.stall(25_434);
  const [stall] = log.list();
  assert.deepEqual([stall?.action, stall?.error], ['mainThread', 'blocked 25.4 s'], 'how long the window froze');
  for (let i = 0; i < 20; i++) log.record('refresh', new Error('again'));
  assert.equal(log.list().length, 10, 'only the latest are kept');
});
