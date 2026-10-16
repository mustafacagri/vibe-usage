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

const { PROVIDER_IDS, AUTO } = require('../catalog.cjs');
const { AppError } = require('./errors.cjs');

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
  const line = String(text || '').split('\n').map(x => x.trim())
    .find(x => x.length >= TITLE_MIN_LENGTH && !NON_TITLE_PREFIXES.some(prefix => x.startsWith(prefix)));
  return line ? line.replace(/^[#\-*\s]+/, '').slice(0, TITLE_MAX_LENGTH) : '';
}

// A session list item, or null for sessions without a single user prompt. An empty title is
// worded by the UI ("untitled session").
function listEntry(providerId, id, transcript, { updatedAt, sizeBytes, title }) {
  if (!transcript.turnCount) return null;
  return { id, providerId, title: title || transcript.sessionTitle, updatedAt, sizeBytes, turnCount: transcript.turnCount, model: transcript.sessionModel };
}

function openDb(file) {
  const { DatabaseSync } = require('node:sqlite');
  return new DatabaseSync(file, { readOnly: true });
}

function emptyTranscript(providerId, id) {
  return { providerId, sessionId: id, sessionTitle: '', sessionModel: '', initialGoal: '', lastUserMsg: '', lastAssistantMsg: '', turnCount: 0, files: [] };
}

function addUser(t, text) {
  const clean = sanitizeText(text);
  if (!clean) return;
  t.turnCount++;
  if (!t.initialGoal) t.initialGoal = clean;
  if (!t.sessionTitle) t.sessionTitle = titleFrom(clean);
  t.lastUserMsg = clean;
}

function addAssistant(t, text) {
  const clean = sanitizeText(text);
  if (clean) t.lastAssistantMsg = clean;
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
  const t = emptyTranscript('claude', id);
  const files = new Set();
  const content = await fsp.readFile(file, 'utf8');
  for (const line of content.split('\n')) {
    if (!line) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (obj.type === 'ai-title' && obj.aiTitle) t.aiTitle = obj.aiTitle;
    if (typeof obj.message?.model === 'string' && !obj.message.model.includes('<synthetic>')) t.sessionModel = obj.message.model;
    if (obj.type === 'user' && obj.message?.content && !obj.isMeta) {
      // Tool results are user-role records too; only count real prompts.
      if (Array.isArray(obj.message.content) && obj.message.content.every(c => c?.type === 'tool_result')) continue;
      addUser(t, claudeText(obj.message.content));
    }
    if (obj.type === 'assistant' && obj.message?.content && !obj.isApiErrorMessage) {
      const text = claudeText(obj.message.content);
      if (!/usage limit|rate limit|limit reached|resets at/i.test(text)) addAssistant(t, text);
    }
    const fp = obj.toolUseResult?.filePath || obj.message?.content?.find?.(c => c?.input?.file_path)?.input?.file_path;
    if (typeof fp === 'string') files.add(fp);
  }
  if (t.aiTitle) t.sessionTitle = t.aiTitle;
  delete t.aiTitle;
  t.files = [...files].slice(-RECENT_FILES);
  return t;
}

async function listClaude(projectDir, homeDir) {
  const sessions = [];
  for (const dir of claudeProjectDirs(projectDir, homeDir)) {
    for (const f of await fsp.readdir(dir).catch(() => [])) {
      if (!f.endsWith('.jsonl')) continue;
      try {
        const full = path.join(dir, f);
        const stat = await fsp.stat(full);
        const id = f.slice(0, -'.jsonl'.length);
        sessions.push(listEntry('claude', id, await readClaudeFile(full, id), { updatedAt: stat.mtimeMs, sizeBytes: stat.size }));
      } catch {}
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
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkRollouts(full, out);
    else if (e.isFile() && e.name.startsWith('rollout-') && (e.name.endsWith('.jsonl') || e.name.endsWith('.jsonl.zst'))) out.push(full);
  }
  return out;
}

const HEAD_BYTES = 8192;
const ZSTD_READ_CHUNK_BYTES = 16384;

function readHead(file) {
  if (!file.endsWith('.zst')) {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(HEAD_BYTES);
      return buf.toString('utf8', 0, fs.readSync(fd, buf, 0, buf.length, 0));
    } finally {
      fs.closeSync(fd);
    }
  }
  return new Promise(resolve => {
    const chunks = [];
    let size = 0;
    const input = fs.createReadStream(file, { highWaterMark: ZSTD_READ_CHUNK_BYTES });
    const out = input.pipe(zlib.createZstdDecompress());
    const done = () => { input.destroy(); out.destroy(); resolve(Buffer.concat(chunks).toString('utf8')); };
    out.on('data', d => { chunks.push(d); size += d.length; if (size >= HEAD_BYTES) done(); });
    out.on('end', done);
    out.on('error', done);
    input.on('error', done);
  });
}

async function readRollout(file) {
  const raw = await fsp.readFile(file);
  return (file.endsWith('.zst') ? zlib.zstdDecompressSync(raw) : raw).toString('utf8');
}

// The first record is session_meta; id, cwd and source precede the (large) base instructions.
// Subagent threads (Guardian reviews, spawned workers) have an object source and are skipped.
const codexMetaMemo = new Map();
async function readCodexMeta(file) {
  const mtimeMs = fs.statSync(file).mtimeMs;
  const memo = codexMetaMemo.get(file);
  if (memo && memo.mtimeMs === mtimeMs) return memo.meta;
  const head = await readHead(file);
  const str = re => { const m = head.match(re); if (!m) return ''; try { return JSON.parse(`"${m[1]}"`); } catch { return ''; } };
  const meta = head.includes('"type":"session_meta"')
    ? { id: str(/"id":"((?:[^"\\]|\\.)*)"/), cwd: str(/"cwd":"((?:[^"\\]|\\.)*)"/), subagent: /"source":\{"subagent"/.test(head) }
    : null;
  codexMetaMemo.set(file, { mtimeMs, meta });
  return meta;
}

function codexText(content) {
  return Array.isArray(content) ? content.map(c => (c && (c.type === 'input_text' || c.type === 'output_text') ? c.text || '' : '')).join('\n') : '';
}

// Injected context (AGENTS.md, environment, skills) is sent as user-role messages.
function isCodexInjected(text) {
  const s = text.trimStart();
  return s.startsWith('<') || s.startsWith('# AGENTS.md instructions');
}

async function readCodexFile(file, id) {
  const t = emptyTranscript('codex', id);
  const content = await readRollout(file);
  for (const line of content.split('\n')) {
    if (!line) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    const p = obj.payload || {};
    if (obj.type === 'turn_context' && typeof p.model === 'string') t.sessionModel = p.model;
    if (obj.type === 'event_msg' && p.type === 'thread_settings_applied' && typeof p.thread_settings?.model === 'string') t.sessionModel = p.thread_settings.model;
    if (obj.type === 'response_item' && p.type === 'message') {
      const text = codexText(p.content);
      if (p.role === 'user' && !isCodexInjected(text)) addUser(t, text);
      if (p.role === 'assistant') addAssistant(t, text);
    }
  }
  return t;
}

function codexThreadNames(homeDir) {
  const names = new Map();
  try {
    for (const line of fs.readFileSync(path.join(codexHome(homeDir), 'session_index.jsonl'), 'utf8').split('\n')) {
      try { const o = JSON.parse(line); if (o.id && o.thread_name) names.set(o.id, o.thread_name); } catch {}
    }
  } catch {}
  return names;
}

// Fork snapshots (rollout-…-<id>_<childId>.jsonl[.zst]) start with the parent's session_meta;
// a session's own rollout is the file named exactly after its id.
async function findCodexRollouts(projectDir, homeDir) {
  const byId = new Map();
  for (const file of walkRollouts(path.join(codexHome(homeDir), 'sessions'))) {
    try {
      const meta = await readCodexMeta(file);
      if (!meta?.id || meta.subagent || !samePath(meta.cwd, projectDir)) continue;
      const own = /^rollout-.*-([0-9a-f-]{36})\.jsonl(\.zst)?$/i.exec(path.basename(file))?.[1] === meta.id;
      const prev = byId.get(meta.id);
      if (!prev || (own && !prev.own)) byId.set(meta.id, { file, id: meta.id, own });
    } catch {}
  }
  return [...byId.values()].map(({ file, id }) => ({ file, id }));
}

// Turn counts need a full parse; reuse it until the rollout changes.
const codexSummaryMemo = new Map();
async function codexSummary(file, id) {
  const mtimeMs = fs.statSync(file).mtimeMs;
  const memo = codexSummaryMemo.get(file);
  if (memo && memo.mtimeMs === mtimeMs) return memo.t;
  const t = await readCodexFile(file, id);
  codexSummaryMemo.set(file, { mtimeMs, t });
  return t;
}

async function listCodex(projectDir, homeDir) {
  const names = codexThreadNames(homeDir);
  const sessions = [];
  for (const { file, id } of await findCodexRollouts(projectDir, homeDir)) {
    try {
      const stat = await fsp.stat(file);
      sessions.push(listEntry('codex', id, await codexSummary(file, id), { updatedAt: stat.mtimeMs, sizeBytes: stat.size, title: names.get(id) }));
    } catch {}
  }
  return sessions;
}

async function readCodex(projectDir, homeDir, id) {
  const hit = (await findCodexRollouts(projectDir, homeDir)).find(r => r.id === id);
  if (!hit) return null;
  const t = await readCodexFile(hit.file, id);
  const name = codexThreadNames(homeDir).get(id);
  if (name) t.sessionTitle = name;
  return t;
}

// ----------------------------------------------------------------- Cursor CLI
// ~/.cursor/chats/<hash>/<chatId>/{meta.json,store.db}. meta.json records cwd;
// store.db holds JSON message blobs ({"role":...}) in insertion (rowid) order.
function cursorChatDirs(projectDir, homeDir) {
  const root = path.join(homeDir, '.cursor', 'chats');
  const out = [];
  for (const h of fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory())) {
    for (const c of fs.readdirSync(path.join(root, h.name), { withFileTypes: true }).filter(d => d.isDirectory())) {
      const dir = path.join(root, h.name, c.name);
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
        if (meta.hasConversation !== false && samePath(meta.cwd, projectDir)) out.push({ id: c.name, dir, meta });
      } catch {}
    }
  }
  return out;
}

function cursorText(content) {
  if (typeof content === 'string') return content;
  return Array.isArray(content) ? content.map(c => (c && c.type === 'text' ? c.text || '' : '')).join('\n') : '';
}

function readCursorChat(dir, id) {
  const t = emptyTranscript('cursor', id);
  const db = openDb(path.join(dir, 'store.db'));
  try {
    try {
      const row = db.prepare("SELECT value FROM meta WHERE key = '0'").get();
      const raw = row?.value == null ? '' : String(row.value);
      const meta = JSON.parse(/^[0-9a-f]+$/i.test(raw) ? Buffer.from(raw, 'hex').toString('utf8') : raw);
      if (meta.name && meta.name !== 'New Agent') t.chatName = meta.name;
    } catch {}
    for (const { data } of db.prepare('SELECT data FROM blobs ORDER BY rowid').all()) {
      const buf = Buffer.from(data);
      if (buf[0] !== 0x7b) continue; // non-JSON blobs are internal tree nodes
      let msg;
      try { msg = JSON.parse(buf.toString('utf8')); } catch { continue; }
      const text = cursorText(msg.content);
      if (msg.role === 'user') {
        const q = text.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/);
        if (q) addUser(t, q[1]);
      } else if (msg.role === 'assistant') {
        addAssistant(t, text);
      }
    }
  } finally {
    db.close();
  }
  if (t.chatName) t.sessionTitle = t.chatName;
  delete t.chatName;
  return t;
}

async function listCursor(projectDir, homeDir) {
  const sessions = [];
  for (const { id, dir, meta } of cursorChatDirs(projectDir, homeDir)) {
    try {
      const stat = fs.statSync(path.join(dir, 'store.db'));
      sessions.push(listEntry('cursor', id, readCursorChat(dir, id), { updatedAt: meta.updatedAtMs || stat.mtimeMs, sizeBytes: stat.size }));
    } catch {}
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
      if (next === undefined || next < 0x20 || next === 0x2f && blob[at + uri.length + 1] < 0x20) return true;
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
  try {
    const row = db.prepare('SELECT data FROM gen_metadata ORDER BY idx DESC LIMIT 1').get();
    const buf = row?.data ? Buffer.from(row.data) : null;
    if (!buf) return '';
    let found = '';
    for (let i = buf.indexOf(MODEL_NAME_TAG); i !== -1; i = buf.indexOf(MODEL_NAME_TAG, i + 1)) {
      const len = buf[i + MODEL_NAME_TAG.length];
      if (!len || len > MODEL_NAME_MAX_LENGTH) continue;
      const start = i + MODEL_NAME_TAG.length + 1;
      const name = buf.toString('utf8', start, start + len);
      if (MODEL_NAME.test(name)) found = name;
    }
    return found;
  } catch {
    return '';
  }
}

function antigravityConversations(projectDir, homeDir) {
  const convDir = path.join(antigravityRoot(homeDir), 'conversations');
  const uris = workspaceUris(projectDir);
  const out = [];
  for (const f of fs.readdirSync(convDir)) {
    if (!f.endsWith('.db')) continue;
    const file = path.join(convDir, f);
    let db;
    try {
      db = openDb(file);
      const rows = db.prepare('SELECT data FROM trajectory_metadata_blob').all();
      if (rows.some(r => r.data && blobHasWorkspace(Buffer.from(r.data), uris))) {
        out.push({ id: f.slice(0, -3), file, model: antigravityModel(db) });
      }
    } catch {} finally {
      try { db?.close(); } catch {}
    }
  }
  return out;
}

async function readAntigravityTranscript(homeDir, id, model) {
  const t = emptyTranscript('antigravity', id);
  t.sessionModel = model || '';
  const file = path.join(antigravityRoot(homeDir), 'brain', id, '.system_generated', 'logs', 'transcript.jsonl');
  let content;
  try { content = await fsp.readFile(file, 'utf8'); } catch { return t; }
  for (const line of content.split('\n')) {
    if (!line) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (obj.type === 'USER_INPUT' && typeof obj.content === 'string') addUser(t, obj.content.replace(/<[^>]+>/g, ''));
    if (obj.type === 'PLANNER_RESPONSE' && typeof obj.content === 'string') addAssistant(t, obj.content);
  }
  return t;
}

async function listAntigravity(projectDir, homeDir) {
  const sessions = [];
  for (const { id, file, model } of antigravityConversations(projectDir, homeDir)) {
    try {
      const stat = fs.statSync(file);
      sessions.push(listEntry('antigravity', id, await readAntigravityTranscript(homeDir, id, model), { updatedAt: stat.mtimeMs, sizeBytes: stat.size }));
    } catch {}
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
  return results.flatMap(r => (r.status === 'fulfilled' ? r.value : [])).filter(Boolean).sort((a, b) => b.updatedAt - a.updatedAt);
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
    const t = await Promise.resolve().then(() => READERS[p](projectDir, homeDir, sessionId)).catch(() => null);
    if (t) return t;
  }
  return null;
}

module.exports = { listProviderSessions, readSession };
