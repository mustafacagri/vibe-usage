// Per-provider discovery and reading of local agent sessions for a project directory. Every
// provider is filtered by the session's recorded working directory, so a session only ever
// appears under the project it was started in. Formats were verified against real local
// data (Claude Code JSONL, Codex rollout JSONL, Cursor CLI store.db, Antigravity
// conversations/*.db + brain transcript); unknown fields are left empty instead of guessed.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import zlib from 'node:zlib';
import { SYNTHETIC_MODEL } from '../providers/claude.ts';
import { AUTO, PROVIDER_IDS, type Auto, type ProviderId } from '../shared/catalog.ts';
import type { SessionSummary } from '../shared/ipc.ts';
import { attempt, attemptSync, isObject, jsonLines, readJsonSync, type JsonObject } from './files.ts';

// What a handover needs from a session.
export interface Transcript {
  providerId: ProviderId;
  sessionId: string;
  sessionTitle: string;
  sessionModel: string;
  initialGoal: string;
  lastUserMsg: string;
  lastAssistantMsg: string;
  turnCount: number;
  files: string[];
}

const SECRET = /(?:sk-[a-zA-Z0-9_-]{20,}|ghp_[a-zA-Z0-9]{20,}|AKIA[0-9A-Z]{16}|bearer\s+[a-zA-Z0-9_.-]{30,})/gi;
const SYSTEM_REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/gi;
const REDACTED = '[REDACTED_SECRET]';

function sanitizeText(text: string): string {
  return text.replace(SECRET, REDACTED).replace(SYSTEM_REMINDER, '').trim();
}

const CASE_INSENSITIVE_PATHS: ReadonlySet<NodeJS.Platform> = new Set(['win32', 'darwin']);

function samePath(a: unknown, b: string): boolean {
  if (typeof a !== 'string' || !a) return false;
  const normalize = (p: string): string => {
    const resolved = path.resolve(p).replace(/[\\/]+$/, '');
    return CASE_INSENSITIVE_PATHS.has(process.platform) ? resolved.toLowerCase() : resolved;
  };
  return normalize(a) === normalize(b);
}

const field = (value: unknown, key: string): unknown => (isObject(value) ? value[key] : undefined);
const text = (value: unknown): string => (typeof value === 'string' ? value : '');

const TITLE_MAX_LENGTH = 70;
const TITLE_MIN_LENGTH = 4;
const RECENT_FILES = 10;
// Lines that open a prompt but say nothing about it: markup, mentions, rules, code fences.
const NON_TITLE_PREFIXES = ['<', '@', '---', '```'];

// First meaningful line of the first prompt, without Markdown heading or list markers.
function titleFrom(prompt: string): string {
  const line = prompt
    .split('\n')
    .map(x => x.trim())
    .find(x => x.length >= TITLE_MIN_LENGTH && !NON_TITLE_PREFIXES.some(prefix => x.startsWith(prefix)));
  return line ? line.replace(/^[#\-*\s]+/, '').slice(0, TITLE_MAX_LENGTH) : '';
}

interface ListDetails {
  updatedAt: number;
  sizeBytes: number;
  title?: string | undefined;
}

// A session list item, or null for sessions without a single user prompt. An empty title is
// worded by the UI ("untitled session").
function listEntry(transcript: Transcript, { updatedAt, sizeBytes, title }: ListDetails): SessionSummary | null {
  if (!transcript.turnCount) return null;
  return {
    id: transcript.sessionId,
    providerId: transcript.providerId,
    title: title || transcript.sessionTitle,
    updatedAt,
    sizeBytes,
    turnCount: transcript.turnCount,
    model: transcript.sessionModel
  };
}

const openDb = (file: string): DatabaseSync => new DatabaseSync(file, { readOnly: true });

function withDb<T>(file: string, task: (db: DatabaseSync) => T): T {
  const db = openDb(file);
  try {
    return task(db);
  } finally {
    db.close();
  }
}

const bytes = (value: SQLOutputValue | undefined): Buffer | null => (value instanceof Uint8Array ? Buffer.from(value) : null);

function emptyTranscript(providerId: ProviderId, sessionId: string): Transcript {
  return {
    providerId,
    sessionId,
    sessionTitle: '',
    sessionModel: '',
    initialGoal: '',
    lastUserMsg: '',
    lastAssistantMsg: '',
    turnCount: 0,
    files: []
  };
}

function addUser(transcript: Transcript, message: string): void {
  const clean = sanitizeText(message);
  if (!clean) return;
  transcript.turnCount++;
  if (!transcript.initialGoal) transcript.initialGoal = clean;
  if (!transcript.sessionTitle) transcript.sessionTitle = titleFrom(clean);
  transcript.lastUserMsg = clean;
}

function addAssistant(transcript: Transcript, message: string): void {
  const clean = sanitizeText(message);
  if (clean) transcript.lastAssistantMsg = clean;
}

// Text parts of a content array whose part types are listed; a plain string as is.
function contentText(content: unknown, types: readonly string[]): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(part => (types.includes(String(field(part, 'type'))) ? text(field(part, 'text')) : '')).join('\n');
}

// ---------------------------------------------------------------- Claude Code
function claudeProjectDirs(projectDir: string, homeDir: string): string[] {
  const resolved = path.resolve(projectDir);
  const slugs = new Set([resolved.replace(/[/\\:]/g, '-'), resolved.replace(/[^a-zA-Z0-9]/g, '-')]);
  return [...slugs].map(slug => path.join(homeDir, '.claude', 'projects', slug)).filter(dir => fs.existsSync(dir));
}

const CLAUDE_TEXT_PARTS = ['text'];

function claudeFilePath(record: JsonObject): unknown {
  const content = field(record.message, 'content');
  const edited = Array.isArray(content) ? content.map(part => field(field(part, 'input'), 'file_path')).find(Boolean) : undefined;
  return field(record.toolUseResult, 'filePath') ?? edited;
}

async function readClaudeFile(file: string, id: string): Promise<Transcript> {
  const transcript = emptyTranscript('claude', id);
  const files = new Set<string>();
  let aiTitle = '';
  for (const record of jsonLines(await fsp.readFile(file, 'utf8'))) {
    const { message } = record;
    const content = field(message, 'content');
    const model = field(message, 'model');
    if (record.type === 'ai-title' && typeof record.aiTitle === 'string') aiTitle = record.aiTitle;
    // Messages Claude Code generates itself (API errors, limit notices) are not the model's.
    const synthetic = Boolean(record.isApiErrorMessage) || model === SYNTHETIC_MODEL;
    if (typeof model === 'string' && !synthetic) transcript.sessionModel = model;
    // Tool results are user-role records too; only real prompts count.
    const toolResults = Array.isArray(content) && content.every(part => field(part, 'type') === 'tool_result');
    if (record.type === 'user' && content && !record.isMeta && !toolResults) addUser(transcript, contentText(content, CLAUDE_TEXT_PARTS));
    if (record.type === 'assistant' && content && !synthetic) addAssistant(transcript, contentText(content, CLAUDE_TEXT_PARTS));
    const edited = claudeFilePath(record);
    if (typeof edited === 'string') files.add(edited);
  }
  if (aiTitle) transcript.sessionTitle = aiTitle;
  transcript.files = [...files].slice(-RECENT_FILES);
  return transcript;
}

async function listClaude(projectDir: string, homeDir: string): Promise<(SessionSummary | null)[]> {
  const sessions: (SessionSummary | null)[] = [];
  for (const dir of claudeProjectDirs(projectDir, homeDir)) {
    for (const name of await fsp.readdir(dir).catch(() => [])) {
      if (!name.endsWith('.jsonl')) continue;
      const file = path.join(dir, name);
      sessions.push(
        await attempt(async () => {
          const stat = await fsp.stat(file);
          return listEntry(await readClaudeFile(file, path.basename(name, '.jsonl')), { updatedAt: stat.mtimeMs, sizeBytes: stat.size });
        })
      );
    }
  }
  return sessions;
}

async function readClaude(projectDir: string, homeDir: string, id: string): Promise<Transcript | null> {
  for (const dir of claudeProjectDirs(projectDir, homeDir)) {
    const file = path.join(dir, `${id}.jsonl`);
    if (fs.existsSync(file)) return readClaudeFile(file, id);
  }
  return null;
}

// ---------------------------------------------------------------------- Codex
const codexHome = (homeDir: string): string => path.join(homeDir, '.codex');
const ROLLOUT_FILE = /^rollout-.*\.jsonl(\.zst)?$/;
// A session's own rollout is named after its id; fork snapshots append `_<childId>`.
const OWN_ROLLOUT = /^rollout-.*-([0-9a-f-]{36})\.jsonl(\.zst)?$/i;
const isCompressed = (file: string): boolean => file.endsWith('.zst');

// Codex stores recent rollouts as .jsonl and compresses older ones to .jsonl.zst.
function walkRollouts(dir: string): string[] {
  const entries = attemptSync(() => fs.readdirSync(dir, { withFileTypes: true })) ?? [];
  return entries.flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walkRollouts(full);
    return entry.isFile() && ROLLOUT_FILE.test(entry.name) ? [full] : [];
  });
}

const MAX_META_LINE_BYTES = 1024 * 1024;

// The first line of a rollout (its session_meta record), streamed so that a large or
// compressed file is never read whole. Resolves to '' when there is no complete line.
function readFirstLine(file: string): Promise<string> {
  return new Promise(resolve => {
    const input = fs.createReadStream(file);
    const stream = isCompressed(file) ? input.pipe(zlib.createZstdDecompress()) : input;
    const chunks: Buffer[] = [];
    let size = 0;
    const finish = (line: string): void => {
      input.destroy();
      stream.destroy();
      resolve(line);
    };
    stream.on('data', (chunk: Buffer) => {
      const newline = chunk.indexOf(0x0a);
      chunks.push(newline === -1 ? chunk : chunk.subarray(0, newline));
      size += chunk.length;
      if (newline !== -1) finish(Buffer.concat(chunks).toString('utf8'));
      else if (size > MAX_META_LINE_BYTES) finish('');
    });
    stream.on('end', () => {
      finish('');
    });
    stream.on('error', () => {
      finish('');
    });
    input.on('error', () => {
      finish('');
    });
  });
}

async function readRollout(file: string): Promise<string> {
  const raw = await fsp.readFile(file);
  return (isCompressed(file) ? zlib.zstdDecompressSync(raw) : raw).toString('utf8');
}

// Parsed results per file, reused until the file changes.
function mtimeMemo<T>(): (file: string, compute: () => Promise<T>) => Promise<T> {
  const memo = new Map<string, { mtimeMs: number; value: T }>();
  return async (file, compute) => {
    const { mtimeMs } = await fsp.stat(file);
    const hit = memo.get(file);
    if (hit?.mtimeMs === mtimeMs) return hit.value;
    const value = await compute();
    memo.set(file, { mtimeMs, value });
    return value;
  };
}

interface CodexMeta {
  id: string;
  cwd: unknown;
  subagent: boolean;
}

// The first record is session_meta. Subagent threads (Guardian reviews, spawned workers) have
// an object `source` and are skipped.
const codexMetaMemo = mtimeMemo<CodexMeta | null>();
function readCodexMeta(file: string): Promise<CodexMeta | null> {
  return codexMetaMemo(file, async () => {
    const [record] = jsonLines(await readFirstLine(file));
    const payload = record?.type === 'session_meta' ? record.payload : undefined;
    const id = field(payload, 'id');
    return typeof id === 'string'
      ? { id, cwd: field(payload, 'cwd'), subagent: Boolean(field(field(payload, 'source'), 'subagent')) }
      : null;
  });
}

const CODEX_TEXT_PARTS = ['input_text', 'output_text'];

// Injected context (AGENTS.md, environment, skills) is sent as user-role messages.
function isCodexInjected(message: string): boolean {
  const start = message.trimStart();
  return start.startsWith('<') || start.startsWith('# AGENTS.md instructions');
}

async function readCodexFile(file: string, id: string): Promise<Transcript> {
  const transcript = emptyTranscript('codex', id);
  for (const record of jsonLines(await readRollout(file))) {
    const payload = isObject(record.payload) ? record.payload : {};
    const settingsModel = field(payload.thread_settings, 'model');
    if (record.type === 'turn_context' && typeof payload.model === 'string') transcript.sessionModel = payload.model;
    if (record.type === 'event_msg' && payload.type === 'thread_settings_applied' && typeof settingsModel === 'string')
      transcript.sessionModel = settingsModel;
    if (record.type === 'response_item' && payload.type === 'message') {
      const message = Array.isArray(payload.content) ? contentText(payload.content, CODEX_TEXT_PARTS) : '';
      if (payload.role === 'user' && !isCodexInjected(message)) addUser(transcript, message);
      if (payload.role === 'assistant') addAssistant(transcript, message);
    }
  }
  return transcript;
}

function codexThreadNames(homeDir: string): Map<string, string> {
  const index = attemptSync(() => fs.readFileSync(path.join(codexHome(homeDir), 'session_index.jsonl'), 'utf8')) ?? '';
  const names = new Map<string, string>();
  for (const { id, thread_name: name } of jsonLines(index))
    if (typeof id === 'string' && typeof name === 'string' && name) names.set(id, name);
  return names;
}

interface Rollout {
  file: string;
  id: string;
}

// Fork snapshots start with the parent's session_meta; a session's own rollout is preferred.
async function findCodexRollouts(projectDir: string, homeDir: string): Promise<Rollout[]> {
  const byId = new Map<string, Rollout & { own: boolean }>();
  for (const file of walkRollouts(path.join(codexHome(homeDir), 'sessions'))) {
    const meta = await attempt(() => readCodexMeta(file));
    if (!meta || meta.subagent || !samePath(meta.cwd, projectDir)) continue;
    const own = OWN_ROLLOUT.exec(path.basename(file))?.[1] === meta.id;
    const previous = byId.get(meta.id);
    if (!previous || (own && !previous.own)) byId.set(meta.id, { file, id: meta.id, own });
  }
  return [...byId.values()].map(({ file, id }) => ({ file, id }));
}

// Turn counts need a full parse; reuse it until the rollout changes.
const codexSummaryMemo = mtimeMemo<Transcript>();

async function listCodex(projectDir: string, homeDir: string): Promise<(SessionSummary | null)[]> {
  const names = codexThreadNames(homeDir);
  const sessions: (SessionSummary | null)[] = [];
  for (const { file, id } of await findCodexRollouts(projectDir, homeDir)) {
    sessions.push(
      await attempt(async () => {
        const stat = await fsp.stat(file);
        const transcript = await codexSummaryMemo(file, () => readCodexFile(file, id));
        return listEntry(transcript, { updatedAt: stat.mtimeMs, sizeBytes: stat.size, title: names.get(id) });
      })
    );
  }
  return sessions;
}

async function readCodex(projectDir: string, homeDir: string, id: string): Promise<Transcript | null> {
  const hit = (await findCodexRollouts(projectDir, homeDir)).find(rollout => rollout.id === id);
  if (!hit) return null;
  const transcript = await readCodexFile(hit.file, id);
  const name = codexThreadNames(homeDir).get(id);
  if (name) transcript.sessionTitle = name;
  return transcript;
}

// ----------------------------------------------------------------- Cursor CLI
// ~/.cursor/chats/<hash>/<chatId>/{meta.json,store.db}. meta.json records cwd; store.db holds
// JSON message blobs ({"role":...}) in insertion (rowid) order.
const CURSOR_DEFAULT_CHAT_NAME = 'New Agent';
const JSON_OBJECT_START = 0x7b; // '{'; other blobs are internal tree nodes
const HEX = /^[0-9a-f]+$/i;
const USER_QUERY = /<user_query>\s*([\s\S]*?)\s*<\/user_query>/;
const CURSOR_TEXT_PARTS = ['text'];

interface CursorChat {
  id: string;
  dir: string;
  updatedAtMs: unknown;
}

const subdirectories = (dir: string): fs.Dirent[] =>
  (attemptSync(() => fs.readdirSync(dir, { withFileTypes: true })) ?? []).filter(entry => entry.isDirectory());

function cursorChatDirs(projectDir: string, homeDir: string): CursorChat[] {
  const root = path.join(homeDir, '.cursor', 'chats');
  return subdirectories(root).flatMap(workspace =>
    subdirectories(path.join(root, workspace.name)).flatMap(chat => {
      const dir = path.join(root, workspace.name, chat.name);
      const meta = readJsonSync(path.join(dir, 'meta.json'));
      if (!isObject(meta) || meta.hasConversation === false || !samePath(meta.cwd, projectDir)) return [];
      return [{ id: chat.name, dir, updatedAtMs: meta.updatedAtMs }];
    })
  );
}

function readCursorChat(dir: string, id: string): Transcript {
  const transcript = emptyTranscript('cursor', id);
  withDb(path.join(dir, 'store.db'), db => {
    // The chat record is JSON, stored hex-encoded by current CLI versions.
    const raw = String(db.prepare("SELECT value FROM meta WHERE key = '0'").get()?.value ?? '');
    const chat = attemptSync((): unknown => JSON.parse(HEX.test(raw) ? Buffer.from(raw, 'hex').toString('utf8') : raw));
    const name = field(chat, 'name');
    if (typeof name === 'string' && name && name !== CURSOR_DEFAULT_CHAT_NAME) transcript.sessionTitle = name;
    for (const row of db.prepare('SELECT data FROM blobs ORDER BY rowid').all()) {
      const blob = bytes(row.data);
      if (blob?.[0] !== JSON_OBJECT_START) continue;
      const message = attemptSync((): unknown => JSON.parse(blob.toString('utf8')));
      const content = contentText(field(message, 'content'), CURSOR_TEXT_PARTS);
      const role = field(message, 'role');
      const query = role === 'user' ? USER_QUERY.exec(content)?.[1] : undefined;
      if (query !== undefined) addUser(transcript, query);
      if (role === 'assistant') addAssistant(transcript, content);
    }
  });
  return transcript;
}

function listCursor(projectDir: string, homeDir: string): (SessionSummary | null)[] {
  return cursorChatDirs(projectDir, homeDir).map(({ id, dir, updatedAtMs }) =>
    attemptSync(() => {
      const stat = fs.statSync(path.join(dir, 'store.db'));
      const updatedAt = typeof updatedAtMs === 'number' && updatedAtMs ? updatedAtMs : stat.mtimeMs;
      return listEntry(readCursorChat(dir, id), { updatedAt, sizeBytes: stat.size });
    })
  );
}

function readCursor(projectDir: string, homeDir: string, id: string): Transcript | null {
  const hit = cursorChatDirs(projectDir, homeDir).find(chat => chat.id === id);
  return hit ? readCursorChat(hit.dir, id) : null;
}

// ---------------------------------------------------------------- Antigravity
// conversations/<id>.db is SQLite; trajectory_metadata_blob carries the workspace as a
// file:// URI. The readable transcript lives in brain/<id>/.system_generated/logs.
const antigravityRoot = (homeDir: string): string => path.join(homeDir, '.gemini', 'antigravity-ide');
const WINDOWS_DRIVE_URI = /^file:\/\/\/([A-Za-z]):(.*)$/;
const PROTOBUF_TAG_START = 0x20; // bytes below are control bytes: the next protobuf tag
const SLASH = 0x2f;

function workspaceUris(projectDir: string): Buffer[] {
  const href = pathToFileURL(path.resolve(projectDir)).href.replace(/\/$/, '');
  const uris = new Set([href]);
  // VS Code-style URIs lower-case and percent-encode the Windows drive colon.
  const [, drive, rest] = WINDOWS_DRIVE_URI.exec(href) ?? [];
  if (drive) {
    uris.add(`file:///${drive.toLowerCase()}%3A${rest}`);
    uris.add(`file:///${drive.toLowerCase()}:${rest}`);
  }
  return [...uris].map(uri => Buffer.from(uri));
}

// The URI is protobuf-embedded; a match must not continue as a longer path segment.
function blobHasWorkspace(blob: Buffer, uris: readonly Buffer[]): boolean {
  const endsAt = (at: number): boolean => {
    const next = blob[at];
    return next === undefined || next < PROTOBUF_TAG_START;
  };
  return uris.some(uri => {
    for (let at = blob.indexOf(uri); at !== -1; at = blob.indexOf(uri, at + 1)) {
      const end = at + uri.length;
      // The URI ends at a control byte, optionally after one '/'.
      if (endsAt(end) || (blob[end] === SLASH && endsAt(end + 1))) return true;
    }
    return false;
  });
}

// Best effort: the latest generation record stores the model display name as a
// length-prefixed string under protobuf field 21 (tag 0xaa 0x01).
const MODEL_NAME_TAG = Buffer.from([0xaa, 0x01]);
const MODEL_NAME_MAX_LENGTH = 80;
const MODEL_NAME = /^(Gemini|Claude|GPT)[\w .()-]*$/;

function antigravityModel(db: DatabaseSync): string {
  const blob = bytes(attemptSync(() => db.prepare('SELECT data FROM gen_metadata ORDER BY idx DESC LIMIT 1').get())?.data);
  if (!blob) return '';
  let found = '';
  for (let i = blob.indexOf(MODEL_NAME_TAG); i !== -1; i = blob.indexOf(MODEL_NAME_TAG, i + 1)) {
    const length = blob[i + MODEL_NAME_TAG.length];
    if (!length || length > MODEL_NAME_MAX_LENGTH) continue;
    const start = i + MODEL_NAME_TAG.length + 1;
    const name = blob.toString('utf8', start, start + length);
    if (MODEL_NAME.test(name)) found = name;
  }
  return found;
}

interface AntigravityConversation {
  id: string;
  file: string;
  model: string;
}

function antigravityConversations(projectDir: string, homeDir: string): AntigravityConversation[] {
  const dir = path.join(antigravityRoot(homeDir), 'conversations');
  const uris = workspaceUris(projectDir);
  return (attemptSync(() => fs.readdirSync(dir)) ?? [])
    .filter(name => name.endsWith('.db'))
    .flatMap(name => {
      const file = path.join(dir, name);
      const conversation = attemptSync(() =>
        withDb(file, db => {
          const rows = db.prepare('SELECT data FROM trajectory_metadata_blob').all();
          const inProject = rows.some(row => {
            const blob = bytes(row.data);
            return blob !== null && blobHasWorkspace(blob, uris);
          });
          return inProject ? { id: path.basename(name, '.db'), file, model: antigravityModel(db) } : null;
        })
      );
      return conversation ? [conversation] : [];
    });
}

const MARKUP = /<[^>]+>/g;

async function readAntigravityTranscript(homeDir: string, id: string, model: string): Promise<Transcript> {
  const transcript = emptyTranscript('antigravity', id);
  transcript.sessionModel = model;
  const file = path.join(antigravityRoot(homeDir), 'brain', id, '.system_generated', 'logs', 'transcript.jsonl');
  for (const { type, content } of jsonLines(await fsp.readFile(file, 'utf8').catch(() => ''))) {
    if (typeof content !== 'string') continue;
    if (type === 'USER_INPUT') addUser(transcript, content.replace(MARKUP, ''));
    if (type === 'PLANNER_RESPONSE') addAssistant(transcript, content);
  }
  return transcript;
}

async function listAntigravity(projectDir: string, homeDir: string): Promise<(SessionSummary | null)[]> {
  const sessions: (SessionSummary | null)[] = [];
  for (const { id, file, model } of antigravityConversations(projectDir, homeDir)) {
    sessions.push(
      await attempt(async () => {
        const stat = await fsp.stat(file);
        return listEntry(await readAntigravityTranscript(homeDir, id, model), { updatedAt: stat.mtimeMs, sizeBytes: stat.size });
      })
    );
  }
  return sessions;
}

async function readAntigravity(projectDir: string, homeDir: string, id: string): Promise<Transcript | null> {
  const hit = antigravityConversations(projectDir, homeDir).find(conversation => conversation.id === id);
  return hit ? readAntigravityTranscript(homeDir, id, hit.model) : null;
}

// --------------------------------------------------------------------- public
type Lister = (projectDir: string, homeDir: string) => Promise<(SessionSummary | null)[]> | (SessionSummary | null)[];
type Reader = (projectDir: string, homeDir: string, id: string) => Promise<Transcript | null> | Transcript | null;

const LISTERS: Record<ProviderId, Lister> = { claude: listClaude, codex: listCodex, cursor: listCursor, antigravity: listAntigravity };
const READERS: Record<ProviderId, Reader> = { claude: readClaude, codex: readCodex, cursor: readCursor, antigravity: readAntigravity };

const providersFor = (providerId: ProviderId | Auto): readonly ProviderId[] => (providerId === AUTO ? PROVIDER_IDS : [providerId]);

// Sessions of the project, newest first. A provider whose data cannot be read lists none.
export async function listProviderSessions(providerId: ProviderId | Auto, projectDir: string, homeDir: string): Promise<SessionSummary[]> {
  const results = await Promise.allSettled(providersFor(providerId).map(async id => LISTERS[id](projectDir, homeDir)));
  return results
    .flatMap(result => (result.status === 'fulfilled' ? result.value : []))
    .filter(session => session !== null)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export interface SessionQuery {
  providerId: ProviderId | Auto;
  sessionId: string;
  projectDir: string;
  homeDir: string;
}

// One session; with sessionId 'auto' the newest session of the provider(s). Null when
// nothing matches: another provider's session is never substituted.
export async function readSession({ providerId, sessionId, projectDir, homeDir }: SessionQuery): Promise<Transcript | null> {
  if (!sessionId || sessionId === AUTO) {
    const [latest] = await listProviderSessions(providerId, projectDir, homeDir);
    return latest ? readSession({ providerId: latest.providerId, sessionId: latest.id, projectDir, homeDir }) : null;
  }
  for (const id of providersFor(providerId)) {
    const transcript = await attempt(async () => READERS[id](projectDir, homeDir, sessionId));
    if (transcript) return transcript;
  }
  return null;
}
