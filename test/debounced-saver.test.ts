import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { createDebouncedSaver } from '../src/core/files.ts';
import { tempDir } from './helpers/fixtures.ts';

const SAVE_DELAY_MS = 30_000;

test('changes made in a burst are written once, a while after the first, with what is known by then', async t => {
  const file = path.join(await tempDir(t, 'vibe-saver-'), 'kept.json');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let text = 'one';
  const writes: string[] = [];
  const saver = createDebouncedSaver(file, () => {
    writes.push(text);
    return text;
  });
  saver.schedule();
  text = 'two';
  saver.schedule();
  t.mock.timers.tick(SAVE_DELAY_MS - 1);
  assert.deepEqual(writes, [], 'nothing is written before the delay is over');
  t.mock.timers.tick(1);
  await saver.flush();
  assert.deepEqual(writes, ['two', 'two'], 'the timer wrote once; the flush wrote what is there now');
  assert.equal(await fs.readFile(file, 'utf8'), 'two');
});

test('a flush writes at once and cancels the write that was waiting', async t => {
  const file = path.join(await tempDir(t, 'vibe-saver-'), 'kept.json');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const writes: string[] = [];
  const saver = createDebouncedSaver(file, () => {
    writes.push('write');
    return 'text';
  });
  saver.schedule();
  await saver.flush();
  t.mock.timers.tick(SAVE_DELAY_MS);
  await saver.flush();
  assert.deepEqual(writes, ['write', 'write'], 'two flushes, and no third write from the timer that was cancelled');
});

test('a write that fails is not an error for the caller, and the next one is tried', async t => {
  const dir = await tempDir(t, 'vibe-saver-');
  // A folder where the file should be: the atomic replace fails.
  const file = path.join(dir, 'kept.json');
  await fs.mkdir(file);
  const saver = createDebouncedSaver(file, () => 'text');
  await saver.flush();
  await fs.rmdir(file);
  await saver.flush();
  assert.equal(await fs.readFile(file, 'utf8'), 'text');
});
