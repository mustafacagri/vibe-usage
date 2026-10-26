import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { claudeLimitStop, claudeProjectDir, latestClaudeSession, readSession, RECENT_TURNS, sessionSources } from '../src/core/sessions.ts';
import test from 'node:test';
import zlib from 'node:zlib';
import { collectHandoverContext, listSessions } from '../src/core/handover.ts';
import type { SessionSummary } from '../src/shared/ipc.ts';
import { account, codexRollout, tempDir, writeAntigravityDb, writeAntigravityTranscript, writeCursorChat } from './helpers/fixtures.ts';

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

  const sessions = await listSessions('auto', project, sessionSources(home));
  assert.equal(session(sessions, s => s.providerId === 'claude').title, 'Claude Session Title');
  assert.equal(session(sessions, s => s.providerId === 'antigravity').title, 'Antigravity Arch Plan Task');

  const context = await collectHandoverContext(project, { sessionId: conversationId, sources: sessionSources(home) });
  assert.deepEqual(
    [context.hasSession, context.sessionId, context.providerId, context.sessionTitle],
    [true, conversationId, 'antigravity', 'Antigravity Arch Plan Task']
  );
});

test('sessions are read from every profile folder an account uses', async t => {
  const home = await tempDir(t, 'vibe-profile-sess-home-');
  const project = await tempDir(t, 'vibe-profile-sess-proj-');
  const work = path.join(home, 'codex-work');
  const sessions = path.join(work, 'sessions', '2026', '10', '17');
  await fs.mkdir(sessions, { recursive: true });
  const id = '0199a213-81c0-7800-8aa1-bbab2a035a99';
  await fs.writeFile(
    path.join(sessions, `rollout-2026-10-17T10-00-00-${id}.jsonl`),
    codexRollout({ id, cwd: project, user: ['Work task'] })
  );
  const claudeWork = path.join(home, 'claude-work', 'projects', path.resolve(project).replace(/[/\\:]/g, '-'));
  await fs.mkdir(claudeWork, { recursive: true });
  await fs.writeFile(
    path.join(claudeWork, 'work-claude.jsonl'),
    JSON.stringify({ type: 'user', message: { content: 'Claude work task' } })
  );

  assert.deepEqual(await listSessions('auto', project, sessionSources(home)), [], 'folders no account uses are not read');
  const accounts = [
    account({ id: 'codex:work', providerId: 'codex', configDir: work }),
    account({ id: 'claude:work', configDir: path.join(home, 'claude-work') }),
    account({ id: 'codex:off', providerId: 'codex', configDir: path.join(home, 'elsewhere'), enabled: false })
  ];
  const listed = await listSessions('auto', project, sessionSources(home, accounts));
  assert.deepEqual(listed.map(s => [s.providerId, s.title]).sort(), [
    ['claude', 'Claude work task'],
    ['codex', 'Work task']
  ]);
  const context = await collectHandoverContext(project, { sessionId: id, sources: sessionSources(home, accounts) });
  assert.equal(context.lastUserMsg, 'Work task');
});

test('a Claude transcript is parsed again only after it changes', async t => {
  const home = await tempDir(t, 'vibe-claude-memo-home-');
  const project = await tempDir(t, 'vibe-claude-memo-proj-');
  const dir = path.join(home, '.claude', 'projects', path.resolve(project).replace(/[/\\:]/g, '-'));
  const file = path.join(dir, 'memo.jsonl');
  await fs.mkdir(dir, { recursive: true });
  const write = async (title: string, mtime: Date): Promise<void> => {
    const records = [
      { type: 'ai-title', aiTitle: title },
      { type: 'user', message: { content: 'Task' } }
    ];
    await fs.writeFile(file, records.map(record => JSON.stringify(record)).join('\n'));
    await fs.utimes(file, mtime, mtime);
  };
  const title = async (): Promise<string> =>
    session(await listSessions('claude', project, sessionSources(home)), s => s.id === 'memo').title;
  const first = new Date('2026-10-01T10:00:00Z');
  await write('First title', first);
  assert.equal(await title(), 'First title');
  assert.equal(await title(), 'First title', 'an unchanged file can reuse its parsed transcript');
  await write('Unseen title', first);
  assert.equal(await title(), 'Unseen title', 'replacing contents while preserving mtime invalidates the cache');
  await write('Second title', new Date('2026-10-01T11:00:00Z'));
  assert.equal(await title(), 'Second title');
});

test('a copied Claude session keeps its physical profile and reviewed version from listing through reading', async t => {
  const home = await tempDir(t, 'vibe-copied-session-');
  const project = path.join(home, 'project');
  await fs.mkdir(project);
  const main = account({ id: 'claude:main', configDir: path.join(home, '.claude') });
  const spare = account({ id: 'claude:spare', configDir: path.join(home, '.claude-spare'), primary: false });
  const sources = sessionSources(home, [main, spare]);
  const files: string[] = [];
  for (const [index, profile] of [main, spare].entries()) {
    const file = path.join(profile.configDir ?? '', 'projects', project.replace(/[/\\:]/g, '-'), 'shared.jsonl');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(
      file,
      JSON.stringify({ type: 'user', cwd: project, message: { content: index ? 'New request on spare' : 'Old request on main' } })
    );
    const time = new Date(Date.parse('2026-10-17T12:00:00Z') + index * 60_000);
    await fs.utimes(file, time, time);
    files.push(file);
  }
  const listed = await listSessions('claude', project, sources);
  assert.equal(listed.length, 2);
  const newest = session(listed, entry => entry.source.accountId === spare.id);
  const older = session(listed, entry => entry.source.accountId === main.id);
  assert.notEqual(newest.source.id, older.source.id, 'the logical id is shared, the physical source is not');
  assert.equal(listed[0]?.source.id, newest.source.id);
  const query = { providerId: 'claude' as const, sessionId: 'shared', projectDir: project, sources };
  assert.equal((await readSession({ ...query, sessionId: 'auto' }))?.lastUserMsg, 'New request on spare');
  assert.equal(await readSession(query), null, 'an ambiguous named id needs a physical source');
  assert.equal((await readSession({ ...query, sessionSource: newest.source }))?.lastUserMsg, 'New request on spare');
  assert.equal((await readSession({ ...query, sessionSource: older.source }))?.lastUserMsg, 'Old request on main');
  assert.equal(
    await readSession({ ...query, sessionSource: { ...newest.source, accountId: main.id } }),
    null,
    'the account is part of the identity'
  );
  assert.equal(
    await readSession({ ...query, projectDir: home, sessionSource: newest.source }),
    null,
    'the source cannot be replayed for another project'
  );
  assert.equal(
    await readSession({ ...query, sessionSource: { id: files[0] ?? '', version: newest.source.version } }),
    null,
    'a path is never a source capability'
  );

  const changed = files[1];
  assert.ok(changed);
  const stat = await fs.stat(changed);
  await fs.appendFile(changed, `\n${JSON.stringify({ type: 'user', cwd: project, message: { content: 'Changed after preview' } })}\n`);
  await fs.utimes(changed, stat.atime, stat.mtime);
  assert.equal(await readSession({ ...query, sessionSource: newest.source }), null, 'a stale review never silently reads a new version');
  const refreshed = session(await listSessions('claude', project, sources), entry => entry.source.accountId === spare.id);
  assert.equal(refreshed.source.id, newest.source.id);
  assert.notEqual(refreshed.source.version, newest.source.version);
  assert.equal((await readSession({ ...query, sessionSource: refreshed.source }))?.lastUserMsg, 'Changed after preview');
});

test('relocated Claude sessions are discovered under their worktree even when relocation is outside the transcript tail', async t => {
  const home = await tempDir(t, 'vibe-worktree-session-');
  const project = path.join(home, 'project');
  const worktree = path.join(project, '.claude', 'worktrees', 'task');
  await fs.mkdir(worktree, { recursive: true });
  const dir = path.join(home, '.claude', 'projects', project.replace(/[/\\:]/g, '-'));
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'relocated.jsonl');
  const records = [
    { type: 'user', cwd: project, message: { content: 'Continue this worktree task' } },
    { type: 'relocated', relocatedCwd: worktree },
    ...Array.from({ length: 800 }, () => ({ type: 'progress', data: 'x'.repeat(1024) })),
    { type: 'assistant', cwd: path.join(worktree, 'src'), message: { content: 'Latest worktree state' } }
  ];
  await fs.writeFile(file, records.map(record => JSON.stringify(record)).join('\n'));
  assert.equal(await claudeProjectDir(file), worktree);
  const sources = sessionSources(home);
  assert.deepEqual(await listSessions('claude', project, sources), [], 'the parent slug is not the session project');
  const listed = await listSessions('claude', worktree, sources);
  assert.equal(listed.length, 1, 'the worktree is found without its own storage slug');
  const selected = listed[0];
  assert.ok(selected);
  assert.equal(
    (await readSession({ providerId: 'claude', sessionId: selected.id, sessionSource: selected.source, projectDir: worktree, sources }))
      ?.projectDir,
    await fs.realpath(worktree)
  );
  assert.equal(
    await readSession({ providerId: 'claude', sessionId: selected.id, sessionSource: selected.source, projectDir: project, sources }),
    null
  );
  assert.equal(
    (await latestClaudeSession(path.join(home, '.claude')))?.projectDir,
    worktree,
    'manual and continuity discovery share project ownership'
  );
});

test('Codex copies in separate profiles remain distinct sources with their own thread names', async t => {
  const home = await tempDir(t, 'vibe-codex-copies-');
  const project = path.join(home, 'project');
  await fs.mkdir(project);
  const profiles = [
    account({ id: 'codex:main', providerId: 'codex', configDir: path.join(home, '.codex') }),
    account({ id: 'codex:spare', providerId: 'codex', configDir: path.join(home, '.codex-spare'), primary: false })
  ];
  const id = '0199a213-81c0-7800-8aa1-bbab2a035a99';
  for (const [index, profile] of profiles.entries()) {
    const root = profile.configDir ?? '';
    const file = path.join(root, 'sessions', `rollout-2026-10-17-${id}.jsonl`);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, codexRollout({ id, cwd: project, user: [index ? 'Latest spare work' : 'Original main work'] }));
    await fs.writeFile(path.join(root, 'session_index.jsonl'), JSON.stringify({ id, thread_name: index ? 'Spare title' : 'Main title' }));
    const at = new Date(Date.parse('2026-10-17T12:00:00Z') + index * 60_000);
    await fs.utimes(file, at, at);
  }
  const sources = sessionSources(home, profiles);
  const listed = await listSessions('codex', project, sources);
  assert.equal(listed.length, 2);
  assert.deepEqual(
    listed.map(entry => [entry.title, entry.source.accountId]),
    [
      ['Spare title', 'codex:spare'],
      ['Main title', 'codex:main']
    ]
  );
  const query = { providerId: 'codex' as const, sessionId: id, projectDir: project, sources };
  assert.equal(await readSession(query), null);
  assert.equal((await readSession({ ...query, sessionId: 'auto' }))?.lastUserMsg, 'Latest spare work');
  const original = listed[1];
  assert.ok(original);
  assert.equal((await readSession({ ...query, sessionSource: original.source }))?.lastUserMsg, 'Original main work');
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
      user: ['Fix the quota screen', 'Add tests too'],
      assistant: ['Fixed it', 'Tests added']
    })
  );
  await fs.writeFile(
    path.join(day, `rollout-2026-10-16T09-00-00-${B}.jsonl.zst`),
    zlib.zstdCompressSync(Buffer.from(codexRollout({ id: B, cwd: project, user: ['Old compressed session'] })))
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
  await fs.writeFile(
    path.join(day, `rollout-2026-10-16T12-30-00-${E}.jsonl`),
    codexRollout({ id: E, cwd: other, user: ['Another project'] })
  );
  await fs.writeFile(
    path.join(home, '.codex', 'session_index.jsonl'),
    `${JSON.stringify({ id: A, thread_name: 'Quota screen', updated_at: '2026-10-16T10:00:00Z' })}\n`
  );

  const sessions = await listSessions('codex', project, sessionSources(home));
  assert.deepEqual(sessions.map(s => s.id).sort(), [A, B].sort());
  const a = session(sessions, s => s.id === A);
  assert.equal(a.title, 'Quota screen');
  assert.equal(a.turnCount, 2, 'injected AGENTS.md / environment messages are not user turns');
  assert.equal(a.model, 'gpt-6-luna');
  assert.equal(session(sessions, s => s.id === B).title, 'Old compressed session');

  const context = await collectHandoverContext(project, { sessionId: A, providerId: 'codex', sources: sessionSources(home) });
  assert.deepEqual(
    [context.providerId, context.initialGoal, context.lastUserMsg, context.lastAssistantMsg],
    ['codex', 'Fix the quota screen', 'Add tests too', 'Tests added']
  );
  assert.deepEqual(
    (await listSessions('codex', other, sessionSources(home))).map(s => s.id),
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
    (await listSessions('cursor', project, sessionSources(home))).map(s => [s.id, s.title, s.turnCount, s.providerId]),
    [['chat-mine', 'Refactor storage', 1, 'cursor']]
  );
  const context = await collectHandoverContext(project, { sessionId: 'chat-mine', providerId: 'cursor', sources: sessionSources(home) });
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

  const sessions = await listSessions('antigravity', project, sessionSources(home));
  assert.deepEqual(sessions.map(s => s.id).sort(), ['exact', 'nomodel'], 'other folders and prompt-less conversations are excluded');
  const exact = session(sessions, s => s.id === 'exact');
  assert.deepEqual([exact.title, exact.model], ['Task exact', 'Gemini 3.8 Flash (High)']);
  assert.equal(session(sessions, s => s.id === 'nomodel').model, '', 'an unknown model stays unknown');
});

test('a path that is not an existing folder lists no sessions', async t => {
  const home = await tempDir(t, 'vibe-none-home-');
  assert.deepEqual(await listSessions('auto', 'relative/path', sessionSources(home)), []);
  // A deleted project whose transcripts remain: its old sessions are not offered.
  const deleted = path.join(home, 'deleted-project');
  const claudeDir = path.join(home, '.claude', 'projects', deleted.replace(/[/\\:]/g, '-'));
  await fs.mkdir(claudeDir, { recursive: true });
  await fs.writeFile(path.join(claudeDir, 'old.jsonl'), JSON.stringify({ type: 'user', message: { content: 'Task' } }));
  assert.deepEqual(await listSessions('auto', deleted, sessionSources(home)), []);
});

const claudeRecord = (type: 'user' | 'assistant', content: unknown, fields: object = {}) => ({
  type,
  message: { role: type, content },
  ...fields
});

async function writeClaudeSession(home: string, project: string, id: string, records: object[]): Promise<void> {
  const dir = path.join(home, '.claude', 'projects', path.resolve(project).replace(/[/\\:]/g, '-'));
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${id}.jsonl`), records.map(record => JSON.stringify(record)).join('\n'));
}

test('the recent conversation is chronological text, without tool calls or their output', async t => {
  const home = await tempDir(t, 'vibe-recent-home-');
  const project = await tempDir(t, 'vibe-recent-proj-');
  await writeClaudeSession(home, project, 'recent', [
    claudeRecord('user', 'Add a dark theme.'),
    claudeRecord('assistant', [{ type: 'text', text: 'Reading the styles first.' }]),
    claudeRecord('assistant', [{ type: 'tool_use', name: 'Read', input: { file_path: 'src/ui/app.css' } }]),
    claudeRecord('user', [{ type: 'tool_result', content: 'body { color: black }' }]),
    claudeRecord('assistant', [{ type: 'text', text: 'Added the dark palette; tests pass.' }]),
    claudeRecord('user', 'A subagent prompt', { isSidechain: true }),
    claudeRecord('user', 'Caveat: generated by a command', { isMeta: true }),
    claudeRecord('user', 'Now make it follow the system setting.')
  ]);
  const context = await collectHandoverContext(project, { sources: sessionSources(home) });
  assert.deepEqual(context.recent, [
    { role: 'user', text: 'Add a dark theme.' },
    { role: 'assistant', text: 'Reading the styles first.\n\nAdded the dark palette; tests pass.' },
    { role: 'user', text: 'Now make it follow the system setting.' }
  ]);
});

test('Codex, Cursor and Antigravity sessions report their recent conversation too', async t => {
  const home = await tempDir(t, 'vibe-recent-all-home-');
  const project = await tempDir(t, 'vibe-recent-all-proj-');
  const day = path.join(home, '.codex', 'sessions', '2026', '10', '18');
  await fs.mkdir(day, { recursive: true });
  const id = '01a1ffff-0000-7000-8000-000000000006';
  await fs.writeFile(
    path.join(day, `rollout-2026-10-18T10-00-00-${id}.jsonl`),
    codexRollout({ id, cwd: project, user: ['Fix the build', 'And the lint'], assistant: ['Build fixed'] })
  );
  writeCursorChat(path.join(home, '.cursor', 'chats'), {
    id: 'chat-r',
    cwd: project,
    name: 'Chat',
    user: ['Rename it'],
    assistant: ['Renamed']
  });
  const conversations = path.join(home, '.gemini', 'antigravity-ide', 'conversations');
  await fs.mkdir(conversations, { recursive: true });
  writeAntigravityDb(path.join(conversations, 'ag-r.db'), project);
  writeAntigravityTranscript(home, 'ag-r', ['Plan <b>it</b>', 'Go'], ['Planned']);

  const recent = async (sessionId: string) =>
    (await collectHandoverContext(project, { sessionId, sources: sessionSources(home) })).recent.map(turn => [turn.role, turn.text]);
  assert.deepEqual(
    await recent(id),
    [
      ['user', 'Fix the build'],
      ['assistant', 'Build fixed'],
      ['user', 'And the lint']
    ],
    'injected AGENTS.md / environment messages are not part of the conversation'
  );
  assert.deepEqual(await recent('chat-r'), [
    ['user', 'Rename it'],
    ['assistant', 'Renamed']
  ]);
  assert.deepEqual(await recent('ag-r'), [
    ['user', 'Plan it'],
    ['assistant', 'Planned'],
    ['user', 'Go']
  ]);
});

test('the recent conversation keeps the newest turns, within its count and length bounds', async t => {
  const home = await tempDir(t, 'vibe-recent-bounds-home-');
  const project = await tempDir(t, 'vibe-recent-bounds-proj-');
  const rounds = (count: number, answer: (i: number) => string, request = (i: number) => `request ${i}`) =>
    Array.from({ length: count }, (_, i) => [claudeRecord('user', request(i)), claudeRecord('assistant', answer(i))]).flat();
  await writeClaudeSession(
    home,
    project,
    'short',
    rounds(20, i => (i === 19 ? `START ${'x'.repeat(5000)} END` : `answer ${i}`))
  );
  const read = async (sessionId: string) => (await collectHandoverContext(project, { sessionId, sources: sessionSources(home) })).recent;

  const short = await read('short');
  assert.equal(short.length, RECENT_TURNS.count);
  assert.deepEqual(short.slice(0, 2), [
    { role: 'user', text: 'request 14' },
    { role: 'assistant', text: 'answer 14' }
  ]);
  const last = short.at(-1)?.text ?? '';
  assert.ok(last.length <= RECENT_TURNS.turnChars);
  assert.ok(last.startsWith('START ') && last.endsWith(' END'), 'a long turn keeps its beginning and its end');

  const long = (i: number): string => `${i} ${'y'.repeat(RECENT_TURNS.turnChars)}`;
  await writeClaudeSession(home, project, 'long', rounds(10, long, long));
  const turns = await read('long');
  assert.ok(turns.reduce((sum, turn) => sum + turn.text.length, 0) <= RECENT_TURNS.totalChars);
  assert.ok(turns.length < RECENT_TURNS.count);
  assert.ok(turns.at(-1)?.text.startsWith('9 '), 'the newest turn is kept');
});

test('recent conversation text loses secrets before it is clipped', async t => {
  const home = await tempDir(t, 'vibe-recent-secret-home-');
  const project = await tempDir(t, 'vibe-recent-secret-proj-');
  // The key straddles the point where the turn is clipped.
  const key = `sk-${'a1'.repeat(20)}`;
  const message = `${'z'.repeat(700)} ${key} ${'z'.repeat(2000)}`;
  await writeClaudeSession(home, project, 'secret', [claudeRecord('user', `Use ${key}`), claudeRecord('assistant', message)]);
  const { recent } = await collectHandoverContext(project, { sources: sessionSources(home) });
  assert.equal(recent[0]?.text, 'Use [REDACTED_SECRET]');
  assert.equal(
    recent
      .map(turn => turn.text)
      .join('')
      .includes('a1a1'),
    false
  );
});

test('a known Claude session is found by its id, not by reading every transcript', async t => {
  const root = await tempDir(t, 'vibe-latest-claude-');
  const project = path.join(root, 'projects', 'C--work-app');
  await fs.mkdir(project, { recursive: true });
  const write = async (id: string, minutesAgo: number) => {
    const file = path.join(project, `${id}.jsonl`);
    await fs.writeFile(file, `${JSON.stringify({ type: 'user', cwd: '/work/app' })}\n`);
    const at = new Date(Date.now() - minutesAgo * 60 * 1000);
    await fs.utimes(file, at, at);
  };
  await write('older', 30);
  await write('newer', 1);
  assert.equal((await latestClaudeSession(root))?.sessionId, 'newer');
  assert.equal((await latestClaudeSession(root, { projectDir: '/work/app', sessionId: 'older' }))?.sessionId, 'older');
  assert.equal(await latestClaudeSession(root, { projectDir: '/work/other', sessionId: 'older' }), null, 'another project');
  assert.equal(
    await latestClaudeSession(root, { projectDir: '/work/app', sessionId: '../C--work-app/older' }),
    null,
    'an id is never a path'
  );
});

test('a Claude session belongs to the folder Claude Code attributes it to, wherever its agent went', async t => {
  const dir = await tempDir(t, 'vibe-project-dir-');
  const write = async (name: string, records: object[]) => {
    const file = path.join(dir, name);
    await fs.writeFile(file, `${records.map(r => JSON.stringify(r)).join('\n')}\n`);
    return file;
  };
  const limit = {
    type: 'assistant',
    isApiErrorMessage: true,
    apiError: 'usage_limit_reached',
    isSidechain: false,
    timestamp: '2026-10-18T00:34:19.000Z',
    message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: "You've hit your session limit" }] }
  };
  // The agent `cd`'d into a worktree: later records carry that folder, the session is still the project's.
  const project = '/work/app';
  const worktree = '/work/app/.claude/worktrees/fix';
  const wandered = await write('wandered.jsonl', [
    { type: 'user', cwd: project, message: { role: 'user', content: 'go' } },
    { type: 'assistant', cwd: worktree, message: { role: 'assistant', content: [] } },
    { ...limit, cwd: worktree }
  ]);
  assert.equal(await claudeProjectDir(wandered), project);
  assert.equal((await claudeLimitStop(wandered))?.cwd, project, 'the stop is attributed the same way');
  // Relocated into a worktree by Claude Code itself: the worktree is its folder from then on.
  const relocated = await write('relocated.jsonl', [
    { type: 'user', cwd: project, message: { role: 'user', content: 'go' } },
    { type: 'relocated', sessionId: 'relocated', relocatedCwd: worktree },
    { ...limit, cwd: worktree }
  ]);
  assert.equal(await claudeProjectDir(relocated), worktree);
  assert.equal(await claudeProjectDir(await write('empty.jsonl', [{ type: 'summary' }])), null);
  // A relocation in the middle of a multi-megabyte transcript is found wherever the 1 MiB read
  // boundary falls, including inside the marker itself.
  const filler = { type: 'assistant', cwd: project, message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(1000) }] } };
  for (const padding of [0, 1, 7, 13, 500]) {
    const lines: Record<string, unknown>[] = [{ type: 'user', cwd: project, message: { role: 'user', content: 'go' } }];
    for (let size = 0; size < 1024 * 1024 + padding; size += 1100) lines.push(filler);
    lines.push({ type: 'relocated', sessionId: 'big', relocatedCwd: worktree }, ...Array.from({ length: 1500 }, () => filler));
    assert.equal(await claudeProjectDir(await write(`big-${padding}.jsonl`, lines)), worktree, `padding ${padding}`);
  }
});
