// Per-provider discovery and reading of local agent sessions for a project directory. Every
// provider is filtered by the session's recorded working directory, so a session only ever
// appears under the project it was started in. Formats were verified against real local
// data (Claude Code JSONL, Codex rollout JSONL, Cursor CLI store.db, Antigravity
// conversations/*.db + brain transcript); unknown fields are left empty instead of guessed.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import zlib from 'node:zlib';
import { CLAUDE_FILES, SYNTHETIC_MODEL } from '../providers/claude.ts';
import { CODEX_SESSIONS_DIR } from '../providers/codex.ts';
import { accountProfileDirs, defaultProfileDir } from '../providers/profiles.ts';
import {
  AUTO,
  CLAUDE_PERMISSION_MODES,
  isOneOf,
  WORK_PROVIDER_IDS,
  type Auto,
  type ClaudePermissionMode,
  type ProfileProviderId,
  type ProviderId
} from '../shared/catalog.ts';
import type { SessionSourceRef, SessionSummary } from '../shared/ipc.ts';
import type { Account } from '../shared/types.ts';
import {
  attempt,
  attemptSync,
  field,
  isObject,
  JSON_LINES_EXTENSION,
  jsonLines,
  newestFiles,
  readJsonSync,
  readTail,
  samePath,
  type JsonObject
} from './files.ts';
import { redactSecretsWithReview } from './redact.ts';

// Where transcripts are kept: tools with profile folders keep them in each profile (the
// default one and every folder an account uses); the others under the home folder.
export interface SessionSources {
  homeDir: string;
  profiles: Readonly<Record<ProfileProviderId, readonly string[]>>;
  accounts?: readonly Account[];
}

export function sessionSources(homeDir: string, accounts: readonly Account[] = []): SessionSources {
  return {
    homeDir,
    accounts,
    profiles: { claude: accountProfileDirs('claude', homeDir, accounts), codex: accountProfileDirs('codex', homeDir, accounts) }
  };
}

// A message of the conversation: what the user or the agent wrote, without tool calls or
// their output.
export interface Turn {
  role: 'user' | 'assistant';
  text: string;
}

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
  // The end of the conversation, oldest first. Consecutive messages of one role form one turn.
  recent: Turn[];
  secretReviewRequired?: boolean;
}

export interface ResolvedSession extends Transcript {
  source: SessionSourceRef;
  projectDir: string;
}

interface SessionCandidate {
  summary: SessionSummary;
  transcript: ResolvedSession;
}

const canonicalPath = (file: string): string => attemptSync(() => fs.realpathSync.native(file)) ?? path.resolve(file);
const sameProject = (a: string, b: string): boolean => samePath(a, b) || samePath(canonicalPath(a), canonicalPath(b));
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fileVersion = (file: string): string => {
  const stat = attemptSync(() => fs.statSync(file, { bigint: true }));
  return stat ? [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':') : 'missing';
};
const SESSION_CACHE_LIMIT = 512;
function cacheEntry<T>(cache: Map<string, T>, file: string, value: T, limit = SESSION_CACHE_LIMIT): void {
  cache.delete(file);
  cache.set(file, value);
  if (cache.size > limit) cache.delete(cache.keys().next().value ?? '');
}

function sourceAccount(providerId: ProviderId, profile: string | undefined, sources: SessionSources): string | undefined {
  return sources.accounts?.find(account => {
    if (!account.enabled || account.providerId !== providerId) return false;
    if (!profile || (providerId !== 'claude' && providerId !== 'codex')) return true;
    return sameProject(account.configDir ?? defaultProfileDir(providerId, sources.homeDir), profile);
  })?.id;
}

// The recent conversation is bounded by turns, by turn length and in total.
export const RECENT_TURNS = { count: 12, turnChars: 1500, totalChars: 12000 };
const ELISION = '\n[…]\n';

const SYSTEM_REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/gi;

// Secrets are removed from the whole message, before any clipping could cut one in half.
function sanitizeText(text: string, transcript: Transcript): string {
  const result = redactSecretsWithReview(text.replace(SYSTEM_REMINDER, ''));
  if (result.requiresReview) transcript.secretReviewRequired = true;
  return result.text.trim();
}

// Long turns keep their beginning (the request) and their end (the conclusion).
function elide(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const half = Math.floor((limit - ELISION.length) / 2);
  return `${text.slice(0, half)}${ELISION}${text.slice(-half)}`;
}

// A folder a record names, compared with `b`.
const namesPath = (a: unknown, b: string): boolean => typeof a === 'string' && a !== '' && sameProject(a, b);

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
  file: string;
  projectDir: string;
  sources: SessionSources;
  profile?: string;
  dependencies?: string[];
}

// A session list item, or null for sessions without a single user prompt. An empty title is
// worded by the UI ("untitled session").
function listEntry(transcript: Transcript, details: ListDetails): SessionCandidate | null {
  if (!transcript.turnCount) return null;
  const { updatedAt, sizeBytes, title, file, projectDir, sources, profile, dependencies = [] } = details;
  const accountId = sourceAccount(transcript.providerId, profile, sources);
  const source: SessionSourceRef = {
    id: digest([transcript.providerId, canonicalPath(file), canonicalPath(projectDir), accountId ?? null]),
    version: digest([[file, ...dependencies].map(fileVersion), transcript, title ?? null]),
    ...(accountId ? { accountId } : {})
  };
  return {
    summary: {
      id: transcript.sessionId,
      providerId: transcript.providerId,
      source,
      title: title || transcript.sessionTitle,
      updatedAt,
      sizeBytes,
      turnCount: transcript.turnCount,
      model: transcript.sessionModel
    },
    transcript: { ...transcript, ...(title ? { sessionTitle: title } : {}), source, projectDir: canonicalPath(projectDir) }
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
    files: [],
    recent: []
  };
}

// Appends to the recent conversation, dropping the oldest turns beyond its bounds.
function remember({ recent }: Transcript, role: Turn['role'], message: string): void {
  const last = recent.at(-1);
  if (last?.role === role) last.text = elide(`${last.text}\n\n${message}`, RECENT_TURNS.turnChars);
  else recent.push({ role, text: elide(message, RECENT_TURNS.turnChars) });
  let total = recent.reduce((sum, turn) => sum + turn.text.length, 0);
  while (recent.length > RECENT_TURNS.count || (recent.length > 1 && total > RECENT_TURNS.totalChars))
    total -= recent.shift()?.text.length ?? 0;
}

function addUser(transcript: Transcript, message: string): void {
  const clean = sanitizeText(message, transcript);
  if (!clean) return;
  transcript.turnCount++;
  if (!transcript.initialGoal) transcript.initialGoal = clean;
  if (!transcript.sessionTitle) transcript.sessionTitle = titleFrom(clean);
  transcript.lastUserMsg = clean;
  remember(transcript, 'user', clean);
}

function addAssistant(transcript: Transcript, message: string): void {
  const clean = sanitizeText(message, transcript);
  if (!clean) return;
  transcript.lastAssistantMsg = clean;
  remember(transcript, 'assistant', clean);
}

// Text parts of a content array whose part types are listed; a plain string as is.
function contentText(content: unknown, types: readonly string[]): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(part => (types.includes(String(field(part, 'type'))) ? text(field(part, 'text')) : '')).join('\n');
}

// ---------------------------------------------------------------- Claude Code
function claudeProjectDirs(projectDir: string, { profiles }: SessionSources): { dir: string; profile: string; legacyProject: boolean }[] {
  const resolved = path.resolve(projectDir);
  const slugs = new Set([resolved.replace(/[/\\:]/g, '-'), resolved.replace(/[^a-zA-Z0-9]/g, '-')]);
  // A worktree's transcript can remain in its original repository's storage directory, and Claude
  // Code creates worktrees inside the repository: only the project's own directory and those of
  // folders that contain it can hold such a session. Reading every project's transcripts instead
  // took about a minute on a cold disk with several GB of transcripts. Recorded/relocated cwd
  // still determines ownership.
  const encloses = (name: string): boolean => [...slugs].some(slug => slug.startsWith(`${name}-`));
  return profiles.claude.flatMap(profile => {
    const root = path.join(profile, CLAUDE_FILES.projects);
    return subdirectories(root)
      .filter(entry => slugs.has(entry.name) || encloses(entry.name))
      .map(entry => ({ dir: path.join(root, entry.name), profile, legacyProject: slugs.has(entry.name) }));
  });
}

const CLAUDE_TEXT_PARTS = ['text'];

function claudeFilePath(record: JsonObject): unknown {
  const content = field(record.message, 'content');
  const edited = Array.isArray(content) ? content.map(part => field(field(part, 'input'), 'file_path')).find(Boolean) : undefined;
  return field(record.toolUseResult, 'filePath') ?? edited;
}

// Parsed results per file, reused until the file changes.
function mtimeMemo<T>(): (file: string, compute: () => Promise<T>) => Promise<T> {
  const memo = new Map<string, { version: string; value: T }>();
  return async (file, compute) => {
    const version = fileVersion(file);
    const hit = memo.get(file);
    if (hit?.version === version) return hit.value;
    const value = await compute();
    if (fileVersion(file) !== version) throw new Error('Session changed while reading');
    // A bounded cache, shared by listing and resolving the exact reviewed source.
    cacheEntry(memo, file, { version, value });
    return value;
  };
}

// Listing parses every transcript of the project, which can be hundreds of megabytes.
const claudeMemo = mtimeMemo<Transcript>();
const readClaudeFile = (file: string, id: string): Promise<Transcript> => claudeMemo(file, () => parseClaudeFile(file, id));

async function parseClaudeFile(file: string, id: string): Promise<Transcript> {
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
    // Older versions kept subagent threads (sidechains) in the same file; they are not the
    // conversation with the user.
    const mainThread = content && !record.isSidechain;
    if (record.type === 'user' && mainThread && !record.isMeta && !toolResults)
      addUser(transcript, contentText(content, CLAUDE_TEXT_PARTS));
    if (record.type === 'assistant' && mainThread && !synthetic) addAssistant(transcript, contentText(content, CLAUDE_TEXT_PARTS));
    const edited = claudeFilePath(record);
    if (typeof edited === 'string') files.add(edited);
  }
  if (aiTitle) transcript.sessionTitle = aiTitle;
  transcript.files = [...files].slice(-RECENT_FILES);
  return transcript;
}

async function listClaude(projectDir: string, sources: SessionSources, sessionId?: string): Promise<(SessionCandidate | null)[]> {
  const sessions: (SessionCandidate | null)[] = [];
  for (const { dir, profile, legacyProject } of claudeProjectDirs(projectDir, sources)) {
    for (const name of await fsp.readdir(dir).catch(() => [])) {
      if (!name.endsWith(JSON_LINES_EXTENSION)) continue;
      if (sessionId && name !== `${sessionId}${JSON_LINES_EXTENSION}`) continue;
      const file = path.join(dir, name);
      sessions.push(
        await attempt(async () => {
          const ownership = await readClaudeProject(file);
          if (!ownership) return null;
          const recordedProject = ownership.projectDir;
          if (recordedProject ? !sameProject(recordedProject, projectDir) : !legacyProject) return null;
          const stat = await fsp.stat(file);
          const transcript = await readClaudeFile(file, path.basename(name, JSON_LINES_EXTENSION));
          if (fileVersion(file) !== ownership.version) return null;
          return listEntry(transcript, {
            updatedAt: stat.mtimeMs,
            sizeBytes: stat.size,
            file,
            projectDir,
            sources,
            profile
          });
        })
      );
    }
  }
  return sessions;
}

// ---------------------------------------------------------------------- Codex
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

interface CodexMeta {
  id: string;
  cwd: unknown;
  subagent: boolean;
  // Started by `codex exec`: a program runs it, not a person in a terminal.
  headless: boolean;
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
      ? {
          id,
          cwd: field(payload, 'cwd'),
          subagent: Boolean(field(field(payload, 'source'), 'subagent')),
          headless: field(payload, 'source') === 'exec'
        }
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

function codexThreadNames({ profiles }: SessionSources): Map<string, string> {
  const names = new Map<string, string>();
  for (const root of profiles.codex) {
    const index = attemptSync(() => fs.readFileSync(path.join(root, 'session_index.jsonl'), 'utf8')) ?? '';
    for (const { id, thread_name: name } of jsonLines(index))
      if (typeof id === 'string' && typeof name === 'string' && name) names.set(id, name);
  }
  return names;
}

interface Rollout {
  file: string;
  id: string;
  profile: string;
}

// Fork snapshots start with the parent's session_meta; a session's own rollout is preferred.
async function findCodexRollouts(projectDir: string, { profiles }: SessionSources): Promise<Rollout[]> {
  const byId = new Map<string, Rollout & { own: boolean }>();
  for (const { file, profile } of profiles.codex.flatMap(profile =>
    walkRollouts(path.join(profile, CODEX_SESSIONS_DIR)).map(file => ({ file, profile }))
  )) {
    const meta = await attempt(() => readCodexMeta(file));
    if (!meta || meta.subagent || typeof meta.cwd !== 'string' || !sameProject(meta.cwd, projectDir)) continue;
    const own = OWN_ROLLOUT.exec(path.basename(file))?.[1] === meta.id;
    const key = `${canonicalPath(profile)}:${meta.id}`;
    const previous = byId.get(key);
    if (!previous || (own && !previous.own)) byId.set(key, { file, id: meta.id, profile, own });
  }
  return [...byId.values()].map(({ file, id, profile }) => ({ file, id, profile }));
}

// Turn counts need a full parse; reuse it until the rollout changes.
const codexSummaryMemo = mtimeMemo<Transcript>();

async function listCodex(projectDir: string, sources: SessionSources, sessionId?: string): Promise<(SessionCandidate | null)[]> {
  const sessions: (SessionCandidate | null)[] = [];
  for (const { file, id, profile } of await findCodexRollouts(projectDir, sources)) {
    if (sessionId && id !== sessionId) continue;
    sessions.push(
      await attempt(async () => {
        const stat = await fsp.stat(file);
        const transcript = await codexSummaryMemo(file, () => readCodexFile(file, id));
        const names = codexThreadNames({ ...sources, profiles: { ...sources.profiles, codex: [profile] } });
        return listEntry(transcript, {
          updatedAt: stat.mtimeMs,
          sizeBytes: stat.size,
          title: names.get(id),
          file,
          projectDir,
          sources,
          profile,
          dependencies: [path.join(profile, 'session_index.jsonl')]
        });
      })
    );
  }
  return sessions;
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
      if (!isObject(meta) || meta.hasConversation === false || !namesPath(meta.cwd, projectDir)) return [];
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

function listCursor(projectDir: string, sources: SessionSources, sessionId?: string): (SessionCandidate | null)[] {
  return cursorChatDirs(projectDir, sources.homeDir)
    .filter(chat => !sessionId || chat.id === sessionId)
    .map(({ id, dir, updatedAtMs }) =>
      attemptSync(() => {
        const file = path.join(dir, 'store.db');
        const stat = fs.statSync(file);
        const updatedAt = typeof updatedAtMs === 'number' && updatedAtMs ? updatedAtMs : stat.mtimeMs;
        return listEntry(readCursorChat(dir, id), {
          updatedAt,
          sizeBytes: stat.size,
          file,
          projectDir,
          sources,
          dependencies: [path.join(dir, 'meta.json'), `${file}-wal`]
        });
      })
    );
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
const antigravityTranscriptFile = (homeDir: string, id: string): string =>
  path.join(antigravityRoot(homeDir), 'brain', id, '.system_generated', 'logs', 'transcript.jsonl');

async function readAntigravityTranscript(homeDir: string, id: string, model: string): Promise<Transcript> {
  const transcript = emptyTranscript('antigravity', id);
  transcript.sessionModel = model;
  const file = antigravityTranscriptFile(homeDir, id);
  for (const { type, content } of jsonLines(await fsp.readFile(file, 'utf8').catch(() => ''))) {
    if (typeof content !== 'string') continue;
    if (type === 'USER_INPUT') addUser(transcript, content.replace(MARKUP, ''));
    if (type === 'PLANNER_RESPONSE') addAssistant(transcript, content);
  }
  return transcript;
}

async function listAntigravity(projectDir: string, sources: SessionSources, sessionId?: string): Promise<(SessionCandidate | null)[]> {
  const { homeDir } = sources;
  const sessions: (SessionCandidate | null)[] = [];
  for (const { id, file, model } of antigravityConversations(projectDir, homeDir)) {
    if (sessionId && id !== sessionId) continue;
    sessions.push(
      await attempt(async () => {
        const stat = await fsp.stat(file);
        return listEntry(await readAntigravityTranscript(homeDir, id, model), {
          updatedAt: stat.mtimeMs,
          sizeBytes: stat.size,
          file,
          projectDir,
          sources,
          dependencies: [`${file}-wal`, antigravityTranscriptFile(homeDir, id)]
        });
      })
    );
  }
  return sessions;
}

// ------------------------------------------------------------- latest session
// The session a profile last worked in, in whichever project: what continues when its quota
// runs out. Antigravity keeps its own sessions inside the app and has none.
export interface RecentSession {
  providerId: ProviderId;
  sessionId: string;
  projectDir: string;
  updatedAt: number;
  // The transcript, for tools whose sessions can be carried to another profile.
  file: string;
  model?: string;
  accountId?: string;
}

export interface SessionIdentity {
  projectDir: string;
  sessionId: string;
}
const matchesSession = (session: RecentSession, identity?: SessionIdentity): boolean =>
  !identity || (samePath(session.projectDir, identity.projectDir) && session.sessionId === identity.sessionId);

// Claude Code writes the working directory into its records; it is near the top of the file.
const PROJECT_HEAD_BYTES = 256 * 1024;
// Metadata only (a path and a version), so far more files than the content caches.
const PROJECT_CACHE_LIMIT = 50_000;
interface ClaudeProject {
  version: string;
  projectDir: string | null;
}
const claudeProjectMemo = new Map<string, ClaudeProject>();
const mtime = (file: string): number => attemptSync(() => fs.statSync(file).mtimeMs) ?? 0;
const isFileSync = (file: string): boolean => attemptSync(() => fs.statSync(file).isFile()) ?? false;

export async function recentSessionModel(session: RecentSession): Promise<string> {
  // The model is in the last turns; a transcript can be hundreds of MB, so only its end is read.
  if (session.providerId === 'claude') return (await claudeSessionMode(session.file)).model ?? '';
  if (session.providerId === 'codex') return (await readCodexFile(session.file, session.sessionId)).sessionModel;
  return session.model ?? '';
}

// The folder a Claude Code session belongs to, as Claude Code itself attributes it: where it was
// relocated to (a worktree), else where it started. The `cwd` of later records follows the
// agent's shell and can point anywhere inside the project.
// The owner is the first record's cwd (head of the file) unless a later `relocated` record moved
// the session. A transcript can be gigabytes, so the body is searched as raw bytes for the
// marker and only the lines containing it are decoded.
const RELOCATION_MARKER = Buffer.from('"relocatedCwd"');
const SCAN_CHUNK_BYTES = 1024 * 1024;
const MAX_CARRIED_LINE_BYTES = 4 * 1024 * 1024;
const NEWLINE = 10;

function projectScan(): { feed(chunk: Buffer): void; finish(): string | null } {
  const owner: { initial: string | null; relocated: string | null } = { initial: null, relocated: null };
  const head = new StringDecoder('utf8');
  let headText = '';
  let headRead = 0;
  let carry: Buffer = Buffer.alloc(0);
  const inspectRelocation = (line: Buffer): void => {
    const [record] = jsonLines(line.toString('utf8'));
    if (record?.type === 'relocated' && typeof record.relocatedCwd === 'string' && record.relocatedCwd)
      owner.relocated = record.relocatedCwd;
  };
  return {
    feed(chunk) {
      if (headRead < PROJECT_HEAD_BYTES) {
        headText += head.write(chunk);
        headRead += chunk.length;
      }
      const data = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      let position = 0;
      for (;;) {
        const at = data.indexOf(RELOCATION_MARKER, position);
        if (at < 0) break;
        const end = data.indexOf(NEWLINE, at);
        if (end < 0) {
          // The line continues in the next chunk.
          carry = data.subarray(data.lastIndexOf(NEWLINE, at) + 1);
          return;
        }
        inspectRelocation(data.subarray(data.lastIndexOf(NEWLINE, at) + 1, end));
        position = end + 1;
      }
      // Keep the unfinished line so a marker split across chunks is still found whole.
      const unfinished = data.subarray(data.lastIndexOf(NEWLINE) + 1);
      carry = unfinished.length <= MAX_CARRIED_LINE_BYTES ? unfinished : Buffer.alloc(0);
    },
    finish() {
      if (carry.length && carry.includes(RELOCATION_MARKER)) inspectRelocation(carry);
      const first = jsonLines(headText).find(record => typeof record.cwd === 'string' && record.cwd);
      owner.initial = typeof first?.cwd === 'string' ? first.cwd : null;
      return owner.relocated ?? owner.initial;
    }
  };
}

// Read asynchronously, as every transcript is (see readTail), and cached per file version.
async function readClaudeProject(file: string): Promise<ClaudeProject | null> {
  const version = fileVersion(file);
  const hit = claudeProjectMemo.get(file);
  if (hit?.version === version) return hit;
  const project = await attempt(async () => {
    const scan = projectScan();
    const handle = await fsp.open(file, 'r');
    try {
      const buffer = Buffer.alloc(SCAN_CHUNK_BYTES);
      for (
        let read = await handle.read(buffer, 0, buffer.length, null);
        read.bytesRead;
        read = await handle.read(buffer, 0, buffer.length, null)
      )
        scan.feed(Buffer.from(buffer.subarray(0, read.bytesRead)));
    } finally {
      await handle.close();
    }
    return { version, projectDir: scan.finish() };
  });
  if (!project || fileVersion(file) !== version) return null;
  cacheEntry(claudeProjectMemo, file, project, PROJECT_CACHE_LIMIT);
  return project;
}

export const claudeProjectDir = async (file: string): Promise<string | null> => (await readClaudeProject(file))?.projectDir ?? null;

export async function latestClaudeSession(root: string, identity?: SessionIdentity): Promise<RecentSession | null> {
  const projects = path.join(root, CLAUDE_FILES.projects);
  // A known session is found by its file name; otherwise each project's newest transcript is a
  // candidate. Profiles can hold thousands of transcripts, so no others are read.
  const files = subdirectories(projects)
    .flatMap(dir => {
      const folder = path.join(projects, dir.name);
      if (!identity) return newestFiles(folder, JSON_LINES_EXTENSION).slice(0, 1);
      // An id is a file name, never a path.
      if (path.basename(identity.sessionId) !== identity.sessionId) return [];
      return [path.join(folder, `${identity.sessionId}${JSON_LINES_EXTENSION}`)].filter(isFileSync);
    })
    .map(file => ({ file, updatedAt: mtime(file) }))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map(entry => entry.file);
  for (const file of files) {
    const projectDir = await claudeProjectDir(file);
    if (!projectDir) continue;
    const session: RecentSession = {
      providerId: 'claude',
      sessionId: path.basename(file, JSON_LINES_EXTENSION),
      projectDir,
      updatedAt: mtime(file),
      file
    };
    if (matchesSession(session, identity)) return session;
  }
  return null;
}

// A Claude Code session of the profile by its id alone, in whichever project folder it is kept
// (a worktree's sessions are kept under its repository's folder).
export async function claudeSessionById(root: string, sessionId: string): Promise<RecentSession | null> {
  // An id is a file name, never a path.
  if (path.basename(sessionId) !== sessionId) return null;
  const projects = path.join(root, CLAUDE_FILES.projects);
  const file = subdirectories(projects)
    .map(dir => path.join(projects, dir.name, `${sessionId}${JSON_LINES_EXTENSION}`))
    .filter(isFileSync)
    .sort((a, b) => mtime(b) - mtime(a))[0];
  const projectDir = file ? await claudeProjectDir(file) : null;
  return file && projectDir ? { providerId: 'claude', sessionId, projectDir, updatedAt: mtime(file), file } : null;
}

export async function latestCodexSession(root: string, identity?: SessionIdentity): Promise<RecentSession | null> {
  const files = walkRollouts(path.join(root, CODEX_SESSIONS_DIR))
    .map(file => ({ file, updatedAt: mtime(file) }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  for (const { file, updatedAt } of files) {
    // A rollout named `<id>_<other>` still names its session by its metadata.
    const meta = await attempt(() => readCodexMeta(file));
    if (!meta || meta.subagent || typeof meta.cwd !== 'string' || !meta.cwd) continue;
    const session: RecentSession = { providerId: 'codex', sessionId: meta.id, projectDir: meta.cwd, updatedAt, file };
    if (matchesSession(session, identity)) return session;
  }
  return null;
}

export function latestCursorSession(homeDir: string, identity?: SessionIdentity): RecentSession | null {
  const root = path.join(homeDir, '.cursor', 'chats');
  const chats = subdirectories(root).flatMap(workspace =>
    subdirectories(path.join(root, workspace.name)).flatMap(chat => {
      const dir = path.join(root, workspace.name, chat.name);
      const meta = readJsonSync(path.join(dir, 'meta.json'));
      if (!isObject(meta) || meta.hasConversation === false || typeof meta.cwd !== 'string' || !meta.cwd) return [];
      const file = path.join(dir, 'store.db');
      const updatedAt = typeof meta.updatedAtMs === 'number' && meta.updatedAtMs ? meta.updatedAtMs : mtime(file);
      return [{ providerId: 'cursor' as const, sessionId: chat.name, projectDir: meta.cwd, updatedAt, file }];
    })
  );
  return chats.filter(s => matchesSession(s, identity)).sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null;
}

// ----------------------------------------------------------- stopped by a limit
// A file can be copied or touched long after its stop. Event time is authoritative;
// allow only a small clock skew for a record written as the clock is sampled.
export function isRecentStop(stoppedAt: number | undefined, now: number, maxAgeMs: number): boolean {
  const age = now - (stoppedAt ?? NaN);
  return Number.isFinite(age) && age >= -5000 && age <= maxAgeMs;
}

// A session whose agent stopped because its account ran out: the tool wrote its own
// usage-limit error as the last turn. Unlike a quota percentage, this says the agent is no
// longer working, so continuing the session elsewhere cannot run two agents at once. Only the
// end of a transcript is read.
export interface StoppedSession extends RecentSession {
  stoppedAt: number;
}

const TAIL_SCAN_BYTES = 512 * 1024;
// Every usage-limit stop Claude Code writes carries this error (checked on 2026-10-19: all 73
// in this machine's transcripts, Claude Code 2.1.294 to 2.1.302); its wording is not read.
const CLAUDE_LIMIT_ERROR = 'usage_limit_reached';
const CODEX_LIMIT_ERROR = 'usage_limit_exceeded';
const timestamp = (value: unknown): number => (typeof value === 'string' ? Date.parse(value) : NaN);

// Claude Code: the session's stop at the usage limit (a synthetic main-thread assistant record),
// standing until a reply came after it. A prompt alone is waiting, not going on: the user's,
// or a queued notice (a background task's) that Claude Code takes while it holds the session
// for the reset, hours before anything is answered. A reply that is another kind of error
// (overloaded, the network) clears the stop too: the session went on, and stopped on something
// else. `headless` marks a run started by a program (`claude -p`, the Agent SDK), not a person
// in a terminal.
export async function claudeLimitStop(file: string): Promise<{ stoppedAt: number; cwd: string; headless: boolean } | null> {
  let stop: JsonObject | null = null;
  for (const record of jsonLines(await readTail(file, TAIL_SCAN_BYTES))) {
    if (record.type !== 'assistant' || record.isSidechain || record.isMeta) continue;
    stop = record.isApiErrorMessage === true && record.apiError === CLAUDE_LIMIT_ERROR ? record : null;
  }
  const stoppedAt = timestamp(stop?.timestamp);
  if (!stop || !Number.isFinite(stoppedAt)) return null;
  const headless = typeof stop.entrypoint === 'string' && stop.entrypoint.startsWith('sdk-');
  const cwd = await claudeProjectDir(file);
  return cwd ? { stoppedAt, cwd, headless } : null;
}

// How a Claude Code session was last running, so that it goes on the same way under another
// profile: the model it used and its permission mode. Only the end of the transcript is read.
export async function claudeSessionMode(file: string): Promise<{ model?: string; permissionMode?: ClaudePermissionMode }> {
  let model: string | undefined;
  let permissionMode: ClaudePermissionMode | undefined;
  for (const record of jsonLines(await readTail(file, TAIL_SCAN_BYTES))) {
    if (record.isSidechain) continue;
    const used = field(record.message, 'model');
    if (typeof used === 'string' && used !== SYNTHETIC_MODEL && !record.isApiErrorMessage) model = used;
    if (isOneOf(CLAUDE_PERMISSION_MODES, record.permissionMode)) permissionMode = record.permissionMode;
  }
  return { ...(model ? { model } : {}), ...(permissionMode ? { permissionMode } : {}) };
}

// A background command a Claude Code session started and was not told has finished.
export interface BackgroundTask {
  id: string;
  command: string;
  outputFile: string | null;
  startedAt: number;
}

const TASK_OUTPUT = /Output is being written to: (.+?\.output)/;
const TASK_FINISHED = /<task-id>([^<]+)<\/task-id>/g;
// Tools that end a background command without a task notification, and the input naming it.
const TASK_STOPPERS: Readonly<Record<string, string>> = { TaskStop: 'task_id', KillShell: 'shell_id' };
// The message Claude Code adds when a background command finishes.
const TASK_NOTIFICATION = '<task-notification>';
// Only lines carrying one of these can start or end a background command, or name one that
// may be moved there; the rest of a transcript (most of it) is never parsed.
const TASK_MARKERS = ['"command":', 'backgroundTaskId', TASK_NOTIFICATION, ...Object.keys(TASK_STOPPERS).map(name => `"${name}"`)];
const MAX_TASK_SCANS = 50;
// Commands called but not yet answered, kept by tool use id; a result is not parsed unless it
// names a task, so the newest calls are kept and the rest let go.
const MAX_PENDING_COMMANDS = 64;

// What a transcript said about background commands, up to `size` bytes (whole lines only).
interface TaskScan {
  size: number;
  identity: string;
  // The command of each background tool call, by tool use id, until its result names the task.
  commands: Map<string, string>;
  started: Map<string, BackgroundTask>;
  finished: Set<string>;
}

// Transcripts only grow, so each is read once and then from where it was left; one that
// shrank or was replaced is read again.
const taskScans = new Map<string, TaskScan>();

function scanTaskLine(scan: TaskScan, line: string): void {
  if (!TASK_MARKERS.some(marker => line.includes(marker))) return;
  if (line.includes(TASK_NOTIFICATION)) for (const [, id] of line.matchAll(TASK_FINISHED)) if (id) scan.finished.add(id);
  const [record] = jsonLines(line);
  if (!record || record.isSidechain) return;
  const content = field(record.message, 'content');
  for (const part of Array.isArray(content) ? content : []) {
    const type = field(part, 'type');
    const input = field(part, 'input');
    const stopper = TASK_STOPPERS[String(field(part, 'name'))];
    const stopped = stopper ? field(input, stopper) : undefined;
    if (type === 'tool_use' && typeof stopped === 'string') scan.finished.add(stopped);
    // Any command may end up in the background: asked for it, or moved there by Claude Code when
    // it ran past its time. Its text is kept until its result says which.
    const command = field(input, 'description') ?? field(input, 'command');
    if (type === 'tool_use' && typeof field(input, 'command') === 'string' && typeof command === 'string') {
      scan.commands.set(String(field(part, 'id')), command);
      for (const oldest of [...scan.commands.keys()].slice(0, Math.max(0, scan.commands.size - MAX_PENDING_COMMANDS)))
        scan.commands.delete(oldest);
    }
    const id = field(record.toolUseResult, 'backgroundTaskId');
    if (type !== 'tool_result' || typeof id !== 'string') continue;
    const useId = String(field(part, 'tool_use_id'));
    scan.started.set(id, {
      id,
      command: scan.commands.get(useId) ?? '',
      outputFile: TASK_OUTPUT.exec(contentText(field(part, 'content'), CLAUDE_TEXT_PARTS))?.[1] ?? null,
      startedAt: timestamp(record.timestamp)
    });
    scan.commands.delete(useId);
  }
}

// Reads the bytes after `scan.size` up to the last complete line, a chunk at a time.
async function readNewLines(file: string, scan: TaskScan, size: number): Promise<void> {
  let pending: Buffer[] = [];
  let consumed = scan.size;
  // Without an encoding the stream yields buffers; its typings say `any`.
  for await (const read of fs.createReadStream(file, { start: scan.size, end: size - 1 })) {
    const chunk: unknown = read;
    if (!Buffer.isBuffer(chunk)) continue;
    const newline = chunk.lastIndexOf(0x0a);
    if (newline < 0) {
      pending.push(chunk);
      continue;
    }
    const lines = Buffer.concat([...pending, chunk.subarray(0, newline + 1)]);
    for (const line of lines.toString('utf8').split('\n')) scanTaskLine(scan, line);
    consumed += lines.length;
    pending = [chunk.subarray(newline + 1)];
  }
  scan.size = consumed;
}

// The session's background commands still running as far as its transcript knows: started
// (the tool result names the task) and neither notified as finished nor stopped since. They
// belong to the process that started them, which alone is notified when they finish.
export async function claudeBackgroundTasks(file: string): Promise<BackgroundTask[]> {
  const stat = await fsp.stat(file);
  const identity = `${stat.ino}:${stat.birthtimeMs}`;
  const known = taskScans.get(file);
  const scan: TaskScan =
    known?.identity === identity && known.size <= stat.size
      ? known
      : { size: 0, identity, commands: new Map(), started: new Map(), finished: new Set() };
  if (stat.size > scan.size) await readNewLines(file, scan, stat.size);
  taskScans.delete(file);
  taskScans.set(file, scan);
  for (const oldest of [...taskScans.keys()].slice(0, Math.max(0, taskScans.size - MAX_TASK_SCANS))) taskScans.delete(oldest);
  return [...scan.started.values()].filter(task => !scan.finished.has(task.id));
}

// When a Claude Code transcript was last written to, by its records' own times (a file's times
// can change without a write). NaN when it holds none.
export async function claudeLastWrittenAt(file: string): Promise<number> {
  let last = Number.NaN;
  for (const record of jsonLines(await readTail(file, TAIL_SCAN_BYTES))) {
    const at = timestamp(record.timestamp);
    if (Number.isFinite(at) && !(at <= last)) last = at;
  }
  return last;
}

// What a transcript's own records say about when it was last written, with its size. A file's
// times are no evidence: Claude Code touches a transcript hours after its last record, and a
// copy keeps its source's. Null for a file that cannot be read.
export interface TranscriptWrite {
  // The newest record time; NaN when no record carries one.
  lastRecordAt: number;
  size: number;
}
const writeMemo = new Map<string, { version: string; value: TranscriptWrite }>();
export async function claudeTranscriptWrite(file: string): Promise<TranscriptWrite | null> {
  const stat = await attempt(() => fsp.stat(file));
  if (!stat) return null;
  const version = fileVersion(file);
  const hit = writeMemo.get(file);
  if (hit?.version === version) return hit.value;
  const value = { lastRecordAt: await claudeLastWrittenAt(file), size: stat.size };
  if (fileVersion(file) !== version) return null;
  cacheEntry(writeMemo, file, { version, value });
  return value;
}

// Claude Code: the last main-thread message is the model's reply that ended its turn, so the
// session waits for the user.
export async function claudeTurnEnded(file: string): Promise<boolean> {
  const messages = [...jsonLines(await readTail(file, TAIL_SCAN_BYTES))].filter(
    record => (record.type === 'user' || record.type === 'assistant') && !record.isSidechain && !record.isMeta
  );
  const last = messages.at(-1);
  return last?.type === 'assistant' && !last.isApiErrorMessage && field(last.message, 'stop_reason') === 'end_turn';
}

// Codex: the last turn completed with the usage-limit error, and no turn started since.
export async function codexLimitStop(file: string): Promise<{ stoppedAt: number } | null> {
  if (isCompressed(file)) return null;
  let stoppedAt: number | null = null;
  for (const record of jsonLines(await readTail(file, TAIL_SCAN_BYTES))) {
    const type = record.type === 'event_msg' ? field(record.payload, 'type') : undefined;
    if (type === 'task_started') stoppedAt = null;
    if (type === 'task_complete')
      stoppedAt = field(field(record.payload, 'error'), 'codex_error_info') === CODEX_LIMIT_ERROR ? timestamp(record.timestamp) : null;
  }
  return stoppedAt !== null && Number.isFinite(stoppedAt) ? { stoppedAt } : null;
}

// The stop scans run on every refresh, over every session written in the last minutes. A
// transcript still being written belongs to an agent at work, not one stopped at its limit: it is
// read once it has been quiet this long. Reading it sooner shows no stop and costs the most, as an
// antivirus program scans a changed file whole on each open. An unchanged one is not read again.
export const STOP_QUIET_MS = 15 * 1000;
const claudeStopMemo = mtimeMemo<Awaited<ReturnType<typeof claudeLimitStop>>>();
const codexStopMemo = mtimeMemo<Awaited<ReturnType<typeof codexLimitStop>>>();
const settled = (updatedAt: number, now: number, maxAgeMs: number): boolean =>
  now - updatedAt <= maxAgeMs && now - updatedAt >= STOP_QUIET_MS;

// Sessions of a Claude Code profile written in the last `maxAgeMs` whose agent stopped at the
// usage limit, newest first. Headless runs are left to the program that started them: it sees
// the error itself, and opening each one in a terminal would bury the user's own sessions.
export async function claudeLimitStops(root: string, now: number, maxAgeMs: number): Promise<StoppedSession[]> {
  const projects = path.join(root, CLAUDE_FILES.projects);
  const stops: StoppedSession[] = [];
  for (const dir of subdirectories(projects))
    for (const file of newestFiles(path.join(projects, dir.name), JSON_LINES_EXTENSION)) {
      const updatedAt = mtime(file);
      if (!settled(updatedAt, now, maxAgeMs)) continue;
      const stop = await attempt(() => claudeStopMemo(file, () => claudeLimitStop(file)));
      if (stop && !stop.headless && isRecentStop(stop.stoppedAt, now, maxAgeMs))
        stops.push({
          providerId: 'claude',
          sessionId: path.basename(file, JSON_LINES_EXTENSION),
          projectDir: stop.cwd,
          updatedAt,
          file,
          stoppedAt: stop.stoppedAt
        });
    }
  return stops.sort((a, b) => b.stoppedAt - a.stoppedAt);
}

export async function codexLimitStops(root: string, now: number, maxAgeMs: number): Promise<StoppedSession[]> {
  const stops: StoppedSession[] = [];
  for (const file of walkRollouts(path.join(root, CODEX_SESSIONS_DIR))) {
    const updatedAt = mtime(file);
    if (!settled(updatedAt, now, maxAgeMs)) continue;
    const stop = await attempt(() => codexStopMemo(file, () => codexLimitStop(file)));
    const meta = stop && (await attempt(() => readCodexMeta(file)));
    if (
      !stop ||
      !isRecentStop(stop.stoppedAt, now, maxAgeMs) ||
      !meta ||
      meta.subagent ||
      meta.headless ||
      typeof meta.cwd !== 'string' ||
      !meta.cwd
    )
      continue;
    stops.push({ providerId: 'codex', sessionId: meta.id, projectDir: meta.cwd, updatedAt, file, stoppedAt: stop.stoppedAt });
  }
  return stops.sort((a, b) => b.stoppedAt - a.stoppedAt);
}

// --------------------------------------------------------------------- public
type Lister = (
  projectDir: string,
  sources: SessionSources,
  sessionId?: string
) => Promise<(SessionCandidate | null)[]> | (SessionCandidate | null)[];

// GitHub Copilot keeps no sessions this app can read.
const LISTERS: Record<ProviderId, Lister> = {
  claude: listClaude,
  codex: listCodex,
  cursor: listCursor,
  antigravity: listAntigravity,
  copilot: () => []
};

const providersFor = (providerId: ProviderId | Auto): readonly ProviderId[] => (providerId === AUTO ? WORK_PROVIDER_IDS : [providerId]);

// Sessions of the project, newest first. A provider whose data cannot be read lists none.
async function sessionCandidates(
  providerId: ProviderId | Auto,
  projectDir: string,
  sources: SessionSources,
  sessionId?: string
): Promise<SessionCandidate[]> {
  const results = await Promise.allSettled(providersFor(providerId).map(async id => LISTERS[id](projectDir, sources, sessionId)));
  return results
    .flatMap(result => (result.status === 'fulfilled' ? result.value : []))
    .filter(session => session !== null)
    .sort((a, b) => b.summary.updatedAt - a.summary.updatedAt);
}

export async function listProviderSessions(
  providerId: ProviderId | Auto,
  projectDir: string,
  sources: SessionSources
): Promise<SessionSummary[]> {
  return (await sessionCandidates(providerId, projectDir, sources)).map(candidate => candidate.summary);
}

export interface SessionQuery {
  providerId: ProviderId | Auto;
  sessionId: string;
  projectDir: string;
  sources: SessionSources;
  sessionSource?: SessionSourceRef;
}

// One session; with sessionId 'auto' the newest session of the provider(s). Null when
// nothing matches: another provider's session is never substituted.
export async function readSession({
  providerId,
  sessionId,
  projectDir,
  sources,
  sessionSource
}: SessionQuery): Promise<ResolvedSession | null> {
  const automatic = !sessionId || sessionId === AUTO;
  const candidates = (await sessionCandidates(providerId, projectDir, sources, automatic ? undefined : sessionId)).filter(candidate => {
    if (!automatic && candidate.summary.id !== sessionId) return false;
    const actual = candidate.summary.source;
    return (
      !sessionSource ||
      (actual.id === sessionSource.id && actual.version === sessionSource.version && actual.accountId === sessionSource.accountId)
    );
  });
  // Auto selects one physical source directly, without re-resolving its logical id in the
  // first profile. A named id shared by several sources needs an explicit reviewed source.
  if (!automatic && candidates.length !== 1) return null;
  return candidates[0]?.transcript ?? null;
}
