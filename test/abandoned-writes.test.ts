import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { removeAbandonedWrites, temporaryPath, writeFileAtomic } from '../src/core/files.ts';
import { tempDir } from './helpers/fixtures.ts';

const HOUR_MS = 3_600_000;

async function writeAt(file: string, text: string, modified: number): Promise<string> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text);
  await fs.utimes(file, new Date(modified), new Date(modified));
  return file;
}

test('a start removes what writes cut short left behind, and nothing else', async t => {
  const dir = await tempDir(t, 'vibe-abandoned-');
  const history = path.join(dir, 'history.json');
  await writeFileAtomic(history, '{"kept":true}');
  const earlier = Date.now() - 2 * HOUR_MS;
  // A crash after the temporary file was written, and one right after it was created (empty).
  const crashed = await writeAt(temporaryPath(history), '{"partial', earlier);
  const empty = await writeAt(temporaryPath(path.join(dir, 'token-usage.json')), '', earlier);
  // A write still under way, perhaps by the CLI, which writes to the same folder.
  const writing = await writeAt(temporaryPath(path.join(dir, 'settings.json')), '{', Date.now());
  // Names that only look alike: the app's own files and backups, and other programs' files.
  const others = await Promise.all(
    ['settings.json.bak', 'settings.json.lock.sqlite', '.settings.json.tmp', 'history.json.0123456789abcdef.tmp', '.notes.0123.tmp'].map(
      name => writeAt(path.join(dir, name), 'other', earlier)
    )
  );
  await fs.mkdir(temporaryPath(path.join(dir, 'folder')));

  await removeAbandonedWrites(dir);

  const left = new Set(await fs.readdir(dir));
  for (const file of [crashed, empty]) assert.ok(!left.has(path.basename(file)), `${path.basename(file)} is removed`);
  for (const file of [history, writing, ...others]) assert.ok(left.has(path.basename(file)), `${path.basename(file)} is kept`);
  assert.equal(left.size, 2 + others.length + 1, 'the folder named like a temporary file is kept');
  assert.equal(await fs.readFile(history, 'utf8'), '{"kept":true}');
});

test('a folder that does not exist (yet) is nothing to clean', async t => {
  const dir = await tempDir(t, 'vibe-abandoned-');
  await removeAbandonedWrites(path.join(dir, 'tabs'));
  assert.deepEqual(await fs.readdir(dir), []);
});
