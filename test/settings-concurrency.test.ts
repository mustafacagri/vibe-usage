import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { isObject } from '../src/core/files.ts';
import { createService } from '../src/core/service.ts';
import { backupPath, defaultSettings, loadSettings, saveSettings, transactSettings } from '../src/core/settings.ts';
import { settingsLockPath } from '../src/core/settings-lock.ts';
import { tempDir } from './helpers/fixtures.ts';

function message(child: ChildProcess, event: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      finish(new Error(`worker did not report ${event}`));
    }, 5000);
    const receive = (value: unknown): void => {
      if (!isObject(value)) return;
      if (value.event === event) finish();
      else if (value.event === 'failed') finish(new Error('worker failed'));
    };
    const error = (cause: Error): void => {
      finish(cause);
    };
    function finish(cause?: Error): void {
      clearTimeout(timer);
      child.off('message', receive);
      child.off('error', error);
      if (cause) reject(cause);
      else resolve();
    }
    child.on('message', receive);
    child.on('error', error);
  });
}

async function worker(t: TestContext, file: string): Promise<ChildProcess> {
  const child = fork(fileURLToPath(new URL('./helpers/settings-worker.ts', import.meta.url)), [file], {
    execArgv: [],
    stdio: ['ignore', 'ignore', 'ignore', 'ipc']
  });
  t.after(() => {
    child.kill();
  });
  await message(child, 'ready');
  return child;
}

test('a separate stale CLI discovery preserves the desktop off choice and unrelated settings', async t => {
  const file = path.join(await tempDir(t, 'vibe-settings-process-'), 'settings.json');
  await saveSettings(file, { ...defaultSettings(), autoContinue: 'tools' });
  const cli = await worker(t, file);
  let changes = 0;
  const desktop = await createService({
    settingsPath: file,
    providers: [],
    onChange: () => {
      changes++;
    }
  });
  await desktop.updateSettings({ autoContinue: 'off', language: 'tr' });
  const done = message(cli, 'done');
  cli.send({ command: 'discover' });
  await done;
  const stored = await loadSettings(file);
  assert.equal(stored?.autoContinue, 'off');
  assert.equal(stored.language, 'tr');
  assert.deepEqual(
    stored.accounts.map(a => a.id),
    ['claude:main', 'claude:spare']
  );
  await desktop.syncSettings();
  assert.equal(desktop.snapshot().settings.accounts.length, 2);
  assert.equal(changes, 1, 'external changes notify the running desktop');
});

test('contending writers wait asynchronously, reload under the lock and recover after owner death', async t => {
  const file = path.join(await tempDir(t, 'vibe-settings-lock-'), 'settings.json');
  const child = await worker(t, file);
  const locked = message(child, 'locked');
  child.send({ command: 'hold' });
  await locked;
  let entered = false;
  const contender = transactSettings(file, async transaction => {
    entered = true;
    assert.equal(transaction.settings.language, 'tr', 'reload follows the prior commit');
    await transaction.save({ ...transaction.settings, pinned: true });
  });
  await delay(40);
  assert.equal(entered, false, 'another process owns the write lock; the event loop remains responsive');
  const done = message(child, 'done');
  child.send({ command: 'release' });
  await Promise.all([done, contender]);
  assert.equal((await loadSettings(file))?.pinned, true);
  const lockedAgain = message(child, 'locked');
  child.send({ command: 'hold' });
  await lockedAgain;
  const exited = new Promise<void>(resolve =>
    child.once('exit', () => {
      resolve();
    })
  );
  child.kill('SIGKILL');
  await exited;
  await transactSettings(file, async transaction => {
    await transaction.save({ ...transaction.settings, autoContinue: 'off' });
  });
  assert.equal((await loadSettings(file))?.language, 'tr');
  assert.equal((await loadSettings(backupPath(file)))?.pinned, true, 'backup remains the last valid document');
});

test('revision conflicts and failed writes never publish an uncommitted service snapshot', async t => {
  const file = path.join(await tempDir(t, 'vibe-settings-failure-'), 'settings.json');
  await saveSettings(file, defaultSettings());
  await assert.rejects(
    transactSettings(file, async transaction => {
      await fs.writeFile(file, JSON.stringify({ ...transaction.settings, language: 'tr' }));
      await transaction.save({ ...transaction.settings, pinned: true });
    }),
    /settings_locked/
  );
  const service = await createService({ settingsPath: file, providers: [] });
  const before = service.snapshot();
  const rename = fs.rename.bind(fs);
  const mocked = t.mock.method(fs, 'rename', async (from: string, to: string) => {
    if (to === file && path.basename(from).startsWith('.')) throw Object.assign(new Error('write failed'), { code: 'EIO' });
    await rename(from, to);
  });
  await assert.rejects(service.updateSettings({ pinned: true }), /write failed/);
  assert.deepEqual(service.snapshot(), before);
  assert.deepEqual(await loadSettings(file), before.settings);
  assert.deepEqual(await loadSettings(backupPath(file)), before.settings);
  mocked.mock.restore();
});

test('a substituted settings mutex symlink is rejected before a write', async t => {
  const dir = await tempDir(t, 'vibe-settings-link-');
  const file = path.join(dir, 'settings.json');
  const target = path.join(dir, 'target');
  await fs.writeFile(target, 'keep');
  try {
    await fs.symlink(target, settingsLockPath(file));
  } catch (error) {
    if (process.platform === 'win32' && isObject(error) && error.code === 'EPERM') {
      t.skip('Windows symlinks require Developer Mode or elevation');
      return;
    }
    throw error;
  }
  await assert.rejects(saveSettings(file, defaultSettings()), /settings_locked/);
  assert.equal(await fs.readFile(target, 'utf8'), 'keep');
});
