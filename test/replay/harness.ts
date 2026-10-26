// Replays a recorded timeline through the real continuity logic: each moment's sessions,
// transcripts and processes are laid out in a temporary home, the real finders read them, and
// only starting a process is faked (recorded instead). What the logic did at each moment is
// compared with what the rules say it should have done (expected.json, written by hand).
//
// A timeline is a folder of moments, replayed in name order. A moment holds:
//   clock.txt                                   the moment's time (ISO)
//   snapshot.json                               the service snapshot; settings are completed
//                                               with the defaults
//   processes.json                              { alive: pid[], system: SystemProcess[], unknown?: true }
//                                               (system: the processes the system lists, with starts)
//                                               (unknown: the system can say neither which run
//                                               nor when one started)
//   sessions/<profile>/<file>                   Claude Code's sessions/ folder of a profile
//   transcripts/<profile>/<project>/<id>.tail.jsonl
//                                               a transcript's last records
//   mtimes.json (optional)                      { "<profile>/<project>/<id>": ISO } file times
//                                               (default: the moment's time)
//   moment.json (optional)                      { "restart": true } recreates the app state from disk;
//                                               { "accept": [card id] } clicks those cards after the
//                                               refresh (a refusal is recorded by its code)
//   expected.json                               what should happen (see Expected)
// `<home>` in any string stands for the replay's home folder and `<clock>` for the moment's time.
// REPLAY_DEBUG=1 prints the stored continuity state after each moment.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { endClaudeSession, findClaudeProcess, type ProcessControl, type SystemProcess } from '../../src/core/claude-processes.ts';
import {
  carryClaudeSession,
  createContinuity,
  findRecentSession,
  findStoppedSessions,
  holdsUnsavedConversation,
  RESUME_PROMPT,
  type ContinueResult
} from '../../src/core/continuity.ts';
import { createQuotaWatch } from '../../src/core/glance.ts';
import { AppError, systemErrorCode } from '../../src/core/errors.ts';
import { defaultSettings } from '../../src/core/settings.ts';
import type { Account, Snapshot } from '../../src/shared/types.ts';

export interface StartRecord {
  sessionId: string;
  from: string | null;
  to: string | null;
  // How the session was told to go on: the resume prompt, another prompt (the return prompt that
  // names background commands, say: not a fault), or none.
  prompt: 'resume' | 'other' | 'none';
}

export interface MomentResult {
  moment: string;
  starts: StartRecord[];
  notices: string[];
  cards: string[];
  refusals: string[];
}

// Each field that is present is compared exactly; a missing one is not checked.
export type Expected = Partial<Omit<MomentResult, 'moment'>> & { note?: string };

interface Processes {
  alive: number[];
  system: SystemProcess[];
  unknown?: boolean;
}

const readJsonFile = async <T>(file: string, fallback: T): Promise<T> => {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T;
  } catch (error) {
    if (systemErrorCode(error) === 'ENOENT') return fallback;
    throw error;
  }
};

// Replaces the placeholders in every string of a JSON value.
function resolve<T>(value: T, home: string, clock: string): T {
  return JSON.parse(
    JSON.stringify(value, (_key, item: unknown) =>
      typeof item === 'string' ? item.replaceAll('<home>', home.replaceAll('\\', '/')).replaceAll('<clock>', clock) : item
    )
  ) as T;
}

async function listFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []);
  return entries.filter(entry => entry.isFile()).map(entry => path.relative(dir, path.join(entry.parentPath, entry.name)));
}

// The profile folders of the home: `.claude` and every `.claude-*`, as the moment names them.
async function layOut(momentDir: string, home: string, clock: number): Promise<void> {
  for (const profile of await fs.readdir(home).catch(() => []))
    if (profile === '.claude' || profile.startsWith('.claude-')) await fs.rm(path.join(home, profile), { recursive: true, force: true });
  const mtimes = await readJsonFile<Record<string, string>>(path.join(momentDir, 'mtimes.json'), {});
  for (const file of await listFiles(path.join(momentDir, 'sessions'))) {
    const [profile = '', ...rest] = file.split(path.sep);
    const target = path.join(home, profile, 'sessions', ...rest);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(path.join(momentDir, 'sessions', file), target);
  }
  for (const file of await listFiles(path.join(momentDir, 'transcripts'))) {
    if (!file.endsWith('.tail.jsonl')) continue;
    const [profile = '', project = '', name = ''] = file.split(path.sep);
    const id = name.slice(0, -'.tail.jsonl'.length);
    const target = path.join(home, profile, 'projects', project, `${id}.jsonl`);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(path.join(momentDir, 'transcripts', file), target);
    const stamp = mtimes[`${profile}/${project}/${id}`];
    const at = new Date(stamp ? Date.parse(stamp) : clock);
    await fs.utimes(target, at, at);
  }
}

const promptKind = (prompt: string | undefined): StartRecord['prompt'] =>
  prompt === undefined ? 'none' : prompt.startsWith(RESUME_PROMPT) ? 'resume' : 'other';

// Replays the timeline and returns what happened at each moment, with what was expected.
export async function replay(timelineDir: string): Promise<{ result: MomentResult; expected: Expected }[]> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-replay-home-'));
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-replay-data-'));
  try {
    let now = 0;
    let processes: Processes = { alive: [], system: [] };
    let started: StartRecord[] = [];
    const watchLow = createQuotaWatch();
    const unavailable = () => new Error('the system cannot say');
    // The system as the moment recorded it. A process's start comes from the system list; a live
    // one missing from it is taken as gone by the time it would be ended.
    const control: ProcessControl = {
      isAlive: pid => processes.alive.includes(pid),
      list: () => (processes.unknown ? Promise.reject(unavailable()) : Promise.resolve(processes.system)),
      started: pid => {
        if (processes.unknown) return Promise.reject(unavailable());
        const listed = processes.system.find(p => p.pid === pid);
        return Promise.resolve(listed ? { at: listed.at, ticks: listed.ticks } : null);
      },
      end: () => undefined
    };
    const create = () =>
      createContinuity({
        homeDir: home,
        dataDir,
        launch: { dataDir, homeDir: home },
        clock: () => now,
        findSession: (account: Account, identity) => findRecentSession(account, home, identity),
        findStopped: (account: Account) => findStoppedSessions(account, home, now),
        findRunning: (account: Account, sessionId: string) =>
          findClaudeProcess(account.configDir ?? path.join(home, '.claude'), sessionId, control),
        // Starting is recorded, not done; the checks a real move makes first are made (a process
        // that holds unsaved work, or whose end cannot be told, keeps the session), and the
        // transcript is carried as a real move carries it.
        start: async (session, to, _state, _context, options): Promise<ContinueResult> => {
          if (options?.running && (await holdsUnsavedConversation(options.running, session.file))) throw new AppError('session_unsaved');
          if (options?.running && (await endClaudeSession(options.running, control)) === 'unknown') throw new AppError('process_unknown');
          started.push({
            sessionId: session.sessionId,
            from: session.accountId ?? null,
            to: to.account?.id ?? null,
            prompt: promptKind(options?.prompt)
          });
          const resumed = session.providerId === 'claude' && to.providerId === 'claude' && Boolean(to.account?.configDir);
          if (resumed && to.account?.configDir) await carryClaudeSession(session, to.account.configDir);
          return { to: to.providerId, accountId: to.account?.id ?? null, resumed, mode: 'terminal', tab: null };
        }
      });
    let continuity = await create();
    const moments = (await fs.readdir(timelineDir, { withFileTypes: true }))
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .sort();
    const out: { result: MomentResult; expected: Expected }[] = [];
    for (const moment of moments) {
      const dir = path.join(timelineDir, moment);
      const clockText = (await fs.readFile(path.join(dir, 'clock.txt'), 'utf8')).trim();
      now = Date.parse(clockText);
      if (!Number.isFinite(now)) throw new Error(`${moment}: clock.txt is not a time`);
      const clock = new Date(now).toISOString();
      const plan = await readJsonFile<{ restart?: boolean; accept?: string[] }>(path.join(dir, 'moment.json'), {});
      if (plan.restart) continuity = await create();
      await layOut(dir, home, now);
      processes = resolve(await readJsonFile<Processes>(path.join(dir, 'processes.json'), { alive: [], system: [] }), home, clock);
      const recorded = resolve(await readJsonFile<Partial<Snapshot>>(path.join(dir, 'snapshot.json'), {}), home, clock);
      const snapshot: Snapshot = {
        refreshing: false,
        providers: recorded.providers ?? [],
        settings: { ...defaultSettings(), ...recorded.settings }
      };
      started = [];
      const notices = await continuity.observe(snapshot, { low: watchLow(snapshot) });
      const refusals = notices.flatMap(n => (n.kind === 'failed' ? [n.code] : []));
      // The cards the user clicked at this moment, after the refresh, as a click accepts them.
      for (const id of plan.accept ?? [])
        await continuity.accept(id, snapshot).catch((error: unknown) => {
          refusals.push(error instanceof AppError ? error.code : 'unexpected');
        });
      if (process.env.REPLAY_DEBUG)
        console.log(moment, await fs.readFile(path.join(dataDir, 'continuity.json'), 'utf8').catch(() => '(none)'));
      out.push({
        result: {
          moment,
          starts: started,
          notices: notices.map(n => n.kind),
          cards: continuity.suggestions().map(s => s.id),
          refusals
        },
        expected: await readJsonFile<Expected>(path.join(dir, 'expected.json'), {})
      });
    }
    return out;
  } finally {
    await fs.rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
}

// The fields of `expected` that are given, taken from `result`, for a whole-object comparison.
export function comparable(result: MomentResult, expected: Expected): { actual: Expected; wanted: Expected } {
  const keys = (['starts', 'notices', 'cards', 'refusals'] as const).filter(key => expected[key] !== undefined);
  return {
    actual: Object.fromEntries(keys.map(key => [key, result[key]])),
    wanted: Object.fromEntries(keys.map(key => [key, expected[key]]))
  };
}
