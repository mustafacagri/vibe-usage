// Reading data that other tools write (session transcripts, model caches, settings). It is
// read best effort: a missing, unreadable or malformed file counts as absent and never fails
// the caller, so one damaged session cannot hide all the others.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export type JsonObject = Record<string, unknown>;

export const isObject = (value: unknown): value is JsonObject => typeof value === 'object' && value !== null && !Array.isArray(value);
export const asArray = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);

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
