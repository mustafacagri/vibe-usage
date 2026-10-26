// Reading data that other tools write (session transcripts, model caches, settings). It is
// read best effort: a missing, unreadable or malformed file counts as absent and never fails
// the caller, so one damaged session cannot hide all the others.
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { DURATION_MS } from '../shared/catalog.ts';

export type JsonObject = Record<string, unknown>;

export const isObject = (value: unknown): value is JsonObject => typeof value === 'object' && value !== null && !Array.isArray(value);
export const asArray = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);

// Text written on Windows (PowerShell 5's UTF-8, Notepad) may start with a byte order mark.
export const parseJson = (text: string): unknown => JSON.parse(text.replace(/^\uFEFF/, ''));

// A field of a JSON object; undefined for anything else.
export const field = (value: unknown, key: string): unknown => (isObject(value) ? value[key] : undefined);

// A folder as a key: resolved, and in one case where the file system ignores case (Windows,
// macOS), so that two spellings of one folder compare equal.
export const pathKey = (dir: string, platform: NodeJS.Platform = process.platform): string => {
  const resolved = path.resolve(dir);
  return platform === 'win32' || platform === 'darwin' ? resolved.toLowerCase() : resolved;
};
export const samePath = (a: string, b: string): boolean => pathKey(a) === pathKey(b);

// The extension of JSON Lines files: the session transcripts both CLIs write.
export const JSON_LINES_EXTENSION = '.jsonl';

// Parsed records of a JSON Lines document; blank, malformed and non-object lines are skipped
// (the last line of a file another process is writing may be incomplete).
export function* jsonLines(text: string): Generator<JsonObject> {
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const record = attemptSync((): unknown => JSON.parse(line));
    if (isObject(record)) yield record;
  }
}

// The first `bytes` of a file as text ('' when unreadable); a trailing partial line is
// dropped by jsonLines.
export function readHeadSync(file: string, bytes: number): string {
  return (
    attemptSync(() => {
      const fd = fs.openSync(file, 'r');
      try {
        const buffer = Buffer.alloc(bytes);
        return buffer.toString('utf8', 0, fs.readSync(fd, buffer, 0, bytes, 0));
      } finally {
        fs.closeSync(fd);
      }
    }) ?? ''
  );
}

// The last `bytes` of a file as text ('' when unreadable); a leading partial line is dropped
// by jsonLines.
export function readTailSync(file: string, bytes: number): string {
  return (
    attemptSync(() => {
      const fd = fs.openSync(file, 'r');
      try {
        const { size } = fs.fstatSync(fd);
        const length = Math.min(bytes, size);
        const buffer = Buffer.alloc(length);
        return buffer.toString('utf8', 0, fs.readSync(fd, buffer, 0, length, size - length));
      } finally {
        fs.closeSync(fd);
      }
    }) ?? ''
  );
}

// readHeadSync, off the main thread (see readTail).
export async function readHead(file: string, bytes: number): Promise<string> {
  return (
    (await attempt(async () => {
      const handle = await fsp.open(file, 'r');
      try {
        const buffer = Buffer.alloc(bytes);
        const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
        return buffer.toString('utf8', 0, bytesRead);
      } finally {
        await handle.close();
      }
    })) ?? ''
  );
}

// readTailSync, off the main thread. Opening a file can take long: an antivirus program may scan
// it whole first (25 s for a 41 MB transcript under Kaspersky), and the app must stay responsive.
export async function readTail(file: string, bytes: number): Promise<string> {
  return (
    (await attempt(async () => {
      const handle = await fsp.open(file, 'r');
      try {
        const { size } = await handle.stat();
        const length = Math.min(bytes, size);
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, size - length);
        return buffer.toString('utf8', 0, bytesRead);
      } finally {
        await handle.close();
      }
    })) ?? ''
  );
}

// Files in `dir` with the given extension, newest first ([] when unreadable).
export function newestFiles(dir: string, extension: string): string[] {
  return (attemptSync(() => fs.readdirSync(dir)) ?? [])
    .filter(name => name.endsWith(extension))
    .map(name => path.join(dir, name))
    .map(file => ({ file, mtimeMs: attemptSync(() => fs.statSync(file).mtimeMs) ?? 0 }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .map(entry => entry.file);
}

export function readJsonSync(file: string): unknown {
  return attemptSync((): unknown => JSON.parse(fs.readFileSync(file, 'utf8')));
}

export async function readJson(file: string): Promise<unknown> {
  return attempt(async (): Promise<unknown> => JSON.parse(await fsp.readFile(file, 'utf8')));
}

export const isFile = (file: string): Promise<boolean> =>
  fsp.stat(file).then(
    stat => stat.isFile(),
    () => false
  );
export const isDirectory = (file: string): Promise<boolean> =>
  fsp.stat(file).then(
    stat => stat.isDirectory(),
    () => false
  );

// Writes the app's own data atomically and private to the user: a crash mid-write never
// leaves a truncated file.
export async function writeFileAtomic(file: string, text: string): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomBytes(8).toString('hex')}.tmp`);
  try {
    const handle = await fsp.open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(text, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fsp.rename(temporary, file);
  } finally {
    await fsp.rm(temporary, { force: true });
  }
}

// How long changes to a kept file are gathered before it is written.
const SAVE_DELAY_MS = 30 * DURATION_MS.SECOND;

export interface DebouncedSaver {
  // A change was made: the file is written a while after the first change of a burst.
  schedule: () => void;
  // Writes now, and resolves once everything asked for so far is on disk.
  flush: () => Promise<void>;
}

// Keeps `file` up to date with what `serialize` returns, without writing for every change. Writes run
// one after another. One that fails is not retried: the data stays in memory, and the next change
// writes it again.
export function createDebouncedSaver(file: string, serialize: () => string): DebouncedSaver {
  let timer: NodeJS.Timeout | undefined;
  let pending: Promise<void> = Promise.resolve();
  function flush(): Promise<void> {
    clearTimeout(timer);
    timer = undefined;
    const text = serialize();
    pending = pending.then(() => writeFileAtomic(file, text)).catch(() => undefined);
    return pending;
  }
  return {
    schedule() {
      timer ??= setTimeout(() => void flush(), SAVE_DELAY_MS);
      timer.unref();
    },
    flush
  };
}

// The same, for the moment the app quits, when nothing asynchronous is waited for.
export function writeFileAtomicSync(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomBytes(8).toString('hex')}.tmp`);
  try {
    const handle = fs.openSync(temporary, 'wx', 0o600);
    try {
      fs.writeFileSync(handle, text, 'utf8');
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

// The task's result, or null if it throws.
export async function attempt<T>(task: () => Promise<T>): Promise<T | null> {
  try {
    return await task();
  } catch {
    return null;
  }
}

export function attemptSync<T>(task: () => T): T | null {
  try {
    return task();
  } catch {
    return null;
  }
}
