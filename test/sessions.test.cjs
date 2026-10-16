'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { writeAntigravityDb, writeAntigravityTranscript, codexRollout, writeCursorChat } = require('./helpers/fixtures.cjs');

test('auto discovery lists sessions of every provider', async t => {
  const { listSessions, collectHandoverContext } = require('../src/core/handover.cjs');
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-multi-sess-home-'));
  const tempProj = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-multi-sess-proj-'));
  t.after(async () => {
    await fs.rm(tempHome, { recursive: true, force: true });
    await fs.rm(tempProj, { recursive: true, force: true });
  });

  // 1. Setup mock Claude session
  const slug = path.resolve(tempProj).replace(/[/\\:]/g, '-');
  const claudeDir = path.join(tempHome, '.claude', 'projects', slug);
  await fs.mkdir(claudeDir, { recursive: true });
  await fs.writeFile(path.join(claudeDir, 'claude-sess.jsonl'), JSON.stringify({ type: 'ai-title', aiTitle: 'Claude Session Title' }) + '\n' + JSON.stringify({ type: 'user', message: { content: 'Task 1' } }), 'utf8');

  // 2. Setup mock Antigravity session
  const convDir = path.join(tempHome, '.gemini', 'antigravity-ide', 'conversations');
  const convId = 'ag-test-conv-123';
  await fs.mkdir(convDir, { recursive: true });
  writeAntigravityDb(path.join(convDir, `${convId}.db`), tempProj, 'Gemini 3.8 Flash (High)');
  writeAntigravityTranscript(tempHome, convId, ['Antigravity Arch Plan Task'], ['Step 1 completed']);

  // Test listSessions with providerId: 'auto'
  const autoSessions = await listSessions({ providerId: 'auto', projectDir: tempProj, homeDir: tempHome });
  assert.ok(autoSessions.length >= 2);
  const foundClaude = autoSessions.find(s => s.providerId === 'claude');
  const foundAg = autoSessions.find(s => s.providerId === 'antigravity');
  assert.ok(foundClaude);
  assert.ok(foundAg);
  assert.equal(foundClaude.title, 'Claude Session Title');
  assert.equal(foundAg.title, 'Antigravity Arch Plan Task');

  // Test collectHandoverContext targeting Antigravity session explicitly
  const handoverAg = await collectHandoverContext(tempProj, { sessionId: convId, homeDir: tempHome });
  assert.equal(handoverAg.hasSession, true);
  assert.equal(handoverAg.sessionId, convId);
  assert.equal(handoverAg.providerId, 'antigravity');
  assert.equal(handoverAg.sessionTitle, 'Antigravity Arch Plan Task');
});

test('Codex sessions are project-scoped, include compressed rollouts and exclude subagents', async t => {
  const { listSessions, collectHandoverContext } = require('../src/core/handover.cjs');
  const zlib = require('node:zlib');
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-codex-home-'));
  const proj = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-codex-proj-'));
  const other = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-codex-other-'));
  t.after(async () => { for (const d of [home, proj, other]) await fs.rm(d, { recursive: true, force: true }); });

  const day = path.join(home, '.codex', 'sessions', '2026', '10', '16');
  await fs.mkdir(day, { recursive: true });
  const A = '01a1aaaa-0000-7000-8000-000000000001';
  const B = '01a1bbbb-0000-7000-8000-000000000002';
  await fs.writeFile(path.join(day, `rollout-2026-10-16T10-00-00-${A}.jsonl`), codexRollout({ id: A, cwd: proj, model: 'gpt-6-luna', user: ['Kota ekranını düzelt', 'Testleri de ekle'], assistant: ['Düzelttim', 'Testler eklendi'] }));
  await fs.writeFile(path.join(day, `rollout-2026-10-16T09-00-00-${B}.jsonl.zst`), zlib.zstdCompressSync(Buffer.from(codexRollout({ id: B, cwd: proj, user: ['Eski sıkıştırılmış oturum'] }))));
  // Fork snapshot of A: begins with A's session_meta, must not duplicate A.
  await fs.writeFile(path.join(day, `rollout-2026-10-16T11-00-00-${A}_01a1cccc-0000-7000-8000-000000000003.jsonl`), codexRollout({ id: A, cwd: proj, user: ['snapshot'] }));
  // Guardian reviewer thread and another project's session.
  await fs.writeFile(path.join(day, 'rollout-2026-10-16T12-00-00-01a1dddd-0000-7000-8000-000000000004.jsonl'), codexRollout({ id: '01a1dddd-0000-7000-8000-000000000004', cwd: proj, source: { subagent: { other: 'guardian' } }, user: ['review'] }));
  await fs.writeFile(path.join(day, 'rollout-2026-10-16T12-30-00-01a1eeee-0000-7000-8000-000000000005.jsonl'), codexRollout({ id: '01a1eeee-0000-7000-8000-000000000005', cwd: other, user: ['Başka proje'] }));
  await fs.writeFile(path.join(home, '.codex', 'session_index.jsonl'), JSON.stringify({ id: A, thread_name: 'Kota ekranı', updated_at: '2026-10-16T10:00:00Z' }) + '\n');

  const sessions = await listSessions({ providerId: 'codex', projectDir: proj, homeDir: home });
  assert.deepEqual(sessions.map(s => s.id).sort(), [A, B].sort());
  const a = sessions.find(s => s.id === A);
  assert.equal(a.title, 'Kota ekranı');
  assert.equal(a.turnCount, 2, 'injected AGENTS.md / environment messages are not user turns');
  assert.equal(a.model, 'gpt-6-luna');
  assert.equal(sessions.find(s => s.id === B).title, 'Eski sıkıştırılmış oturum');

  const h = await collectHandoverContext(proj, { sessionId: A, providerId: 'codex', homeDir: home });
  assert.equal(h.providerId, 'codex');
  assert.equal(h.initialGoal, 'Kota ekranını düzelt');
  assert.equal(h.lastUserMsg, 'Testleri de ekle');
  assert.equal(h.lastAssistantMsg, 'Testler eklendi');

  assert.deepEqual(await listSessions({ providerId: 'codex', projectDir: other, homeDir: home }).then(x => x.map(s => s.id)), ['01a1eeee-0000-7000-8000-000000000005']);
});

test('Cursor CLI sessions are matched by folder and read from store.db', async t => {
  const { listSessions, collectHandoverContext } = require('../src/core/handover.cjs');
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-cursor-home-'));
  const proj = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-cursor-proj-'));
  t.after(async () => { for (const d of [home, proj]) await fs.rm(d, { recursive: true, force: true }); });

  const chats = path.join(home, '.cursor', 'chats');
  writeCursorChat(chats, { id: 'chat-mine', cwd: proj, name: 'Refactor storage', user: ['Storage katmanını ayır'], assistant: ['Ayırdım'] });
  writeCursorChat(chats, { id: 'chat-other', cwd: path.join(proj, 'nested'), name: 'Other', user: ['x'] });
  writeCursorChat(chats, { id: 'chat-empty', cwd: proj, name: 'New Agent' });

  const sessions = await listSessions({ providerId: 'cursor', projectDir: proj, homeDir: home });
  assert.deepEqual(sessions.map(s => [s.id, s.title, s.turnCount, s.providerId]), [['chat-mine', 'Refactor storage', 1, 'cursor']]);

  const h = await collectHandoverContext(proj, { sessionId: 'chat-mine', providerId: 'cursor', homeDir: home });
  assert.equal(h.lastUserMsg, 'Storage katmanını ayır');
  assert.equal(h.lastAssistantMsg, 'Ayırdım');
});

test('Antigravity sessions require an exact workspace match and report the model', async t => {
  const { listSessions } = require('../src/core/handover.cjs');
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-ag-home-'));
  const proj = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-ag-proj-'));
  t.after(async () => { for (const d of [home, proj]) await fs.rm(d, { recursive: true, force: true }); });

  const conv = path.join(home, '.gemini', 'antigravity-ide', 'conversations');
  await fs.mkdir(conv, { recursive: true });
  writeAntigravityDb(path.join(conv, 'exact.db'), proj, 'Gemini 3.8 Flash (High)');
  writeAntigravityDb(path.join(conv, 'prefix.db'), `${proj}-2`, 'Gemini 3.8 Flash (High)');
  writeAntigravityDb(path.join(conv, 'nomodel.db'), proj, null);
  writeAntigravityDb(path.join(conv, 'empty.db'), proj, null);
  for (const id of ['exact', 'prefix', 'nomodel']) writeAntigravityTranscript(home, id, [`Task ${id}`]);

  const sessions = await listSessions({ providerId: 'antigravity', projectDir: proj, homeDir: home });
  assert.deepEqual(sessions.map(s => s.id).sort(), ['exact', 'nomodel'], 'other folders and prompt-less conversations are excluded');
  assert.equal(sessions.find(s => s.id === 'exact').title, 'Task exact');
  assert.equal(sessions.find(s => s.id === 'exact').model, 'Gemini 3.8 Flash (High)');
  assert.equal(sessions.find(s => s.id === 'nomodel').model, '', 'unknown model stays unknown');
});
