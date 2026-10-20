import assert from 'node:assert/strict';
import test from 'node:test';
import { createPreviewState } from '../src/shared/preview-state.ts';

const deferred = <T>() => Promise.withResolvers<T>();

test('a changed form cannot accept an old preview, even after returning to its original values', async () => {
  const state = createPreviewState<string, string>(value => value);
  let form = 'project A / Codex';
  const pending = deferred<string>();
  const result = state.load(
    form,
    () => pending.promise,
    () => form
  );
  form = 'project B / Cursor';
  state.clear();
  form = 'project A / Codex';
  pending.resolve('old brief');
  assert.equal(await result, null);
  assert.equal(state.read(form), null);
});

test('only the latest preview can be executed and every request field participates in the check', async () => {
  const state = createPreviewState<object, string>(value => JSON.stringify(value));
  let form = { project: 'a', target: 'codex', source: { id: 'profile-a', version: 'one' }, model: 'm1' };
  const old = deferred<string>();
  const latest = deferred<string>();
  const first = state.load(
    form,
    () => old.promise,
    () => form
  );
  const second = state.load(
    form,
    () => latest.promise,
    () => form
  );
  latest.resolve('current brief');
  assert.equal(await second, 'current brief');
  old.resolve('old brief');
  assert.equal(await first, null);
  assert.deepEqual(state.read(form), { request: form, preview: 'current brief' });
  for (const changed of [
    { ...form, project: 'b' },
    { ...form, target: 'cursor' },
    { ...form, source: { ...form.source, id: 'profile-b' } },
    { ...form, source: { ...form.source, version: 'two' } },
    { ...form, model: 'm2' }
  ])
    assert.equal(state.read(changed), null);
  form = { ...form, model: 'm2' };
  const stale = deferred<string>();
  const third = state.load(
    form,
    () => stale.promise,
    () => form
  );
  form = { ...form, project: 'b' };
  stale.resolve('changed without an event');
  assert.equal(await third, null);
  assert.equal(state.read(form), null);
});

test('closing a form drops late errors, while a current preview error remains visible', async () => {
  const state = createPreviewState<string, string>(value => value);
  const pending = deferred<string>();
  const result = state.load(
    'a',
    () => pending.promise,
    () => 'a'
  );
  state.clear();
  pending.reject(new Error('old request failed'));
  assert.equal(await result, null);
  assert.equal(state.read('a'), null);
  await assert.rejects(
    state.load(
      'a',
      () => Promise.reject(new Error('current failure')),
      () => 'a'
    ),
    /current failure/
  );
  const changed = deferred<string>();
  let form = 'a';
  const stale = state.load(
    form,
    () => changed.promise,
    () => form
  );
  form = 'b';
  changed.reject(new Error('old request failed'));
  assert.equal(await stale, null);
});
