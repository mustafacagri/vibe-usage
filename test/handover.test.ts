import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {
  collectHandoverContext,
  executeHandover,
  HANDOVER_FILE,
  HANDOVER_PROMPT,
  listSessions,
  parseProviderChoice,
  previewSmartLaunch,
  renderBrief,
  smartLaunch,
  type HandoverContext
} from '../src/core/handover.ts';
import type { ProviderId } from '../src/shared/catalog.ts';
import type { Account, ProviderState } from '../src/shared/types.ts';
import { account, fakeSpawn, measuredAccount, quotaWindow, tempDir, writeCursorChat } from './helpers/fixtures.ts';

async function writeClaudeSession(home: string, projectDir: string, id: string, records: object[]): Promise<void> {
  const dir = path.join(home, '.claude', 'projects', path.resolve(projectDir).replace(/[/\\:]/g, '-'));
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${id}.jsonl`), records.map(record => JSON.stringify(record)).join('\n'));
}
const user = (content: unknown) => ({ type: 'user', message: { role: 'user', content } });
const assistant = (content: unknown) => ({ type: 'assistant', message: { role: 'assistant', content } });

function state(
  accounts: Account[] = [],
  providers: ProviderState[] = [],
  providerOrder: ProviderId[] = ['claude', 'codex', 'cursor', 'antigravity']
) {
  return { settings: { providerOrder, preferredModels: {}, accounts }, providers };
}

function context(fields: Partial<HandoverContext> = {}): HandoverContext {
  return {
    providerId: null,
    sessionId: '',
    sessionTitle: '',
    sessionModel: '',
    initialGoal: '',
    lastUserMsg: '',
    lastAssistantMsg: '',
    turnCount: 0,
    hasSession: false,
    git: { branch: '', lastCommit: '', changedFiles: [] },
    recentFiles: [],
    ...fields
  };
}

test('handover context summarizes the transcript and the files tools touched', async t => {
  const home = await tempDir(t, 'vibe-home-');
  const project = await tempDir(t, 'vibe-proj-');
  await writeClaudeSession(home, project, 'session-abc', [
    user('Projeyi Vanilla JS yapalım.'),
    assistant('index.html ve src/ui/app.js oluşturuyorum.'),
    assistant([{ type: 'tool_use', name: 'Write', input: { file_path: 'src/ui/app.js' } }]),
    { ...user([{ type: 'tool_result', content: 'ok' }]), toolUseResult: { filePath: 'src/ui/app.js' } },
    user('Kota tablosunu 2 sütunlu yap.'),
    assistant('Quota grid 2 sütun olarak düzenlendi.')
  ]);
  const summary = await collectHandoverContext(project, { homeDir: home });
  assert.equal(summary.hasSession, true);
  assert.deepEqual(
    [summary.providerId, summary.sessionId, summary.turnCount],
    ['claude', 'session-abc', 2],
    'tool results are not user turns'
  );
  assert.equal(summary.initialGoal, 'Projeyi Vanilla JS yapalım.');
  assert.equal(summary.lastUserMsg, 'Kota tablosunu 2 sütunlu yap.');
  assert.equal(summary.lastAssistantMsg, 'Quota grid 2 sütun olarak düzenlendi.');
  assert.deepEqual(summary.recentFiles, ['src/ui/app.js'], 'mentioned paths are not touched files');
});

test('transcripts lose system reminders, secrets and messages the tool generated itself', async t => {
  const home = await tempDir(t, 'vibe-home-');
  const project = await tempDir(t, 'vibe-proj-');
  await writeClaudeSession(home, project, 'session-sec', [
    user('<system-reminder>Kurallara uy.</system-reminder>API anahtarım sk-ant-api03-12345678901234567890 ile bağlan.'),
    assistant('Fixed the rate limit handling; resets at midnight are now shown.'),
    { ...assistant('Usage limit reached. Resets at 3:00 PM.'), isApiErrorMessage: true },
    { type: 'assistant', message: { role: 'assistant', model: '<synthetic>', content: 'Rate limit notice' } }
  ]);
  const summary = await collectHandoverContext(project, { homeDir: home });
  assert.equal(summary.lastUserMsg, 'API anahtarım [REDACTED_SECRET] ile bağlan.');
  assert.equal(
    summary.lastAssistantMsg,
    'Fixed the rate limit handling; resets at midnight are now shown.',
    'real answers about limits are kept'
  );
});

test('sessions list with titles; a named session wins over the newest', async t => {
  const home = await tempDir(t, 'vibe-home-');
  const project = await tempDir(t, 'vibe-proj-');
  await writeClaudeSession(home, project, 'sess-1', [{ type: 'ai-title', aiTitle: 'Startup araştırması' }, user('Araştırmaya başla.')]);
  await new Promise(resolve => setTimeout(resolve, 20));
  await writeClaudeSession(home, project, 'sess-2', [user('Admin reviews tablo tasarımı'), assistant('Tamamlandı.')]);
  assert.deepEqual(
    (await listSessions('claude', project, home)).map(s => [s.id, s.title]),
    [
      ['sess-2', 'Admin reviews tablo tasarımı'],
      ['sess-1', 'Startup araştırması']
    ]
  );
  assert.equal((await collectHandoverContext(project, { sessionId: 'sess-1', homeDir: home })).initialGoal, 'Araştırmaya başla.');
  assert.equal((await collectHandoverContext(project, { homeDir: home })).sessionId, 'sess-2');
});

test('a missing named session is an error, never a substitute', async t => {
  const home = await tempDir(t, 'vibe-home-');
  const project = await tempDir(t, 'vibe-proj-');
  await writeClaudeSession(home, project, 'claude-1', [user('CLAUDE TASK')]);
  writeCursorChat(path.join(home, '.cursor', 'chats'), {
    id: 'chat-1',
    cwd: project,
    name: 'Cursor görevi',
    user: ['CURSOR TASK'],
    assistant: ['cursor done']
  });
  await assert.rejects(collectHandoverContext(project, { sessionId: 'chat-1', providerId: 'codex', homeDir: home }), /session_not_found/);
  const summary = await collectHandoverContext(project, { sessionId: 'chat-1', providerId: 'cursor', homeDir: home });
  assert.deepEqual([summary.providerId, summary.lastUserMsg], ['cursor', 'CURSOR TASK']);
});

test('the brief is a fixed English template for the receiving tool', () => {
  const brief = renderBrief(
    context({
      sessionTitle: 'Quota UI',
      sessionId: 's1',
      sessionModel: 'claude-opus-5-5',
      turnCount: 3,
      initialGoal: 'Build it',
      lastUserMsg: 'Fix it',
      lastAssistantMsg: 'Done',
      git: { branch: 'main', lastCommit: 'abc fix', changedFiles: [] },
      recentFiles: ['a b.js']
    }),
    { from: 'claude', to: 'codex', model: 'gpt-5.6-terra', tier: 'flagship' },
    new Date('2026-10-16T20:00:00Z')
  );
  assert.match(brief, /^# Vibe Usage handover: Claude → Codex\n\n> Generated by Vibe Usage on 2026-10-16T20:00:00\.000Z/);
  assert.match(brief, /\*\*Source model:\*\* `claude-opus-5-5` \(flagship tier\)/);
  assert.match(brief, /## 3\. Last state reported by Claude\nDone/);
  assert.match(brief, /- `a b\.js`/);
  assert.match(
    renderBrief(context(), { from: null, to: 'cursor', model: null, tier: 'balanced' }),
    /Unknown tool → Cursor[\s\S]*Not recorded/
  );
});

test('provider choices from the renderer or the command line are checked', () => {
  assert.equal(parseProviderChoice('auto'), 'auto');
  assert.equal(parseProviderChoice('codex'), 'codex');
  for (const value of ['malicious; rm -rf /', 'nope', undefined, 7]) assert.throws(() => parseProviderChoice(value), /invalid_provider/);
});

test('handover writes the brief and starts the target', async t => {
  const home = await tempDir(t, 'vibe-home-');
  const project = await tempDir(t, 'vibe-proj-');
  const dataDir = await tempDir(t, 'vibe-data-');
  writeCursorChat(path.join(home, '.cursor', 'chats'), { id: 'chat-1', cwd: project, name: 'Cursor görevi', user: ['CURSOR TASK'] });
  const calls: string[][] = [];
  const result = await executeHandover(
    {
      projectDir: project,
      fromProvider: 'auto',
      toProvider: 'antigravity',
      targetModel: 'ignored',
      sessionId: 'chat-1',
      sessionProvider: 'cursor'
    },
    state(),
    { dataDir, homeDir: home, platform: 'darwin', spawnProcess: fakeSpawn(calls) }
  );
  assert.deepEqual(result, { from: 'cursor', to: 'antigravity', model: null, mode: 'app' }, 'apps take no model');
  assert.deepEqual(calls, [['/usr/bin/open', '-a', 'Antigravity', project]]);
  const brief = await fs.readFile(path.join(project, HANDOVER_FILE), 'utf8');
  assert.match(brief, /Cursor → Antigravity/);
  assert.match(brief, /CURSOR TASK/);
  await assert.rejects(
    executeHandover({ projectDir: 'relative', fromProvider: 'auto', toProvider: 'codex', sessionId: 'auto' }, state(), { dataDir }),
    /invalid_path/
  );
});

test('a terminal target starts with the brief prompt and the chosen model', async t => {
  const home = await tempDir(t, 'vibe-home-');
  const project = await tempDir(t, 'vibe-proj-');
  const dataDir = await tempDir(t, 'vibe-data-');
  const claude = path.join(dataDir, 'claude');
  await fs.writeFile(claude, '');
  process.env.VIBE_CLAUDE_BINARY = claude;
  t.after(() => {
    delete process.env.VIBE_CLAUDE_BINARY;
  });
  const profile = account({ id: 'claude:default', labelKey: 'accountA', configDir: home, configDirExplicit: false });
  const calls: string[][] = [];
  const result = await executeHandover(
    { projectDir: project, fromProvider: 'auto', toProvider: 'claude', targetModel: 'opus', sessionId: 'auto' },
    state([profile]),
    { dataDir, homeDir: home, platform: 'darwin', spawnProcess: fakeSpawn(calls) }
  );
  assert.deepEqual(result, { from: null, to: 'claude', model: 'opus', mode: 'terminal' });
  const script = await fs.readFile(calls[0]?.[3] ?? '', 'utf8');
  assert.ok(script.includes(`exec '${claude}' '--model' 'opus' '${HANDOVER_PROMPT}'`));
  assert.ok(script.includes('CLAUDE_CONFIG_DIR'), 'the default profile unsets CLAUDE_CONFIG_DIR');
});

test('smart launch starts the provider with verified quota, without a brief', async t => {
  const project = await tempDir(t, 'vibe-proj-');
  const dataDir = await tempDir(t, 'vibe-data-');
  const antigravity = account({ id: 'antigravity:a', providerId: 'antigravity', label: 'me@example.com' });
  const measured = measuredAccount({
    ...antigravity,
    fetchedAt: new Date().toISOString(),
    windows: [quotaWindow({ scope: 'Gemini', remainingPercent: 70 })]
  });
  const quota = state(
    [antigravity],
    [{ id: 'antigravity', status: 'ok', accounts: [measured] }],
    ['cursor', 'antigravity', 'claude', 'codex']
  );
  assert.deepEqual(previewSmartLaunch(quota, { dataDir }), {
    providerId: 'antigravity',
    verified: true,
    isFallback: true,
    headroomPercent: 70,
    model: null
  });
  const calls: string[][] = [];
  const result = await smartLaunch({ projectDir: project }, quota, { dataDir, platform: 'darwin', spawnProcess: fakeSpawn(calls) });
  assert.deepEqual(result, { to: 'antigravity', model: null, mode: 'app', verified: true });
  await assert.rejects(fs.stat(path.join(project, HANDOVER_FILE)));
});
