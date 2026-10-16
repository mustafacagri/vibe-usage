'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { writeCursorChat, fakeSpawn } = require('./helpers/fixtures.cjs');
const {
  HANDOVER_FILE,
  HANDOVER_PROMPT,
  collectHandoverContext,
  renderBrief,
  executeHandover,
  listSessions,
  previewSmartLaunch,
  smartLaunch
} = require('../src/core/handover.cjs');

async function tempDirs(t, ...prefixes) {
  const dirs = await Promise.all(prefixes.map(p => fs.mkdtemp(path.join(os.tmpdir(), p))));
  t.after(() => Promise.all(dirs.map(d => fs.rm(d, { recursive: true, force: true }))));
  return dirs;
}

async function writeClaudeSession(home, projectDir, id, records) {
  const dir = path.join(home, '.claude', 'projects', path.resolve(projectDir).replace(/[/\\:]/g, '-'));
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${id}.jsonl`), records.map(r => JSON.stringify(r)).join('\n'));
}
const user = content => ({ type: 'user', message: { role: 'user', content } });
const assistant = content => ({ type: 'assistant', message: { role: 'assistant', content } });

function snapshot(accounts = []) {
  return { settings: { providerOrder: ['claude', 'codex', 'cursor', 'antigravity'], preferredModels: {}, accounts }, providers: [] };
}

test('handover context summarizes the transcript and the files tools touched', async t => {
  const [home, project] = await tempDirs(t, 'vibe-home-', 'vibe-proj-');
  await writeClaudeSession(home, project, 'session-abc', [
    user('Projeyi Vanilla JS yapalım.'),
    assistant('index.html ve src/ui/app.js oluşturuyorum.'),
    assistant([{ type: 'tool_use', name: 'Write', input: { file_path: 'src/ui/app.js' } }]),
    { ...user([{ type: 'tool_result', content: 'ok' }]), toolUseResult: { filePath: 'src/ui/app.js' } },
    user('Kota tablosunu 2 sütunlu yap.'),
    assistant('Quota grid 2 sütun olarak düzenlendi.')
  ]);
  const context = await collectHandoverContext(project, { homeDir: home });
  assert.equal(context.hasSession, true);
  assert.deepEqual(
    [context.providerId, context.sessionId, context.turnCount],
    ['claude', 'session-abc', 2],
    'tool results are not user turns'
  );
  assert.equal(context.initialGoal, 'Projeyi Vanilla JS yapalım.');
  assert.equal(context.lastUserMsg, 'Kota tablosunu 2 sütunlu yap.');
  assert.equal(context.lastAssistantMsg, 'Quota grid 2 sütun olarak düzenlendi.');
  assert.deepEqual(context.recentFiles, ['src/ui/app.js'], 'mentioned paths are not touched files');
});

test('transcripts lose system reminders, secrets and rate-limit noise', async t => {
  const [home, project] = await tempDirs(t, 'vibe-home-', 'vibe-proj-');
  await writeClaudeSession(home, project, 'session-sec', [
    user('<system-reminder>Kurallara uy.</system-reminder>API anahtarım sk-ant-api03-12345678901234567890 ile bağlan.'),
    assistant('Fixed the rate limit handling; resets at midnight are now shown.'),
    { ...assistant('Usage limit reached. Resets at 3:00 PM.'), isApiErrorMessage: true },
    { type: 'assistant', message: { role: 'assistant', model: '<synthetic>', content: 'Rate limit notice' } }
  ]);
  const context = await collectHandoverContext(project, { homeDir: home });
  assert.equal(context.lastUserMsg, 'API anahtarım [REDACTED_SECRET] ile bağlan.');
  assert.equal(
    context.lastAssistantMsg,
    'Fixed the rate limit handling; resets at midnight are now shown.',
    'real answers about limits are kept'
  );
});

test('sessions list with titles; a named session wins over the newest', async t => {
  const [home, project] = await tempDirs(t, 'vibe-home-', 'vibe-proj-');
  await writeClaudeSession(home, project, 'sess-1', [{ type: 'ai-title', aiTitle: 'Startup araştırması' }, user('Araştırmaya başla.')]);
  await new Promise(resolve => setTimeout(resolve, 20));
  await writeClaudeSession(home, project, 'sess-2', [user('Admin reviews tablo tasarımı'), assistant('Tamamlandı.')]);
  const sessions = await listSessions({ providerId: 'claude', projectDir: project, homeDir: home });
  assert.deepEqual(
    sessions.map(s => [s.id, s.title]),
    [
      ['sess-2', 'Admin reviews tablo tasarımı'],
      ['sess-1', 'Startup araştırması']
    ]
  );
  assert.equal((await collectHandoverContext(project, { sessionId: 'sess-1', homeDir: home })).initialGoal, 'Araştırmaya başla.');
  assert.equal((await collectHandoverContext(project, { homeDir: home })).sessionId, 'sess-2');
  assert.deepEqual(await listSessions({ providerId: 'claude', projectDir: path.join(project, 'missing'), homeDir: home }), []);
});

test('a missing named session is an error, never a substitute', async t => {
  const [home, project] = await tempDirs(t, 'vibe-home-', 'vibe-proj-');
  await writeClaudeSession(home, project, 'claude-1', [user('CLAUDE TASK')]);
  writeCursorChat(path.join(home, '.cursor', 'chats'), {
    id: 'chat-1',
    cwd: project,
    name: 'Cursor görevi',
    user: ['CURSOR TASK'],
    assistant: ['cursor done']
  });
  await assert.rejects(collectHandoverContext(project, { sessionId: 'chat-1', providerId: 'codex', homeDir: home }), /session_not_found/);
  const context = await collectHandoverContext(project, { sessionId: 'chat-1', providerId: 'cursor', homeDir: home });
  assert.deepEqual([context.providerId, context.lastUserMsg], ['cursor', 'CURSOR TASK']);
});

test('the brief is a fixed English template for the receiving tool', () => {
  const brief = renderBrief(
    {
      sessionTitle: 'Quota UI',
      sessionId: 's1',
      sessionModel: 'claude-opus-5-5',
      turnCount: 3,
      initialGoal: 'Build it',
      lastUserMsg: 'Fix it',
      lastAssistantMsg: 'Done',
      git: { branch: 'main', lastCommit: 'abc fix' },
      recentFiles: ['a b.js']
    },
    { from: 'claude', to: 'codex', model: 'gpt-5.6-terra', tier: 'flagship' }
  );
  assert.match(brief, /^# Vibe Usage handover: Claude → Codex\n/);
  assert.match(brief, /\*\*Source model:\*\* `claude-opus-5-5` \(flagship tier\)/);
  assert.match(brief, /## 3\. Last state reported by Claude\nDone/);
  assert.match(brief, /- `a b\.js`/);
  assert.match(renderBrief({ git: {}, recentFiles: [] }, { from: null, to: 'cursor' }), /Unknown tool → Cursor[\s\S]*Not recorded/);
});

test('handover validates providers, writes the brief and starts the target', async t => {
  const [home, project, data] = await tempDirs(t, 'vibe-home-', 'vibe-proj-', 'vibe-data-');
  writeCursorChat(path.join(home, '.cursor', 'chats'), { id: 'chat-1', cwd: project, name: 'Cursor görevi', user: ['CURSOR TASK'] });
  const base = { projectDir: project, dataDir: data, snapshot: snapshot(), homeDir: home, platform: 'darwin' };
  await assert.rejects(executeHandover({ ...base, fromProvider: 'malicious; rm -rf /' }), /invalid_provider/);
  await assert.rejects(executeHandover({ ...base, toProvider: 'nope' }), /invalid_provider/);
  await assert.rejects(executeHandover({ ...base, sessionProvider: 'auto', sessionId: 'x' }), /invalid_provider/);

  const calls = [];
  const result = await executeHandover({
    ...base,
    toProvider: 'antigravity',
    targetModel: 'ignored',
    sessionId: 'chat-1',
    sessionProvider: 'cursor',
    spawnProcess: fakeSpawn(calls)
  });
  assert.deepEqual(result, { from: 'cursor', to: 'antigravity', model: null, mode: 'app' }, 'apps take no model');
  assert.deepEqual(calls, [['/usr/bin/open', '-a', 'Antigravity', project]]);
  const brief = await fs.readFile(path.join(project, HANDOVER_FILE), 'utf8');
  assert.match(brief, /Cursor → Antigravity/);
  assert.match(brief, /CURSOR TASK/);
});

test('a terminal target starts with the brief prompt and the chosen model', async t => {
  const [home, project, data] = await tempDirs(t, 'vibe-home-', 'vibe-proj-', 'vibe-data-');
  const claude = path.join(data, 'claude');
  await fs.writeFile(claude, '');
  process.env.VIBE_CLAUDE_BINARY = claude;
  t.after(() => {
    delete process.env.VIBE_CLAUDE_BINARY;
  });
  const account = {
    id: 'claude:default',
    providerId: 'claude',
    labelKey: 'accountA',
    configDir: home,
    configDirExplicit: false,
    primary: true,
    enabled: true
  };
  const calls = [];
  const result = await executeHandover({
    projectDir: project,
    dataDir: data,
    snapshot: snapshot([account]),
    toProvider: 'claude',
    targetModel: 'opus',
    homeDir: home,
    platform: 'darwin',
    spawnProcess: fakeSpawn(calls)
  });
  assert.deepEqual(result, { from: null, to: 'claude', model: 'opus', mode: 'terminal' });
  const script = await fs.readFile(calls[0][3], 'utf8');
  assert.ok(script.includes(`exec '${claude}' '--model' 'opus' '${HANDOVER_PROMPT}'`));
  assert.ok(script.includes('CLAUDE_CONFIG_DIR'), 'the default profile unsets CLAUDE_CONFIG_DIR');
});

test('smart launch starts the provider with verified quota, without a brief', async t => {
  const [project, data] = await tempDirs(t, 'vibe-proj-', 'vibe-data-');
  const state = {
    settings: {
      providerOrder: ['cursor', 'antigravity', 'claude', 'codex'],
      preferredModels: {},
      accounts: [{ id: 'antigravity:a', providerId: 'antigravity', label: 'me@example.com', primary: true, enabled: true }]
    },
    providers: [
      {
        id: 'antigravity',
        accounts: [
          {
            id: 'antigravity:a',
            status: 'ok',
            fetchedAt: new Date().toISOString(),
            windows: [{ id: 'w', scope: 'Gemini', remainingPercent: 70 }]
          }
        ]
      }
    ]
  };
  assert.deepEqual(previewSmartLaunch(state), {
    providerId: 'antigravity',
    verified: true,
    isFallback: true,
    headroomPercent: 70,
    model: null
  });
  const calls = [];
  const result = await smartLaunch({
    projectDir: project,
    dataDir: data,
    snapshot: state,
    platform: 'darwin',
    spawnProcess: fakeSpawn(calls)
  });
  assert.deepEqual(result, { to: 'antigravity', model: null, mode: 'app', verified: true });
  await assert.rejects(fs.stat(path.join(project, HANDOVER_FILE)));
});
