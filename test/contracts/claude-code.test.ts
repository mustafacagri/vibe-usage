// What the app assumes about Claude Code's and Codex's own files, checked against artifacts
// captured from a real install (Claude Code 2.1.302, on 2026-10-18): shapes kept, content
// stripped. A Claude Code upgrade that changes a shape fails here, not overnight.
//
// The corpus in test/fixtures/claude-code/ is frozen: these tests pin what was seen, and a
// recapture is a deliberate change reviewed with the tests it moves. The probe
// (`npm run probe:claude`) checks the live install the same way.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { CLAUDE_SESSION_STATUSES } from '../../src/core/claude-processes.ts';
import { isOneOf } from '../../src/shared/catalog.ts';
import {
  claudeBackgroundTasks,
  claudeLastWrittenAt,
  claudeLimitStop,
  claudeProjectDir,
  claudeSessionMode,
  claudeTranscriptWrite,
  claudeTurnEnded
} from '../../src/core/sessions.ts';
import { parseClaudeUsage } from '../../src/providers/claude.ts';
import { isAccountEligible, usableModel } from '../../src/core/selection.ts';
import { measuredAccount, tempDir } from '../helpers/fixtures.ts';

const CORPUS = path.resolve(import.meta.dirname, '..', 'fixtures', 'claude-code');
const fixture = (rel: string): string => path.join(CORPUS, rel);
const records = async (rel: string): Promise<Record<string, unknown>[]> =>
  (await fs.readFile(fixture(rel), 'utf8'))
    .split('\n')
    .filter(line => line.startsWith('{'))
    .map(line => JSON.parse(line) as Record<string, unknown>);
const json = async (rel: string): Promise<Record<string, unknown>> =>
  JSON.parse(await fs.readFile(fixture(rel), 'utf8')) as Record<string, unknown>;

const str = (value: unknown): string => (typeof value === 'string' ? value : '');
// The record at `index`, which the fixture is asserted to hold.
const at = <T>(list: readonly T[], index: number): T => {
  const item = list.at(index);
  assert.ok(item !== undefined, `record ${index}`);
  return item;
};
const kind = (r: Record<string, unknown>): string => `${str(r.type)}${typeof r.subtype === 'string' ? `/${r.subtype}` : ''}`;
// A record's text: a system record's own, or its message's.
const textOf = (r: Record<string, unknown>): string => str(r.content) || str((r.message as { content?: unknown } | undefined)?.content);

test('corpus: a usage-limit stop stands while Claude Code holds the session, until a reply follows the reset', async t => {
  const file = fixture('transcripts/limit-then-resume.jsonl');
  const seen = await records('transcripts/limit-then-resume.jsonl');
  assert.deepEqual(
    seen.map(kind),
    [
      // The stop, and Claude Code announcing it holds the session for the reset.
      'assistant',
      'system/informational',
      'system/turn_duration',
      // A background task's notice, queued and taken while holding: a user record, no reply.
      'queue-operation',
      'queue-operation',
      'user',
      // The reset: a prompt Claude Code queues itself, answered after an automatic compaction.
      'queue-operation',
      'queue-operation',
      'system/informational',
      'user',
      'last-prompt',
      'ai-title',
      'mode',
      'permission-mode',
      'atis-latch',
      'system/compact_boundary',
      'user',
      'last-prompt',
      'ai-title',
      'mode',
      'permission-mode',
      'atis-latch',
      'assistant'
    ],
    'the records Claude Code 2.1.302 writes from a limit stop to the reply after the reset'
  );
  const stop = at(seen, 0);
  assert.equal(stop.isApiErrorMessage, true);
  assert.equal(stop.apiError, 'usage_limit_reached');
  assert.equal((stop.message as { model?: unknown }).model, '<synthetic>');
  assert.equal(stop.entrypoint, 'cli');
  assert.match(
    textOf(at(seen, 1)),
    /^Usage limit reached · continuing automatically at .+ · esc to cancel$/,
    'Claude Code holds the session itself'
  );
  assert.ok(textOf(at(seen, 5)).startsWith('<task-notification>'), 'the notice taken while holding');
  assert.equal(textOf(at(seen, 8)), 'Usage limit reset · continuing automatically');
  assert.match(
    textOf(at(seen, 9)),
    /^Your claude\.ai usage limit has reset\. Continue the task/,
    'the prompt Claude Code queues at the reset'
  );
  const reply = at(seen, -1);
  assert.equal((reply.message as { model?: unknown }).model, 'claude-fable-5-1', 'the reply');

  // The stop stands at every prefix without a reply: a prompt alone is waiting.
  const dir = await tempDir(t, 'vibe-limit-');
  const stoppedAt = Date.parse(str(stop.timestamp));
  for (const [count, label] of [
    [3, 'held'],
    [6, 'a notice taken while holding'],
    [10, 'the reset prompt, not answered yet'],
    [seen.length - 1, 'compacted before the reply']
  ] as const) {
    const prefix = path.join(dir, `${count}.jsonl`);
    await fs.writeFile(
      prefix,
      `${seen
        .slice(0, count)
        .map(r => JSON.stringify(r))
        .join('\n')}\n`
    );
    assert.deepEqual(await claudeLimitStop(prefix), { stoppedAt, cwd: 'C:\\work\\app', headless: false }, label);
  }
  assert.equal(await claudeLimitStop(file), null, 'the reply after the reset means the session went on');
  assert.equal(await claudeLastWrittenAt(file), Date.parse(str(reply.timestamp)), 'the newest record time is the reply');
  assert.deepEqual(await claudeSessionMode(file), { model: 'claude-fable-5-1', permissionMode: 'auto' });
});

test('corpus: a fresh start writes mode, permission-mode and snapshots before the first prompt', async () => {
  const seen = await records('transcripts/fresh-start.head.jsonl');
  assert.deepEqual(
    seen.slice(0, 5).map(r => r.type),
    ['mode', 'permission-mode', 'file-history-snapshot', 'file-history-snapshot', 'atis-latch']
  );
  assert.equal(
    await claudeProjectDir(fixture('transcripts/fresh-start.head.jsonl')),
    'C:\\work\\app',
    'the first record with a cwd names the project'
  );
});

test('corpus: a turn that ended leaves an end_turn reply, then bookkeeping without timestamps', async () => {
  const file = fixture('transcripts/turn-end.tail.jsonl');
  const seen = await records('transcripts/turn-end.tail.jsonl');
  const last = [...seen].reverse().find(r => r.type === 'user' || r.type === 'assistant');
  assert.equal((last?.message as { stop_reason?: unknown }).stop_reason, 'end_turn');
  assert.equal(await claudeTurnEnded(file), true);
  const after = seen.slice(seen.lastIndexOf(last ?? {}) + 1);
  assert.ok(after.length > 0 && after.every(r => r.type !== 'user' && r.type !== 'assistant'), 'queue-operation and system records follow');
  const write = await claudeTranscriptWrite(file);
  assert.ok(write && Number.isFinite(write.lastRecordAt));
});

test('corpus: a session relocated into a worktree belongs to it; one whose agent wandered there does not', async () => {
  const relocated = fixture('transcripts/worktree-relocated.jsonl');
  const marks = await records('transcripts/worktree-relocated.jsonl');
  const mark = marks.find(r => r.type === 'relocated');
  assert.deepEqual(Object.keys(mark ?? {}).sort(), ['relocatedCwd', 'sessionId', 'type'], 'the relocated record’s exact shape');
  assert.equal(await claudeProjectDir(relocated), 'C:\\work\\app\\.claude\\worktrees\\task');
  assert.ok(marks.some(r => r.type === 'worktree-state'));
  const wandered = fixture('transcripts/worktree-wandered.jsonl');
  const tail = (await records('transcripts/worktree-wandered.jsonl')).at(-1);
  assert.equal(tail?.cwd, 'C:\\work\\app\\.claude\\worktrees\\task', 'later records follow the agent’s shell');
  assert.equal(await claudeProjectDir(wandered), 'C:\\work\\app', 'the session is still the project’s');
});

// A background command is named by its tool result, whether the call asked for the background
// or Claude Code moved it there when it ran past its time. It ends by a TaskStop call or by
// the notification Claude Code queues when it finishes. With neither, it is still running.
const backgroundTask = async (rel: string): Promise<{ seen: Record<string, unknown>[]; taskId: string; asked: boolean }> => {
  const seen = await records(rel);
  const parts = (at(seen, 0).message as { content?: { type?: string; input?: { run_in_background?: unknown } }[] }).content ?? [];
  const asked = parts.some(p => p.type === 'tool_use' && p.input?.run_in_background === true);
  const result = at(seen, 1);
  const resultParts = (result.message as { content?: { content?: unknown }[] }).content ?? [];
  const moved = resultParts.some(p => str(p.content).includes('moved to the background (ID: '));
  assert.ok(asked !== moved, `${rel}: the call asked for the background, or the result says it was moved there`);
  const taskId = (result.toolUseResult as { backgroundTaskId?: unknown }).backgroundTaskId;
  assert.equal(typeof taskId, 'string', `${rel}: the result names the task`);
  return { seen, taskId: String(taskId), asked };
};

test('corpus: a background command is named by its result; TaskStop or its notification ends it', async t => {
  const { seen: stopped, taskId: stoppedId } = await backgroundTask('transcripts/background-task-stopped.jsonl');
  const stopParts = (at(stopped, 2).message as { content?: { name?: string; input?: { task_id?: unknown } }[] }).content ?? [];
  assert.ok(
    stopParts.some(p => p.name === 'TaskStop' && p.input?.task_id === stoppedId),
    'TaskStop names the task'
  );
  assert.deepEqual(await claudeBackgroundTasks(fixture('transcripts/background-task-stopped.jsonl')), [], 'stopped: nothing left running');

  // A finished command's notification is queued (the enqueue record names the task), then
  // dequeued and taken as a prompt when the session is idle, or removed (that record names it
  // too) and attached to the turn it is busy with.
  const dir = await tempDir(t, 'vibe-bg-');
  for (const [rel, wasAsked, named] of [
    ['transcripts/background-task-notified.jsonl', true, ['queue-operation', 'user']],
    ['transcripts/background-task-attached.jsonl', false, ['queue-operation', 'queue-operation', 'attachment']]
  ] as const) {
    const { seen, taskId, asked } = await backgroundTask(rel);
    assert.equal(asked, wasAsked, rel);
    const queued = at(seen, 2);
    assert.equal(kind(queued), 'queue-operation');
    assert.equal(queued.operation, 'enqueue');
    assert.equal(kind(at(seen, -1)), named.at(-1), `${rel}: how the notification is delivered`);
    const naming = seen.slice(2).filter(r => JSON.stringify(r).includes(`<task-id>${taskId}</task-id>`));
    assert.deepEqual(naming.map(kind), named, `${rel}: the records naming the task`);
    assert.deepEqual(await claudeBackgroundTasks(fixture(rel)), [], `${rel}: finished, nothing left running`);

    // Cut after the call and its result, the task is still running, with its command; cut after
    // the enqueue, it has finished: the notification exists because the command exited.
    const cut = async (count: number): Promise<string> => {
      const file = path.join(dir, `${path.basename(rel, '.jsonl')}-${count}.jsonl`);
      await fs.writeFile(
        file,
        `${seen
          .slice(0, count)
          .map(r => JSON.stringify(r))
          .join('\n')}\n`
      );
      return file;
    };
    const tasks = await claudeBackgroundTasks(await cut(2));
    assert.equal(tasks.length, 1, `${rel}: running`);
    assert.equal(at(tasks, 0).id, taskId);
    assert.ok(at(tasks, 0).command, 'the command it runs is known');
    assert.deepEqual(await claudeBackgroundTasks(await cut(3)), [], `${rel}: ended at the enqueue`);
  }
});

test('corpus: a subagent’s limit record is a sidechain record, never a stop of the session', async () => {
  const seen = await records('transcripts/subagent-limit.jsonl');
  assert.ok(seen.every(r => r.isSidechain === true));
  assert.ok(seen.some(r => r.apiError === 'usage_limit_reached'));
  assert.equal(await claudeLimitStop(fixture('transcripts/subagent-limit.jsonl')), null);
});

test('corpus: an idle process writes an away summary with a timestamp; it counts as written', async () => {
  const record = at(await records('transcripts/away-summary.jsonl'), 0);
  assert.equal(record.type, 'system');
  assert.equal(record.subtype, 'away_summary');
  assert.ok(Number.isFinite(Date.parse(str(record.timestamp))));
});

test('corpus: a listed process records its pid, session, status, start and exact system start', async () => {
  const entries = await records('sessions/listed.jsonl');
  assert.ok(entries.length > 0);
  for (const entry of entries) {
    assert.equal(typeof entry.pid, 'number');
    assert.equal(typeof entry.sessionId, 'string');
    assert.equal(typeof entry.startedAt, 'number');
    assert.match(String(entry.procStart), /^\d+$/, 'Windows file-time ticks');
    assert.ok(entry.status === undefined || isOneOf(CLAUDE_SESSION_STATUSES, entry.status));
    assert.ok(['cli', 'sdk-cli'].includes(String(entry.entrypoint)));
    assert.equal(entry.kind, 'interactive');
  }
  const keys = (await json('sessions/key-names.json')) as unknown as string[];
  assert.ok(
    keys.every(name => /^\d+\.<sha256>\.key$/.test(name)),
    'every process leaves <pid>.<hash>.key'
  );
});

test('corpus: the usage response of a team plan has no weekly limit; a pro plan’s weekly row binds while inactive', async () => {
  const team = parseClaudeUsage(await json('usage/team.json'));
  assert.deepEqual(
    team.windows.map(w => w.id).filter(id => !id.startsWith('limit:')),
    ['five_hour'],
    'seven_day: null with no weekly entry in limits is left out'
  );
  const scoped = team.windows.find(w => w.id.startsWith('limit:weekly_scoped'));
  assert.ok(scoped, 'the model-scoped weekly row');
  assert.equal(scoped.active, false, 'reported inactive: it is not the headline row');
  const account = measuredAccount({ status: 'ok', fetchedAt: new Date().toISOString(), windows: team.windows });
  assert.equal(
    isAccountEligible(account, { model: 'fable' }),
    scoped.remainingPercent !== null && scoped.remainingPercent > 5,
    'inactive still binds for its model'
  );
  assert.deepEqual(usableModel(account, 'opus'), { model: 'opus' });
  const pro = parseClaudeUsage(await json('usage/pro.json'));
  assert.ok(
    pro.windows.some(w => w.id === 'seven_day'),
    'a pro plan reports its weekly limit'
  );
});

test('corpus: credentials and the state file keep the keys the app reads', async () => {
  const shape = (await json('credentials-shape.json')) as { claudeAiOauth?: Record<string, unknown> };
  assert.deepEqual(
    ['accessToken', 'refreshToken', 'expiresAt', 'refreshTokenExpiresAt'].map(k => shape.claudeAiOauth?.[k]),
    ['string', 'string', 'number', 'number']
  );
  for (const label of ['team', 'pro']) {
    const state = (await json(`state/${label}-keys.json`)) as {
      keys: string[];
      project: Record<string, unknown> | string;
      oauthAccount: Record<string, unknown>;
    };
    assert.ok(state.keys.includes('hasCompletedOnboarding'));
    assert.ok(state.keys.includes('projects'));
    assert.equal(state.oauthAccount.emailAddress, 'string');
    if (typeof state.project === 'object') assert.equal(state.project.hasTrustDialogAccepted, 'boolean');
  }
});

test('corpus: Codex session metadata names its source: desktop, exec, or a subagent', async () => {
  const metas = await records('codex/session-meta.jsonl');
  const sources = metas.map(m => (m.payload as { source?: unknown }).source);
  assert.ok(sources.includes('vscode'), 'the desktop app');
  assert.ok(sources.includes('exec'), 'codex exec');
  assert.ok(
    sources.some(s => typeof s === 'object' && s !== null && 'subagent' in s),
    'a subagent'
  );
});

// The machine texts the app's parsers match, the only long strings a capture may keep; every
// other text is a placeholder. A task notification keeps its ids, file and status, nothing said.
const MACHINE_TEXTS = [
  /^Command running in background with ID: \S+\. Output is being written to: [^\n]+\.output\.$/,
  /^Command did not complete within its \d+s timeout and was moved to the background \(ID: \S+\)\. Output is being written to: [^\n]+\.output\.$/,
  /^<task-notification>\n(<(task-id|tool-use-id|output-file|status)>[^<\n]*<\/\2>\n)*(<(summary|result)>\[\4\]<\/\4>\n)*<\/task-notification>$/,
  // The prompt Claude Code queues itself at the reset.
  /^Your claude\.ai usage limit has reset\. Continue the task you were working on when the limit was reached; do not repeat work that is already complete\.$/
];
const LONG_TEXT = 120;
const strings = (value: unknown, at: string): [string, string][] => {
  if (typeof value === 'string') return [[at, value]];
  if (Array.isArray(value)) return value.flatMap((item, i) => strings(item, `${at}[${i}]`));
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([k, v]) => strings(v, `${at}.${k}`));
  return [];
};

const walk = async (d: string): Promise<string[]> =>
  (
    await Promise.all(
      (await fs.readdir(d, { withFileTypes: true })).map(async e => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]))
    )
  ).flat();

// A capture is checked against fixed privacy rules, never the runner's home directory or
// signed-in accounts. Live-install inspection belongs to the opt-in probe, not npm test.
const assertNoIdentifiers = (text: string, rel: string): void => {
  // Paths may be JSON-escaped. Only the corpus's synthetic home name is allowed.
  assert.doesNotMatch(text, /sk-ant-|[\\/]+(?:Users|home)[\\/]+(?![\\/]|me\b)/, rel);
  assert.doesNotMatch(text, /[A-Za-z0-9+_-]{80,}/, `${rel}: a token-sized string`);
  assert.doesNotMatch(text, /"(?:accessToken|refreshToken)"\s*:\s*"(?!string")[^"]+"/, `${rel}: a credential value`);
  for (const address of text.matchAll(/[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})/gi))
    assert.match(address[1] ?? '', /^(?:example\.(?:com|org|net|test)|[^.]+\.example)$/i, `${rel}: a non-fixture email`);
};

test('corpus privacy checks reject synthetic personal data without reading local credentials', () => {
  for (const value of [
    '/home/synthetic-person/project',
    String.raw`C:\Users\synthetic-person\project`,
    'person@private.invalid',
    JSON.stringify({ accessToken: 'fake-token-value' }),
    JSON.stringify({ refreshToken: 'fake-refresh-value' }),
    'z'.repeat(81)
  ])
    assert.throws(() => {
      assertNoIdentifiers(value, 'synthetic capture');
    });
  assertNoIdentifiers('/home/me/project person@example.test "accessToken": "string"', 'sanitized capture');
  // Ordinary identifiers such as a root variable must not depend on the OS username.
  assertNoIdentifiers('const root = "fixture";', 'source');
});

test('corpus: the capture holds nothing personal: no identifiers, no prose', async () => {
  for (const file of await walk(CORPUS)) {
    const rel = path.relative(CORPUS, file);
    const text = await fs.readFile(file, 'utf8');
    assertNoIdentifiers(text, rel);
    const values = file.endsWith('.jsonl')
      ? text
          .split('\n')
          .filter(line => line.startsWith('{'))
          .flatMap((line, i) => strings(JSON.parse(line), `${i + 1}`))
      : strings(JSON.parse(text), '');
    for (const [at, value] of values)
      if (value.length >= LONG_TEXT)
        assert.ok(
          MACHINE_TEXTS.some(shape => shape.test(value)),
          `${rel} ${at}: a long text that is not one of the machine texts (${value.length} chars)`
        );
  }
});
