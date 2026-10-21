import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { createDebouncedSaver } from '../src/core/files.ts';
import { tempDir } from './helpers/fixtures.ts';

const SAVE_DELAY_MS = 30_000;

test('a burst of changes is written once, the delay after its first change, with what is known by then', async t => {
  const file = path.join(await tempDir(t, 'vibe-saver-'), 'kept.json');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let text = 'one';
  const writes: string[] = [];
  const saver = createDebouncedSaver(file, () => {
    writes.push(text);
    return text;
  });
  saver.schedule();
  t.mock.timers.tick(SAVE_DELAY_MS - 1000);
  text = 'two';
  // A later change does not push the write back: a steady stream of changes would never reach the disk.
  saver.schedule();
  assert.deepEqual(writes, [], 'nothing is written before the delay is over');
  t.mock.timers.tick(1000);
  assert.deepEqual(writes, ['two'], 'the delay after the first change was over');
  await saver.flush();
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
  // Two changes, so a second timer would be left behind if the saver kept one per change.
  saver.schedule();
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
