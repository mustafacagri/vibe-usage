'use strict';
// Test fixtures mirroring the on-disk formats the providers really write (verified against
// local installs), at minimal size.
const path = require('node:path');

function writeAntigravityDb(file, projectDir, modelName) {
  const { DatabaseSync } = require('node:sqlite');
  const { pathToFileURL } = require('node:url');
  const uri = Buffer.from(pathToFileURL(path.resolve(projectDir)).href);
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE trajectory_metadata_blob (id TEXT DEFAULT "main", data BLOB, PRIMARY KEY (id)); CREATE TABLE gen_metadata (idx INTEGER, data BLOB, size INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (idx));');
  db.prepare('INSERT INTO trajectory_metadata_blob (id, data) VALUES (?, ?)').run('main', Buffer.concat([Buffer.from([0x0a, uri.length]), uri, Buffer.from([0x12, 0x02, 0x08, 0x01])]));
  if (modelName) {
    const name = Buffer.from(modelName);
    db.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)').run(0, Buffer.concat([Buffer.from([0x0a, 0x01, 0x41, 0xaa, 0x01, name.length]), name]));
  }
  db.close();
}

function codexRollout({ id, cwd, source = 'vscode', model = 'gpt-6-luna', user = [], assistant = [] }) {
  const lines = [{ type: 'session_meta', payload: { session_id: id, id, cwd, source, base_instructions: { text: 'x'.repeat(200) } } }, { type: 'turn_context', payload: { cwd, model } }];
  lines.push({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `# AGENTS.md instructions for ${cwd}\n\n<INSTRUCTIONS>x</INSTRUCTIONS>` }] } });
  lines.push({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>\n  <cwd>x</cwd>\n</environment_context>' }] } });
  user.forEach((u, i) => {
    lines.push({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: u }] } });
    if (assistant[i]) lines.push({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: assistant[i] }] } });
  });
  return lines.map(l => JSON.stringify({ timestamp: '2026-10-16T10:00:00.000Z', ...l })).join('\n') + '\n';
}

function writeCursorChat(chatsRoot, { id, cwd, name, user = [], assistant = [] }) {
  const { DatabaseSync } = require('node:sqlite');
  const fsSync = require('node:fs');
  const dir = path.join(chatsRoot, 'a1b2c3', id);
  fsSync.mkdirSync(dir, { recursive: true });
  fsSync.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ schemaVersion: 1, hasConversation: true, updatedAtMs: Date.now(), cwd }));
  const db = new DatabaseSync(path.join(dir, 'store.db'));
  db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB);');
  db.prepare("INSERT INTO meta VALUES ('0', ?)").run(Buffer.from(JSON.stringify({ agentId: id, name })).toString('hex'));
  const put = (k, v) => db.prepare('INSERT INTO blobs VALUES (?, ?)').run(k, Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)));
  put('sys', { role: 'system', content: 'You are an AI coding assistant' });
  put('info', { role: 'user', content: `<user_info>\nWorkspace Path: ${cwd}\n</user_info>` });
  put('tree', '\x0a\x20internal-node');
  user.forEach((u, i) => {
    put(`u${i}`, { role: 'user', content: [{ type: 'text', text: `<user_query>\n${u}\n</user_query>` }] });
    if (assistant[i]) put(`a${i}`, { role: 'assistant', content: [{ type: 'reasoning', text: '' }, { type: 'text', text: assistant[i] }] });
  });
  db.close();
}

function fakeSpawn(calls) {
  return (cmd, args) => {
    calls.push([cmd, ...args]);
    return { once(event, cb) { if (event === 'spawn') setImmediate(cb); }, unref() {} };
  };
}

// A promise that a test resolves explicitly, for deterministic ordering of async races.
function createDeferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

module.exports = { writeAntigravityDb, codexRollout, writeCursorChat, fakeSpawn, createDeferred };
