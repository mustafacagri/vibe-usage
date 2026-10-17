import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import zlib from 'node:zlib';
import { collectHandoverContext, listSessions } from '../src/core/handover.ts';
import type { SessionSummary } from '../src/shared/ipc.ts';
import { codexRollout, tempDir, writeAntigravityDb, writeAntigravityTranscript, writeCursorChat } from './helpers/fixtures.ts';

function session(sessions: SessionSummary[], predicate: (session: SessionSummary) => boolean): SessionSummary {
  const found = sessions.find(predicate);
  assert.ok(found, 'session listed');
  return found;
}

test('auto discovery lists sessions of every provider', async t => {
  const home = await tempDir(t, 'vibe-multi-sess-home-');
  const project = await tempDir(t, 'vibe-multi-sess-proj-');
  const claudeDir = path.join(home, '.claude', 'projects', path.resolve(project).replace(/[/\\:]/g, '-'));
  await fs.mkdir(claudeDir, { recursive: true });
  await fs.writeFile(
    path.join(claudeDir, 'claude-sess.jsonl'),
    [
      { type: 'ai-title', aiTitle: 'Claude Session Title' },
      { type: 'user', message: { content: 'Task 1' } }
    ]
      .map(line => JSON.stringify(line))
      .join('\n')
  );
  const conversations = path.join(home, '.gemini', 'antigravity-ide', 'conversations');
  const conversationId = 'ag-test-conv-123';
  await fs.mkdir(conversations, { recursive: true });
  writeAntigravityDb(path.join(conversations, `${conversationId}.db`), project, 'Gemini 3.8 Flash (High)');
  writeAntigravityTranscript(home, conversationId, ['Antigravity Arch Plan Task'], ['Step 1 completed']);

  const sessions = await listSessions('auto', project, home);
  assert.equal(session(sessions, s => s.providerId === 'claude').title, 'Claude Session Title');
  assert.equal(session(sessions, s => s.providerId === 'antigravity').title, 'Antigravity Arch Plan Task');

  const context = await collectHandoverContext(project, { sessionId: conversationId, homeDir: home });
  assert.deepEqual(
    [context.hasSession, context.sessionId, context.providerId, context.sessionTitle],
    [true, conversationId, 'antigravity', 'Antigravity Arch Plan Task']
  );
});

test('Codex sessions are project-scoped, include compressed rollouts and exclude subagents', async t => {
  const home = await tempDir(t, 'vibe-codex-home-');
  const project = await tempDir(t, 'vibe-codex-proj-');
  const other = await tempDir(t, 'vibe-codex-other-');
  const day = path.join(home, '.codex', 'sessions', '2026', '10', '16');
  await fs.mkdir(day, { recursive: true });
  const A = '01a1aaaa-0000-7000-8000-000000000001';
  const B = '01a1bbbb-0000-7000-8000-000000000002';
  const D = '01a1dddd-0000-7000-8000-000000000004';
  const E = '01a1eeee-0000-7000-8000-000000000005';
  await fs.writeFile(
    path.join(day, `rollout-2026-10-16T10-00-00-${A}.jsonl`),
    codexRollout({
      id: A,
      cwd: project,
      model: 'gpt-6-luna',
      user: ['Kota ekranını düzelt', 'Testleri de ekle'],
      assistant: ['Düzelttim', 'Testler eklendi']
    })
  );
  await fs.writeFile(
    path.join(day, `rollout-2026-10-16T09-00-00-${B}.jsonl.zst`),
    zlib.zstdCompressSync(Buffer.from(codexRollout({ id: B, cwd: project, user: ['Eski sıkıştırılmış oturum'] })))
  );
  // A fork snapshot of A begins with A's session_meta and must not duplicate A.
  await fs.writeFile(
    path.join(day, `rollout-2026-10-16T11-00-00-${A}_01a1cccc-0000-7000-8000-000000000003.jsonl`),
    codexRollout({ id: A, cwd: project, user: ['snapshot'] })
  );
  // A Guardian reviewer thread, and another project's session.
  await fs.writeFile(
    path.join(day, `rollout-2026-10-16T12-00-00-${D}.jsonl`),
    codexRollout({ id: D, cwd: project, source: { subagent: { other: 'guardian' } }, user: ['review'] })
  );
  await fs.writeFile(path.join(day, `rollout-2026-10-16T12-30-00-${E}.jsonl`), codexRollout({ id: E, cwd: other, user: ['Başka proje'] }));
  await fs.writeFile(
    path.join(home, '.codex', 'session_index.jsonl'),
    `${JSON.stringify({ id: A, thread_name: 'Kota ekranı', updated_at: '2026-10-16T10:00:00Z' })}\n`
  );

  const sessions = await listSessions('codex', project, home);
  assert.deepEqual(sessions.map(s => s.id).sort(), [A, B].sort());
  const a = session(sessions, s => s.id === A);
  assert.equal(a.title, 'Kota ekranı');
  assert.equal(a.turnCount, 2, 'injected AGENTS.md / environment messages are not user turns');
  assert.equal(a.model, 'gpt-6-luna');
  assert.equal(session(sessions, s => s.id === B).title, 'Eski sıkıştırılmış oturum');

  const context = await collectHandoverContext(project, { sessionId: A, providerId: 'codex', homeDir: home });
  assert.deepEqual(
    [context.providerId, context.initialGoal, context.lastUserMsg, context.lastAssistantMsg],
    ['codex', 'Kota ekranını düzelt', 'Testleri de ekle', 'Testler eklendi']
  );
  assert.deepEqual(
    (await listSessions('codex', other, home)).map(s => s.id),
    [E]
  );
});

test('Cursor CLI sessions are matched by folder and read from store.db', async t => {
  const home = await tempDir(t, 'vibe-cursor-home-');
  const project = await tempDir(t, 'vibe-cursor-proj-');
  const chats = path.join(home, '.cursor', 'chats');
  writeCursorChat(chats, {
    id: 'chat-mine',
    cwd: project,
    name: 'Refactor storage',
    user: ['Storage katmanını ayır'],
    assistant: ['Ayırdım']
  });
  writeCursorChat(chats, { id: 'chat-other', cwd: path.join(project, 'nested'), name: 'Other', user: ['x'] });
  writeCursorChat(chats, { id: 'chat-empty', cwd: project, name: 'New Agent' });

  assert.deepEqual(
    (await listSessions('cursor', project, home)).map(s => [s.id, s.title, s.turnCount, s.providerId]),
    [['chat-mine', 'Refactor storage', 1, 'cursor']]
  );
  const context = await collectHandoverContext(project, { sessionId: 'chat-mine', providerId: 'cursor', homeDir: home });
  assert.deepEqual([context.lastUserMsg, context.lastAssistantMsg], ['Storage katmanını ayır', 'Ayırdım']);
});

test('Antigravity sessions require an exact workspace match and report the model', async t => {
  const home = await tempDir(t, 'vibe-ag-home-');
  const project = await tempDir(t, 'vibe-ag-proj-');
  const conversations = path.join(home, '.gemini', 'antigravity-ide', 'conversations');
  await fs.mkdir(conversations, { recursive: true });
  writeAntigravityDb(path.join(conversations, 'exact.db'), project, 'Gemini 3.8 Flash (High)');
  writeAntigravityDb(path.join(conversations, 'prefix.db'), `${project}-2`, 'Gemini 3.8 Flash (High)');
  writeAntigravityDb(path.join(conversations, 'nomodel.db'), project);
  writeAntigravityDb(path.join(conversations, 'empty.db'), project);
  for (const id of ['exact', 'prefix', 'nomodel']) writeAntigravityTranscript(home, id, [`Task ${id}`]);

  const sessions = await listSessions('antigravity', project, home);
  assert.deepEqual(sessions.map(s => s.id).sort(), ['exact', 'nomodel'], 'other folders and prompt-less conversations are excluded');
  const exact = session(sessions, s => s.id === 'exact');
  assert.deepEqual([exact.title, exact.model], ['Task exact', 'Gemini 3.8 Flash (High)']);
  assert.equal(session(sessions, s => s.id === 'nomodel').model, '', 'an unknown model stays unknown');
});

test('a path that is not an existing folder lists no sessions', async t => {
  const home = await tempDir(t, 'vibe-none-home-');
  assert.deepEqual(await listSessions('auto', 'relative/path', home), []);
  assert.deepEqual(await listSessions('auto', path.join(home, 'missing'), home), []);
});
