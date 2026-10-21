// The tokens Claude and Codex spent, counted from the transcripts they keep in each profile
// folder: today and the last seven days, by model. The logs are large (gigabytes), so each file
// is read once and again only where it has grown; what was read is kept on disk.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { CLAUDE_FILES, SYNTHETIC_MODEL } from '../providers/claude.ts';
import { CODEX_SESSIONS_DIR } from '../providers/codex.ts';
import { defaultProfileDir } from '../providers/profiles.ts';
import { DURATION_MS, isProfileProvider, type ProfileProviderId } from '../shared/catalog.ts';
import type { Account, AccountTokens, TokenTotals } from '../shared/types.ts';
import { systemErrorCode } from './errors.ts';
import { attempt, isObject, JSON_LINES_EXTENSION, pathKey, readJson, writeFileAtomic, type JsonObject } from './files.ts';

const CACHE_FILE = 'token-usage.json';
const CACHE_VERSION = 1;
const TOKEN_WINDOW_MS = DURATION_MS.WEEK;
const SAVE_DELAY_MS = 30 * DURATION_MS.SECOND;
const NEWLINE = 0x0a;
const KEY_LENGTH = 12;

// A record's positions: its time in ms, the model, the four counts, and the key that names a Claude
// response (its files may repeat one; Codex records have none).
const RECORD = { time: 0, model: 1, input: 2, output: 3, cacheRead: 4, cacheWrite: 5, key: 6 } as const;
type TokenRecord = readonly [number, string, number, number, number, number, string];

interface FileState {
  size: number;
  mtimeMs: number;
  // Where the first line not yet read begins.
  offset: number;
  // What the next line is compared with: Claude writes one response as several lines in a row,
  // and Codex repeats its running total when only the rate limits changed.
  lastKey: string;
  lastTotal: number | null;
  // The model of the latest turn (Codex names it once per turn, not per call).
  model: string;
  records: TokenRecord[];
}

const emptyState = (): FileState => ({ size: 0, mtimeMs: 0, offset: 0, lastKey: '', lastTotal: null, model: '', records: [] });

const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0);
const keyOf = (value: string): string => createHash('sha256').update(value).digest('base64url').slice(0, KEY_LENGTH);

// How one tool writes what it spent. `read` takes a line of a transcript and returns the record
// it holds, if any, keeping what the next line depends on in `state`. Both formats were checked
// against this machine's real transcripts (2026-10-21): Claude writes a response as several lines
// carrying one `message.id` and the same counts, and its `input_tokens` leave out the cache; Codex's
// `total_tokens` is `input_tokens` plus `output_tokens` (the cached part is inside `input_tokens`),
// and its running total moves with each call.
interface LogFormat {
  folder: string;
  wants(line: string): boolean;
  read(line: JsonObject, state: FileState): TokenRecord | null;
}

function readClaudeLine(line: JsonObject, state: FileState): TokenRecord | null {
  const { message, requestId, timestamp } = line;
  if (!isObject(message) || !isObject(message.usage) || typeof message.id !== 'string') return null;
  const { model, usage } = message;
  const time = typeof timestamp === 'string' ? Date.parse(timestamp) : NaN;
  if (typeof model !== 'string' || model === SYNTHETIC_MODEL || !Number.isFinite(time)) return null;
  const key = keyOf(`${message.id}|${typeof requestId === 'string' ? requestId : ''}`);
  if (key === state.lastKey) return null;
  state.lastKey = key;
  return [
    time,
    model,
    count(usage.input_tokens),
    count(usage.output_tokens),
    count(usage.cache_read_input_tokens),
    count(usage.cache_creation_input_tokens),
    key
  ];
}

// A call is counted when the running total moved. A resumed session's file starts at the total
// the earlier file ended with, so the total itself says nothing: the call's own count is used.
function readCodexLine(line: JsonObject, state: FileState): TokenRecord | null {
  const { payload, timestamp } = line;
  if (!isObject(payload)) return null;
  if (line.type === 'turn_context') {
    if (typeof payload.model === 'string') state.model = payload.model;
    return null;
  }
  if (payload.type !== 'token_count' || !isObject(payload.info)) return null;
  const { total_token_usage: total, last_token_usage: last } = payload.info;
  const time = typeof timestamp === 'string' ? Date.parse(timestamp) : NaN;
  if (!isObject(total) || !isObject(last) || typeof total.total_tokens !== 'number' || !Number.isFinite(time)) return null;
  if (total.total_tokens === state.lastTotal) return null;
  state.lastTotal = total.total_tokens;
  const cached = count(last.cached_input_tokens);
  // No Codex log checked carried a cache write, and where it would be counted is unknown: it is not read.
  return [time, state.model, Math.max(count(last.input_tokens) - cached, 0), count(last.output_tokens), cached, 0, ''];
}

const LOG_FORMATS = {
  claude: { folder: CLAUDE_FILES.projects, wants: line => line.includes('"usage"'), read: readClaudeLine },
  codex: {
    folder: CODEX_SESSIONS_DIR,
    wants: line => line.includes('"token_count"') || line.includes('"turn_context"'),
    read: readCodexLine
  }
} as const satisfies Record<ProfileProviderId, LogFormat>;

// The whole lines of `file` from byte `start`, each with the offset after it; a last line still
// being written is left out.
async function* completeLines(file: string, start: number): AsyncGenerator<{ text: string; end: number }> {
  let pending = Buffer.alloc(0);
  let consumed = start;
  for await (const chunk of createReadStream(file, { start })) {
    pending = Buffer.concat([pending, chunk]);
    for (let at = pending.indexOf(NEWLINE); at !== -1; at = pending.indexOf(NEWLINE)) {
      consumed += at + 1;
      yield { text: pending.toString('utf8', 0, at), end: consumed };
      pending = pending.subarray(at + 1);
    }
  }
}

function parseLine(text: string): JsonObject | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function readFrom(file: string, state: FileState, format: LogFormat, since: number): Promise<void> {
  for await (const { text, end } of completeLines(file, state.offset)) {
    state.offset = end;
    if (!format.wants(text)) continue;
    const line = parseLine(text);
    const record = line && format.read(line, state);
    if (record && record[RECORD.time] >= since) state.records.push(record);
  }
}

const isRecord = (value: unknown): value is TokenRecord =>
  Array.isArray(value) &&
  value.length === Object.keys(RECORD).length &&
  typeof value[RECORD.time] === 'number' &&
  typeof value[RECORD.model] === 'string' &&
  value.slice(RECORD.input, RECORD.key).every(n => typeof n === 'number') &&
  typeof value[RECORD.key] === 'string';

const isFileState = (value: unknown): value is FileState =>
  isObject(value) &&
  typeof value.size === 'number' &&
  typeof value.mtimeMs === 'number' &&
  typeof value.offset === 'number' &&
  typeof value.lastKey === 'string' &&
  (value.lastTotal === null || typeof value.lastTotal === 'number') &&
  typeof value.model === 'string' &&
  Array.isArray(value.records) &&
  value.records.every(isRecord);

// A damaged or foreign cache starts empty: the logs are the source.
function parseCache(document: unknown): Map<string, FileState> {
  const files = new Map<string, FileState>();
  if (!isObject(document) || document.version !== CACHE_VERSION || !isObject(document.files)) return files;
  for (const [file, state] of Object.entries(document.files)) if (isFileState(state)) files.set(file, state);
  return files;
}

const emptyTotals = (): TokenTotals => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

function add(totals: TokenTotals, record: TokenRecord): void {
  totals.input += record[RECORD.input];
  totals.output += record[RECORD.output];
  totals.cacheRead += record[RECORD.cacheRead];
  totals.cacheWrite += record[RECORD.cacheWrite];
}

const sum = (totals: TokenTotals): number => totals.input + totals.output + totals.cacheRead + totals.cacheWrite;

function summarize(accountId: string, records: readonly TokenRecord[], now: number): AccountTokens {
  const weekStart = now - TOKEN_WINDOW_MS;
  const dayStart = new Date(now).setHours(0, 0, 0, 0);
  const result: AccountTokens = { accountId, today: emptyTotals(), week: emptyTotals(), models: [] };
  const byModel = new Map<string, TokenTotals>();
  const seen = new Set<string>();
  for (const record of records) {
    const time = record[RECORD.time];
    const model = record[RECORD.model];
    const key = record[RECORD.key];
    if (time < weekStart) continue;
    // A response a profile's other file repeats (a resumed or moved session) is one response.
    if (key) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    add(result.week, record);
    if (time >= dayStart) add(result.today, record);
    const totals = byModel.get(model) ?? emptyTotals();
    add(totals, record);
    byModel.set(model, totals);
  }
  result.models = [...byModel]
    .map(([model, tokens]) => ({ model, tokens }))
    .sort((a, b) => sum(b.tokens) - sum(a.tokens) || a.model.localeCompare(b.model));
  return result;
}

// A missing file or folder is the answer "nothing there"; every other failure (no permission, too many
// open files) is not, and reaches the caller.
async function orMissing<T>(task: () => Promise<T>): Promise<T | null> {
  try {
    return await task();
  } catch (error) {
    if (systemErrorCode(error) === 'ENOENT') return null;
    throw error;
  }
}

// The profile folder an account's tool keeps its logs in.
const profileOf = (account: Account & { providerId: ProfileProviderId }, homeDir: string): string =>
  path.resolve(account.configDir ?? defaultProfileDir(account.providerId, homeDir));

export interface TokenUsage {
  // The usage of each account whose tool keeps token counts in its logs.
  read(accounts: readonly Account[]): Promise<AccountTokens[]>;
  flush(): Promise<void>;
}

export async function createTokenUsage({
  dataDir,
  homeDir,
  clock = Date.now
}: {
  dataDir: string;
  homeDir: string;
  clock?: () => number;
}): Promise<TokenUsage> {
  const cacheFile = path.join(dataDir, CACHE_FILE);
  const files = parseCache(await attempt(() => readJson(cacheFile)));
  let saveTimer: NodeJS.Timeout | undefined;
  let pending: Promise<void> = Promise.resolve();
  let queue: Promise<unknown> = Promise.resolve();

  function save(): Promise<void> {
    clearTimeout(saveTimer);
    saveTimer = undefined;
    const document = JSON.stringify({ version: CACHE_VERSION, files: Object.fromEntries(files) });
    // The cache can be read again from the logs: a save that fails costs a slower next start, nothing else.
    pending = pending.then(() => writeFileAtomic(cacheFile, document)).catch(() => undefined);
    return pending;
  }

  function scheduleSave(): void {
    saveTimer ??= setTimeout(() => void save(), SAVE_DELAY_MS);
    saveTimer.unref();
  }

  // Brings what is kept for the profile's logs up to date; returns the files it holds.
  async function refreshProfile(providerId: ProfileProviderId, profile: string, since: number): Promise<string[]> {
    const format = LOG_FORMATS[providerId];
    const root = path.join(profile, format.folder);
    const names = (await orMissing(() => fsp.readdir(root, { recursive: true }))) ?? [];
    const present: string[] = [];
    for (const name of names.filter(entry => entry.endsWith(JSON_LINES_EXTENSION)).sort()) {
      const file = path.join(root, name);
      const stat = await orMissing(() => fsp.stat(file));
      // A file untouched for longer than the window holds nothing in it.
      if (!stat?.isFile() || stat.mtimeMs < since) continue;
      present.push(file);
      let state = files.get(file);
      if (state?.size === stat.size && state.mtimeMs === stat.mtimeMs) continue;
      // A file that shrank was replaced: it is read again from its start.
      if (!state || stat.size < state.offset) state = emptyState();
      // A file that vanished since it was listed is left as it was; any other failure is the caller's.
      const read = await orMissing(async () => {
        await readFrom(file, state, format, since);
        return true;
      });
      if (!read) continue;
      state.size = stat.size;
      state.mtimeMs = stat.mtimeMs;
      state.records = state.records.filter(record => record[RECORD.time] >= since);
      files.set(file, state);
      scheduleSave();
    }
    return present;
  }

  async function scan(accounts: readonly Account[]): Promise<AccountTokens[]> {
    const now = clock();
    const since = now - TOKEN_WINDOW_MS;
    const profiles = new Map<string, string[]>();
    const tracked = accounts.filter((account): account is Account & { providerId: ProfileProviderId } =>
      isProfileProvider(account.providerId)
    );
    for (const account of tracked) {
      const profile = profileOf(account, homeDir);
      const key = `${account.providerId}:${pathKey(profile)}`;
      if (!profiles.has(key)) profiles.set(key, await refreshProfile(account.providerId, profile, since));
    }
    for (const [file, state] of files) {
      if (state.mtimeMs < since) {
        files.delete(file);
        scheduleSave();
      }
    }
    return tracked.map(account => {
      const present = profiles.get(`${account.providerId}:${pathKey(profileOf(account, homeDir))}`) ?? [];
      return summarize(
        account.id,
        present.flatMap(file => files.get(file)?.records ?? []),
        now
      );
    });
  }

  return {
    // One scan at a time: two callers asking together share the files' state.
    read: accounts => {
      const result = queue.then(() => scan(accounts));
      queue = result.catch(() => undefined);
      return result;
    },
    flush: save
  };
}
