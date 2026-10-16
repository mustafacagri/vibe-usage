'use strict';
// Per-provider discovery and reading of local agent sessions for a project directory.
// Every provider is filtered by the session's recorded working directory, so a session
// only ever appears under the project it was started in. Formats were verified against
// real local data (Claude Code JSONL, Codex rollout JSONL, Cursor CLI store.db,
// Antigravity conversations/*.db + brain transcript); unknown fields are left empty
// instead of guessed.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const { pathToFileURL } = require('node:url');
const { DatabaseSync } = require('node:sqlite');

const { PROVIDER_IDS, AUTO } = require('../catalog.cjs');
const { AppError } = require('./errors.cjs');
const { jsonLines, readJsonSync, attempt, attemptSync } = require('./files.cjs');
const { SYNTHETIC_MODEL } = require('../providers/claude.cjs');

function sanitizeText(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/(?:sk-[a-zA-Z0-9_-]{20,}|ghp_[a-zA-Z0-9]{20,}|AKIA[0-9A-Z]{16}|bearer\s+[a-zA-Z0-9_.-]{30,})/gi, '[REDACTED_SECRET]')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, '')
    .trim();
}

function samePath(a, b) {
  if (!a || !b) return false;
  const norm = p => {
    const r = path.resolve(p).replace(/[\\/]+$/, '');
    return process.platform === 'win32' || process.platform === 'darwin' ? r.toLowerCase() : r;
  };
  return norm(a) === norm(b);
}

const TITLE_MAX_LENGTH = 70;
const TITLE_MIN_LENGTH = 4;
const RECENT_FILES = 10;
// Lines that open a prompt but say nothing about it: markup, mentions, rules, code fences.
const NON_TITLE_PREFIXES = ['<', '@', '---', '```'];

// First meaningful line of the first prompt, without Markdown heading or list markers.
function titleFrom(text) {
  const line = String(text || '')
    .split('\n')
    .map(x => x.trim())
    .find(x => x.length >= TITLE_MIN_LENGTH && !NON_TITLE_PREFIXES.some(prefix => x.startsWith(prefix)));
  return line ? line.replace(/^[#\-*\s]+/, '').slice(0, TITLE_MAX_LENGTH) : '';
}

// A session list item, or null for sessions without a single user prompt. An empty title is
// worded by the UI ("untitled session").
function listEntry(providerId, id, transcript, { updatedAt, sizeBytes, title }) {
  if (!transcript.turnCount) return null;
  return {
    id,
    providerId,
    title: title || transcript.sessionTitle,
    updatedAt,
    sizeBytes,
    turnCount: transcript.turnCount,
    model: transcript.sessionModel
  };
}

function openDb(file) {
  return new DatabaseSync(file, { readOnly: true });
}

function emptyTranscript(providerId, id) {
  return {
    providerId,
    sessionId: id,
    sessionTitle: '',
    sessionModel: '',
    initialGoal: '',
    lastUserMsg: '',
    lastAssistantMsg: '',
    turnCount: 0,
    files: []
  };
}

function addUser(transcript, text) {
  const clean = sanitizeText(text);
  if (!clean) return;
  transcript.turnCount++;
  if (!transcript.initialGoal) transcript.initialGoal = clean;
  if (!transcript.sessionTitle) transcript.sessionTitle = titleFrom(clean);
  transcript.lastUserMsg = clean;
}

function addAssistant(transcript, text) {
  const clean = sanitizeText(text);
  if (clean) transcript.lastAssistantMsg = clean;
}

// ---------------------------------------------------------------- Claude Code
function claudeProjectDirs(projectDir, homeDir) {
  const resolved = path.resolve(projectDir);
  const slugs = new Set([resolved.replace(/[/\\:]/g, '-'), resolved.replace(/[^a-zA-Z0-9]/g, '-')]);
  return [...slugs].map(s => path.join(homeDir, '.claude', 'projects', s)).filter(d => fs.existsSync(d));
}

function claudeText(content) {
  return Array.isArray(content) ? content.map(c => (c && c.type === 'text' ? c.text || '' : '')).join('\n') : String(content || '');
}

async function readClaudeFile(file, id) {
  const transcript = emptyTranscript('claude', id);
  const files = new Set();
  for (const obj of jsonLines(await fsp.readFile(file, 'utf8'))) {
    if (obj.type === 'ai-title' && obj.aiTitle) transcript.aiTitle = obj.aiTitle;
    // Messages Claude Code generates itself (API errors, limit notices) are not the model's.
    const synthetic = obj.isApiErrorMessage || obj.message?.model === SYNTHETIC_MODEL;
    if (typeof obj.message?.model === 'string' && !synthetic) transcript.sessionModel = obj.message.model;
    if (obj.type === 'user' && obj.message?.content && !obj.isMeta) {
      // Tool results are user-role records too; only count real prompts.
      if (Array.isArray(obj.message.content) && obj.message.content.every(c => c?.type === 'tool_result')) continue;
      addUser(transcript, claudeText(obj.message.content));
    }
    if (obj.type === 'assistant' && obj.message?.content && !synthetic) addAssistant(transcript, claudeText(obj.message.content));
    const fp = obj.toolUseResult?.filePath || obj.message?.content?.find?.(c => c?.input?.file_path)?.input?.file_path;
    if (typeof fp === 'string') files.add(fp);
  }
  if (transcript.aiTitle) transcript.sessionTitle = transcript.aiTitle;
  delete transcript.aiTitle;
  transcript.files = [...files].slice(-RECENT_FILES);
  return transcript;
}

async function listClaude(projectDir, homeDir) {
  const sessions = [];
  for (const dir of claudeProjectDirs(projectDir, homeDir)) {
    for (const f of await fsp.readdir(dir).catch(() => [])) {
      if (!f.endsWith('.jsonl')) continue;
      const full = path.join(dir, f);
      const id = path.basename(f, '.jsonl');
      sessions.push(
        await attempt(async () => {
          const stat = await fsp.stat(full);
          return listEntry('claude', id, await readClaudeFile(full, id), { updatedAt: stat.mtimeMs, sizeBytes: stat.size });
        })
      );
    }
  }
  return sessions;
}

async function readClaude(projectDir, homeDir, id) {
  for (const dir of claudeProjectDirs(projectDir, homeDir)) {
    const file = path.join(dir, `${id}.jsonl`);
    if (fs.existsSync(file)) return readClaudeFile(file, id);
  }
  return null;
}

// ---------------------------------------------------------------------- Codex
function codexHome(homeDir) {
  return path.join(homeDir, '.codex');
}

// Codex stores recent rollouts as .jsonl and compresses older ones to .jsonl.zst.
function walkRollouts(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkRollouts(full, out);
    else if (e.isFile() && e.name.startsWith('rollout-') && (e.name.endsWith('.jsonl') || e.name.endsWith('.jsonl.zst'))) out.push(full);
  }
  return out;
}

const MAX_META_LINE_BYTES = 1024 * 1024;

// The first line of a rollout (its session_meta record), streamed so that a large or
// compressed file is never read whole. Resolves to '' when there is no complete line.
function readFirstLine(file) {
  return new Promise(resolve => {
    const input = fs.createReadStream(file);
    const stream = file.endsWith('.zst') ? input.pipe(zlib.createZstdDecompress()) : input;
    const chunks = [];
    let size = 0;
    const finish = line => {
      input.destroy();
      stream.destroy();
      resolve(line);
    };
    stream.on('data', chunk => {
      const newline = chunk.indexOf(0x0a);
      chunks.push(newline === -1 ? chunk : chunk.subarray(0, newline));
      size += chunk.length;
      if (newline !== -1) finish(Buffer.concat(chunks).toString('utf8'));
      else if (size > MAX_META_LINE_BYTES) finish('');
    });
    stream.on('end', () => finish(''));
    stream.on('error', () => finish(''));
    input.on('error', () => finish(''));
  });
}

async function readRollout(file) {
  const raw = await fsp.readFile(file);
  return (file.endsWith('.zst') ? zlib.zstdDecompressSync(raw) : raw).toString('utf8');
}

// The first record is session_meta. Subagent threads (Guardian reviews, spawned workers)
// have an object `source` and are skipped.
const codexMetaMemo = new Map();
async function readCodexMeta(file) {
  const mtimeMs = fs.statSync(file).mtimeMs;
  const memo = codexMetaMemo.get(file);
  if (memo && memo.mtimeMs === mtimeMs) return memo.meta;
  const [record] = jsonLines(await readFirstLine(file));
  const payload = record?.type === 'session_meta' ? record.payload : null;
  const meta = typeof payload?.id === 'string' ? { id: payload.id, cwd: payload.cwd, subagent: Boolean(payload.source?.subagent) } : null;
  codexMetaMemo.set(file, { mtimeMs, meta });
  return meta;
}

function codexText(content) {
  return Array.isArray(content)
    ? content.map(c => (c && (c.type === 'input_text' || c.type === 'output_text') ? c.text || '' : '')).join('\n')
    : '';
}

// Injected context (AGENTS.md, environment, skills) is sent as user-role messages.
function isCodexInjected(text) {
  const s = text.trimStart();
  return s.startsWith('<') || s.startsWith('# AGENTS.md instructions');
}

async function readCodexFile(file, id) {
  const transcript = emptyTranscript('codex', id);
  for (const obj of jsonLines(await readRollout(file))) {
    const p = obj.payload || {};
    if (obj.type === 'turn_context' && typeof p.model === 'string') transcript.sessionModel = p.model;
    if (obj.type === 'event_msg' && p.type === 'thread_settings_applied' && typeof p.thread_settings?.model === 'string')
      transcript.sessionModel = p.thread_settings.model;
    if (obj.type === 'response_item' && p.type === 'message') {
      const text = codexText(p.content);
      if (p.role === 'user' && !isCodexInjected(text)) addUser(transcript, text);
      if (p.role === 'assistant') addAssistant(transcript, text);
    }
  }
  return transcript;
}

function codexThreadNames(homeDir) {
  const index = attemptSync(() => fs.readFileSync(path.join(codexHome(homeDir), 'session_index.jsonl'), 'utf8')) || '';
  return new Map([...jsonLines(index)].filter(o => o.id && o.thread_name).map(o => [o.id, o.thread_name]));
}

// Fork snapshots (rollout-…-<id>_<childId>.jsonl[.zst]) start with the parent's session_meta;
// a session's own rollout is the file named exactly after its id.
async function findCodexRollouts(projectDir, homeDir) {
  const byId = new Map();
  for (const file of walkRollouts(path.join(codexHome(homeDir), 'sessions'))) {
    const meta = await attempt(() => readCodexMeta(file));
    if (!meta || meta.subagent || !samePath(meta.cwd, projectDir)) continue;
    const own = /^rollout-.*-([0-9a-f-]{36})\.jsonl(\.zst)?$/i.exec(path.basename(file))?.[1] === meta.id;
    const prev = byId.get(meta.id);
    if (!prev || (own && !prev.own)) byId.set(meta.id, { file, id: meta.id, own });
  }
  return [...byId.values()].map(({ file, id }) => ({ file, id }));
}

// Turn counts need a full parse; reuse it until the rollout changes.
const codexSummaryMemo = new Map();
async function codexSummary(file, id) {
  const mtimeMs = fs.statSync(file).mtimeMs;
  const memo = codexSummaryMemo.get(file);
  if (memo && memo.mtimeMs === mtimeMs) return memo.transcript;
  const transcript = await readCodexFile(file, id);
  codexSummaryMemo.set(file, { mtimeMs, transcript });
  return transcript;
}

async function listCodex(projectDir, homeDir) {
  const names = codexThreadNames(homeDir);
  const sessions = [];
  for (const { file, id } of await findCodexRollouts(projectDir, homeDir)) {
    sessions.push(
      await attempt(async () => {
        const stat = await fsp.stat(file);
        return listEntry('codex', id, await codexSummary(file, id), {
          updatedAt: stat.mtimeMs,
          sizeBytes: stat.size,
          title: names.get(id)
        });
      })
    );
  }
  return sessions;
}

async function readCodex(projectDir, homeDir, id) {
  const hit = (await findCodexRollouts(projectDir, homeDir)).find(r => r.id === id);
  if (!hit) return null;
  const transcript = await readCodexFile(hit.file, id);
  const name = codexThreadNames(homeDir).get(id);
  if (name) transcript.sessionTitle = name;
  return transcript;
}

// ----------------------------------------------------------------- Cursor CLI
// ~/.cursor/chats/<hash>/<chatId>/{meta.json,store.db}. meta.json records cwd;
// store.db holds JSON message blobs ({"role":...}) in insertion (rowid) order.
const CURSOR_DEFAULT_CHAT_NAME = 'New Agent';
const JSON_OBJECT_START = 0x7b; // '{'; other blobs are internal tree nodes
function cursorChatDirs(projectDir, homeDir) {
  const root = path.join(homeDir, '.cursor', 'chats');
  const out = [];
  for (const h of fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory())) {
    for (const c of fs.readdirSync(path.join(root, h.name), { withFileTypes: true }).filter(d => d.isDirectory())) {
      const dir = path.join(root, h.name, c.name);
      const meta = readJsonSync(path.join(dir, 'meta.json'));
      if (meta && meta.hasConversation !== false && samePath(meta.cwd, projectDir)) out.push({ id: c.name, dir, meta });
    }
  }
  return out;
}

function cursorText(content) {
  if (typeof content === 'string') return content;
  return Array.isArray(content) ? content.map(c => (c && c.type === 'text' ? c.text || '' : '')).join('\n') : '';
}

function readCursorChat(dir, id) {
  const transcript = emptyTranscript('cursor', id);
  const db = openDb(path.join(dir, 'store.db'));
  try {
    // The chat record is JSON, stored hex-encoded by current CLI versions.
    const raw = String(db.prepare("SELECT value FROM meta WHERE key = '0'").get()?.value ?? '');
    const chat = attemptSync(() => JSON.parse(/^[0-9a-f]+$/i.test(raw) ? Buffer.from(raw, 'hex').toString('utf8') : raw));
    if (chat?.name && chat.name !== CURSOR_DEFAULT_CHAT_NAME) transcript.sessionTitle = chat.name;
    for (const { data } of db.prepare('SELECT data FROM blobs ORDER BY rowid').all()) {
      const buf = Buffer.from(data);
      if (buf[0] !== JSON_OBJECT_START) continue;
      const msg = attemptSync(() => JSON.parse(buf.toString('utf8')));
      if (!msg) continue;
      const text = cursorText(msg.content);
      if (msg.role === 'user') {
        const query = text.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/);
        if (query) addUser(transcript, query[1]);
      } else if (msg.role === 'assistant') {
        addAssistant(transcript, text);
      }
    }
  } finally {
    db.close();
  }
  return transcript;
}

async function listCursor(projectDir, homeDir) {
  const sessions = [];
  for (const { id, dir, meta } of cursorChatDirs(projectDir, homeDir)) {
    sessions.push(
      attemptSync(() => {
        const stat = fs.statSync(path.join(dir, 'store.db'));
        return listEntry('cursor', id, readCursorChat(dir, id), { updatedAt: meta.updatedAtMs || stat.mtimeMs, sizeBytes: stat.size });
      })
    );
  }
  return sessions;
}

async function readCursor(projectDir, homeDir, id) {
  const hit = cursorChatDirs(projectDir, homeDir).find(c => c.id === id);
  return hit ? readCursorChat(hit.dir, id) : null;
}

// ---------------------------------------------------------------- Antigravity
// conversations/<id>.db is SQLite; trajectory_metadata_blob carries the workspace as a
// file:// URI. The readable transcript lives in brain/<id>/.system_generated/logs.
function antigravityRoot(homeDir) {
  return path.join(homeDir, '.gemini', 'antigravity-ide');
}

function workspaceUris(projectDir) {
  const href = pathToFileURL(path.resolve(projectDir)).href.replace(/\/$/, '');
  const uris = new Set([href]);
  // VS Code-style URIs lower-case and percent-encode the Windows drive colon.
  const m = href.match(/^file:\/\/\/([A-Za-z]):(.*)$/);
  if (m) {
    uris.add(`file:///${m[1].toLowerCase()}%3A${m[2]}`);
    uris.add(`file:///${m[1].toLowerCase()}:${m[2]}`);
  }
  return [...uris].map(u => Buffer.from(u));
}

// The URI is protobuf-embedded; a match must not continue as a longer path segment.
function blobHasWorkspace(blob, uris) {
  for (const uri of uris) {
    let at = blob.indexOf(uri);
    while (at !== -1) {
      const next = blob[at + uri.length];
      // The URI ends at a control byte (the next protobuf tag), optionally after one '/'.
      if (next === undefined || next < 0x20 || (next === 0x2f && blob[at + uri.length + 1] < 0x20)) return true;
      at = blob.indexOf(uri, at + 1);
    }
  }
  return false;
}

// Best effort: the latest generation record stores the model display name as a
// length-prefixed string under protobuf field 21 (tag 0xaa 0x01).
const MODEL_NAME_TAG = Buffer.from([0xaa, 0x01]);
const MODEL_NAME_MAX_LENGTH = 80;
const MODEL_NAME = /^(Gemini|Claude|GPT)[\w .()-]*$/;
function antigravityModel(db) {
  const row = attemptSync(() => db.prepare('SELECT data FROM gen_metadata ORDER BY idx DESC LIMIT 1').get());
  if (!row?.data) return '';
  const buf = Buffer.from(row.data);
  let found = '';
  for (let i = buf.indexOf(MODEL_NAME_TAG); i !== -1; i = buf.indexOf(MODEL_NAME_TAG, i + 1)) {
    const length = buf[i + MODEL_NAME_TAG.length];
    if (!length || length > MODEL_NAME_MAX_LENGTH) continue;
    const start = i + MODEL_NAME_TAG.length + 1;
    const name = buf.toString('utf8', start, start + length);
    if (MODEL_NAME.test(name)) found = name;
  }
  return found;
}

function antigravityConversations(projectDir, homeDir) {
  const convDir = path.join(antigravityRoot(homeDir), 'conversations');
  const uris = workspaceUris(projectDir);
  const out = [];
  for (const f of fs.readdirSync(convDir)) {
    if (!f.endsWith('.db')) continue;
    const file = path.join(convDir, f);
    const conversation = attemptSync(() => {
      const db = openDb(file);
      try {
        const rows = db.prepare('SELECT data FROM trajectory_metadata_blob').all();
        return rows.some(r => r.data && blobHasWorkspace(Buffer.from(r.data), uris))
          ? { id: path.basename(f, '.db'), file, model: antigravityModel(db) }
          : null;
      } finally {
        db.close();
      }
    });
    if (conversation) out.push(conversation);
  }
  return out;
}

async function readAntigravityTranscript(homeDir, id, model) {
  const transcript = emptyTranscript('antigravity', id);
  transcript.sessionModel = model || '';
  const file = path.join(antigravityRoot(homeDir), 'brain', id, '.system_generated', 'logs', 'transcript.jsonl');
  const content = await fsp.readFile(file, 'utf8').catch(() => '');
  for (const obj of jsonLines(content)) {
    if (obj.type === 'USER_INPUT' && typeof obj.content === 'string') addUser(transcript, obj.content.replace(/<[^>]+>/g, ''));
    if (obj.type === 'PLANNER_RESPONSE' && typeof obj.content === 'string') addAssistant(transcript, obj.content);
  }
  return transcript;
}

async function listAntigravity(projectDir, homeDir) {
  const sessions = [];
  for (const { id, file, model } of antigravityConversations(projectDir, homeDir)) {
    sessions.push(
      await attempt(async () => {
        const stat = fs.statSync(file);
        return listEntry('antigravity', id, await readAntigravityTranscript(homeDir, id, model), {
          updatedAt: stat.mtimeMs,
          sizeBytes: stat.size
        });
      })
    );
  }
  return sessions;
}

async function readAntigravity(projectDir, homeDir, id) {
  const hit = antigravityConversations(projectDir, homeDir).find(c => c.id === id);
  return hit ? readAntigravityTranscript(homeDir, id, hit.model) : null;
}

// --------------------------------------------------------------------- public
const LISTERS = { claude: listClaude, codex: listCodex, cursor: listCursor, antigravity: listAntigravity };
const READERS = { claude: readClaude, codex: readCodex, cursor: readCursor, antigravity: readAntigravity };

async function listProviderSessions(providerId, projectDir, homeDir) {
  const providers = providerId === AUTO ? PROVIDER_IDS : [providerId];
  if (!providers.every(p => LISTERS[p])) throw new AppError('invalid_provider');
  const results = await Promise.allSettled(providers.map(p => Promise.resolve().then(() => LISTERS[p](projectDir, homeDir))));
  return results
    .flatMap(r => (r.status === 'fulfilled' ? r.value : []))
    .filter(Boolean)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

// Reads one session. With sessionId 'auto' the newest session of the provider(s) is used.
// Returns null when nothing matches; never substitutes another provider's session.
async function readSession({ providerId = AUTO, sessionId = AUTO, projectDir, homeDir }) {
  if (!sessionId || sessionId === AUTO) {
    const [latest] = await listProviderSessions(providerId, projectDir, homeDir);
    if (!latest) return null;
    providerId = latest.providerId;
    sessionId = latest.id;
  }
  const providers = providerId === AUTO ? PROVIDER_IDS : [providerId];
  for (const p of providers) {
    const transcript = await Promise.resolve()
      .then(() => READERS[p](projectDir, homeDir, sessionId))
      .catch(() => null);
    if (transcript) return transcript;
  }
  return null;
}

module.exports = { listProviderSessions, readSession };
