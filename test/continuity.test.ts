import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import type { LiveClaudeSession, OpenClaudeSession } from '../src/core/claude-processes.ts';
import {
  carryClaudeSession,
  createContinuity,
  continueSession,
  holdsUnsavedConversation,
  findRecentSession,
  findStoppedSession,
  RESTART_PROMPT,
  RESUME_PROMPT,
  RETURN_PROMPT,
  RETURN_TASK_WAIT_MS,
  type ContinueResult,
  type ContinuityOptions
} from '../src/core/continuity.ts';
import { AppError } from '../src/core/errors.ts';
import { isObject } from '../src/core/files.ts';
import { createQuotaWatch } from '../src/core/glance.ts';
import { RESUME_WITHOUT_QUESTION } from '../src/core/launch.ts';
import { chooseSuccessor, type Successor } from '../src/core/selection.ts';
import { claudeLimitStop, codexLimitStop, type BackgroundTask, type RecentSession, type StoppedSession } from '../src/core/sessions.ts';
import { defaultSettings } from '../src/core/settings.ts';
import { PROVIDER_IDS, type ProviderId } from '../src/shared/catalog.ts';
import type { Account, AutoContinue, MeasuredAccount, ReopenAfterRestart, ReturnToPrimary, Snapshot } from '../src/shared/types.ts';
import { account, codexRollout, fakeSpawn, measuredAccount, quotaWindow, tempDir, writeCursorChat } from './helpers/fixtures.ts';

const NOW = Date.parse('2026-10-17T12:00:00.000Z');
const MINUTE = 60 * 1000;

const claudeA = account({ id: 'claude:a', configDir: '/profiles/a', primary: true });
const claudeB = account({ id: 'claude:b', configDir: '/profiles/b', primary: false });
const claudeC = account({ id: 'claude:c', configDir: '/profiles/c', primary: false });
const codex = account({ id: 'codex:default', providerId: 'codex', primary: true });

function reading(base: Account, remaining: number): MeasuredAccount {
  return measuredAccount({
    ...base,
    fetchedAt: new Date(NOW).toISOString(),
    windows: [quotaWindow({ id: 'five_hour', remainingPercent: remaining, usedPercent: 100 - remaining })]
  });
}

function snapshot(readings: MeasuredAccount[], autoContinue: AutoContinue = 'off'): Snapshot {
  const ids: ProviderId[] = [...PROVIDER_IDS];
  return {
    refreshing: false,
    settings: { ...defaultSettings(), autoContinue, accounts: [claudeA, claudeB, claudeC, codex] },
    providers: ids.map(id => ({ id, status: 'ok', accounts: readings.filter(r => r.providerId === id) }))
  };
}

const session = (fields: Partial<StoppedSession> = {}): StoppedSession => ({
  providerId: 'claude',
  sessionId: 'session-1',
  projectDir: '/work/app',
  updatedAt: NOW - 2 * MINUTE,
  file: '/profiles/a/projects/-work-app/session-1.jsonl',
  stoppedAt: NOW - 2 * MINUTE,
  ...fields
});

test('work goes to the roomiest other account with real room, then to other tools when allowed', () => {
  const state = snapshot([reading(claudeA, 0), reading(claudeB, 40), reading(claudeC, 90), reading(codex, 90)]);
  assert.deepEqual(
    chooseSuccessor(state, claudeA, 'accounts', { now: NOW }),
    { providerId: 'claude', account: claudeC },
    'most room, not primary first'
  );
  const nearlyOut = snapshot([reading(claudeA, 0), reading(claudeB, 8), reading(claudeC, 2), reading(codex, 90)]);
  assert.equal(chooseSuccessor(nearlyOut, claudeA, 'accounts', { now: NOW }), null, '8% would run out again within minutes');
  assert.deepEqual(chooseSuccessor(nearlyOut, claudeA, 'tools', { now: NOW }), { providerId: 'codex', account: codex });
  const nobody = snapshot([reading(claudeA, 0), reading(claudeB, 8), reading(claudeC, 2), reading(codex, 10)]);
  assert.equal(chooseSuccessor(nobody, claudeA, 'tools', { now: NOW }), null);
});

test('a stop is read from the transcript: the tool’s own usage-limit error as the last turn', async t => {
  const dir = await tempDir(t, 'vibe-stop-');
  const write = async (name: string, records: object[]) => {
    const file = path.join(dir, name);
    await fs.writeFile(file, records.map(r => JSON.stringify(r)).join('\n'));
    return file;
  };
  const limit = {
    type: 'assistant',
    isApiErrorMessage: true,
    error: 'rate_limit',
    apiError: 'usage_limit_reached',
    isSidechain: false,
    cwd: '/work/app',
    timestamp: '2026-10-17T11:58:00.000Z',
    message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: "You've hit your session limit · resets 4pm" }] }
  };
  const prompt = { type: 'user', isSidechain: false, cwd: '/work/app', message: { role: 'user', content: 'go on' } };
  assert.deepEqual(claudeLimitStop(await write('stopped.jsonl', [prompt, limit, { type: 'pr-link', prNumber: 1 }])), {
    stoppedAt: Date.parse('2026-10-17T11:58:00.000Z'),
    cwd: '/work/app',
    headless: false
  });
  assert.equal(
    claudeLimitStop(await write('headless.jsonl', [prompt, { ...limit, entrypoint: 'sdk-cli' }]))?.headless,
    true,
    'a run started by a program is told apart'
  );
  const reply = {
    type: 'assistant',
    isSidechain: false,
    cwd: '/work/app',
    message: { role: 'assistant', model: 'claude-opus-5-5', content: [] }
  };
  assert.equal(
    claudeLimitStop(await write('prompted.jsonl', [limit, prompt]))?.stoppedAt,
    Date.parse('2026-10-17T11:58:00.000Z'),
    'a prompt alone is waiting: a queued notice Claude Code takes while holding for the reset, or one not answered yet'
  );
  assert.equal(
    claudeLimitStop(await write('resumed.jsonl', [limit, prompt, reply])),
    null,
    'a reply after the limit means the session went on'
  );
  assert.equal(claudeLimitStop(await write('overloaded.jsonl', [prompt, { ...limit, apiError: 'overloaded', message: {} }])), null);
  assert.equal(
    claudeLimitStop(await write('subagent.jsonl', [prompt, { ...limit, isSidechain: true }])),
    null,
    'only the main thread counts'
  );

  const event = (type: string, extra: object = {}) => ({
    timestamp: '2026-10-17T11:59:00.000Z',
    type: 'event_msg',
    payload: { type, ...extra }
  });
  const exceeded = event('task_complete', { error: { message: 'You’ve hit your usage limit.', codex_error_info: 'usage_limit_exceeded' } });
  assert.deepEqual(codexLimitStop(await write('codex-stopped.jsonl', [event('task_started'), exceeded])), {
    stoppedAt: Date.parse('2026-10-17T11:59:00.000Z')
  });
  assert.equal(codexLimitStop(await write('codex-resumed.jsonl', [exceeded, event('task_started')])), null);
  assert.equal(codexLimitStop(await write('codex-done.jsonl', [exceeded, event('task_complete')])), null);
});

test('touching or restoring a transcript cannot make an ancient or future usage stop current', async t => {
  const home = await tempDir(t, 'vibe-stop-event-time-');
  for (const providerId of ['claude', 'codex'] as const) {
    const configDir = path.join(home, providerId);
    const holder = account({ id: `${providerId}:clock`, providerId, configDir });
    const id = '0199a213-81c0-7800-8aa1-bbab2a035a99';
    const file =
      providerId === 'claude'
        ? path.join(configDir, 'projects', '-work-app', `${id}.jsonl`)
        : path.join(configDir, 'sessions', `rollout-2026-10-17-${id}.jsonl`);
    await fs.mkdir(path.dirname(file), { recursive: true });
    for (const [age, expected] of [
      [7 * 24 * 60 * MINUTE, false],
      [-60 * MINUTE, false],
      [2 * MINUTE, true]
    ] as const) {
      const timestamp = new Date(NOW - age).toISOString();
      const body =
        providerId === 'claude'
          ? [
              { type: 'user', cwd: '/work/app', message: { content: 'Continue the task' } },
              {
                type: 'assistant',
                cwd: '/work/app',
                timestamp,
                isApiErrorMessage: true,
                apiError: 'usage_limit_reached',
                message: { model: '<synthetic>', content: 'Usage limit' }
              }
            ]
              .map(record => JSON.stringify(record))
              .join('\n')
          : `${codexRollout({ id, cwd: '/work/app', user: ['Continue the task'] })}\n${JSON.stringify({ type: 'event_msg', timestamp, payload: { type: 'task_complete', error: { codex_error_info: 'usage_limit_exceeded' } } })}`;
      await fs.writeFile(file, body);
      await fs.utimes(file, new Date(NOW), new Date(NOW));
      assert.equal(Boolean(await findStoppedSession(holder, home, NOW)), expected, `${providerId}: event age ${age}ms, fresh file mtime`);
    }
  }
});

test('stop freshness is rechecked at observation and acceptance using the event time', async t => {
  const state = snapshot([reading(claudeA, 0), reading(claudeB, 80)], 'accounts');
  const ancient = await harness(t, { stopped: { [claudeA.id]: session({ updatedAt: NOW, stoppedAt: NOW - 7 * 24 * 60 * MINUTE }) } });
  assert.deepEqual(await ancient.continuity.observe(state, { low: [] }), []);
  assert.equal(ancient.started.length, 0);
  let now = NOW;
  const offered = await harness(t, { stopped: { [claudeA.id]: session() }, clock: () => now });
  const manual = { ...state, settings: { ...state.settings, autoContinue: 'off' as const } };
  await offered.continuity.observe(manual, { low: [] });
  const suggestion = offered.continuity.suggestions()[0];
  assert.ok(suggestion);
  now += 31 * MINUTE;
  await assert.rejects(offered.continuity.accept(suggestion.id, manual), /suggestion_expired/);
  assert.equal(offered.started.length, 0, 'an offer cannot outlive the stop it was made for');
});

test('a Claude Code session moves to the other profile whole and goes on by itself there', async t => {
  const root = await tempDir(t, 'vibe-continue-');
  const project = path.join(root, 'project');
  const slug = 'C--work-project';
  const from = path.join(root, '.claude', 'projects', slug);
  await fs.mkdir(path.join(from, 'session-1', 'subagents'), { recursive: true });
  await fs.mkdir(project);
  await fs.writeFile(path.join(from, 'session-1.jsonl'), `${JSON.stringify({ type: 'user', cwd: project })}\n`);
  await fs.writeFile(path.join(from, 'session-1', 'subagents', 'agent.jsonl'), '{}\n');
  // The project's memory goes along; what the other profile already keeps there stays.
  await fs.mkdir(path.join(from, 'memory'));
  await fs.writeFile(path.join(from, 'memory', 'MEMORY.md'), 'rules\n');
  await fs.writeFile(path.join(from, 'memory', 'facts.md'), 'facts\n');
  const theirs = path.join(root, '.claude-2', 'projects', slug, 'memory');
  await fs.mkdir(theirs, { recursive: true });
  await fs.writeFile(path.join(theirs, 'MEMORY.md'), 'their rules\n');
  const binary = path.join(root, 'claude');
  await fs.writeFile(binary, '');
  process.env.VIBE_CLAUDE_BINARY = binary;
  t.after(() => {
    delete process.env.VIBE_CLAUDE_BINARY;
  });
  const target = account({ id: 'claude:b', configDir: path.join(root, '.claude-2'), primary: false });
  const calls: string[][] = [];
  const result = await continueSession(
    session({ projectDir: project, file: path.join(from, 'session-1.jsonl') }),
    { providerId: 'claude', account: target },
    snapshot([]),
    { dataDir: root, homeDir: root, platform: 'darwin', spawnProcess: fakeSpawn(calls) },
    { prompt: RESUME_PROMPT }
  );
  assert.deepEqual(result, { to: 'claude', accountId: 'claude:b', resumed: true, mode: 'terminal', tab: null });
  const carried = path.join(root, '.claude-2', 'projects', slug);
  assert.equal(await fs.readFile(path.join(carried, 'session-1.jsonl'), 'utf8'), `${JSON.stringify({ type: 'user', cwd: project })}\n`);
  assert.equal(await fs.readFile(path.join(carried, 'session-1', 'subagents', 'agent.jsonl'), 'utf8'), '{}\n');
  assert.equal(await fs.readFile(path.join(carried, 'memory', 'facts.md'), 'utf8'), 'facts\n', 'memory carried');
  assert.equal(await fs.readFile(path.join(carried, 'memory', 'MEMORY.md'), 'utf8'), 'their rules\n', 'theirs kept');
  const script = await fs.readFile(calls[0]?.at(-1) ?? '', 'utf8');
  assert.ok(script.includes(`export CLAUDE_CODE_RESUME_THRESHOLD_MINUTES='${RESUME_WITHOUT_QUESTION}'`), 'no resume question unattended');
  assert.ok(script.includes(`export CLAUDE_CONFIG_DIR='${target.configDir ?? ''}'`));
  assert.ok(script.endsWith(`exec '${binary}' '--resume' 'session-1' '${RESUME_PROMPT.replaceAll("'", `'\\''`)}'\n`));
});

// A continuity over a temporary data folder, with sessions found and starts recorded.
async function harness(
  t: TestContext,
  {
    recent = {},
    stopped = {},
    running = {},
    open = {},
    tasks = [],
    clock = () => NOW,
    resumed = true,
    fails = () => false,
    historyCap,
    dataDir,
    options = {}
  }: {
    recent?: Record<string, RecentSession>;
    // Each account's stopped session, or its several stopped sessions.
    stopped?: Record<string, StoppedSession | StoppedSession[]>;
    // The live process of each account's copy of a session.
    running?: Record<string, LiveClaudeSession | 'unknown'>;
    // The interactive sessions open in each account's profile.
    open?: Record<string, OpenClaudeSession[] | 'unknown'>;
    tasks?: BackgroundTask[];
    clock?: () => number;
    // Whether the fake moves continue sessions whole (else from a brief).
    resumed?: boolean;
    // Whether the nth start (from 1) fails.
    fails?: (n: number) => boolean;
    historyCap?: number;
    dataDir?: string;
    options?: Pick<ContinuityOptions, 'getCurrentSnapshot' | 'findOpen' | 'findRunning'>;
  } = {}
) {
  const started: {
    session: RecentSession;
    to: Successor;
    prompt: string | undefined;
    running: LiveClaudeSession | null;
    tab: string | null;
  }[] = [];
  const continuity = await createContinuity({
    homeDir: '/home/me',
    dataDir: dataDir ?? (await tempDir(t, 'vibe-continuity-')),
    launch: { dataDir: '/data' },
    clock,
    ...(historyCap === undefined ? {} : { historyCap }),
    findSession: target => Promise.resolve(recent[target.id] ?? null),
    findStopped: target => Promise.resolve([stopped[target.id] ?? []].flat()),
    findRunning: (target, sessionId) => {
      const process = running[target.id];
      if (process === 'unknown') return Promise.resolve({ kind: 'unknown', reason: 'timed out' });
      return Promise.resolve(process?.sessionId === sessionId ? { kind: 'found', process } : { kind: 'none' });
    },
    findTasks: () => Promise.resolve(tasks),
    findOpen: target => {
      const sessions = open[target.id];
      return sessions === 'unknown' ? Promise.reject(new Error('timed out')) : Promise.resolve(sessions ?? []);
    },
    ...options,
    start: (moved, to, _state, _context, options): Promise<ContinueResult> => {
      started.push({ session: moved, to, prompt: options?.prompt, running: options?.running ?? null, tab: options?.tab ?? null });
      if (fails(started.length)) return Promise.reject(new AppError('launch_failed'));
      const tab = `/data/tabs/${moved.sessionId}-${started.length}.json`;
      return Promise.resolve({ to: to.providerId, accountId: to.account?.id ?? null, resumed, mode: 'terminal', tab });
    }
  });
  return { continuity, started };
}

test('queued observations read settings and quota alerts only when their serialized work starts', { timeout: 10_000 }, async t => {
  const scanning = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  let firstScan = true;
  const { continuity, started } = await harness(t, {
    stopped: { [claudeA.id]: session() },
    options: {
      findOpen: async () => {
        if (firstScan) {
          firstScan = false;
          scanning.resolve(undefined);
          await release.promise;
        }
        return [];
      }
    }
  });
  const first = continuity.observe(snapshot([]), { low: [] });
  await scanning.promise;
  let current = snapshot([reading(claudeA, 0), reading(claudeB, 80)], 'accounts');
  let supplierCalls = 0;
  const alertsSettings: AutoContinue[] = [];
  const queued = continuity.observe(
    () => {
      supplierCalls++;
      return Promise.resolve(current);
    },
    {
      low: state => {
        alertsSettings.push(state.settings.autoContinue);
        return [];
      }
    }
  );
  assert.equal(supplierCalls, 0, 'settings are not captured before an earlier observation finishes');
  current = { ...current, settings: { ...current.settings, autoContinue: 'off' } };
  release.resolve(undefined);
  await first;
  const notices = await queued;
  assert.equal(supplierCalls, 1);
  assert.deepEqual(alertsSettings, ['off']);
  assert.deepEqual(
    notices.map(notice => notice.kind),
    ['suggested']
  );
  assert.equal(started.length, 0, 'turning automation off while queued cannot start an agent');
});

test('settings changed during process preflight stop automation without losing an explicit manual choice', { timeout: 10_000 }, async t => {
  const checking = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  let lookups = 0;
  let current = snapshot([reading(claudeA, 0), reading(claudeB, 80)], 'accounts');
  const dataDir = await tempDir(t, 'vibe-dispatch-settings-');
  const { continuity, started } = await harness(t, {
    dataDir,
    stopped: { [claudeA.id]: session() },
    options: {
      getCurrentSnapshot: () => Promise.resolve(current),
      findRunning: async () => {
        if (++lookups === 2) {
          checking.resolve(undefined);
          await release.promise;
        }
        return { kind: 'none' };
      }
    }
  });
  const observing = continuity.observe(current, { low: [] });
  await checking.promise;
  const durable = JSON.parse(await fs.readFile(path.join(dataDir, 'continuity.json'), 'utf8')) as { transitions: { status: string }[] };
  assert.equal(durable.transitions[0]?.status, 'dispatching', 'the intent was durable before process preflight');
  current = { ...current, settings: { ...current.settings, autoContinue: 'off' } };
  release.resolve(undefined);
  const notices = await observing;
  assert.deepEqual(
    notices.map(notice => notice.kind),
    ['suggested']
  );
  assert.equal(started.length, 0);
  assert.equal(continuity.transitions()[0]?.status, 'offered', 'an unstarted action is not recorded as a failed launch');
  const suggestion = continuity.suggestions()[0];
  assert.ok(suggestion);
  await continuity.accept(suggestion.id, current);
  assert.equal(started.length, 1, 'autoContinue off still permits the user to accept a suggestion');
});

test('dispatch rejects source, destination and model routing changes made during process preflight', { timeout: 10_000 }, async t => {
  for (const changed of ['source profile', 'target profile', 'target credential selector', 'target model'] as const) {
    const checking = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    let lookups = 0;
    let current = snapshot([reading(claudeA, 0), reading(claudeB, 80)], 'accounts');
    const { continuity, started } = await harness(t, {
      stopped: { [claudeA.id]: session() },
      options: {
        getCurrentSnapshot: () => Promise.resolve(current),
        findRunning: async () => {
          if (++lookups === 2) {
            checking.resolve(undefined);
            await release.promise;
          }
          return { kind: 'none' };
        }
      }
    });
    const observing = continuity.observe(current, { low: [] });
    await checking.promise;
    current = {
      ...current,
      settings: {
        ...current.settings,
        accounts: current.settings.accounts.map(account => {
          if (changed === 'source profile' && account.id === claudeA.id) return { ...account, configDir: '/profiles/replaced-source' };
          if (changed === 'target profile' && account.id === claudeB.id) return { ...account, configDir: '/profiles/replaced-target' };
          if (changed === 'target credential selector' && account.id === claudeB.id) return { ...account, configDirExplicit: true };
          return account;
        }),
        ...(changed === 'target model'
          ? {
              projectPreferences: [
                { projectDir: '/work/app', tool: 'claude' as const, model: 'claude-opus-5-5', autoContinue: 'inherit' as const }
              ]
            }
          : {})
      }
    };
    release.resolve(undefined);
    await observing;
    assert.equal(started.length, 0, `${changed}: the durable intent cannot silently change its routing`);
    assert.equal(continuity.transitions()[0]?.status, 'offered', `${changed}: a fresh user decision remains possible`);
  }
});

test('quitting during preflight prevents the queued action from launching', { timeout: 10_000 }, async t => {
  const checking = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  let lookups = 0;
  const current = snapshot([reading(claudeA, 0), reading(claudeB, 80)], 'accounts');
  const { continuity, started } = await harness(t, {
    stopped: { [claudeA.id]: session() },
    options: {
      findRunning: async () => {
        if (++lookups === 2) {
          checking.resolve(undefined);
          await release.promise;
        }
        return { kind: 'none' };
      }
    }
  });
  const observing = continuity.observe(current, { low: [] });
  await checking.promise;
  continuity.quit();
  release.resolve(undefined);
  assert.deepEqual(await observing, []);
  assert.equal(started.length, 0);
  assert.deepEqual(await continuity.observe(current, { low: [] }), []);
});

const live = (fields: Partial<LiveClaudeSession> = {}): LiveClaudeSession => ({
  pid: 4242,
  sessionId: 'session-1',
  listed: true,
  status: 'idle',
  statusSince: NOW - 10 * MINUTE,
  startedAt: NOW - 60 * MINUTE,
  procStart: null,
  ...fields
});

// The second account with a real profile folder holding its copy of session-1.
// A transcript whose last record is ten minutes old: idle, by what it says about itself.
const IDLE_TRANSCRIPT = `${JSON.stringify({ type: 'user', timestamp: new Date(NOW - 10 * MINUTE).toISOString(), message: { role: 'user', content: 'go' } })}\n`;

async function movedCopy(t: TestContext, prefix: string, transcript = IDLE_TRANSCRIPT) {
  const profiles = await tempDir(t, prefix);
  const second = account({ id: 'claude:b', configDir: path.join(profiles, 'b'), primary: false });
  const copy = path.join(profiles, 'b', 'projects', '-work-app', 'session-1.jsonl');
  await fs.mkdir(path.dirname(copy), { recursive: true });
  await fs.writeFile(copy, transcript);
  const old = new Date(NOW - 10 * MINUTE);
  await fs.utimes(copy, old, old);
  const state = (remainingA: number, returnToPrimary: ReturnToPrimary, at = NOW): Snapshot => {
    const fresh = (measured: MeasuredAccount) => ({ ...measured, fetchedAt: new Date(at).toISOString() });
    const base = snapshot([fresh(reading(claudeA, remainingA)), fresh(reading(second, 80))], 'accounts');
    return { ...base, settings: { ...base.settings, returnToPrimary, accounts: [claudeA, second] } };
  };
  return { copy, state };
}

test('a moved session is not started again from where it left, and its process there is ended', async t => {
  const { state } = await movedCopy(t, 'vibe-moved-');
  const out = state(0, 'ask');
  const current = { id: 'b1', command: 'npm test', outputFile: '/tmp/b1.output', startedAt: NOW - 5 * MINUTE };
  const earlier = { id: 'b0', command: 'old', outputFile: null, startedAt: NOW - 90 * MINUTE };
  const stopped = { 'claude:a': [session()] };
  const { continuity, started } = await harness(t, { stopped, running: { 'claude:a': live() }, tasks: [earlier, current] });
  await continuity.observe(out, { low: [] });
  const [first] = started;
  assert.ok(first);
  assert.equal(first.running?.pid, 4242, 'the stopped process is handed over to be ended');
  assert.ok(first.prompt?.startsWith(RESUME_PROMPT));
  assert.ok(first.prompt?.includes('b1 (npm test, output: /tmp/b1.output)'), 'its background commands are named');
  assert.ok(!first.prompt?.includes('b0'), 'not those of an earlier process');
  // The user typed on in the old tab and hit the limit again: the copy elsewhere goes on alone.
  stopped['claude:a'] = [session({ stoppedAt: NOW - MINUTE })];
  assert.deepEqual(await continuity.observe(out, { low: [] }), []);
  assert.equal(started.length, 1);
});

test('back on the main account: offered, or on its own once idle and quiet, in the tab it ran in', async t => {
  const { copy, state } = await movedCopy(t, 'vibe-return-');
  let now = NOW;
  const running: Record<string, LiveClaudeSession> = { 'claude:b': live({ status: 'busy' }) };
  const tasks: BackgroundTask[] = [];
  const { continuity, started } = await harness(t, { stopped: { 'claude:a': [session()] }, running, tasks, clock: () => now });
  await continuity.observe(state(0, 'auto'), { low: [] });
  assert.equal(started.length, 1, 'moved off the main account');

  const [offer] = await continuity.observe(state(100, 'ask'), { low: [] });
  assert.equal(offer?.kind === 'suggested' && offer.suggestion.id, 'return:claude:session-1');
  assert.equal(await continuity.isRunning('return:claude:session-1'), true, 'its agent is busy');

  assert.deepEqual(await continuity.observe(state(100, 'auto'), { low: [] }), [], 'busy: it waits');
  running['claude:b'] = live({ startedAt: NOW - 20 * MINUTE });
  tasks.push({ id: 'b9', command: 'npm run build', outputFile: null, startedAt: NOW - 5 * MINUTE });
  assert.deepEqual(await continuity.observe(state(100, 'auto'), { low: [] }), [], 'a background command still runs');
  now += RETURN_TASK_WAIT_MS;
  const [returned] = await continuity.observe(state(100, 'auto', now), { low: [] });
  assert.equal(returned?.kind, 'returned');
  const back = started[1];
  assert.ok(back);
  assert.equal(back.to.account?.id, 'claude:a');
  assert.equal(back.session.file, copy, 'the copy where it ran goes back');
  assert.equal(back.running?.pid, 4242);
  assert.equal(back.tab, '/data/tabs/session-1-1.json', 'in the tab it ran in');
  assert.ok(back.prompt?.startsWith(RETURN_PROMPT) && back.prompt.includes('b9 (npm run build)'), 'told what is still running');
  assert.deepEqual(await continuity.observe(state(100, 'auto', now), { low: [] }), [], 'home: nothing more to do');
});

test('return-to-primary changed to ask during its final preflight leaves a manual offer', { timeout: 10_000 }, async t => {
  const { state } = await movedCopy(t, 'vibe-return-settings-');
  const checking = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  let returning = false;
  let lookups = 0;
  let current = state(0, 'auto');
  const { continuity, started } = await harness(t, {
    stopped: { [claudeA.id]: session() },
    options: {
      getCurrentSnapshot: () => Promise.resolve(current),
      findRunning: async account => {
        if (account.id !== claudeB.id) return { kind: 'none' };
        // Pickup was verified in the first observation; now the idle check and final preflight.
        if (returning && ++lookups === 2) {
          checking.resolve(undefined);
          await release.promise;
        }
        return { kind: 'found', process: live() };
      }
    }
  });
  await continuity.observe(current, { low: [] });
  assert.equal(started.length, 1);
  returning = true;
  current = state(100, 'auto');
  const observing = continuity.observe(current, { low: [] });
  await checking.promise;
  current = state(100, 'ask');
  release.resolve(undefined);
  assert.deepEqual(
    (await observing).map(notice => notice.kind),
    ['suggested']
  );
  assert.equal(started.length, 1, 'the source process is not ended or relaunched under the old auto setting');
  assert.equal(continuity.suggestions()[0]?.kind, 'return');
  assert.equal(continuity.transitions().at(-1)?.status, 'offered');
});

test('the wait for background commands before going home starts over when the session was busy in between', async t => {
  const { state } = await movedCopy(t, 'vibe-return-wait-');
  let now = NOW;
  const running: Record<string, LiveClaudeSession> = { 'claude:b': live({ status: 'busy' }) };
  const tasks: BackgroundTask[] = [];
  const { continuity, started } = await harness(t, { stopped: { 'claude:a': [session()] }, running, tasks, clock: () => now });
  await continuity.observe(state(0, 'auto'), { low: [] });
  // Quiet with a command running: the wait begins.
  running['claude:b'] = live({ startedAt: NOW - 20 * MINUTE });
  tasks.push({ id: 'b9', command: 'npm run build', outputFile: null, startedAt: NOW - 5 * MINUTE });
  assert.deepEqual(await continuity.observe(state(100, 'auto', now), { low: [] }), []);
  // Busy for most of the wait, then quiet again with a command running.
  now += RETURN_TASK_WAIT_MS - MINUTE;
  running['claude:b'] = live({ status: 'busy', startedAt: NOW - 20 * MINUTE });
  assert.deepEqual(await continuity.observe(state(100, 'auto', now), { low: [] }), []);
  now += 2 * MINUTE;
  running['claude:b'] = live({ startedAt: NOW - 20 * MINUTE, statusSince: now - 20 * MINUTE });
  assert.deepEqual(await continuity.observe(state(100, 'auto', now), { low: [] }), [], 'its command gets the whole wait again');
  assert.equal(started.length, 1);
});

test('a session closed where it was moved to is not brought back, and off leaves work where it is', async t => {
  const { state } = await movedCopy(t, 'vibe-closed-');
  const closed = await harness(t, { stopped: { 'claude:a': [session()] } });
  await closed.continuity.observe(state(0, 'auto'), { low: [] });
  assert.deepEqual(await closed.continuity.observe(state(100, 'auto'), { low: [] }), []);
  assert.equal(closed.started.length, 1);
  const off = await harness(t, { stopped: { 'claude:a': [session()] }, running: { 'claude:b': live() } });
  await off.continuity.observe(state(0, 'off'), { low: [] });
  assert.deepEqual(await off.continuity.observe(state(100, 'off'), { low: [] }), []);
  assert.equal(off.started.length, 1);
});

test('sessions of one account that stop between two refreshes all go on', async t => {
  const out = snapshot([reading(claudeA, 0), reading(claudeB, 80)], 'accounts');
  const together = [session({ sessionId: 'session-2', stoppedAt: NOW - MINUTE }), session()];
  const { continuity, started } = await harness(t, { stopped: { 'claude:a': together } });
  assert.deepEqual(
    (await continuity.observe(out, { low: [] })).map(n => n.kind),
    ['continued', 'continued']
  );
  assert.deepEqual(
    started.map(s => s.session.sessionId),
    ['session-2', 'session-1']
  );
  assert.deepEqual(await continuity.observe(out, { low: [] }), [], 'each once');
});

test('opted in, a session stopped at the limit goes on by itself, once, even across restarts', async t => {
  const dataDir = await tempDir(t, 'vibe-continuity-');
  const out = snapshot([reading(claudeA, 0), reading(claudeB, 80), reading(codex, 90)], 'accounts');
  const first = await harness(t, { stopped: { 'claude:a': session() }, dataDir });
  const notices = await Promise.all([first.continuity.observe(out, { low: [] }), first.continuity.observe(out, { low: [] })]);
  assert.deepEqual(
    notices.flat().map(n => n.kind),
    ['continued'],
    'two refreshes at once still move it once'
  );
  assert.deepEqual(
    first.started.map(s => [s.to.account?.id, s.prompt]),
    [['claude:b', RESUME_PROMPT]]
  );
  const restarted = await harness(t, { stopped: { 'claude:a': session() }, dataDir });
  assert.deepEqual(await restarted.continuity.observe(out, { low: [] }), [], 'remembered after a restart');
  assert.equal(restarted.started.length, 0);
});

test('a stop is left alone once the limit has reset; with nobody to take over the user is told', async t => {
  const reset = await harness(t, { stopped: { 'claude:a': session() } });
  assert.deepEqual(await reset.continuity.observe(snapshot([reading(claudeA, 100), reading(claudeB, 80)], 'accounts'), { low: [] }), []);
  const stranded = await harness(t, { stopped: { 'claude:a': session() } });
  const allOut = snapshot([reading(claudeA, 0), reading(claudeB, 3), reading(codex, 90)], 'accounts');
  assert.deepEqual(
    (await stranded.continuity.observe(allOut, { low: [] })).map(n => n.kind),
    ['stranded'],
    'other tools are not allowed'
  );
  assert.deepEqual(await stranded.continuity.observe(allOut, { low: [] }), [], 'said once');
  const tools = await harness(t, { stopped: { 'claude:a': session() } });
  await tools.continuity.observe(snapshot([reading(claudeA, 0), reading(claudeB, 3), reading(codex, 90)], 'tools'), { low: [] });
  assert.deepEqual(
    tools.started.map(s => s.to.providerId),
    ['codex']
  );
});

test('not opted in, a stopped session is offered and resumes with the prompt to go on', async t => {
  const { continuity, started } = await harness(t, { stopped: { 'claude:a': session() } });
  const out = snapshot([reading(claudeA, 0), reading(claudeB, 80)]);
  const [notice] = await continuity.observe(out, { low: [] });
  assert.equal(notice?.kind === 'suggested' && notice.suggestion.remainingPercent, 0);
  assert.equal(started.length, 0);
  assert.equal(await continuity.isRunning('low:claude:a:session-1'), false, 'a stopped agent is not running');
  await continuity.accept('low:claude:a:session-1', out);
  assert.deepEqual(
    started.map(s => [s.to.account?.id, s.prompt]),
    [['claude:b', RESUME_PROMPT]]
  );
});

test('running low offers to move the work, warns while it is still being written, and offers it back later', async t => {
  const { copy, state } = await movedCopy(t, 'vibe-low-');
  const busy = session({ updatedAt: NOW - 10 * 1000 });
  const { continuity, started } = await harness(t, { recent: { 'claude:a': busy } });
  const low = createQuotaWatch();
  const watch = (current: Snapshot) => continuity.observe(current, { low: low(current) });
  await watch(state(60, 'ask'));
  const notices = await watch(state(15, 'ask'));
  assert.deepEqual(
    notices.map(n => n.kind === 'suggested' && [n.suggestion.id, n.suggestion.target.accountId]),
    [['low:claude:a', 'claude:b']]
  );
  assert.equal(await continuity.isRunning('low:claude:a'), true, 'written 10 seconds ago');
  await continuity.accept('low:claude:a', state(15, 'ask'));
  assert.deepEqual(
    started.map(s => [s.to.account?.id, s.prompt]),
    [['claude:b', undefined]],
    'a session that did not stop opens without being told to go on'
  );
  await assert.rejects(continuity.accept('low:claude:a', snapshot([])), /suggestion_expired/);

  const back = await watch(state(100, 'ask'));
  assert.deepEqual(
    back.map(n => n.kind === 'suggested' && [n.suggestion.id, n.suggestion.target.accountId]),
    [['return:claude:session-1', 'claude:a']]
  );
  await continuity.accept('return:claude:session-1', state(100, 'ask'));
  assert.deepEqual(
    started.map(s => [s.session.file, s.to.account?.id]),
    [
      ['/profiles/a/projects/-work-app/session-1.jsonl', 'claude:b'],
      [copy, 'claude:a']
    ],
    'the copy where it ran goes back'
  );
});
test('a low offer needs a recent session and someone with room; recovering withdraws it', async t => {
  const old = await harness(t, { recent: { 'claude:a': session({ updatedAt: NOW - 5 * 60 * MINUTE }) } });
  const lowWatch = createQuotaWatch();
  lowWatch(snapshot([reading(claudeA, 60), reading(claudeB, 80)]));
  const lowState = snapshot([reading(claudeA, 15), reading(claudeB, 80)]);
  const alerts = lowWatch(lowState);
  assert.deepEqual(await old.continuity.observe(lowState, { low: alerts }), [], 'the session is too old');
  const fresh = await harness(t, { recent: { 'claude:a': session() } });
  await fresh.continuity.observe(lowState, { low: alerts });
  assert.equal(fresh.continuity.suggestions().length, 1);
  await fresh.continuity.observe(snapshot([reading(claudeA, 40), reading(claudeB, 80)]), { low: [] });
  assert.deepEqual(fresh.continuity.suggestions(), [], 'back above the line');
});

test('accept never falls back to exhausted remembered target', async t => {
  const { continuity, started } = await harness(t, { stopped: { 'claude:a': session() } });
  await continuity.observe(snapshot([reading(claudeA, 0), reading(claudeB, 80)]), { low: [] });
  await assert.rejects(
    continuity.accept('low:claude:a:session-1', snapshot([reading(claudeA, 0), reading(claudeB, 0)])),
    /no_verified_quota/
  );
  assert.equal(started.length, 0);
  assert.equal(continuity.suggestions().length, 1);
});

test('failed automatic starts persist an offer and require explicit retry after restart', async t => {
  const dataDir = await tempDir(t, 'vibe-retry-');
  let attempts = 0;
  const options = {
    homeDir: '/home',
    dataDir,
    launch: { dataDir },
    clock: () => NOW,
    findSession: () => Promise.resolve(session()),
    findStopped: (a: Account) => Promise.resolve(a.id === claudeA.id ? [session()] : []),
    start: (): Promise<ContinueResult> => {
      attempts++;
      return Promise.reject(new Error('secret details'));
    }
  };
  const state = snapshot([reading(claudeA, 0), reading(claudeB, 80)], 'accounts');
  const first = await createContinuity(options);
  assert.equal((await first.observe(state, { low: [] }))[0]?.kind, 'failed');
  const restarted = await createContinuity(options);
  await restarted.observe(state, { low: [] });
  assert.equal(attempts, 1);
  assert.equal(restarted.suggestions().length, 1);
  await assert.rejects(restarted.accept('low:claude:a:session-1', state), /secret details/);
  assert.equal(attempts, 2);
});

test('return offers never pick a different project or unknown cross-tool target session', async t => {
  for (const crossTool of [false, true]) {
    const target = crossTool ? codex : claudeB;
    const { continuity } = await harness(t, {
      stopped: { 'claude:a': session() },
      recent: { [target.id]: session({ providerId: target.providerId, projectDir: '/unrelated', sessionId: 'other' }) }
    });
    await continuity.observe(snapshot([reading(claudeA, 0), reading(target, 80)], 'tools'), { low: [] });
    await continuity.observe(snapshot([reading(claudeA, 100), reading(target, 80)], 'tools'), { low: [] });
    assert.equal(continuity.suggestions().length, 0);
  }
});

test('waiting offers validate disabled, stale and recovered targets before dispatch', async t => {
  for (const change of ['disabled', 'stale', 'recovered']) {
    const { continuity, started } = await harness(t, { stopped: { 'claude:a': session() } });
    const current = snapshot([reading(claudeA, 0), reading(claudeB, 80)]);
    await continuity.observe(current, { low: [] });
    if (change === 'disabled')
      current.settings.accounts = current.settings.accounts.map(a => (a.id === claudeB.id ? { ...a, enabled: false } : a));
    const source = current.providers.flatMap(p => p.accounts).find(a => a.id === claudeA.id);
    const target = current.providers.flatMap(p => p.accounts).find(a => a.id === claudeB.id);
    assert.ok(source?.windows[0] && target);
    if (change === 'stale') target.fetchedAt = new Date(NOW - 10 * MINUTE).toISOString();
    if (change === 'recovered') source.windows[0].remainingPercent = 100;
    await assert.rejects(continuity.accept('low:claude:a:session-1', current), /no_verified_quota/);
    assert.equal(started.length, 0);
  }
});

test('a failed stop cannot be retried after the source resumes', async t => {
  const stopped: Record<string, StoppedSession> = { 'claude:a': session() };
  const { continuity, started } = await harness(t, { stopped });
  const current = snapshot([reading(claudeA, 0), reading(claudeB, 80)]);
  await continuity.observe(current, { low: [] });
  delete stopped['claude:a'];
  await assert.rejects(continuity.accept('low:claude:a:session-1', current), /suggestion_expired/);
  const record = continuity.transitions()[0];
  assert.ok(record);
  await assert.rejects(continuity.retry(record.id, current), /suggestion_expired/);
  assert.equal(started.length, 0);
});

test('accept and observation races dispatch one stopped session at most once', async t => {
  const { continuity, started } = await harness(t, { stopped: { 'claude:a': session() } });
  const current = snapshot([reading(claudeA, 0), reading(claudeB, 80)]);
  await continuity.observe(current, { low: [] });
  const results = await Promise.allSettled([
    continuity.accept('low:claude:a:session-1', current),
    continuity.observe(current, { low: [] }),
    continuity.accept('low:claude:a:session-1', current)
  ]);
  assert.equal(results.filter(r => r.status === 'rejected').length, 1);
  assert.equal(started.length, 1);
  assert.equal(continuity.transitions()[0]?.status, 'dispatched');
  const copy = continuity.transitions();
  assert.ok(copy[0]);
  copy[0].status = 'failed';
  assert.equal(continuity.transitions()[0]?.status, 'dispatched', 'API callers cannot mutate history');
});

test('ambiguous dispatch intent survives restart without automatic or explicit relaunch', async t => {
  const dataDir = await tempDir(t, 'vibe-crash-');
  const current = snapshot([reading(claudeA, 0), reading(claudeB, 80)]);
  const first = await harness(t, { stopped: { 'claude:a': session() }, dataDir });
  await first.continuity.observe(current, { low: [] });
  const file = path.join(dataDir, 'continuity.json');
  const stored = JSON.parse(await fs.readFile(file, 'utf8')) as { transitions: { status: string }[] };
  assert.ok(stored.transitions[0]);
  stored.transitions[0].status = 'dispatching';
  await fs.writeFile(file, JSON.stringify(stored));
  const restarted = await harness(t, { stopped: { 'claude:a': session() }, dataDir });
  await restarted.continuity.observe(current, { low: [] });
  assert.deepEqual(restarted.continuity.suggestions(), []);
  assert.equal(restarted.continuity.transitions()[0]?.status, 'interrupted');
  const record = restarted.continuity.transitions()[0];
  assert.ok(record);
  await assert.rejects(restarted.continuity.retry(record.id, current), /suggestion_expired/);
  assert.equal(restarted.started.length, 0);
});

test('a failed persistence write prevents an automatic launch', async t => {
  const dataDir = await tempDir(t, 'vibe-write-');
  await fs.mkdir(path.join(dataDir, 'continuity.json'));
  const current = snapshot([reading(claudeA, 0), reading(claudeB, 80)], 'accounts');
  const { continuity, started } = await harness(t, { stopped: { 'claude:a': session() }, dataDir });
  await assert.rejects(continuity.observe(current, { low: [] }));
  assert.equal(started.length, 0);
});

test('unknown cross-tool dispatch identity never enables a return from an arbitrary session', async t => {
  const dataDir = await tempDir(t, 'vibe-cross-');
  const continuity = await createContinuity({
    homeDir: '/home',
    dataDir,
    launch: { dataDir },
    clock: () => NOW,
    findStopped: a => Promise.resolve(a.id === claudeA.id ? [session()] : []),
    findSession: a => Promise.resolve(session({ providerId: a.providerId, sessionId: 'unrelated-same-project' })),
    start: (_session, to) => Promise.resolve({ to: to.providerId, accountId: to.account?.id ?? null, resumed: false, mode: 'terminal' })
  });
  await continuity.observe(snapshot([reading(claudeA, 0), reading(codex, 80)], 'tools'), { low: [] });
  await continuity.observe(snapshot([reading(claudeA, 100), reading(codex, 80)], 'tools'), { low: [] });
  const record = continuity.transitions()[0];
  assert.ok(record);
  assert.equal(record.target.sessionId, null);
  assert.deepEqual(continuity.suggestions(), []);
});

test('a stranded stop keeps a safe explicit retry when quota becomes available', async t => {
  const { continuity, started } = await harness(t, { stopped: { 'claude:a': session() } });
  await continuity.observe(snapshot([reading(claudeA, 0), reading(claudeB, 0)], 'accounts'), { low: [] });
  const record = continuity.transitions()[0];
  assert.equal(record?.status, 'failed');
  assert.equal(record.errorCode, 'no_verified_quota');
  assert.ok(record);
  await continuity.retry(record.id, snapshot([reading(claudeA, 0), reading(claudeB, 80)], 'accounts'));
  assert.equal(started.length, 1);
});

test('simultaneous explicit retries launch once and store only safe failure codes', async t => {
  const dataDir = await tempDir(t, 'vibe-retry-race-');
  let attempts = 0;
  const faults: unknown[] = [];
  const continuity = await createContinuity({
    homeDir: '/home',
    dataDir,
    onFault: error => faults.push(error),
    launch: { dataDir },
    clock: () => NOW,
    findStopped: a => Promise.resolve(a.id === claudeA.id ? [session()] : []),
    start: (_session, to): Promise<ContinueResult> => {
      attempts++;
      if (attempts === 1) return Promise.reject(new Error('private transcript and credential detail'));
      return Promise.resolve({ to: to.providerId, accountId: to.account?.id ?? null, resumed: true, mode: 'terminal' });
    }
  });
  const current = snapshot([reading(claudeA, 0), reading(claudeB, 80)], 'accounts');
  await continuity.observe(current, { low: [] });
  const record = continuity.transitions()[0];
  assert.ok(record);
  assert.equal(record.errorCode, 'launch_failed');
  assert.equal((await fs.readFile(path.join(dataDir, 'continuity.json'), 'utf8')).includes('private transcript'), false);
  assert.ok(faults.length > 0, 'the unforeseen failure is handed on for the diagnostics');
  const result = await Promise.allSettled([continuity.retry(record.id, current), continuity.retry(record.id, current)]);
  assert.equal(result.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(attempts, 2);
  assert.equal(continuity.transitions()[0]?.status, 'dispatched');
});

test('a failure keeps what its message names, in the notice, the record and after a restart', async t => {
  const dataDir = await tempDir(t, 'vibe-failure-params-');
  const options = {
    homeDir: '/home',
    dataDir,
    launch: { dataDir },
    clock: () => NOW,
    findStopped: (a: Account) => Promise.resolve(a.id === claudeA.id ? [session()] : []),
    start: (): Promise<ContinueResult> => Promise.reject(new AppError('start_blocked', { program: 'powershell.exe' }))
  };
  const continuity = await createContinuity(options);
  const notices = await continuity.observe(snapshot([reading(claudeA, 0), reading(claudeB, 80)], 'accounts'), { low: [] });
  const failed = notices.find(notice => notice.kind === 'failed');
  assert.deepEqual(failed && [failed.code, failed.params], ['start_blocked', { program: 'powershell.exe' }]);
  const record = continuity.transitions()[0];
  assert.deepEqual(record && [record.errorCode, record.errorParams], ['start_blocked', { program: 'powershell.exe' }]);
  const reloaded = await createContinuity(options);
  assert.deepEqual(reloaded.transitions()[0]?.errorParams, { program: 'powershell.exe' });
});

test('a return offer revalidates recovered account quota, and a dismissed one stays dismissed', async t => {
  const { state } = await movedCopy(t, 'vibe-revalidate-');
  const { continuity, started } = await harness(t, { stopped: { 'claude:a': session() } });
  await continuity.observe(state(0, 'ask'), { low: [] });
  await continuity.observe(state(100, 'ask'), { low: [] });
  assert.ok(continuity.suggestions().some(s => s.kind === 'return'));
  await assert.rejects(continuity.accept('return:claude:session-1', state(0, 'ask')), /no_verified_quota/);
  assert.equal(started.length, 1);
  continuity.dismiss('return:claude:session-1');
  await continuity.observe(state(100, 'ask'), { low: [] });
  assert.deepEqual(continuity.suggestions(), [], 'dismissal remains effective on the next refresh');
});
test('real profile discovery binds the project, session and model for continuation', async t => {
  const home = await tempDir(t, 'vibe-recent-home-');
  const project = path.join(home, 'project');
  const profile = path.join(home, 'claude-work');
  const dir = path.join(profile, 'projects', 'project');
  await fs.mkdir(dir, { recursive: true });
  const transcript = path.join(dir, 'original.jsonl');
  await fs.writeFile(
    transcript,
    [
      { type: 'user', cwd: project, message: { content: 'Continue this task' } },
      { type: 'assistant', cwd: project, message: { model: 'claude-opus-5-5', content: 'Working' } },
      {
        type: 'assistant',
        cwd: project,
        isApiErrorMessage: true,
        apiError: 'usage_limit_reached',
        timestamp: new Date(NOW - MINUTE).toISOString(),
        message: { model: '<synthetic>', content: "You've hit your session limit" }
      }
    ]
      .map(r => JSON.stringify(r))
      .join('\n')
  );
  await fs.utimes(transcript, new Date(NOW), new Date(NOW));
  const source = account({ configDir: profile });
  assert.equal((await findRecentSession(source, home))?.model, 'claude-opus-5-5');
  assert.equal((await findStoppedSession(source, home, NOW))?.sessionId, 'original');
  const other = path.join(dir, 'unrelated.jsonl');
  await fs.writeFile(other, JSON.stringify({ cwd: path.join(home, 'unrelated'), type: 'user', message: { content: 'Other task' } }));
  await fs.utimes(other, new Date(NOW + MINUTE), new Date(NOW + MINUTE));
  assert.equal((await findRecentSession(source, home))?.sessionId, 'unrelated');
  assert.equal((await findRecentSession(source, home, { projectDir: project, sessionId: 'original' }))?.file, transcript);
  assert.equal(await findRecentSession(source, home, { projectDir: project, sessionId: 'missing' }), null);

  const codexRoot = path.join(home, 'codex-work');
  const rollouts = path.join(codexRoot, 'sessions', '2026', '10', '17');
  await fs.mkdir(rollouts, { recursive: true });
  const rollout = path.join(rollouts, 'rollout-2026-10-17T10-00-00-original-codex.jsonl');
  await fs.writeFile(
    rollout,
    `${
      codexRollout({ id: 'original-codex', cwd: project, model: 'gpt-6-luna', user: ['Codex task'] }) +
      JSON.stringify({
        timestamp: new Date(NOW - MINUTE).toISOString(),
        type: 'event_msg',
        payload: { type: 'task_complete', error: { codex_error_info: 'usage_limit_exceeded' } }
      })
    }\n`
  );
  await fs.utimes(rollout, new Date(NOW), new Date(NOW));
  const codexAccount = account({ providerId: 'codex', id: 'codex:work', configDir: codexRoot });
  assert.equal((await findRecentSession(codexAccount, home, { projectDir: project, sessionId: 'original-codex' }))?.model, 'gpt-6-luna');
  assert.equal((await findStoppedSession(codexAccount, home, NOW))?.sessionId, 'original-codex');
  assert.equal(await findRecentSession(codexAccount, home, { projectDir: '/other', sessionId: 'original-codex' }), null);

  writeCursorChat(path.join(home, '.cursor', 'chats'), { id: 'cursor-task', cwd: project, name: 'Task', user: ['Cursor task'] });
  assert.equal(
    (await findRecentSession(account({ providerId: 'cursor' }), home, { projectDir: project, sessionId: 'cursor-task' }))?.sessionId,
    'cursor-task'
  );
  assert.equal(await findRecentSession(account({ providerId: 'antigravity' }), home), null);
  assert.equal(await findStoppedSession(account({ providerId: 'cursor' }), home, NOW), null);
});

test('a project’s own continuation setting wins over the global one, and its tool and account come first', async t => {
  const projectPreference = (fields: object) => [{ projectDir: path.resolve('/work/app'), autoContinue: 'inherit' as const, ...fields }];
  const out = snapshot([reading(claudeA, 0), reading(claudeB, 80), reading(codex, 90)], 'tools');
  const off = { ...out, settings: { ...out.settings, projectPreferences: projectPreference({ autoContinue: 'off' }) } };
  const held = await harness(t, { stopped: { 'claude:a': session() } });
  assert.deepEqual(
    (await held.continuity.observe(off, { low: [] })).map(n => n.kind),
    ['suggested'],
    'off for the project: offered, never started'
  );
  assert.equal(held.started.length, 0);

  const on = {
    ...out,
    settings: {
      ...out.settings,
      autoContinue: 'off' as const,
      projectPreferences: projectPreference({ tool: 'codex', model: 'gpt-6-sol', autoContinue: 'tools' })
    }
  };
  const moved = await harness(t, { stopped: { 'claude:a': session() } });
  assert.deepEqual(
    (await moved.continuity.observe(on, { low: [] })).map(n => n.kind),
    ['continued'],
    'on for the project although off globally'
  );
  assert.deepEqual(
    moved.started.map(s => [s.to.providerId, s.to.account?.id]),
    [['claude', 'claude:b']],
    'the same tool’s other account still comes before the preferred tool'
  );

  const claudeOut = snapshot([reading(claudeA, 0), reading(claudeB, 8), reading(codex, 90)]);
  const preferred = {
    ...claudeOut,
    settings: { ...claudeOut.settings, projectPreferences: projectPreference({ tool: 'codex', model: 'gpt-6-sol', autoContinue: 'tools' }) }
  };
  const third = await harness(t, { stopped: { 'claude:a': session() } });
  await third.continuity.observe(preferred, { low: [] });
  assert.deepEqual(
    third.started.map(s => [s.to.providerId, s.to.model]),
    [['codex', 'gpt-6-sol']],
    'the project’s model for its tool'
  );
});

test('a failed write after the work started never reports it as failed; one before it starts nothing', async t => {
  const dataDir = await tempDir(t, 'vibe-continuity-');
  const state = path.join(dataDir, 'continuity.json');
  // A folder where the state file belongs makes every later write fail.
  const breakWrites = async () => {
    await fs.rm(state, { force: true });
    await fs.mkdir(state);
  };
  let starts = 0;
  const continuity = await createContinuity({
    homeDir: '/home/me',
    dataDir,
    launch: { dataDir: '/data' },
    clock: () => NOW,
    findSession: () => Promise.resolve(null),
    findStopped: target => Promise.resolve(target.id === 'claude:a' ? [session()] : []),
    start: async (_session, to) => {
      starts++;
      await breakWrites();
      return { to: to.providerId, accountId: to.account?.id ?? null, resumed: true, mode: 'terminal' };
    }
  });
  const out = snapshot([reading(claudeA, 0), reading(claudeB, 80)], 'accounts');
  assert.deepEqual(
    (await continuity.observe(out, { low: [] })).map(n => n.kind),
    ['continued'],
    'the agent runs, so the user is told it continued'
  );
  assert.equal(continuity.transitions()[0]?.status, 'dispatched');
  assert.equal(starts, 1);

  const blocked = await tempDir(t, 'vibe-continuity-');
  const later = await createContinuity({
    homeDir: '/home/me',
    dataDir: blocked,
    launch: { dataDir: '/data' },
    clock: () => NOW,
    findSession: () => Promise.resolve(null),
    findStopped: target => Promise.resolve(target.id === 'claude:a' ? [session()] : []),
    start: () => assert.fail('nothing starts without a durable intent')
  });
  // The offer is written, then writing breaks before it is accepted.
  await later.observe(snapshot([reading(claudeA, 0), reading(claudeB, 80)]), { low: [] });
  await fs.rm(path.join(blocked, 'continuity.json'), { force: true });
  await fs.mkdir(path.join(blocked, 'continuity.json'));
  const [offered] = later.suggestions();
  assert.ok(offered);
  await assert.rejects(later.accept(offered.id, snapshot([reading(claudeA, 0), reading(claudeB, 80)])));
  assert.equal(later.transitions()[0]?.status, 'failed', 'recorded as failed, open to a retry');
});

test('a stranded stop shows no card with a target that has no quota', async t => {
  const { continuity } = await harness(t, { stopped: { 'claude:a': session() } });
  const notices = await continuity.observe(snapshot([reading(claudeA, 0), reading(claudeB, 0)], 'accounts'), { low: [] });
  assert.deepEqual(
    notices.map(n => n.kind),
    ['stranded']
  );
  assert.deepEqual(continuity.suggestions(), []);
  assert.equal(continuity.transitions()[0]?.status, 'failed');
});

test('a session is never carried over a copy that was written after it', async t => {
  const root = await tempDir(t, 'vibe-carry-');
  const from = path.join(root, 'a', 'projects', '-work-app', 'session-1.jsonl');
  const to = path.join(root, 'b', 'projects', '-work-app', 'session-1.jsonl');
  await fs.mkdir(path.dirname(from), { recursive: true });
  await fs.mkdir(path.dirname(to), { recursive: true });
  const record = (minutesAgo: number) =>
    `${JSON.stringify({ type: 'user', timestamp: new Date(NOW - minutesAgo * MINUTE).toISOString(), message: { role: 'user', content: 'go' } })}\n`;
  // The copy went on: a later record. File times say nothing (the source is touched later).
  await fs.writeFile(from, record(10));
  await fs.writeFile(to, record(10) + record(5));
  const later = new Date(NOW);
  await fs.utimes(from, later, later);
  await assert.rejects(carryClaudeSession(session({ file: from }), path.join(root, 'b')), /session_newer_elsewhere/);
  assert.equal(await fs.readFile(to, 'utf8'), record(10) + record(5));
  // The same last record with more bytes after it (an answer under way) counts as later too.
  await fs.writeFile(to, `${record(10)}{"type":"assistant","message":{"content":[]}}\n`);
  await assert.rejects(carryClaudeSession(session({ file: from }), path.join(root, 'b')), /session_newer_elsewhere/);
  // An older copy is replaced.
  await fs.writeFile(to, record(20));
  await carryClaudeSession(session({ file: from }), path.join(root, 'b'));
  assert.equal(await fs.readFile(to, 'utf8'), record(10));
});

test('a stop retires the running-low card for its session, so the card cannot start it again', async t => {
  const stopped: Record<string, StoppedSession> = {};
  const { continuity, started } = await harness(t, { recent: { 'claude:a': session({ updatedAt: NOW - 10 * 1000 }) }, stopped });
  const low = createQuotaWatch();
  const at = (remaining: number) => snapshot([reading(claudeA, remaining), reading(claudeB, 80)], 'accounts');
  await continuity.observe(at(60), { low: low(at(60)) });
  await continuity.observe(at(15), { low: low(at(15)) });
  assert.deepEqual(
    continuity.suggestions().map(s => s.id),
    ['low:claude:a']
  );
  stopped['claude:a'] = session();
  assert.deepEqual(
    (await continuity.observe(at(0), { low: low(at(0)) })).map(n => n.kind),
    ['continued']
  );
  assert.deepEqual(continuity.suggestions(), []);
  await assert.rejects(continuity.accept('low:claude:a', at(0)), /suggestion_expired/);
  assert.equal(started.length, 1);
});

test('a session whose process cannot be ended is not started beside it, in a new tab or the same one', async t => {
  const root = await tempDir(t, 'vibe-not-twice-');
  const project = path.join(root, 'project');
  const from = path.join(root, '.claude', 'projects', 'C--work-project');
  await fs.mkdir(from, { recursive: true });
  await fs.mkdir(project);
  await fs.writeFile(
    path.join(from, 'session-1.jsonl'),
    `${JSON.stringify({ type: 'user', cwd: project, timestamp: new Date(NOW).toISOString() })}\n`
  );
  const binary = path.join(root, 'claude');
  await fs.writeFile(binary, '');
  process.env.VIBE_CLAUDE_BINARY = binary;
  t.after(() => {
    delete process.env.VIBE_CLAUDE_BINARY;
  });
  const running: LiveClaudeSession = {
    pid: 4242,
    sessionId: 'session-1',
    listed: true,
    status: 'idle',
    statusSince: NOW,
    startedAt: NOW - MINUTE,
    procStart: null
  };
  const ended: number[] = [];
  // The system cannot say whether the process still runs: it is left alone.
  const unreadable = {
    isAlive: () => true,
    started: () => Promise.reject(new Error('timed out')),
    end: (pid: number) => void ended.push(pid)
  };
  const tab = path.join(root, 'tab.json');
  for (const platform of ['darwin', 'win32'] as const) {
    const calls: string[][] = [];
    await assert.rejects(
      continueSession(
        session({ projectDir: project, file: path.join(from, 'session-1.jsonl') }),
        { providerId: 'claude', account: account({ id: 'claude:b', configDir: path.join(root, '.claude-2'), primary: false }) },
        snapshot([]),
        { dataDir: root, homeDir: root, platform, spawnProcess: fakeSpawn(calls) },
        { prompt: RESUME_PROMPT, running, tab, processes: unreadable }
      ),
      /process_unknown/
    );
    assert.deepEqual(calls, [], platform);
  }
  assert.deepEqual(ended, []);
  await assert.rejects(fs.access(tab), 'the next command it was offered is taken back');
});

test('in a tab the app opened, a moved session goes on in that same tab', async t => {
  const root = await tempDir(t, 'vibe-same-tab-');
  const project = path.join(root, 'project');
  const from = path.join(root, '.claude', 'projects', 'C--work-project');
  await fs.mkdir(from, { recursive: true });
  await fs.mkdir(project);
  await fs.writeFile(
    path.join(from, 'session-1.jsonl'),
    `${JSON.stringify({ type: 'user', cwd: project, timestamp: new Date(NOW).toISOString() })}\n`
  );
  const binary = path.join(root, 'claude');
  await fs.writeFile(binary, '');
  process.env.VIBE_CLAUDE_BINARY = binary;
  t.after(() => {
    delete process.env.VIBE_CLAUDE_BINARY;
  });
  const tab = path.join(root, 'tab.json');
  const running: LiveClaudeSession = {
    pid: 4242,
    sessionId: 'session-1',
    listed: true,
    status: 'idle',
    statusSince: NOW,
    startedAt: NOW - MINUTE,
    procStart: '1'
  };
  let next: unknown = null;
  // The tab: once its tool exits it takes the next command and removes the file.
  let alive = true;
  const tabProcess = {
    isAlive: () => alive,
    started: () => Promise.resolve({ at: NOW - MINUTE, ticks: '1' }),
    end: () => {
      alive = false;
      next = JSON.parse(readFileSync(tab, 'utf8'));
      rmSync(tab);
    }
  };
  const target = account({ id: 'claude:b', configDir: path.join(root, '.claude-2'), primary: false });
  const calls: string[][] = [];
  const result = await continueSession(
    session({ projectDir: project, file: path.join(from, 'session-1.jsonl') }),
    { providerId: 'claude', account: target },
    snapshot([]),
    { dataDir: root, homeDir: root, platform: 'win32', spawnProcess: fakeSpawn(calls) },
    { prompt: RESUME_PROMPT, running, tab, processes: tabProcess }
  );
  assert.deepEqual(result, { to: 'claude', accountId: 'claude:b', resumed: true, mode: 'terminal', tab });
  assert.deepEqual(calls, [], 'no new tab');
  assert.ok(next && typeof next === 'object');
  const command = next as { workingDirectory: string; executable: string; argumentsBase64: string; set: Record<string, string> };
  assert.equal(command.workingDirectory, project);
  assert.equal(command.executable, binary);
  assert.equal(command.set.CLAUDE_CONFIG_DIR, target.configDir);
  assert.deepEqual(Buffer.from(command.argumentsBase64, 'base64').toString('utf8').split('\0'), ['--resume', 'session-1', RESUME_PROMPT]);
});

test('a failed automatic return waits for an explicit retry instead of failing on every refresh', async t => {
  const { state } = await movedCopy(t, 'vibe-return-fails-');
  const running = { 'claude:b': live({ startedAt: NOW - 20 * MINUTE }) };
  const { continuity, started } = await harness(t, { stopped: { 'claude:a': session() }, running, fails: n => n > 1 });
  await continuity.observe(state(0, 'auto'), { low: [] });
  assert.deepEqual(
    (await continuity.observe(state(100, 'auto'), { low: [] })).map(n => [n.kind, n.kind === 'failed' && n.attempt]),
    [['failed', 'return']],
    'a return, said so'
  );
  for (let refresh = 0; refresh < 3; refresh++) assert.deepEqual(await continuity.observe(state(100, 'auto'), { low: [] }), []);
  assert.equal(started.length, 2, 'tried once');
  const failed = continuity.transitions().find(r => r.status === 'failed');
  assert.ok(failed);
  await continuity.retry(failed.id, state(100, 'auto')).catch(() => undefined);
  assert.equal(started.length, 3, 'the explicit retry tries again');
});

test('a second stop of the same session retires the first one’s failed record', async t => {
  const stopped: Record<string, StoppedSession> = { 'claude:a': session() };
  const { continuity } = await harness(t, { stopped, fails: n => n === 1 });
  const out = snapshot([reading(claudeA, 0), reading(claudeB, 80)], 'accounts');
  await continuity.observe(out, { low: [] });
  stopped['claude:a'] = session({ stoppedAt: NOW - MINUTE });
  await continuity.observe(out, { low: [] });
  assert.deepEqual(
    continuity.transitions().map(r => r.status),
    ['dismissed', 'dispatched']
  );
});

test('a low line above 20% offers moves that can be accepted, and withdraws them only above that line', async t => {
  const busy = session({ updatedAt: NOW - 2 * MINUTE });
  const { continuity, started } = await harness(t, { recent: { 'claude:a': busy } });
  const low = createQuotaWatch();
  const at = (remaining: number): Snapshot => {
    const state = snapshot([reading(claudeA, remaining), reading(claudeB, 80)]);
    return { ...state, settings: { ...state.settings, lowQuotaPercent: 40 } };
  };
  await continuity.observe(at(60), { low: low(at(60)) });
  await continuity.observe(at(30), { low: low(at(30)) });
  assert.deepEqual(
    continuity.suggestions().map(s => s.id),
    ['low:claude:a']
  );
  await continuity.observe(at(30), { low: low(at(30)) });
  assert.deepEqual(
    continuity.suggestions().map(s => s.id),
    ['low:claude:a'],
    '30% is still below the 40% line: the offer stays'
  );
  await continuity.accept('low:claude:a', at(30));
  assert.deepEqual(
    started.map(s => s.to.account?.id),
    ['claude:b']
  );
});

// Above the 20% a stopped session needs but below the user's line, an account would count as
// running low the moment work arrived: it would be offered away again.
test('work that is not stopped moves only to an account above the low line: home, or away from one running low', async t => {
  const line = (state: Snapshot): Snapshot => ({ ...state, settings: { ...state.settings, lowQuotaPercent: 50 } });
  const { state } = await movedCopy(t, 'vibe-low-line-');
  const moved = await harness(t, { stopped: { 'claude:a': [session()] } });
  await moved.continuity.observe(line(state(0, 'ask')), { low: [] });
  assert.equal(moved.started[0]?.to.account?.id, 'claude:b', 'a stopped session takes the account with room');
  assert.deepEqual(await moved.continuity.observe(line(state(30, 'ask')), { low: [] }), [], 'home at 30%, below the line: not offered');
  const [offer] = await moved.continuity.observe(line(state(60, 'ask')), { low: [] });
  assert.equal(offer?.kind === 'suggested' && offer.suggestion.kind, 'return', 'home above the line: offered');

  // The holder crosses the line (60% to 40%) with the taker at `taker`.
  const offered = async (taker: number): Promise<(string | null)[]> => {
    const at = (holder: number): Snapshot => line(snapshot([reading(claudeA, holder), reading(claudeB, taker)]));
    const { continuity } = await harness(t, { recent: { 'claude:a': session({ updatedAt: NOW - 2 * MINUTE }) } });
    const low = createQuotaWatch();
    await continuity.observe(at(60), { low: low(at(60)) });
    await continuity.observe(at(40), { low: low(at(40)) });
    return continuity.suggestions().map(s => s.target.accountId);
  };
  assert.deepEqual(await offered(45), [], 'the only taker is below the line too');
  assert.deepEqual(await offered(70), ['claude:b']);
});

test('a process that does not say what it is doing goes back once its transcript shows the turn ended', async t => {
  const at = new Date(NOW - 10 * MINUTE).toISOString();
  const line = (record: object) => `${JSON.stringify({ timestamp: at, ...record })}\n`;
  const asked = line({ type: 'user', message: { role: 'user', content: 'go on' } });
  const answered = line({
    type: 'assistant',
    message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done.' }] }
  });
  const working = line({ type: 'assistant', message: { role: 'assistant', stop_reason: 'tool_use', content: [] } });
  for (const [transcript, goesBack] of [
    [asked + answered, true],
    [asked + working, false]
  ] as const) {
    const { state } = await movedCopy(t, 'vibe-unknown-status-', transcript);
    const running = { 'claude:b': live({ status: null, statusSince: 0 }) };
    const { continuity, started } = await harness(t, { stopped: { 'claude:a': [session()] }, running });
    await continuity.observe(state(0, 'auto'), { low: [] });
    const notices = await continuity.observe(state(100, 'auto'), { low: [] });
    assert.deepEqual(
      notices.map(n => n.kind),
      goesBack ? ['returned'] : [],
      goesBack ? 'its last turn ended' : 'still working'
    );
    assert.equal(started.length, goesBack ? 2 : 1);
  }
});

test('a waiting offer shows the quota left now and who would take the work now', async t => {
  const { continuity } = await harness(t, { recent: { 'claude:a': session({ updatedAt: NOW - 10 * 1000 }) } });
  const low = createQuotaWatch();
  const watch = (state: Snapshot) => continuity.observe(state, { low: low(state) });
  await watch(snapshot([reading(claudeA, 60), reading(claudeB, 80), reading(claudeC, 50)]));
  await watch(snapshot([reading(claudeA, 19), reading(claudeB, 80), reading(claudeC, 50)]));
  const shown = () => continuity.suggestions().map(s => [s.id, s.remainingPercent, s.target.accountId]);
  assert.deepEqual(shown(), [['low:claude:a', 19, 'claude:b']]);
  await watch(snapshot([reading(claudeA, 6), reading(claudeB, 0), reading(claudeC, 50)]));
  assert.deepEqual(shown(), [['low:claude:a', 6, 'claude:c']], 'not the 19% and the account that ran out since');
});

test('the copy a session was moved with is not taken for a stop of the account it moved to', async t => {
  const { state } = await movedCopy(t, 'vibe-carried-stop-');
  const stopped: Record<string, StoppedSession[]> = { 'claude:a': [session()] };
  let now = NOW;
  const { continuity, started } = await harness(t, { stopped, clock: () => now });
  await continuity.observe(state(0, 'ask'), { low: [] });
  assert.equal(started.length, 1);
  // Until it goes on, the copy ends with the limit error it was moved for, written before the move.
  stopped['claude:a'] = [];
  stopped['claude:b'] = [session({ file: '/profiles/b/projects/-work-app/session-1.jsonl', stoppedAt: NOW - 2 * MINUTE })];
  const lowB = (at: number) => {
    const base = state(0, 'ask');
    return {
      ...base,
      providers: base.providers.map(p => ({ ...p, accounts: p.accounts.map(a => (a.id === 'claude:b' ? reading(a, at) : a)) }))
    };
  };
  assert.deepEqual(await continuity.observe(lowB(10), { low: [] }), [], 'the carried stop is the other account’s');
  assert.deepEqual(continuity.transitions().length, 1, 'no offer for it');
  assert.equal(started.length, 1);
  // A stop the copy hits later, on this account, is a stop of this account.
  now += MINUTE;
  stopped['claude:b'] = [session({ file: '/profiles/b/projects/-work-app/session-1.jsonl', stoppedAt: NOW + MINUTE })];
  assert.deepEqual(
    (await continuity.observe(lowB(10), { low: [] })).map(n => n.kind),
    ['stranded'],
    'its own stop, with no one left to take it'
  );
});

test('a waiting offer is freshened the way it was made: a stop within its scope, a stranded one not brought back', async t => {
  // Only the tool's other accounts may take it, and none can: it waits for an explicit retry.
  const stranded = await harness(t, { stopped: { 'claude:a': session() } });
  await stranded.continuity.observe(snapshot([reading(claudeA, 0), reading(claudeB, 3), reading(codex, 90)], 'accounts'), { low: [] });
  await stranded.continuity.observe(snapshot([reading(claudeA, 0), reading(claudeB, 3), reading(codex, 90)], 'accounts'), { low: [] });
  assert.deepEqual(stranded.continuity.suggestions(), [], 'not offered to another tool');
  // Offered (auto-continue off) to the other account, which then runs out: the next one in scope.
  const offered = await harness(t, { stopped: { 'claude:a': session() } });
  await offered.continuity.observe(snapshot([reading(claudeA, 0), reading(claudeB, 80), reading(claudeC, 10)]), { low: [] });
  await offered.continuity.observe(snapshot([reading(claudeA, 0), reading(claudeB, 0), reading(claudeC, 60)]), { low: [] });
  assert.deepEqual(
    offered.continuity.suggestions().map(s => [s.remainingPercent, s.target.accountId]),
    [[0, 'claude:c']]
  );
});

test('an offer kept from before for the stop a moved copy carried goes away', async t => {
  const dataDir = await tempDir(t, 'vibe-kept-carried-');
  const copy = session({ file: '/profiles/b/projects/-work-app/session-1.jsonl', stoppedAt: NOW - 3 * MINUTE });
  const id = 'low:claude:b:session-1';
  const transitionId = `${id}:${NOW}:0`;
  await fs.writeFile(
    path.join(dataDir, 'continuity.json'),
    JSON.stringify({
      handled: [],
      moved: {
        'claude:session-1': { from: 'claude:a', to: 'claude:b', projectDir: '/work/app', folder: '-work-app', at: NOW - 2 * MINUTE }
      },
      tabs: {},
      transitions: [
        {
          id: transitionId,
          suggestionId: id,
          projectDir: '/work/app',
          createdAt: NOW,
          updatedAt: NOW,
          source: { providerId: 'claude', accountId: 'claude:b', sessionId: 'session-1' },
          target: { providerId: 'cursor', accountId: 'cursor:default', sessionId: null },
          status: 'failed',
          errorCode: 'no_verified_quota'
        }
      ],
      offers: [
        {
          suggestion: {
            id,
            kind: 'low',
            providerId: 'claude',
            accountId: 'claude:b',
            remainingPercent: 0,
            target: { providerId: 'cursor', accountId: 'cursor:default' },
            projectDir: '/work/app',
            sessionProvider: 'claude'
          },
          session: copy,
          holderId: 'claude:b',
          stopped: true,
          createdAt: NOW,
          transitionId,
          stopKey: `claude:b:session-1:${copy.stoppedAt}`
        }
      ]
    })
  );
  const { continuity } = await harness(t, { dataDir });
  assert.equal(continuity.suggestions().length, 1, 'kept from before');
  await continuity.observe(snapshot([reading(claudeA, 0), reading(claudeB, 50)], 'accounts'), { low: [] });
  assert.deepEqual(continuity.suggestions(), []);
  assert.equal(continuity.transitions()[0]?.status, 'dismissed');
});

test('a stop offered outside its scope before goes back to waiting for a retry', async t => {
  const offered = await harness(t, { stopped: { 'claude:a': session() } });
  // Offered while auto-continue was off (every tool), then the user keeps work within Claude.
  await offered.continuity.observe(snapshot([reading(claudeA, 0), reading(claudeB, 3), reading(codex, 90)]), { low: [] });
  assert.deepEqual(
    offered.continuity.suggestions().map(s => s.target.accountId),
    ['codex:default']
  );
  await offered.continuity.observe(snapshot([reading(claudeA, 0), reading(claudeB, 3), reading(codex, 90)], 'accounts'), { low: [] });
  assert.deepEqual(offered.continuity.suggestions(), [], 'no card with a tool out of scope');
});

test('cut off by a limit where it moved, a session goes back to the main account once it resets, and goes on', async t => {
  const limitError = `${JSON.stringify({
    type: 'assistant',
    isApiErrorMessage: true,
    apiError: 'usage_limit_reached',
    isSidechain: false,
    cwd: '/work/app',
    timestamp: new Date(NOW + 30 * MINUTE).toISOString(),
    message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: "You've hit your session limit" }] }
  })}\n`;
  const { copy, state } = await movedCopy(t, 'vibe-cut-off-', limitError);
  let now = NOW;
  const stopped: Record<string, StoppedSession[]> = { 'claude:a': [session()] };
  const running: Record<string, LiveClaudeSession> = {};
  const tasks: BackgroundTask[] = [{ id: 'b7', command: 'npm run e2e', outputFile: null, startedAt: NOW + 10 * MINUTE }];
  const { continuity, started } = await harness(t, { stopped, running, tasks, clock: () => now });
  // Main account out: the session moves to the second one.
  await continuity.observe(state(0, 'auto'), { low: [] });
  assert.equal(started.length, 1);
  // The second account runs out too, with the main one still out: no one can take it, it waits.
  now += 31 * MINUTE;
  running['claude:b'] = live({ status: null, startedAt: NOW });
  stopped['claude:a'] = [];
  stopped['claude:b'] = [session({ file: copy, stoppedAt: NOW + 30 * MINUTE, updatedAt: NOW + 30 * MINUTE })];
  const out = (remainingA: number) => {
    const base = state(remainingA, 'auto', now);
    return {
      ...base,
      providers: base.providers.map(p => ({
        ...p,
        accounts: p.accounts.map(a => (a.id === 'claude:b' ? { ...reading(a, 0), fetchedAt: new Date(now).toISOString() } : a))
      }))
    };
  };
  assert.deepEqual(
    (await continuity.observe(out(0), { low: [] })).map(n => n.kind),
    ['stranded']
  );
  // Hours later the main account resets: back home, told to go on, without waiting for the command.
  now += 2 * 60 * MINUTE;
  const [back] = await continuity.observe(out(100), { low: [] });
  assert.equal(back?.kind, 'returned');
  const home = started[1];
  assert.ok(home);
  assert.equal(home.to.account?.id, 'claude:a');
  assert.equal(home.session.file, copy);
  assert.equal(home.running?.pid, 4242, 'its stopped process there is ended');
  assert.ok(home.prompt?.startsWith(RESUME_PROMPT), 'it goes on by itself');
  assert.ok(home.prompt?.includes('b7 (npm run e2e)'), 'not waited for: named, on the first refresh after the reset');
  assert.deepEqual(continuity.suggestions(), []);
  assert.deepEqual(
    continuity.transitions().map(r => r.status),
    ['dispatched', 'dismissed', 'dispatched'],
    'the stop that waited goes with it, so nothing starts it twice'
  );
});

test('a session whose process has not saved its conversation is never moved: it would be lost', async t => {
  const root = await tempDir(t, 'vibe-unsaved-');
  const project = path.join(root, 'project');
  const from = path.join(root, '.claude', 'projects', 'C--work-project');
  await fs.mkdir(from, { recursive: true });
  await fs.mkdir(project);
  const file = path.join(from, 'session-1.jsonl');
  await fs.writeFile(file, `${JSON.stringify({ type: 'user', cwd: project, timestamp: new Date(NOW - 10 * MINUTE).toISOString() })}\n`);
  const binary = path.join(root, 'claude');
  await fs.writeFile(binary, '');
  process.env.VIBE_CLAUDE_BINARY = binary;
  t.after(() => {
    delete process.env.VIBE_CLAUDE_BINARY;
  });
  // A child session (unlisted) started 5 minutes ago, and the transcript's last record is older: it
  // saved nothing since. A listed process saves as it goes, whatever the file's last record says.
  const running = live({ listed: false, status: null, startedAt: NOW - 5 * MINUTE });
  assert.equal(holdsUnsavedConversation(running, file), true);
  assert.equal(holdsUnsavedConversation(live({ listed: false, startedAt: NOW - 20 * MINUTE }), file), false, 'written since it started');
  assert.equal(
    holdsUnsavedConversation(live({ startedAt: NOW - 5 * MINUTE }), file),
    false,
    'listed: resumed without a prompt, nothing unsaved'
  );
  const ended: number[] = [];
  const calls: string[][] = [];
  await assert.rejects(
    continueSession(
      session({ projectDir: project, file }),
      { providerId: 'claude', account: account({ id: 'claude:b', configDir: path.join(root, '.claude-2'), primary: false }) },
      snapshot([]),
      { dataDir: root, homeDir: root, platform: 'darwin', spawnProcess: fakeSpawn(calls) },
      { running, processes: { isAlive: () => true, started: () => Promise.resolve(null), end: pid => void ended.push(pid) } }
    ),
    /session_unsaved/
  );
  assert.deepEqual([ended, calls], [[], []], 'not ended, nothing started');
  await assert.rejects(fs.access(path.join(root, '.claude-2', 'projects')), 'nothing carried');
});

test('not knowing whether a session’s process runs moves nothing and forgets nothing', async t => {
  const { state } = await movedCopy(t, 'vibe-unknown-');
  // At a stop: the stop waits for the next look instead of being handled blind.
  const stopped: Record<string, StoppedSession[]> = { 'claude:a': [session()] };
  const running: Record<string, LiveClaudeSession | 'unknown'> = { 'claude:a': 'unknown' };
  const { continuity, started } = await harness(t, { stopped, running });
  assert.deepEqual(await continuity.observe(state(0, 'auto'), { low: [] }), [], 'left for the next look');
  assert.equal(started.length, 0);
  assert.deepEqual(continuity.transitions(), [], 'not handled, not recorded');
  running['claude:a'] = live();
  assert.deepEqual(
    (await continuity.observe(state(0, 'auto'), { low: [] })).map(n => n.kind),
    ['continued'],
    'moved once the process could be seen'
  );
  // On the way back: a failed lookup is not "closed where it ran".
  running['claude:b'] = 'unknown';
  assert.deepEqual(await continuity.observe(state(100, 'auto'), { low: [] }), []);
  running['claude:b'] = live({ startedAt: NOW - 20 * MINUTE });
  assert.deepEqual(
    (await continuity.observe(state(100, 'auto'), { low: [] })).map(n => n.kind),
    ['returned'],
    'still remembered, back once the process could be seen'
  );
});

test('accepting an offer while the process cannot be looked up fails safely, to be retried', async t => {
  // Offered (auto-continue off), the stop needs no lookup; accepting it does.
  const out = snapshot([reading(claudeA, 0), reading(claudeB, 80)]);
  const { continuity, started } = await harness(t, { stopped: { 'claude:a': [session()] }, running: { 'claude:a': 'unknown' } });
  await continuity.observe(out, { low: [] });
  await assert.rejects(continuity.accept('low:claude:a:session-1', out), /process_unknown/);
  assert.equal(started.length, 0);
  assert.equal(continuity.transitions()[0]?.errorCode, 'process_unknown');
});

test('the history keeps settled records to its cap and never drops one still live', async t => {
  const dataDir = await tempDir(t, 'vibe-cap-');
  const { state } = await movedCopy(t, 'vibe-cap-copy-');
  const stopped: Record<string, StoppedSession[]> = { 'claude:a': [session()] };
  const running: Record<string, LiveClaudeSession> = { 'claude:b': live({ startedAt: NOW - 20 * MINUTE }) };
  let now = NOW;
  const { continuity, started } = await harness(t, { stopped, running, dataDir, clock: () => now, fails: n => n === 2, historyCap: 20 });
  await continuity.observe(state(0, 'auto'), { low: [] });
  await continuity.observe(state(100, 'auto', now), { low: [] });
  assert.equal(started.length, 2, 'moved, then a return that failed');
  const failed = continuity.transitions().find(r => r.status === 'failed');
  assert.ok(failed);
  // Hundreds of stops of another session settle behind it.
  for (let n = 0; n < 25; n++) {
    now += MINUTE;
    stopped['claude:a'] = [session({ sessionId: `other-${n}`, stoppedAt: now, updatedAt: now })];
    await continuity.observe(state(0, 'auto', now), { low: [] });
  }
  const records = continuity.transitions();
  assert.ok(
    records.some(r => r.id === failed.id && r.status === 'failed'),
    'the failed return is still there'
  );
  assert.ok(records.length <= 20 + 3, 'settled records are capped');
  const restarted = await harness(t, { stopped, running, dataDir, clock: () => now, historyCap: 20 });
  assert.ok(
    restarted.continuity.transitions().some(r => r.id === failed.id),
    'and survives a restart'
  );
  assert.deepEqual(await restarted.continuity.observe(state(100, 'auto', now), { low: [] }), [], 'not retried on its own');
});

test('a stop seen on stale readings waits for fresh ones instead of being stranded', async t => {
  const stopped: Record<string, StoppedSession[]> = { 'claude:a': [session()] };
  const { continuity, started } = await harness(t, { stopped, running: { 'claude:a': live() } });
  const stale = (measured: MeasuredAccount) => ({ ...measured, fetchedAt: new Date(NOW - 6 * MINUTE).toISOString() });
  const old = snapshot([reading(claudeA, 0), stale(reading(claudeB, 90))], 'accounts');
  assert.deepEqual(await continuity.observe(old, { low: [] }), [], 'nothing can be said about B yet');
  assert.deepEqual(continuity.transitions(), []);
  const refreshing = { ...snapshot([reading(claudeA, 0), reading(claudeB, 0)], 'accounts'), refreshing: true };
  assert.deepEqual(await continuity.observe(refreshing, { low: [] }), [], 'readings on their way');
  assert.deepEqual(
    (await continuity.observe(snapshot([reading(claudeA, 0), reading(claudeB, 90)], 'accounts'), { low: [] })).map(n => n.kind),
    ['continued']
  );
  assert.equal(started.length, 1);
  // Fresh readings that leave no one: stranded, once, however often the session stops again.
  const none = await harness(t, { stopped: { 'claude:a': [session()] } });
  const out = snapshot([reading(claudeA, 0), reading(claudeB, 3)], 'accounts');
  assert.deepEqual(
    (await none.continuity.observe(out, { low: [] })).map(n => n.kind),
    ['stranded']
  );
  stopped['claude:a'] = [session({ stoppedAt: NOW - MINUTE })];
  assert.deepEqual(await none.continuity.observe(out, { low: [] }), [], 'the same session, stranded already');
  assert.equal(none.continuity.transitions().length, 1, 'one record for it');
});

test('a session started on another account but never seen running there is reported, once', async t => {
  const { state } = await movedCopy(t, 'vibe-pickup-');
  let now = NOW;
  const { continuity, started } = await harness(t, {
    stopped: { 'claude:a': [session()] },
    running: { 'claude:a': live() },
    clock: () => now
  });
  assert.deepEqual(
    (await continuity.observe(state(0, 'auto'), { low: [] })).map(n => n.kind),
    ['continued']
  );
  assert.equal(started.length, 1);
  now += MINUTE;
  assert.deepEqual(await continuity.observe(state(0, 'auto', now), { low: [] }), [], 'given a few minutes');
  now += 3 * MINUTE;
  const [notice] = await continuity.observe(state(0, 'auto', now), { low: [] });
  assert.equal(notice?.kind === 'failed' && notice.code, 'not_picked_up');
  assert.equal(continuity.transitions()[0]?.errorCode, 'not_picked_up');
  assert.deepEqual(await continuity.observe(state(0, 'auto', now), { low: [] }), [], 'said once');
});

test('a running-low card for a session that can no longer be found goes away', async t => {
  const recent: Record<string, RecentSession> = { 'claude:a': session({ updatedAt: NOW - 10 * 1000 }) };
  const { continuity } = await harness(t, { recent });
  const low = createQuotaWatch();
  const at = (remaining: number) => snapshot([reading(claudeA, remaining), reading(claudeB, 80)]);
  await continuity.observe(at(60), { low: low(at(60)) });
  await continuity.observe(at(15), { low: low(at(15)) });
  assert.deepEqual(
    continuity.suggestions().map(s => s.id),
    ['low:claude:a']
  );
  delete recent['claude:a'];
  await continuity.observe(at(15), { low: low(at(15)) });
  assert.deepEqual(continuity.suggestions(), [], 'the session is gone');
  assert.equal(continuity.transitions()[0]?.status, 'dismissed');
});

test('a session skipping permission prompts moves only to a profile that agreed to that', async t => {
  const root = await tempDir(t, 'vibe-bypass-');
  const project = path.join(root, 'project');
  const from = path.join(root, '.claude', 'projects', 'C--work-project');
  await fs.mkdir(from, { recursive: true });
  await fs.mkdir(project);
  const file = path.join(from, 'session-1.jsonl');
  await fs.writeFile(
    file,
    `${JSON.stringify({ type: 'user', cwd: project, permissionMode: 'bypassPermissions', timestamp: new Date(NOW).toISOString(), message: { role: 'user', content: 'go' } })}\n`
  );
  const binary = path.join(root, 'claude');
  await fs.writeFile(binary, '');
  process.env.VIBE_CLAUDE_BINARY = binary;
  t.after(() => {
    delete process.env.VIBE_CLAUDE_BINARY;
  });
  const target = account({ id: 'claude:b', configDir: path.join(root, '.claude-2'), primary: false });
  await fs.mkdir(target.configDir ?? '', { recursive: true });
  const move = () =>
    continueSession(
      session({ projectDir: project, file }),
      { providerId: 'claude', account: target },
      snapshot([]),
      { dataDir: root, homeDir: root, platform: 'darwin', spawnProcess: fakeSpawn([]) },
      {}
    );
  await fs.writeFile(path.join(target.configDir ?? '', '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true }));
  await assert.rejects(move(), /bypass_not_consented/);
  await fs.writeFile(
    path.join(target.configDir ?? '', '.claude.json'),
    JSON.stringify({ hasCompletedOnboarding: true, bypassPermissionsModeAccepted: true })
  );
  assert.equal((await move()).resumed, true);
});

// Two profiles as Claude Code keeps them, and the window's state with the main one at
// `remainingA` and the spare one at 80%.
async function restartProfiles(t: TestContext) {
  const root = await tempDir(t, 'vibe-restart-');
  const main = account({ id: 'claude:a', configDir: path.join(root, 'a'), primary: true });
  const spare = account({ id: 'claude:b', configDir: path.join(root, 'b'), primary: false });
  const write = async (profile: Account, sessionId: string): Promise<string> => {
    const file = path.join(profile.configDir ?? '', 'projects', '-work-app', `${sessionId}.jsonl`);
    const record = {
      type: 'user',
      cwd: '/work/app',
      sessionId,
      timestamp: new Date(NOW - 10 * MINUTE).toISOString(),
      message: { role: 'user', content: 'go' }
    };
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `${JSON.stringify(record)}\n`);
    return file;
  };
  const state = (remainingA: number, reopenAfterRestart: ReopenAfterRestart, returnToPrimary: ReturnToPrimary = 'auto'): Snapshot => {
    const base = snapshot([reading(main, remainingA), reading(spare, 80)], 'accounts');
    return { ...base, settings: { ...base.settings, reopenAfterRestart, returnToPrimary, accounts: [main, spare] } };
  };
  return { main, spare, write, state, dataDir: await tempDir(t, 'vibe-restart-data-') };
}

const opened = (sessionId: string, fields: Partial<LiveClaudeSession> = {}): OpenClaudeSession => ({
  ...live({ sessionId, ...fields }),
  cwd: '/work/app'
});

test('sessions open when the system went down open again where they ran, and a turn under way goes on', async t => {
  const { main, write, state, dataDir } = await restartProfiles(t);
  const file = await write(main, 'session-1');
  await write(main, 'session-2');
  const before = await harness(t, { dataDir, open: { 'claude:a': [opened('session-1', { status: 'busy' }), opened('session-2')] } });
  assert.deepEqual(await before.continuity.observe(state(80, 'auto'), { low: [] }), []);
  // The system goes down: the app is not quit, and nothing is open after the restart.
  const after = await harness(t, { dataDir });
  const notices = await after.continuity.observe(state(80, 'auto'), { low: [] });
  assert.deepEqual(
    notices.map(n => n.kind),
    ['reopened', 'reopened']
  );
  const [first, second] = after.started;
  assert.ok(first && second);
  assert.equal(first.session.file, file);
  assert.equal(first.session.projectDir, '/work/app', 'in the folder it ran in');
  assert.equal(first.to.account?.id, 'claude:a', 'on the account it ran on');
  assert.equal(first.prompt, RESTART_PROMPT, 'its turn was under way: it goes on');
  assert.equal(first.running, null, 'nothing runs it any more');
  assert.equal(first.tab, null, 'its tab went with the system');
  assert.equal(second.prompt, undefined, 'one waiting for the user opens and waits');
  assert.deepEqual(await after.continuity.observe(state(80, 'auto'), { low: [] }), [], 'once');
});

test('reopening rechecks both automation permission and the profiles covered by its process preflight', { timeout: 10_000 }, async t => {
  for (const changed of ['ask', 'off', 'another profile'] as const) {
    const { main, write, state, dataDir } = await restartProfiles(t);
    await write(main, 'session-1');
    const before = await harness(t, { dataDir, open: { [main.id]: [opened('session-1')] } });
    await before.continuity.observe(state(80, 'auto'), { low: [] });
    const checking = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    let firstLookup = true;
    let current = state(80, 'auto');
    const after = await harness(t, {
      dataDir,
      options: {
        getCurrentSnapshot: () => Promise.resolve(current),
        findRunning: async () => {
          if (firstLookup) {
            firstLookup = false;
            checking.resolve(undefined);
            await release.promise;
          }
          return { kind: 'none' };
        }
      }
    });
    const observing = after.continuity.observe(current, { low: [] });
    await checking.promise;
    current = {
      ...current,
      settings: {
        ...current.settings,
        ...(changed === 'another profile' ? { accounts: [...current.settings.accounts, claudeC] } : { reopenAfterRestart: changed })
      }
    };
    release.resolve(undefined);
    assert.deepEqual(
      (await observing).map(notice => notice.kind),
      ['suggested']
    );
    assert.equal(after.started.length, 0, `${changed}: old permission or an incomplete profile scan cannot reopen a session`);
    assert.equal(after.continuity.transitions()[0]?.status, 'offered');
  }
});

test('a state written before records named their session still opens its sessions again', async t => {
  const { main, write, state, dataDir } = await restartProfiles(t);
  await write(main, 'session-1');
  const before = await harness(t, { dataDir, open: { 'claude:a': [opened('session-1', { status: 'busy' })] } });
  await before.continuity.observe(state(80, 'auto'), { low: [] });
  // As the previous version wrote it: the session only in each record's key.
  const file = path.join(dataDir, 'continuity.json');
  const stored: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.ok(isObject(stored) && isObject(stored.open));
  const legacyOpen = Object.fromEntries(
    Object.entries(stored.open).map(([key, record]) => {
      assert.ok(isObject(record));
      const { sessionId: _sessionId, ...rest } = record;
      return [key, rest];
    })
  );
  await fs.writeFile(file, JSON.stringify({ ...stored, open: legacyOpen }));
  const after = await harness(t, { dataDir });
  const notices = await after.continuity.observe(state(80, 'auto'), { low: [] });
  assert.deepEqual(
    notices.map(n => n.kind),
    ['reopened']
  );
  const [reopened] = after.started;
  assert.ok(reopened);
  assert.deepEqual([reopened.session.sessionId, reopened.prompt], ['session-1', RESTART_PROMPT]);
});

test('a session closed while the app watched, or while it was quit, stays closed', async t => {
  const { main, write, state, dataDir } = await restartProfiles(t);
  await write(main, 'session-1');
  await write(main, 'session-2');
  const open: Record<string, OpenClaudeSession[]> = { 'claude:a': [opened('session-1'), opened('session-2')] };
  const watched = await harness(t, { dataDir, open });
  await watched.continuity.observe(state(80, 'auto'), { low: [] });
  open['claude:a'] = [opened('session-2')];
  await watched.continuity.observe(state(80, 'auto'), { low: [] });
  const restarted = await harness(t, { dataDir });
  await restarted.continuity.observe(state(80, 'auto'), { low: [] });
  assert.deepEqual(
    restarted.started.map(s => s.session.sessionId),
    ['session-2'],
    'only the one still open when the system went down'
  );

  const quitData = await tempDir(t, 'vibe-quit-data-');
  const quit = await harness(t, { dataDir: quitData, open: { 'claude:a': [opened('session-1')] } });
  await quit.continuity.observe(state(80, 'auto'), { low: [] });
  quit.continuity.quit();
  const next = await harness(t, { dataDir: quitData });
  assert.deepEqual(await next.continuity.observe(state(80, 'auto'), { low: [] }), []);
  assert.equal(next.started.length, 0, 'closed after the app was quit: the user’s doing');
});

test('sessions cut off by a crash long before the app starts again are not reopened', async t => {
  const { main, write, state, dataDir } = await restartProfiles(t);
  await write(main, 'session-1');
  const before = await harness(t, { dataDir, open: { 'claude:a': [opened('session-1', { status: 'busy' })] } });
  await before.continuity.observe(state(80, 'auto'), { low: [] });
  // The system went down then; the app is started again two days later.
  const later = NOW + 2 * 24 * 60 * MINUTE;
  const after = await harness(t, { dataDir, clock: () => later });
  assert.deepEqual(await after.continuity.observe(state(80, 'auto'), { low: [] }), []);
  assert.equal(after.started.length, 0);
});

test('a session moved off its main account goes back there if it has room, else opens where it ran, still followed', async t => {
  for (const [remainingA, expected] of [
    [100, 'claude:a'],
    [0, 'claude:b']
  ] as const) {
    const { spare, write, state, dataDir } = await restartProfiles(t);
    const copy = await write(spare, 'session-1');
    const before = await harness(t, {
      dataDir,
      stopped: { 'claude:a': [session()] },
      open: { 'claude:b': [opened('session-1', { status: 'busy' })] }
    });
    await before.continuity.observe(state(0, 'auto'), { low: [] });
    assert.equal(before.started[0]?.to.account?.id, 'claude:b', 'moved off the main account');
    const after = await harness(t, { dataDir });
    const [notice] = await after.continuity.observe(state(remainingA, 'auto'), { low: [] });
    assert.equal(notice?.kind, 'reopened');
    const [reopened] = after.started;
    assert.ok(reopened);
    assert.equal(reopened.session.file, copy, 'from the copy where it ran');
    assert.equal(reopened.to.account?.id, expected);
    assert.equal(reopened.prompt, RESTART_PROMPT);
    if (expected === 'claude:b') {
      // Its move is not forgotten: once the main account has room, it is offered back.
      const [back] = await after.continuity.observe(state(100, 'auto', 'ask'), { low: [] });
      assert.equal(back?.kind === 'suggested' && back.suggestion.id, 'return:claude:session-1');
    }
  }
  // Waiting to be reopened, it is not taken for one closed where it ran: its move stands.
  const { spare, write, state, dataDir } = await restartProfiles(t);
  await write(spare, 'session-1');
  const before = await harness(t, { dataDir, stopped: { 'claude:a': [session()] }, open: { 'claude:b': [opened('session-1')] } });
  await before.continuity.observe(state(0, 'auto'), { low: [] });
  const after = await harness(t, { dataDir });
  await after.continuity.observe(state(0, 'ask'), { low: [] });
  assert.deepEqual(await after.continuity.observe(state(100, 'ask', 'auto'), { low: [] }), []);
  await after.continuity.accept('reopen:claude:session-1', state(100, 'ask', 'auto'));
  assert.equal(after.started[0]?.to.account?.id, 'claude:b', 'where it was offered');
  const [back] = await after.continuity.observe(state(100, 'ask', 'ask'), { low: [] });
  assert.equal(back?.kind === 'suggested' && back.suggestion.id, 'return:claude:session-1');
});

test('asked, a session cut off is offered once; not knowing what is open, or one opened by hand, offers nothing', async t => {
  const { main, write, state, dataDir } = await restartProfiles(t);
  await write(main, 'session-1');
  await write(main, 'session-2');
  const before = await harness(t, { dataDir, open: { 'claude:a': [opened('session-1'), opened('session-2')] } });
  await before.continuity.observe(state(80, 'ask'), { low: [] });
  const open: Record<string, OpenClaudeSession[] | 'unknown'> = { 'claude:a': 'unknown' };
  const after = await harness(t, { dataDir, open });
  assert.deepEqual(await after.continuity.observe(state(80, 'ask'), { low: [] }), [], 'nothing is decided unseen');
  // The user opened session-2 again by hand meanwhile.
  open['claude:a'] = [opened('session-2')];
  const [offered] = await after.continuity.observe(state(80, 'ask'), { low: [] });
  assert.equal(offered?.kind === 'suggested' && offered.suggestion.id, 'reopen:claude:session-1');
  assert.deepEqual(
    after.continuity.suggestions().map(s => [s.kind, s.target.accountId]),
    [['reopen', 'claude:a']]
  );
  assert.deepEqual(await after.continuity.observe(state(80, 'ask'), { low: [] }), [], 'offered once');
  assert.equal(await after.continuity.isRunning('reopen:claude:session-1'), false);
  await after.continuity.accept('reopen:claude:session-1', state(80, 'ask'));
  assert.deepEqual(
    after.started.map(s => [s.session.sessionId, s.prompt]),
    [['session-1', undefined]]
  );
  assert.deepEqual(after.continuity.suggestions(), []);

  const off = await restartProfiles(t);
  await off.write(off.main, 'session-1');
  const watching = await harness(t, { dataDir: off.dataDir, open: { 'claude:a': [opened('session-1')] } });
  await watching.continuity.observe(off.state(80, 'off'), { low: [] });
  const restarted = await harness(t, { dataDir: off.dataDir });
  assert.deepEqual(await restarted.continuity.observe(off.state(80, 'off'), { low: [] }), []);
  assert.deepEqual(await restarted.continuity.observe(off.state(80, 'auto'), { low: [] }), [], 'off forgets it');
  assert.equal(restarted.started.length, 0);
});

test('a positive open-session observation withdraws a reopen even when another profile cannot be scanned', async t => {
  const { main, write, state, dataDir } = await restartProfiles(t);
  await write(main, 'session-1');
  const before = await harness(t, { dataDir, open: { [main.id]: [opened('session-1')] } });
  await before.continuity.observe(state(80, 'ask'), { low: [] });
  const open: Record<string, OpenClaudeSession[] | 'unknown'> = {};
  const after = await harness(t, { dataDir, open });
  await after.continuity.observe(state(80, 'ask'), { low: [] });
  assert.equal(after.continuity.suggestions().length, 1);
  open[main.id] = [opened('session-1', { status: 'busy' })];
  open['claude:b'] = 'unknown';
  await after.continuity.observe(state(80, 'ask'), { low: [] });
  assert.deepEqual(after.continuity.suggestions(), [], 'an unrelated scan failure never erases a live process');
  await assert.rejects(after.continuity.accept('reopen:claude:session-1', state(80, 'ask')), /suggestion_expired/);
  assert.equal(after.started.length, 0);
});

test('reopening checks the exact session again at dispatch and never restarts a live or unknown copy', async t => {
  for (const [holderId, lookupResult] of [
    ['claude:a', 'found'],
    ['claude:b', 'found'],
    ['claude:a', 'unknown'],
    ['claude:b', 'unknown']
  ] as const) {
    const { main, write, state, dataDir } = await restartProfiles(t);
    await write(main, 'session-1');
    const before = await harness(t, { dataDir, open: { [main.id]: [opened('session-1')] } });
    await before.continuity.observe(state(80, 'ask'), { low: [] });
    const running: Record<string, LiveClaudeSession | 'unknown'> = {};
    const after = await harness(t, { dataDir, running, open: { 'claude:b': 'unknown' } });
    await after.continuity.observe(state(80, 'ask'), { low: [] });
    assert.equal(after.continuity.suggestions().length, 1);
    // The user opens a copy, or the targeted process query fails, after the offer was made.
    running[holderId] = lookupResult === 'found' ? live({ status: 'busy' }) : 'unknown';
    assert.equal(await after.continuity.isRunning('reopen:claude:session-1', state(80, 'ask')), true);
    await assert.rejects(
      after.continuity.accept('reopen:claude:session-1', state(80, 'ask')),
      lookupResult === 'found' ? /suggestion_expired/ : /process_unknown/
    );
    assert.equal(after.started.length, 0, `${holderId} ${lookupResult}: no duplicate process is dispatched`);
    assert.equal(
      after.continuity.suggestions().length,
      lookupResult === 'found' ? 0 : 1,
      'unknown remains available for a safe explicit retry'
    );
    if (lookupResult === 'unknown') {
      Reflect.deleteProperty(running, holderId);
      await after.continuity.accept('reopen:claude:session-1', state(80, 'ask'));
      assert.equal(after.started.length, 1, 'a subsequent targeted proof of absence permits reopening');
    }
  }
});
