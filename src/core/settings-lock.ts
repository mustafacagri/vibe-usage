// SQLite supplies a process-wide OS lock, released even if the owner crashes. Settings
// remain JSON; this private, empty database is only the mutex, not another data store.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { AppError, systemErrorCode } from './errors.ts';
import { isObject } from './files.ts';

const LOCK_WAIT_MS = 5000;
const LOCK_RETRY_MS = 20;

export const settingsLockPath = (file: string): string => `${file}.lock.sqlite`;

export async function withSettingsLock<T>(file: string, task: () => Promise<T>): Promise<T> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const mutex = settingsLockPath(file);
  try {
    const handle = await fsp.open(mutex, 'wx', 0o600);
    await handle.close();
  } catch (error) {
    if (systemErrorCode(error) !== 'EEXIST') throw error;
  }
  // Never follow a substituted link or open a directory as the locking database.
  const before = await fsp.lstat(mutex);
  if (!before.isFile() || (process.platform !== 'win32' && (before.mode & 0o077) !== 0)) throw new AppError('settings_locked');
  const db = new DatabaseSync(mutex, { timeout: 0, allowExtension: false });
  let acquired = false;
  try {
    const after = await fsp.lstat(mutex);
    if (!after.isFile() || after.ino !== before.ino || after.dev !== before.dev) throw new AppError('settings_locked');
    const until = performance.now() + LOCK_WAIT_MS;
    while (!acquired) {
      try {
        db.exec('BEGIN IMMEDIATE');
        acquired = true;
      } catch (error) {
        const code = isObject(error) && typeof error.errcode === 'number' ? error.errcode & 0xff : undefined;
        if (code !== 5 && code !== 6) throw error; // SQLITE_BUSY / SQLITE_LOCKED
        if (performance.now() >= until) throw new AppError('settings_locked');
        // SQLite must not block Electron's main thread while another process writes.
        await delay(LOCK_RETRY_MS);
      }
    }
    return await task();
  } finally {
    try {
      if (acquired) db.exec('ROLLBACK');
    } finally {
      db.close();
    }
    // The mutex inode stays put: unlinking it would split waiting and new lock owners.
  }
}
