// Keeping work going when a limit runs out, and bringing it back.
//
// The trigger is the tool's own record that its agent stopped at the usage limit, never a
// quota percentage: at "5% left" the agent is still working, and starting a second one on the
// same folder would have two agents editing the same files. Every refresh looks again (state,
// not edges), and each stop is acted on once, remembered across restarts. The work goes to the
// account with real room left, never to one about to run out.
//
// - Opted in (`autoContinue`), each stopped session continues on its own; otherwise it is offered.
// - An account running low offers to continue its recent session elsewhere.
// - When the tool's main account has room again, work moved off it goes back (`returnToPrimary`):
//   offered, or on its own once the session sits idle with nothing left running.
// - Sessions open when the system went down (a restart, a crash, a power cut) open again where
//   they left off (`reopenAfterRestart`): offered, or on their own. The app tells that apart from
//   the user closing them by its own end: a run it was not quit from ended with the system.
//
// A Claude Code session moves between profiles whole: the process running it is ended once its
// copy is ready, so only one agent ever works on it, and in a tab the app opened the session
// goes on in that same tab. Background commands cannot change process, so the session is told
// which ones its previous process left running. Any other move continues from a handover brief.
import { randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { CLAUDE_FILES, claudeStateFile } from '../providers/claude.ts';
import { defaultProfileDir } from '../providers/profiles.ts';
import {
  APP_NAME,
  CLAUDE_EFFORT_LEVELS,
  DURATION_MS,
  INHERIT,
  isOneOf,
  isProfileProvider,
  isProviderId,
  normalizeProviderOrder,
  providerById,
  SUGGESTION_KINDS,
  TRANSITION_STATUSES,
  type ClaudeEffortLevel,
  type ProviderId
} from '../shared/catalog.ts';
import type { LaunchMode } from '../shared/ipc.ts';
import type { Account, AutoContinue, ErrorCode, MeasuredAccount, Snapshot, Suggestion, TransitionRecord } from '../shared/types.ts';
import {
  endClaudeSession,
  findClaudeProcess,
  openSessionsReader,
  systemProcesses,
  type LiveClaudeSession,
  type OpenClaudeSession,
  type ProcessControl,
  type ProcessEnd,
  type ProcessLookup
} from './claude-processes.ts';
import { AppError } from './errors.ts';
import {
  isDirectory,
  isObject,
  JSON_LINES_EXTENSION,
  readJson,
  samePath,
  writeFileAtomic,
  writeFileAtomicSync,
  type JsonObject
} from './files.ts';
import type { QuotaAlert } from './glance.ts';
import { executeHandover, mappedModels, type LaunchContext } from './handover.ts';
import { launchTool, writeHandoff, type ToolLaunch } from './launch.ts';
import { projectPreference } from './settings.ts';
import {
  chooseSuccessor,
  continueScope,
  headroomPercent,
  isAccountEligible,
  isMeasurementFresh,
  SUCCESSOR_MIN_HEADROOM_PERCENT,
  type ContinueScope,
  type Successor
} from './selection.ts';
import {
  claudeBackgroundTasks,
  claudeLastWrittenAt,
  claudeLimitStop,
  claudeLimitStops,
  claudeSessionById,
  claudeSessionMode,
  claudeTranscriptWrite,
  claudeTurnEnded,
  codexLimitStops,
  isRecentStop,
  latestClaudeSession,
  latestCodexSession,
  latestCursorSession,
  recentSessionModel,
  type BackgroundTask,
  type RecentSession,
  type TranscriptWrite,
  type SessionIdentity,
  type StoppedSession
} from './sessions.ts';

// A stop older than this is history: the user has moved on, or the limit has reset.
const STOP_MAX_AGE_MS = 30 * DURATION_MS.MINUTE;
// A session written this recently, and not stopped, is taken to be running in its terminal.
const RUNNING_SESSION_MS = DURATION_MS.MINUTE;
// A running low account's session is still worth continuing from a suggestion within this.
const RECENT_SESSION_MS = 3 * DURATION_MS.HOUR;
// A suggestion to move work back stays this long.
const RETURN_SUGGESTION_MS = 12 * DURATION_MS.HOUR;
// A session goes back on its own only after sitting idle this long: the user is not at it.
const RETURN_QUIET_MS = 2 * DURATION_MS.MINUTE;
// Background commands still running hold a session back this long at most; after that it goes
// back and is told about them.
export const RETURN_TASK_WAIT_MS = 30 * DURATION_MS.MINUTE;
// A moved session is remembered this long for the way back.
const MOVED_MAX_AGE_MS = 7 * DURATION_MS.DAY;
// A session cut off by the system going down is offered to reopen this long.
const REOPEN_SUGGESTION_MS = DURATION_MS.DAY;
// How long a tab gets to pick up its next command before a new tab is opened instead.
const HANDOFF_PICKUP_MS = 5000;
const HANDOFF_POLL_MS = 100;
const STATE_FILE = 'continuity.json';
const TABS_DIR = 'tabs';
const MAX_HANDLED_STOPS = 200;
const MAX_LISTED_TASKS = 10;
const MAX_TASK_TEXT = 200;

// Written for the agent that resumes the session, so it is deliberately not localized.
export const RESUME_PROMPT =
  'Your previous turn was cut off by a usage limit on another account. Continue the task exactly where it stopped; run `git status` first to see what is already done.';
export const RETURN_PROMPT = 'This session moved back to its main account.';
export const RESTART_PROMPT =
  'The computer went down while this session was open, and your last turn did not finish. Background commands and subagents started before did not survive it. Continue the task exactly where it stopped; run `git status` first to see what is already done.';

// Text from a transcript, made safe for a one-line prompt: no line breaks or control characters.
// eslint-disable-next-line no-control-regex -- matching control characters is the purpose
const BREAKS = /[\u0000-\u001f\u007f\s]+/g;
const oneLine = (text: string): string => text.replace(BREAKS, ' ').trim().slice(0, MAX_TASK_TEXT);

// `prompt`, telling the agent which background commands its previous process left running.
function withBackgroundTasks(prompt: string, tasks: readonly BackgroundTask[]): string {
  if (!tasks.length) return prompt;
  const listed = tasks
    .slice(0, MAX_LISTED_TASKS)
    .map(task => `${task.id} (${oneLine(task.command) || 'command'}${task.outputFile ? `, output: ${oneLine(task.outputFile)}` : ''})`)
    .join('; ');
  return `${prompt} Background tasks started before the move may still be running; they stay with the previous process, so you will not be notified when they finish: ${listed}. Read their output files to see how far they got, and start again only what you still need.`;
}

export async function findRecentSession(account: Account, homeDir: string, identity?: SessionIdentity): Promise<RecentSession | null> {
  let session: RecentSession | null;
  switch (account.providerId) {
    case 'claude':
      session = latestClaudeSession(account.configDir ?? defaultProfileDir('claude', homeDir), identity);
      break;
    case 'codex':
      session = await latestCodexSession(account.configDir ?? defaultProfileDir('codex', homeDir), identity);
      break;
    case 'cursor':
      session = latestCursorSession(homeDir, identity);
      break;
    case 'antigravity':
      session = null;
  }
  return session ? { ...session, accountId: account.id, model: await recentSessionModel(session).catch(() => '') } : null;
}

// The account's sessions whose agent stopped at the usage limit recently, newest first. Only
// Claude Code and Codex record such a stop.
export async function findStoppedSessions(account: Account, homeDir: string, now = Date.now()): Promise<StoppedSession[]> {
  let sessions: StoppedSession[] = [];
  if (account.providerId === 'claude')
    sessions = claudeLimitStops(account.configDir ?? defaultProfileDir('claude', homeDir), now, STOP_MAX_AGE_MS);
  if (account.providerId === 'codex')
    sessions = await codexLimitStops(account.configDir ?? defaultProfileDir('codex', homeDir), now, STOP_MAX_AGE_MS);
  return Promise.all(
    sessions.map(async session => ({ ...session, accountId: account.id, model: await recentSessionModel(session).catch(() => '') }))
  );
}

// The newest of them.
export async function findStoppedSession(account: Account, homeDir: string, now = Date.now()): Promise<StoppedSession | null> {
  return (await findStoppedSessions(account, homeDir, now))[0] ?? null;
}

// Where a Claude Code transcript lands in another profile: under the same project folder.
const carriedTranscript = (session: RecentSession, configDir: string): string =>
  path.join(configDir, CLAUDE_FILES.projects, path.basename(path.dirname(session.file)), path.basename(session.file));

// Copies a Claude Code transcript (and the folder of subagent transcripts and large tool
// results named after it) into another profile, under the same project, so that profile can
// resume it. A newer copy replaces an older one; the source is left as it is. A copy there that
// the session went on in (a later record, or more of the same) is never overwritten. File
// times say nothing about that: a copy keeps its source's, and Claude Code touches files late.
export async function carryClaudeSession(session: RecentSession, configDir: string): Promise<void> {
  const sourceDir = path.dirname(session.file);
  const targetDir = path.dirname(carriedTranscript(session, configDir));
  if (samePath(sourceDir, targetDir)) return;
  const target = path.join(targetDir, path.basename(session.file));
  const source = claudeTranscriptWrite(session.file);
  const existing = claudeTranscriptWrite(target);
  if (!source) throw new AppError('session_not_found');
  if (existing && isNewerWrite(existing, source)) throw new AppError('session_newer_elsewhere');
  await fsp.mkdir(targetDir, { recursive: true, mode: 0o700 });
  await fsp.copyFile(session.file, target);
  const extras = path.join(sourceDir, session.sessionId);
  if (await isDirectory(extras)) await fsp.cp(extras, path.join(targetDir, session.sessionId), { recursive: true, force: true });
  // The project's memory (the rules and facts the agent keeps) goes along, where it is not
  // there yet; what the session writes elsewhere comes home the same way.
  const memory = path.join(sourceDir, 'memory');
  if (await isDirectory(memory))
    await fsp.cp(memory, path.join(targetDir, 'memory'), { recursive: true, force: false, errorOnExist: false });
}

// Whether `a` went on past `b`: a later record, or the same last record and more bytes after it.
const isNewerWrite = (a: TranscriptWrite, b: TranscriptWrite): boolean =>
  Number.isFinite(a.lastRecordAt) && (!Number.isFinite(b.lastRecordAt) || a.lastRecordAt > b.lastRecordAt)
    ? true
    : a.lastRecordAt === b.lastRecordAt && a.size > b.size;

// Whether the profile recorded consent to sessions that skip permission prompts.
async function bypassConsented(account: Account, home: string | undefined): Promise<boolean> {
  const state = await readJson(claudeStateFile(account, home));
  return isObject(state) && state.bypassPermissionsModeAccepted === true;
}

// The effort level a Claude Code profile sets for `model` (its own setting, else the general one).
async function claudeEffort(configDir: string, model: string | undefined): Promise<ClaudeEffortLevel | undefined> {
  const settings = await readJson(path.join(configDir, CLAUDE_FILES.settings));
  if (!isObject(settings)) return undefined;
  const perModel = isObject(settings.modelSettings) && model ? settings.modelSettings[model] : undefined;
  const effort = isObject(perModel) && perModel.effortLevel !== undefined ? perModel.effortLevel : settings.effortLevel;
  return isOneOf(CLAUDE_EFFORT_LEVELS, effort) ? effort : undefined;
}

export interface ContinueResult {
  to: ProviderId;
  accountId: string | null;
  // The session itself continues (rather than a new one from a brief).
  resumed: boolean;
  mode: LaunchMode;
  // The handoff file of the app tab the session now runs in.
  tab?: string | null;
}

export interface MoveOptions {
  // Makes a resumed session go on by itself; without it the session opens and waits.
  prompt?: string | undefined;
  // The process running the session now. It is ended once the copy is ready.
  running?: LiveClaudeSession | null | undefined;
  // The handoff file of the app tab running it, to go on in that tab.
  tab?: string | null | undefined;
  processes?: ProcessControl | undefined;
}

async function pickedUp(file: string): Promise<boolean> {
  for (const deadline = Date.now() + HANDOFF_PICKUP_MS; Date.now() < deadline;) {
    if (!(await fsp.stat(file).catch(() => null))) return true;
    await new Promise(resolve => setTimeout(resolve, HANDOFF_POLL_MS));
  }
  return false;
}

// A process that lists itself saves its session as it goes. One that does not (a child
// session) holds its conversation in memory only: unless its transcript was written since it
// started, ending it and going on from the file would lose what was said since. (A listed
// process resumed without a prompt writes nothing until the user types; it has nothing unsaved.)
const SAVED_SLACK_MS = 2_000;
export function holdsUnsavedConversation(running: LiveClaudeSession, file: string): boolean {
  if (running.listed) return false;
  const written = claudeLastWrittenAt(file);
  return !Number.isFinite(written) || written < running.startedAt - SAVED_SLACK_MS;
}

// Ends the session's current process and starts it as `launch`: in the same tab when the app
// opened that tab and it takes the next command, else in a new tab of its own. A process that
// cannot be ended keeps the session: it is never started a second time beside it. A process
// found gone (or its pid now another's) has nothing to end.
async function relaunchClaude(launch: ToolLaunch, { running, tab, processes = systemProcesses }: MoveOptions): Promise<ContinueResult> {
  const result = { to: 'claude' as const, accountId: launch.account?.id ?? null, resumed: true };
  const windows = (launch.platform ?? process.platform) === 'win32';
  const refusal = (end: ProcessEnd): AppError | null => (end === 'unknown' ? new AppError('process_unknown') : null);
  if (running && tab && windows && (await writeHandoff(tab, launch))) {
    const end = await endClaudeSession(running, processes);
    if (end === 'ended' && (await pickedUp(tab))) return { ...result, mode: 'terminal', tab };
    // Not taken: the tab was closed meanwhile, or the process could not be ended.
    await fsp.rm(tab, { force: true });
    const refused = refusal(end);
    if (refused) throw refused;
  } else if (running) {
    const refused = refusal(await endClaudeSession(running, processes));
    if (refused) throw refused;
  }
  const next = windows ? path.join(launch.dataDir, TABS_DIR, `${randomUUID()}.json`) : null;
  if (next) await fsp.mkdir(path.dirname(next), { recursive: true });
  const { mode } = await launchTool({ ...launch, handoff: next ?? undefined });
  return { ...result, mode, tab: next };
}

// A Claude Code session moves whole to another Claude Code profile: its transcript is carried
// and resumed there. Any other move starts the target tool from a handover brief.
const movesWhole = (from: ProviderId, to: ProviderId): boolean => from === 'claude' && to === 'claude';

export async function continueSession(
  session: RecentSession,
  to: Successor,
  state: Snapshot,
  context: LaunchContext,
  options: MoveOptions = {}
): Promise<ContinueResult> {
  const { dataDir, homeDir, platform, spawnProcess } = context;
  const { prompt } = options;
  if (movesWhole(session.providerId, to.providerId) && to.account?.configDir) {
    if (options.running && holdsUnsavedConversation(options.running, session.file)) throw new AppError('session_unsaved');
    await carryClaudeSession(session, to.account.configDir);
    // The session goes on as it ran: same model (unless the project picks one), permission mode
    // and effort, whatever the other profile's own settings say. The transcript sits in
    // <profile>/projects/<project>/.
    const { model, permissionMode } = claudeSessionMode(session.file);
    // A session that skips permissions runs so only where the user consented to it in that
    // profile; Claude Code would otherwise stop at the question (or quietly run without).
    if (permissionMode === 'bypassPermissions' && !(await bypassConsented(to.account, homeDir))) throw new AppError('bypass_not_consented');
    const effort = await claudeEffort(path.resolve(path.dirname(session.file), '..', '..'), model);
    return relaunchClaude(
      {
        providerId: 'claude',
        account: to.account,
        cwd: session.projectDir,
        dataDir,
        resume: session.sessionId,
        model: to.model || model,
        permissionMode,
        effort,
        prompt,
        title: `${APP_NAME} · ${providerById('claude').name}`,
        platform,
        spawnProcess,
        accounts: state.settings.accounts,
        homeDir
      },
      options
    );
  }
  const result = await executeHandover(
    {
      projectDir: session.projectDir,
      fromProvider: session.providerId,
      toProvider: to.providerId,
      sessionId: session.sessionId,
      sessionProvider: session.providerId,
      account: to.account,
      ...(to.model ? { targetModel: to.model } : {}),
      sourceAccountId: session.accountId
    },
    state,
    context
  );
  return { to: result.to, accountId: to.account?.id ?? null, resumed: false, mode: result.mode };
}

// The moves the app follows a whole session for, by the kind of their suggestion. A failed one
// is told apart from a failed move off an account that ran out.
const ATTEMPTS = ['return', 'reopen'] as const satisfies readonly Suggestion['kind'][];
export type Attempt = (typeof ATTEMPTS)[number];

// What happened, for the app to tell the user.
export type Notice =
  | { kind: 'suggested'; suggestion: Suggestion }
  | { kind: 'continued'; from: MeasuredAccount; to: Successor; result: ContinueResult; projectDir: string }
  // Went back to the tool's main account, which has room again.
  | { kind: 'returned'; from: MeasuredAccount; to: Successor; result: ContinueResult; projectDir: string }
  // Open again after the system went down with it.
  | { kind: 'reopened'; from: MeasuredAccount; to: Successor; result: ContinueResult; projectDir: string }
  // Stopped at the limit, and no account or tool has enough verified quota to take over.
  | { kind: 'stranded'; from: MeasuredAccount }
  // What could not be done: work moved off an account that ran out, or (`attempt`) brought back
  // to its main account, or opened again after the system went down.
  | { kind: 'failed'; from: MeasuredAccount; code: ErrorCode; attempt?: Attempt };

export interface Continuity {
  // Looks at the accounts (and the accounts crossing the low line in `low`) and acts.
  // A supplier is read inside the serialized queue, not when the observation is enqueued.
  observe(
    snapshot: Snapshot | (() => Promise<Snapshot>),
    alerts: { low: readonly QuotaAlert[] | ((snapshot: Snapshot) => readonly QuotaAlert[]) }
  ): Promise<Notice[]>;
  suggestions(): Suggestion[];
  // Whether the suggestion's session still looks busy in its terminal (written moments ago).
  isRunning(id: string, snapshot?: Snapshot): Promise<boolean>;
  accept(id: string, snapshot: Snapshot): Promise<ContinueResult>;
  dismiss(id: string): void;
  transitions(): TransitionRecord[];
  retry(id: string, snapshot: Snapshot): Promise<ContinueResult>;
  // The app is being quit on purpose: sessions open now and gone by its next start were closed,
  // not cut off by the system. Written at once, as the app ends right after.
  quit(): void;
}

export interface ContinuityOptions {
  homeDir: string;
  dataDir: string;
  launch: LaunchContext;
  findSession?: (account: Account, identity?: SessionIdentity) => Promise<RecentSession | null>;
  findStopped?: (account: Account) => Promise<StoppedSession[]>;
  // The process running a Claude Code session in the account's profile, when that can be told.
  findRunning?: (account: Account, sessionId: string) => Promise<ProcessLookup>;
  findTasks?: (file: string) => Promise<BackgroundTask[]>;
  // The interactive Claude Code sessions open in the account's profile now; throws when that
  // cannot be told.
  findOpen?: (account: Account) => Promise<OpenClaudeSession[]>;
  // Reload shared settings after waiting for process/transcript checks and before dispatch.
  getCurrentSnapshot?: () => Promise<Snapshot>;
  start?: typeof continueSession;
  clock?: () => number;
  // How many settled history records are kept.
  historyCap?: number;
}

interface Offer {
  suggestion: Suggestion;
  session: RecentSession;
  // The account whose session it is (the one that ran low, or the one holding the work).
  holder: Account;
  to: Successor;
  // The session stopped at the limit: it resumes with a prompt to go on.
  stopped: boolean;
  createdAt: number;
  transitionId: string;
  // When the stop it continues happened (an offer for a stopped session).
  stoppedAt?: number;
  // The moved session this offer brings back to its main account.
  returning?: string;
  // The session cut off by the system going down that this offer opens again.
  reopening?: string;
}

// No side effect occurred: a changed setting needs a fresh decision, not a failed launch.
// Manual callers receive the existing stale-suggestion error; automatic callers keep an offer.
class DispatchDeferred extends AppError {
  constructor() {
    super('suggestion_expired');
  }
}

// Persist only identifiers and session locations, never account credentials or transcript text:
// the holder by its id, the target from the suggestion.
type StoredOffer = Omit<Offer, 'holder' | 'to'> & { holderId: string };
// A Claude Code session moved off `from` and now in `to`'s profile, for the way back.
interface Moved {
  sessionId: string;
  from: string;
  to: string;
  projectDir: string;
  // The project folder's name under <profile>/projects/.
  folder: string;
  at: number;
}
// A whole session started on another account, until it is seen running there: its process
// listed, or its copy written since. One never seen was not picked up.
interface Dispatch {
  sessionId: string;
  holderId: string;
  // The copy the other account resumes.
  file: string;
  at: number;
  // The move it was, when one the app follows the session for.
  attempt?: Attempt;
}
// A Claude Code session seen open: in which account's profile, the folder it ran in, whether a
// turn was under way, and when it was seen (or, cut off, found gone).
interface Open {
  sessionId: string;
  accountId: string;
  cwd: string;
  busy: boolean;
  at: number;
}
const PICKUP_MAX_MS = 3 * DURATION_MS.MINUTE;
// While the system cannot be asked, a dispatch is given this long before it is given up on.
const PICKUP_UNKNOWN_MAX_MS = 30 * DURATION_MS.MINUTE;
interface StoredState {
  handled: string[];
  offers: StoredOffer[];
  transitions: TransitionRecord[];
  moved: Record<string, Moved>;
  // The handoff file of the app tab each session runs in.
  tabs: Record<string, string>;
  dispatched: Record<string, Dispatch>;
  // When each session was first ready to go back but held by background commands.
  holding: Record<string, number>;
  // The sessions open at the app's last look.
  open: Record<string, Open>;
  // The sessions that were open when the system went down, until they open again.
  interrupted: Record<string, Open>;
  // Whether the app's last run ended by being quit, rather than with the system.
  quit: boolean;
}
const TERMINAL_STATUSES: ReadonlySet<TransitionRecord['status']> = new Set(['dispatched', 'dismissed', 'interrupted']);
// An offer stands only with its record still offered, or failed and waiting for a retry.
const OFFER_STATUSES: ReadonlySet<TransitionRecord['status']> = new Set(['offered', 'failed']);
// The history keeps its newest settled records; one still live (offered, under way, or failed
// with its offer still there to retry) is never dropped, however old.
function capRecords(records: readonly TransitionRecord[], liveIds: ReadonlySet<string>, cap: number): TransitionRecord[] {
  const settled = records.filter(r => TERMINAL_STATUSES.has(r.status) || (r.status === 'failed' && !liveIds.has(r.id)));
  const dropped = new Set(settled.slice(0, Math.max(0, settled.length - cap)));
  return records.filter(r => !dropped.has(r));
}
// The keys of the state's maps and the ids of its offers, each made here and only ever compared:
// what a record is about travels in its own fields.
const keys = {
  session: (session: Pick<RecentSession, 'providerId' | 'sessionId'>): string => `${session.providerId}:${session.sessionId}`,
  stop: (accountId: string, sessionId: string, stoppedAt: number): string => `${accountId}:${sessionId}:${stoppedAt}`
};
// One standing offer per account running low, per stopped session, and per session to open
// again or bring back.
const suggestionIds = {
  low: (accountId: string): string => `low:${accountId}`,
  stop: (accountId: string, sessionId: string): string => `low:${accountId}:${sessionId}`,
  reopen: (sessionKey: string): string => `reopen:${sessionKey}`,
  return: (sessionKey: string): string => `return:${sessionKey}`
};

// State written before its records carried what they are about (until 0.1.1) named the session
// only in its key, `<provider>:<session>`, and an offer's stop only as `<account>:<session>:<at>`.
// They are read from there this once, when such a state is loaded; nothing else takes a key apart.
const legacy = {
  sessionId: (key: string): string => key.slice(key.indexOf(':') + 1),
  stoppedAt: (stopKey: string): number | undefined => {
    const at = Number(stopKey.slice(stopKey.lastIndexOf(':') + 1));
    return Number.isFinite(at) ? at : undefined;
  }
};
// A stored offer's stop: its own field, or the time in the key it was stored with before.
function stoppedAtOf(entry: JsonObject): { stoppedAt?: number } {
  const at =
    typeof entry.stoppedAt === 'number' ? entry.stoppedAt : typeof entry.stopKey === 'string' ? legacy.stoppedAt(entry.stopKey) : undefined;
  return at === undefined ? {} : { stoppedAt: at };
}
// A stored record with its session, from its own field or, written before it had one, its key.
function withSession(key: string, value: JsonObject): JsonObject {
  return typeof value.sessionId === 'string' ? value : { ...value, sessionId: legacy.sessionId(key) };
}
const isDispatch = (value: unknown): value is Dispatch =>
  isObject(value) &&
  typeof value.sessionId === 'string' &&
  typeof value.holderId === 'string' &&
  typeof value.file === 'string' &&
  typeof value.at === 'number' &&
  (value.attempt === undefined || isOneOf(ATTEMPTS, value.attempt));
const isOpen = (value: unknown): value is Open =>
  isObject(value) &&
  typeof value.sessionId === 'string' &&
  typeof value.accountId === 'string' &&
  typeof value.cwd === 'string' &&
  typeof value.busy === 'boolean' &&
  typeof value.at === 'number';
const isMoved = (value: unknown): value is Moved =>
  isObject(value) &&
  typeof value.sessionId === 'string' &&
  typeof value.from === 'string' &&
  typeof value.to === 'string' &&
  typeof value.projectDir === 'string' &&
  typeof value.folder === 'string' &&
  typeof value.at === 'number';
// The stored map's records that pass `is`, each given its session first.
function storedRecords<T>(value: unknown, is: (record: unknown) => record is T): Record<string, T> {
  if (!isObject(value)) return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, record]) => {
      const current = isObject(record) ? withSession(key, record) : record;
      return is(current) ? [[key, current]] : [];
    })
  );
}
const SAFE_ERRORS = [
  'launch_failed',
  'no_verified_quota',
  'suggestion_expired',
  'account_not_found',
  'binary_missing',
  'app_not_found',
  'cursor_agent_missing',
  'session_not_found',
  'session_newer_elsewhere',
  'session_still_running',
  'session_unsaved',
  'process_unknown',
  'not_picked_up',
  'bypass_not_consented'
] as const satisfies readonly ErrorCode[];
const errorCode = (error: unknown): ErrorCode =>
  error instanceof AppError && isOneOf(SAFE_ERRORS, error.code) ? error.code : 'launch_failed';
const sameSession = (a: RecentSession, b: RecentSession): boolean =>
  a.providerId === b.providerId && a.sessionId === b.sessionId && samePath(a.projectDir, b.projectDir);
const validSession = (value: unknown): value is RecentSession =>
  isObject(value) &&
  isProviderId(value.providerId) &&
  typeof value.sessionId === 'string' &&
  typeof value.projectDir === 'string' &&
  typeof value.file === 'string' &&
  typeof value.updatedAt === 'number' &&
  Number.isFinite(value.updatedAt);
const validTarget = (value: unknown): value is JsonObject & Suggestion['target'] =>
  isObject(value) && isProviderId(value.providerId) && (typeof value.accountId === 'string' || value.accountId === null);

async function loadState(file: string, historyCap: number): Promise<StoredState> {
  const document = await readJson(file);
  const state: StoredState = {
    handled: [],
    offers: [],
    transitions: [],
    moved: {},
    tabs: {},
    dispatched: {},
    holding: {},
    open: {},
    interrupted: {},
    // A state from before the app kept this says nothing about how it ended: taken as quit.
    quit: true
  };
  if (!isObject(document)) return state;
  if (Array.isArray(document.handled))
    state.handled = document.handled.filter((k): k is string => typeof k === 'string').slice(-MAX_HANDLED_STOPS);
  if (Array.isArray(document.transitions))
    for (const record of document.transitions) {
      if (
        !isObject(record) ||
        typeof record.id !== 'string' ||
        typeof record.suggestionId !== 'string' ||
        typeof record.projectDir !== 'string' ||
        typeof record.createdAt !== 'number' ||
        typeof record.updatedAt !== 'number' ||
        !validTarget(record.source) ||
        typeof record.source.accountId !== 'string' ||
        typeof record.source.sessionId !== 'string' ||
        !validTarget(record.target) ||
        !(record.target.sessionId === null || typeof record.target.sessionId === 'string') ||
        !isOneOf(TRANSITION_STATUSES, record.status)
      )
        continue;
      state.transitions.push({
        id: record.id,
        suggestionId: record.suggestionId,
        projectDir: record.projectDir,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        source: { providerId: record.source.providerId, accountId: record.source.accountId, sessionId: record.source.sessionId },
        target: { providerId: record.target.providerId, accountId: record.target.accountId, sessionId: record.target.sessionId },
        status: record.status === 'dispatching' ? 'interrupted' : record.status,
        errorCode: isOneOf(SAFE_ERRORS, record.errorCode) ? record.errorCode : null
      });
    }
  if (Array.isArray(document.offers))
    for (const entry of document.offers.slice(-MAX_HANDLED_STOPS)) {
      if (
        !isObject(entry) ||
        !validSession(entry.session) ||
        typeof entry.holderId !== 'string' ||
        typeof entry.stopped !== 'boolean' ||
        typeof entry.createdAt !== 'number' ||
        typeof entry.transitionId !== 'string' ||
        !isObject(entry.suggestion)
      )
        continue;
      const s = entry.suggestion;
      if (
        typeof s.id !== 'string' ||
        !isOneOf(SUGGESTION_KINDS, s.kind) ||
        !isProviderId(s.providerId) ||
        typeof s.accountId !== 'string' ||
        typeof s.remainingPercent !== 'number' ||
        !validTarget(s.target) ||
        typeof s.projectDir !== 'string' ||
        !isProviderId(s.sessionProvider)
      )
        continue;
      if (!state.transitions.some(r => r.id === entry.transitionId && OFFER_STATUSES.has(r.status))) continue;
      state.offers.push({
        suggestion: {
          id: s.id,
          kind: s.kind,
          providerId: s.providerId,
          accountId: s.accountId,
          remainingPercent: s.remainingPercent,
          target: { providerId: s.target.providerId, accountId: s.target.accountId },
          projectDir: s.projectDir,
          sessionProvider: s.sessionProvider
        },
        session: {
          providerId: entry.session.providerId,
          sessionId: entry.session.sessionId,
          projectDir: entry.session.projectDir,
          file: entry.session.file,
          updatedAt: entry.session.updatedAt,
          ...(typeof entry.session.model === 'string' ? { model: entry.session.model } : {})
        },
        holderId: entry.holderId,
        stopped: entry.stopped,
        createdAt: entry.createdAt,
        transitionId: entry.transitionId,
        ...stoppedAtOf(entry),
        ...(typeof entry.returning === 'string' ? { returning: entry.returning } : {}),
        ...(typeof entry.reopening === 'string' ? { reopening: entry.reopening } : {})
      });
    }
  state.moved = storedRecords(document.moved, isMoved);
  // A dispatch kept its session's key in a field of its own before (`key`).
  state.dispatched = storedRecords(
    isObject(document.dispatched)
      ? Object.fromEntries(
          Object.entries(document.dispatched).map(([id, record]) => [
            id,
            isObject(record) && typeof record.key === 'string' && record.sessionId === undefined
              ? { ...record, sessionId: legacy.sessionId(record.key) }
              : record
          ])
        )
      : undefined,
    isDispatch
  );
  if (isObject(document.holding))
    state.holding = Object.fromEntries(
      Object.entries(document.holding).filter((entry): entry is [string, number] => typeof entry[1] === 'number')
    );
  if (isObject(document.tabs))
    state.tabs = Object.fromEntries(
      Object.entries(document.tabs).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    );
  state.open = storedRecords(document.open, isOpen);
  state.interrupted = storedRecords(document.interrupted, isOpen);
  if (typeof document.quit === 'boolean') state.quit = document.quit;
  state.transitions = capRecords(state.transitions, new Set(state.offers.map(o => o.transitionId)), historyCap);
  return state;
}

// Each Claude Code process's start is checked once per run of the app.
function defaultFindOpen(homeDir: string): (account: Account) => Promise<OpenClaudeSession[]> {
  const read = openSessionsReader();
  return account => read(account.configDir ?? defaultProfileDir('claude', homeDir));
}

export async function createContinuity({
  homeDir,
  dataDir,
  launch,
  findSession = (account, identity) => findRecentSession(account, homeDir, identity),
  findStopped = account => findStoppedSessions(account, homeDir),
  findRunning = (account, sessionId) => findClaudeProcess(account.configDir ?? defaultProfileDir('claude', homeDir), sessionId),
  findTasks = claudeBackgroundTasks,
  findOpen = defaultFindOpen(homeDir),
  getCurrentSnapshot,
  start = continueSession,
  clock = Date.now,
  historyCap = MAX_HANDLED_STOPS
}: ContinuityOptions): Promise<Continuity> {
  const file = path.join(dataDir, STATE_FILE);
  const stored = await loadState(file, historyCap);
  const handled = new Set(stored.handled);
  const records = stored.transitions;
  const moved = new Map(Object.entries(stored.moved));
  const tabs = new Map(Object.entries(stored.tabs));
  const dispatched = new Map(Object.entries(stored.dispatched));
  const holding = new Map(Object.entries(stored.holding));
  let open = new Map(Object.entries(stored.open));
  const interrupted = new Map(Object.entries(stored.interrupted));
  // How the app's previous run ended, until this run has looked at what is open now.
  let previousQuit: boolean | null = stored.quit;
  const unsettledAccounts = new Set(!stored.quit ? [...open.values()].map(entry => entry.accountId) : []);
  let quitting = false;
  const isQuitting = (): boolean => quitting;
  const offers = new Map<string, Offer>(
    stored.offers.map(o => [
      o.suggestion.id,
      {
        ...o,
        holder: { id: o.holderId, providerId: o.session.providerId, enabled: true, primary: false },
        to: { providerId: o.suggestion.target.providerId, account: null }
      }
    ])
  );
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task);
    queue = run.catch(() => undefined);
    return run;
  };
  const liveIds = (): Set<string> => new Set([...offers.values()].map(o => o.transitionId));
  const serialize = (): string =>
    JSON.stringify({
      handled: [...handled].slice(-MAX_HANDLED_STOPS),
      transitions: capRecords(records, liveIds(), historyCap),
      offers: [...offers.values()].slice(-MAX_HANDLED_STOPS).map(o => ({
        suggestion: o.suggestion,
        session: o.session,
        holderId: o.holder.id,
        stopped: o.stopped,
        createdAt: o.createdAt,
        transitionId: o.transitionId,
        stoppedAt: o.stoppedAt,
        returning: o.returning,
        reopening: o.reopening
      })),
      moved: Object.fromEntries(moved),
      tabs: Object.fromEntries(tabs),
      dispatched: Object.fromEntries(dispatched),
      holding: Object.fromEntries(holding),
      open: Object.fromEntries(open),
      interrupted: Object.fromEntries(interrupted),
      // Until this run has looked, how the last one ended still stands.
      quit: quitting || (previousQuit ?? false)
    });
  // A write still under way when the app is quit lands after quit()'s own: it is written again,
  // so the next start does not take a quit for the system going down.
  const save = async (): Promise<void> => {
    await writeFileAtomic(file, serialize());
    if (quitting) writeFileAtomicSync(file, serialize());
  };
  const accountOf = (snapshot: Snapshot, id: string | null): Account | null =>
    snapshot.settings.accounts.find(a => a.id === id && a.enabled) ?? null;
  const measuredOf = (snapshot: Snapshot, id: string): MeasuredAccount | null =>
    snapshot.providers.flatMap(p => p.accounts).find(a => a.id === id) ?? null;
  const roomy = (snapshot: Snapshot, id: string, model?: string, minHeadroom = SUCCESSOR_MIN_HEADROOM_PERCENT): boolean =>
    !!accountOf(snapshot, id) &&
    isAccountEligible(measuredOf(snapshot, id), { now: clock(), model }) &&
    (headroomPercent(measuredOf(snapshot, id), model) ?? 0) >= minHeadroom;
  // The room an account needs to count as not running low: above the user's low line. An
  // account that ran low or stopped has room again only then, and work that is not stopped
  // (running low, going home, reopening at home) only moves to an account with as much, or it
  // would be offered away again at once. A stopped session takes any account with some room.
  const lowLine = (snapshot: Snapshot): number => Math.max(SUCCESSOR_MIN_HEADROOM_PERCENT, snapshot.settings.lowQuotaPercent);
  const recovered = (snapshot: Snapshot, id: string, model?: string): boolean => roomy(snapshot, id, model, lowLine(snapshot));
  // Whether some account that could take work from `from` has no fresh reading: nothing can be
  // said yet about whether it would.
  function unmeasured(snapshot: Snapshot, from: Account, scope: ContinueScope): boolean {
    const order = normalizeProviderOrder(snapshot.settings.providerOrder);
    return snapshot.settings.accounts
      .filter(a => a.enabled && a.id !== from.id && (scope === 'tools' ? order.includes(a.providerId) : a.providerId === from.providerId))
      .some(a => {
        // Not attempted yet this run (pending, or a reading remembered from before), or a good
        // reading too old to count. A reading that failed is an answer: it says no.
        const measured = measuredOf(snapshot, a.id);
        if (!measured) return false;
        if (measured.status === 'pending') return true;
        if (measured.status === 'stale') return !measured.messageCode;
        return measured.status === 'ok' && !isMeasurementFresh(measured, clock());
      });
  }
  // A time ahead of the clock (a touched file, a clock that moved) is as fresh as it gets.
  const fresh = (session: RecentSession, maxAge: number): boolean => clock() - session.updatedAt <= maxAge;
  const freshStop = (stoppedAt: number | undefined): boolean => isRecentStop(stoppedAt, clock(), STOP_MAX_AGE_MS);
  const offerFresh = (pending: Offer): boolean =>
    pending.stopped ? freshStop(pending.stoppedAt) : fresh(pending.session, RECENT_SESSION_MS);
  // When a transcript was last written, by its records; one that says nothing is taken as now.
  const writtenAt = (write: TranscriptWrite): number => (Number.isFinite(write.lastRecordAt) ? write.lastRecordAt : clock());
  async function recent(account: Account | null, maxAge: number, identity?: SessionIdentity): Promise<RecentSession | null> {
    const session = account ? await findSession(account, identity).catch(() => null) : null;
    return session && fresh(session, maxAge) && (!identity || sameSession(session, { ...session, ...identity })) ? session : null;
  }
  // Whether the session waits for the user: as its process says, or, when the process does not
  // say, as its transcript shows (its last turn ended).
  // A session cut off by a usage limit waits too: it cannot go on where it is.
  const cutOff = (file: string): boolean => claudeLimitStop(file) !== null;
  const waiting = (process: LiveClaudeSession, file: string): boolean =>
    cutOff(file) || (process.status !== null ? process.status === 'idle' : claudeTurnEnded(file));
  // An offer for a whole session the app follows (back home, or open again): it stands however
  // long the session sat idle.
  const followed = (pending: Offer): boolean => pending.returning !== undefined || pending.reopening !== undefined;
  const expired = (pending: Offer): boolean =>
    (pending.suggestion.kind === 'return' && clock() - pending.createdAt > RETURN_SUGGESTION_MS) ||
    (pending.suggestion.kind === 'reopen' && clock() - pending.createdAt > REOPEN_SUGGESTION_MS);
  // The process running a Claude Code session, as far as it can be told; a failure to ask is
  // `unknown`, never "none".
  async function lookup(account: Account, session: Pick<RecentSession, 'providerId' | 'sessionId'>): Promise<ProcessLookup> {
    if (session.providerId !== 'claude') return { kind: 'none' };
    try {
      return await findRunning(account, session.sessionId);
    } catch (error) {
      return { kind: 'unknown', reason: error instanceof Error ? error.message : String(error) };
    }
  }
  // Reopening must prove absence for this exact session, including a copy the user may
  // have resumed in another profile. Positive evidence wins over an unrelated failure.
  async function reopenLookup(session: RecentSession, accounts: readonly Account[]): Promise<ProcessLookup> {
    let result: ProcessLookup = { kind: 'none' };
    for (const account of accounts.filter(account => account.enabled && account.providerId === 'claude')) {
      const found = await lookup(account, session);
      if (found.kind === 'found') return found;
      if (found.kind === 'unknown') result = found;
    }
    return result;
  }
  // The background commands the process started that have not finished.
  async function openTasks(session: RecentSession, process: LiveClaudeSession | null): Promise<BackgroundTask[]> {
    if (!process) return [];
    const tasks = await findTasks(session.file).catch(() => []);
    return tasks.filter(task => task.startedAt >= process.startedAt);
  }
  // How the offer's session moves: its process ended while it waits (a busy one the user chose
  // to leave running is not), told what it left running, in the tab it runs in.
  async function moveOptions(pending: Offer, session: RecentSession, holder: Account, snapshot: Snapshot): Promise<MoveOptions> {
    // The crash observation can be old: recheck immediately before dispatch. Reopening
    // never kills a process that the user already restarted in the meantime.
    if (pending.reopening) {
      const found = await reopenLookup(session, snapshot.settings.accounts);
      if (found.kind === 'found') throw new AppError('suggestion_expired');
      if (found.kind === 'unknown') throw new AppError('process_unknown');
      const busy = interrupted.get(pending.reopening)?.busy ?? false;
      return { prompt: busy || cutOff(session.file) ? RESTART_PROMPT : undefined, running: null };
    }
    const found = await lookup(holder, session);
    // Not knowing whether it still runs, the session is left where it is: it could be started
    // twice otherwise.
    if (found.kind === 'unknown') throw new AppError('process_unknown');
    const process = found.kind === 'found' ? found.process : null;
    const ending = process && (pending.stopped || waiting(process, session.file)) ? process : null;
    const tasks = await openTasks(session, ending);
    // A session cut off by a limit is told to go on, wherever it moves (back home included).
    const prompt =
      pending.stopped || (session.providerId === 'claude' && cutOff(session.file))
        ? withBackgroundTasks(RESUME_PROMPT, tasks)
        : pending.returning && tasks.length
          ? withBackgroundTasks(RETURN_PROMPT, tasks)
          : undefined;
    return { prompt, running: ending, tab: tabs.get(keys.session(session)) };
  }
  // Remembers where a whole session went, for the way back to the account it first left; one
  // back there is home.
  function recordMove(session: RecentSession, from: Account, to: Successor, result: ContinueResult): void {
    const key = keys.session(session);
    if (result.tab) tabs.set(key, result.tab);
    if (!to.account) return;
    const origin = moved.get(key)?.from ?? from.id;
    if (origin === to.account.id) moved.delete(key);
    else
      moved.set(key, {
        sessionId: session.sessionId,
        from: origin,
        to: to.account.id,
        projectDir: session.projectDir,
        folder: path.basename(path.dirname(session.file)),
        at: clock()
      });
  }
  const recordOf = (offer: Offer): TransitionRecord | undefined => records.find(r => r.id === offer.transitionId);
  const status = (offer: Offer, next: TransitionRecord['status'], error: ErrorCode | null = null): void => {
    const record = recordOf(offer);
    if (record) {
      record.status = next;
      record.updatedAt = clock();
      record.errorCode = error;
    }
  };
  function offer(
    fields: Omit<Offer, 'suggestion' | 'createdAt' | 'transitionId'>,
    kind: Suggestion['kind'],
    account: MeasuredAccount,
    remainingPercent: number,
    id = suggestionIds.low(account.id)
  ): Suggestion {
    const suggestion: Suggestion = {
      id,
      kind,
      providerId: account.providerId,
      accountId: account.id,
      remainingPercent,
      target: { providerId: fields.to.providerId, accountId: fields.to.account?.id ?? null },
      projectDir: fields.session.projectDir,
      sessionProvider: fields.session.providerId
    };
    // A new offer for the same id supersedes the old one: its record can no longer be retried.
    const replaced = offers.get(suggestion.id);
    if (replaced) status(replaced, 'dismissed');
    const transitionId = `${suggestion.id}:${randomUUID()}`;
    offers.set(suggestion.id, { ...fields, suggestion, createdAt: clock(), transitionId });
    records.push({
      id: transitionId,
      suggestionId: suggestion.id,
      createdAt: clock(),
      updatedAt: clock(),
      projectDir: fields.session.projectDir,
      source: { providerId: fields.session.providerId, accountId: fields.holder.id, sessionId: fields.session.sessionId },
      target: {
        ...suggestion.target,
        sessionId: movesWhole(fields.session.providerId, fields.to.providerId) ? fields.session.sessionId : null
      },
      status: 'offered',
      errorCode: null
    });
    records.splice(0, records.length, ...capRecords(records, liveIds(), historyCap));
    return suggestion;
  }
  // The models each tool would continue the session with; the project's own model wins.
  function modelsFor(snapshot: Snapshot, session: RecentSession): Partial<Record<ProviderId, string>> {
    const preference = projectPreference(snapshot.settings, session.projectDir);
    const models = mappedModels(snapshot, session.model ?? null, launch);
    return preference?.tool && preference.model ? { ...models, [preference.tool]: preference.model } : models;
  }
  // Who would take the session; work that is not stopped needs a taker above the low line.
  function successor(
    snapshot: Snapshot,
    holder: Account,
    session: RecentSession,
    scope: ContinueScope,
    stopped: boolean
  ): Successor | null {
    const models = modelsFor(snapshot, session);
    const preference = projectPreference(snapshot.settings, session.projectDir);
    const to = chooseSuccessor(snapshot, holder, scope, {
      now: clock(),
      minHeadroom: stopped ? SUCCESSOR_MIN_HEADROOM_PERCENT : lowLine(snapshot),
      models,
      prefer: { tool: preference?.tool, accountId: preference?.accountId }
    });
    return to ? { ...to, model: to.model ?? models[to.providerId] ?? null } : null;
  }
  async function sourceSession(pending: Offer, snapshot: Snapshot): Promise<{ session: RecentSession; holder: Account }> {
    const holder = accountOf(snapshot, pending.holder.id);
    if (!holder || (!followed(pending) && !offerFresh(pending)) || expired(pending)) throw new AppError('suggestion_expired');
    // Cut off by the system going down: it opens again from its transcript where it ran, unless
    // it is open again already.
    if (pending.reopening) {
      const found = holder.configDir ? claudeSessionById(holder.configDir, pending.session.sessionId) : null;
      if (!found || !sameSession(found, pending.session) || !interrupted.has(pending.reopening)) throw new AppError('suggestion_expired');
      return { session: { ...pending.session, file: found.file, updatedAt: found.updatedAt, accountId: holder.id }, holder };
    }
    if (pending.stopped) {
      const stopped = (await findStopped(holder)).find(
        stop => stop.sessionId === pending.session.sessionId && stop.stoppedAt === pending.stoppedAt
      );
      if (!stopped || !sameSession(stopped, pending.session) || !freshStop(stopped.stoppedAt)) throw new AppError('suggestion_expired');
      return { session: { ...stopped, accountId: holder.id }, holder };
    }
    // A moved session goes back whenever its main account has room, however long it sat idle.
    if (pending.returning) {
      const written = claudeTranscriptWrite(pending.session.file);
      if (!written || !moved.has(pending.returning)) throw new AppError('suggestion_expired');
      return { session: { ...pending.session, updatedAt: writtenAt(written), accountId: holder.id }, holder };
    }
    const current = await recent(holder, RECENT_SESSION_MS, pending.session);
    if (!current) throw new AppError('suggestion_expired');
    return { session: { ...current, accountId: holder.id }, holder };
  }
  const sameAccountSource = (a: Account, b: Account): boolean =>
    a.id === b.id && a.providerId === b.providerId && a.configDir === b.configDir && !!a.configDirExplicit === !!b.configDirExplicit;
  const sameTarget = (a: Successor, b: Successor): boolean =>
    a.providerId === b.providerId &&
    (a.model ?? null) === (b.model ?? null) &&
    (a.account && b.account ? sameAccountSource(a.account, b.account) : a.account === b.account);
  const sameReopenProfiles = (before: Snapshot, after: Snapshot): boolean => {
    const profiles = (snapshot: Snapshot) => snapshot.settings.accounts.filter(a => a.enabled && a.providerId === 'claude');
    const previous = profiles(before);
    const current = profiles(after);
    return previous.length === current.length && previous.every(a => current.some(b => sameAccountSource(a, b)));
  };
  function automaticAllowed(pending: Offer, snapshot: Snapshot): boolean {
    if (pending.reopening)
      return (
        snapshot.settings.reopenAfterRestart === 'auto' &&
        (pending.suggestion.target.accountId === pending.holder.id || snapshot.settings.returnToPrimary !== 'off')
      );
    if (pending.returning)
      return snapshot.settings.returnToPrimary === 'auto' && accountOf(snapshot, pending.suggestion.target.accountId)?.primary === true;
    return pending.stopped && stopScope(snapshot, pending.session) !== 'off';
  }
  function targetFor(pending: Offer, session: RecentSession, holder: Account, snapshot: Snapshot, scope: ContinueScope): Successor {
    const models = modelsFor(snapshot, session);
    const back = accountOf(snapshot, pending.suggestion.target.accountId);
    // A session reopened goes where it was offered to, room or not: it ran there, and a limit
    // it meets there is a stop like any other.
    const to =
      pending.suggestion.kind === 'low'
        ? successor(snapshot, holder, session, scope, pending.stopped)
        : back && (pending.reopening || recovered(snapshot, back.id, models[back.providerId]))
          ? { providerId: back.providerId, account: back, model: pending.reopening ? null : (models[back.providerId] ?? null) }
          : null;
    if (!to || (pending.suggestion.kind === 'low' && recovered(snapshot, holder.id, session.model)))
      throw new AppError('no_verified_quota');
    return to;
  }
  async function acceptNow(id: string, snapshot: Snapshot, scope: ContinueScope = 'tools', automatic = false): Promise<ContinueResult> {
    const pending = offers.get(id);
    if (!pending) throw new AppError('suggestion_expired');
    try {
      snapshot = getCurrentSnapshot ? await getCurrentSnapshot() : snapshot;
      if (quitting || (automatic && !automaticAllowed(pending, snapshot))) throw new DispatchDeferred();
      if (automatic && pending.stopped) scope = continueScope(stopScope(snapshot, pending.session));
      const { session, holder } = await sourceSession(pending, snapshot);
      let to = targetFor(pending, session, holder, snapshot, scope);
      pending.to = to;
      const record = recordOf(pending);
      if (record)
        record.target = {
          providerId: to.providerId,
          accountId: to.account?.id ?? null,
          sessionId: movesWhole(session.providerId, to.providerId) ? session.sessionId : null
        };
      status(pending, 'dispatching');
      // A durable intent must precede dispatch. A crash leaves an ambiguous operation that
      // cannot be blindly retried. A failed write prevents launch altogether.
      await save();
      const options = await moveOptions(pending, session, holder, snapshot);
      const current = getCurrentSnapshot ? await getCurrentSnapshot() : snapshot;
      // A slow process lookup must not keep old permission to automate, an old profile, or an
      // old model alive. The checked process still belongs to the exact source profile below.
      if (isQuitting() || offers.get(id) !== pending || (automatic && !automaticAllowed(pending, current))) throw new DispatchDeferred();
      const currentHolder = accountOf(current, holder.id);
      if (!currentHolder) throw new AppError('suggestion_expired');
      if (!sameAccountSource(holder, currentHolder) || (pending.reopening && !sameReopenProfiles(snapshot, current)))
        throw new DispatchDeferred();
      const currentScope = automatic && pending.stopped ? continueScope(stopScope(current, session)) : scope;
      const currentTarget = targetFor(pending, session, currentHolder, current, currentScope);
      if (!sameTarget(to, currentTarget)) throw new DispatchDeferred();
      to = currentTarget;
      pending.to = to;
      let result: ContinueResult;
      try {
        result = await start(session, to, current, launch, options);
      } catch (error) {
        status(pending, 'failed', errorCode(error));
        await save();
        throw error;
      }
      status(pending, 'dispatched');
      offers.delete(id);
      if (pending.reopening) interrupted.delete(pending.reopening);
      // The session is on its way: what else waited for it (a stop no one could take then, a
      // running-low offer) could only start it a second time.
      for (const [otherId, other] of offers)
        if (sameSession(other.session, session)) {
          status(other, 'dismissed');
          offers.delete(otherId);
        }
      // A whole session is followed for the way back; work moved from a brief has no session
      // to bring back.
      if (result.resumed) {
        recordMove(session, holder, to, result);
        // Until it is seen running there, the move is an intent that went off, nothing more.
        if (record && to.account?.configDir)
          dispatched.set(record.id, {
            sessionId: session.sessionId,
            holderId: to.account.id,
            file: carriedTranscript(session, to.account.configDir),
            at: clock(),
            ...(isOneOf(ATTEMPTS, pending.suggestion.kind) ? { attempt: pending.suggestion.kind } : {})
          });
      }
      // The work is running: a failed write must not report it as failed (the user could start
      // it twice). The durable record stays `dispatching`, which a restart never replays.
      await save().catch(() => undefined);
      return result;
    } catch (error) {
      // Still `dispatching` here means the intent could not be written, so nothing started.
      if (recordOf(pending)?.status !== 'dispatched') {
        // An offer whose session is gone is not a failure to retry: it is withdrawn.
        if (error instanceof DispatchDeferred) status(pending, offers.get(id) === pending ? 'offered' : 'dismissed');
        else if (error instanceof AppError && error.code === 'suggestion_expired') {
          status(pending, 'dismissed');
          offers.delete(id);
          if (pending.reopening) interrupted.delete(pending.reopening);
        } else status(pending, 'failed', errorCode(error));
        await save().catch(() => undefined);
      }
      throw error;
    }
  }
  // Sessions of one account run out together, so several can stop between two refreshes.
  async function onStopped(snapshot: Snapshot, account: MeasuredAccount): Promise<Notice[]> {
    if (!accountOf(snapshot, account.id)) return [];
    const notices: Notice[] = [];
    for (const session of await findStopped(account).catch(() => []))
      if (freshStop(session.stoppedAt)) notices.push(...(await onStop(snapshot, account, session)));
    return notices;
  }
  async function onStop(snapshot: Snapshot, account: MeasuredAccount, session: StoppedSession): Promise<Notice[]> {
    const key = keys.stop(account.id, session.sessionId, session.stoppedAt);
    if (handled.has(key) || recovered(snapshot, account.id, session.model)) return [];
    // Typed on where it left after it moved: the copy elsewhere goes on alone. And the copy
    // carried here ends with the stop it was moved for until it goes on: that stop is the
    // other account's, not this one's.
    const went = moved.get(keys.session(session));
    if (went?.from === account.id || (went?.to === account.id && session.stoppedAt <= went.at)) {
      handled.add(key);
      await save();
      return [];
    }
    const id = suggestionIds.stop(account.id, session.sessionId);
    const scope = stopScope(snapshot, session);
    // Moved on its own, the session's process is ended first; not knowing whether it runs, the
    // stop is left for the next look rather than marked handled.
    if (scope !== 'off' && (await lookup(account, session)).kind === 'unknown') return [];
    const to = successor(snapshot, account, session, continueScope(scope), true);
    // One stop owns one transition even if a low warning already offered it: that offer goes, so
    // it cannot start the session a second time. One for another session of the account stays.
    const previous = offers.get(suggestionIds.low(account.id));
    if (previous && sameSession(previous.session, session)) {
      status(previous, 'dismissed');
      offers.delete(previous.suggestion.id);
    }
    if (!to) {
      // Readings still coming in, or missing, say nothing about who could take it: the stop
      // waits for the next look rather than being stranded on stale quota.
      if (snapshot.refreshing || unmeasured(snapshot, account, continueScope(scope))) return [];
      handled.add(key);
      // Stranded already by an earlier stop of the same session: one record, one word.
      const already = offers.get(id);
      if (already?.suggestion.target.accountId === null) {
        already.stoppedAt = session.stoppedAt;
        already.session = session;
        await save();
        return [];
      }
      const suggestion = offer(
        { session, holder: account, to: { providerId: account.providerId, account: null }, stopped: true, stoppedAt: session.stoppedAt },
        'low',
        account,
        0,
        id
      );
      const pending = offers.get(suggestion.id);
      if (pending) status(pending, 'failed', 'no_verified_quota');
      await save();
      return [{ kind: 'stranded', from: account }];
    }
    const suggestion = offer({ session, holder: account, to, stopped: true, stoppedAt: session.stoppedAt }, 'low', account, 0, id);
    handled.add(key);
    await save();
    if (scope === 'off') return [{ kind: 'suggested', suggestion }];
    const pending = offers.get(suggestion.id);
    try {
      const result = await acceptNow(suggestion.id, snapshot, scope, true);
      return [{ kind: 'continued', from: account, to: pending?.to ?? to, result, projectDir: session.projectDir }];
    } catch (error) {
      if (error instanceof DispatchDeferred) return !quitting && offers.has(suggestion.id) ? [{ kind: 'suggested', suggestion }] : [];
      return [{ kind: 'failed', from: account, code: errorCode(error) }];
    }
  }
  // How far a stop's work may move: a project's own setting wins over the global one, `off`
  // included (offered then, within every tool: see continueScope).
  function stopScope(snapshot: Snapshot, session: RecentSession): AutoContinue {
    const own = projectPreference(snapshot.settings, session.projectDir)?.autoContinue ?? INHERIT;
    return own === INHERIT ? snapshot.settings.autoContinue : own;
  }

  // A waiting offer says what holds now, not what held when it was made: the quota left on its
  // account and, for work to move, who would take it, chosen the way the offer was made (a stop
  // within its scope, running low within every tool). A stop no one could take waits in the
  // history for an explicit retry and is not brought back as a card; with no one to take it now
  // an offer keeps its last target, and accepting checks again.
  function freshen(snapshot: Snapshot, pending: Offer): void {
    const left = headroomPercent(measuredOf(snapshot, pending.suggestion.accountId));
    if (left !== null && !pending.stopped) pending.suggestion.remainingPercent = left;
    if (pending.suggestion.kind !== 'low' || pending.suggestion.target.accountId === null) return;
    const scope = pending.stopped ? stopScope(snapshot, pending.session) : 'tools';
    const to = successor(snapshot, pending.holder, pending.session, continueScope(scope), pending.stopped);
    // A stop no one in its scope can take any more is stranded again (no card, the history's retry).
    if (!to && pending.stopped) pending.suggestion.target = { providerId: pending.suggestion.providerId, accountId: null };
    if (!to) return;
    pending.to = to;
    pending.suggestion.target = { providerId: to.providerId, accountId: to.account?.id ?? null };
  }

  // A stop offered for the copy a session was moved with: the stop is the other account's (an
  // offer made so before this was known, or kept from then, goes).
  function carried(pending: Offer): boolean {
    const went = moved.get(keys.session(pending.session));
    const { stoppedAt } = pending;
    return pending.stopped && went?.to === pending.holder.id && stoppedAt !== undefined && stoppedAt <= went.at;
  }

  // A running-low offer whose session can no longer be found (deleted, or no longer the recent
  // one) has nothing to continue; a stop's and a return's are checked when accepted.
  const vanished = async (pending: Offer): Promise<boolean> =>
    !pending.stopped && !followed(pending) && (await recent(pending.holder, RECENT_SESSION_MS, pending.session)) === null;

  // A session started on another account was picked up once its process is seen there, or its
  // copy written since; one seen neither way within a few minutes was not.
  async function onDispatched(snapshot: Snapshot, id: string, dispatch: Dispatch): Promise<Notice[]> {
    const holder = accountOf(snapshot, dispatch.holderId);
    const found = holder ? await lookup(holder, { providerId: 'claude', sessionId: dispatch.sessionId }) : { kind: 'none' as const };
    const written = claudeTranscriptWrite(dispatch.file);
    const seen = found.kind === 'found' || (written !== null && written.lastRecordAt >= dispatch.at - SAVED_SLACK_MS);
    if (seen) {
      dispatched.delete(id);
      return [];
    }
    // Not knowing whether it runs is not "not running": the look goes on, for a while.
    const waited = clock() - dispatch.at;
    if (waited < PICKUP_MAX_MS || (found.kind === 'unknown' && waited < PICKUP_UNKNOWN_MAX_MS)) return [];
    dispatched.delete(id);
    const code = found.kind === 'unknown' ? 'process_unknown' : 'not_picked_up';
    const record = records.find(r => r.id === id);
    if (record) {
      record.status = 'failed';
      record.errorCode = code;
      record.updatedAt = clock();
    }
    const from = holder ? measuredOf(snapshot, holder.id) : null;
    return from ? [{ kind: 'failed', from, code, ...(dispatch.attempt ? { attempt: dispatch.attempt } : {}) }] : [];
  }

  async function observeNow(snapshot: Snapshot, low: readonly QuotaAlert[]): Promise<Notice[]> {
    for (const [id, pending] of offers) {
      const holder = accountOf(snapshot, pending.holder.id);
      if (holder) pending.holder = holder;
      if (
        (!followed(pending) && !offerFresh(pending)) ||
        !accountOf(snapshot, pending.holder.id) ||
        (pending.suggestion.kind === 'low' && recovered(snapshot, pending.suggestion.accountId, pending.session.model)) ||
        expired(pending) ||
        carried(pending) ||
        (await vanished(pending))
      ) {
        status(pending, 'dismissed');
        offers.delete(id);
      } else freshen(snapshot, pending);
    }
    await track(snapshot);
    const notices: Notice[] = [];
    for (const account of snapshot.providers.flatMap(p => p.accounts).filter(a => isProfileProvider(a.providerId)))
      notices.push(...(await onStopped(snapshot, account)));
    for (const { account, window, kind } of low) {
      if (kind !== 'low' || offers.has(suggestionIds.low(account.id)) || !accountOf(snapshot, account.id)) continue;
      const session = await recent(account, RECENT_SESSION_MS);
      const to = session && successor(snapshot, account, session, 'tools', false);
      if (session && to)
        notices.push({
          kind: 'suggested',
          suggestion: offer({ session, holder: account, to, stopped: false }, 'low', account, window.remainingPercent)
        });
    }
    for (const [id, dispatch] of [...dispatched]) notices.push(...(await onDispatched(snapshot, id, dispatch)));
    for (const [key, entry] of [...interrupted]) notices.push(...(await onInterrupted(snapshot, key, entry)));
    for (const [key, entry] of [...moved]) notices.push(...(await onReturn(snapshot, key, entry)));
    // The notices describe what already happened; a failed write must not hide them.
    await save().catch(() => undefined);
    return notices;
  }
  // Keep each account's evidence even when another account cannot be inspected.
  async function openNow(snapshot: Snapshot): Promise<{ sessions: Map<string, Open>; knownAccounts: Set<string> }> {
    const now = new Map<string, Open>();
    const knownAccounts = new Set<string>();
    for (const account of snapshot.settings.accounts.filter(a => a.enabled && a.providerId === 'claude')) {
      let sessions: OpenClaudeSession[];
      try {
        sessions = await findOpen(account);
        knownAccounts.add(account.id);
      } catch {
        continue;
      }
      for (const session of sessions)
        now.set(keys.session({ providerId: 'claude', sessionId: session.sessionId }), {
          sessionId: session.sessionId,
          accountId: account.id,
          cwd: session.cwd,
          busy: session.status === 'busy',
          at: clock()
        });
    }
    return { sessions: now, knownAccounts };
  }
  // Follows which sessions are open. The first look of a run settles the last run: if it ended
  // without being quit, it went down with the system, and what it saw open and is gone now was
  // cut off. Later in a run, one gone was closed. One open again (by hand, anywhere) is no
  // longer to reopen.
  async function track(snapshot: Snapshot): Promise<void> {
    const { sessions: now, knownAccounts } = await openNow(snapshot);
    if (previousQuit === false)
      for (const [key, entry] of open)
        if (unsettledAccounts.has(entry.accountId) && knownAccounts.has(entry.accountId) && !now.has(key) && !interrupted.has(key)) {
          // It went down around when it was last seen open, not when the app looked again: a
          // session cut off days ago is past reopening.
          interrupted.set(key, entry);
          // Its tab went with it.
          tabs.delete(key);
        }
    for (const accountId of [...unsettledAccounts])
      if (knownAccounts.has(accountId) || !accountOf(snapshot, accountId)) unsettledAccounts.delete(accountId);
    if (!unsettledAccounts.size) previousQuit = null;
    open = new Map([
      ...[...open].filter(([, entry]) => !knownAccounts.has(entry.accountId) && accountOf(snapshot, entry.accountId)),
      ...now
    ]);
    for (const key of [...interrupted.keys()]) if (now.has(key)) forget(key);
  }
  // A session no longer to reopen, and its offer.
  function forget(key: string): void {
    interrupted.delete(key);
    const pending = offers.get(suggestionIds.reopen(key));
    if (pending) {
      status(pending, 'dismissed');
      offers.delete(pending.suggestion.id);
    }
  }
  // A session cut off by the system going down opens again, offered or on its own: on the
  // tool's main account when it had been moved off it and that account has room again (as
  // `returnToPrimary` allows), else where it ran.
  async function onInterrupted(snapshot: Snapshot, key: string, entry: Open): Promise<Notice[]> {
    const setting = snapshot.settings.reopenAfterRestart;
    const holder = accountOf(snapshot, entry.accountId);
    const found = holder?.configDir ? claudeSessionById(holder.configDir, entry.sessionId) : null;
    if (setting === 'off' || !holder || !found || clock() - entry.at > REOPEN_SUGGESTION_MS) {
      forget(key);
      return [];
    }
    const id = suggestionIds.reopen(key);
    const offered = offers.get(id);
    // A failed reopening waits in the history for an explicit retry, like a failed stop.
    if (offered && (setting === 'ask' || recordOf(offered)?.status === 'failed')) return [];
    const went = moved.get(key);
    const home = went?.to === holder.id && snapshot.settings.returnToPrimary !== 'off' ? accountOf(snapshot, went.from) : null;
    const measured = measuredOf(snapshot, holder.id);
    // Readings still coming in say nothing yet about where it should go.
    if (
      snapshot.refreshing ||
      !measured ||
      measured.status === 'pending' ||
      (home && (measuredOf(snapshot, home.id)?.status ?? 'pending') === 'pending')
    )
      return [];
    const session: RecentSession = { ...found, accountId: holder.id };
    const target = home && recovered(snapshot, home.id, modelsFor(snapshot, session)[home.providerId]) ? home : holder;
    const to = { providerId: target.providerId, account: target };
    const suggestion =
      offered?.suggestion ??
      offer(
        { session, holder, to, stopped: false, reopening: key },
        'reopen',
        measured,
        headroomPercent(measuredOf(snapshot, target.id)) ?? 0,
        id
      );
    if (setting === 'ask') return [{ kind: 'suggested', suggestion }];
    const pending = offers.get(suggestion.id);
    try {
      const result = await acceptNow(suggestion.id, snapshot, 'tools', true);
      const from = measuredOf(snapshot, target.id);
      return from ? [{ kind: 'reopened', from, to: pending?.to ?? to, result, projectDir: session.projectDir }] : [];
    } catch (error) {
      if (error instanceof DispatchDeferred) return !quitting && offers.has(suggestion.id) ? [{ kind: 'suggested', suggestion }] : [];
      return [{ kind: 'failed', from: measured, code: errorCode(error), attempt: 'reopen' }];
    }
  }
  // A Claude Code session moved off the tool's main account, which has room again: it goes
  // back, offered or on its own once it sits idle with nothing left running.
  async function onReturn(snapshot: Snapshot, key: string, entry: Moved): Promise<Notice[]> {
    const setting = snapshot.settings.returnToPrimary;
    const home = accountOf(snapshot, entry.from);
    const holder = accountOf(snapshot, entry.to);
    const measured = measuredOf(snapshot, entry.from);
    const { sessionId } = entry;
    const transcript = holder?.configDir
      ? path.join(holder.configDir, CLAUDE_FILES.projects, entry.folder, `${sessionId}${JSON_LINES_EXTENSION}`)
      : null;
    const written = transcript ? claudeTranscriptWrite(transcript) : null;
    if (clock() - entry.at > MOVED_MAX_AGE_MS || !home || !holder || !transcript || !written) {
      moved.delete(key);
      return [];
    }
    if (setting === 'off' || !home.primary || !measured) return [];
    const session: RecentSession = {
      providerId: 'claude',
      sessionId,
      projectDir: entry.projectDir,
      updatedAt: writtenAt(written),
      file: transcript,
      accountId: holder.id
    };
    if (!recovered(snapshot, home.id, modelsFor(snapshot, session)[home.providerId])) return [];
    const id = suggestionIds.return(key);
    const to = { providerId: home.providerId, account: home };
    const ask = () =>
      offer({ session, holder, to, stopped: false, returning: key }, 'return', measured, headroomPercent(measured) ?? 0, id);
    if (setting === 'ask') return offers.has(id) ? [] : [{ kind: 'suggested', suggestion: ask() }];
    const found = await lookup(holder, { providerId: 'claude', sessionId });
    // Not knowing is not "closed": the session is looked at again next time.
    if (found.kind === 'unknown') return [];
    // Closed where it ran: the user ended it there, and it is not reopened unasked. One gone with
    // the system waits to open again, and goes on from there.
    if (found.kind === 'none') {
      if (!interrupted.has(key)) moved.delete(key);
      return [];
    }
    const { process } = found;
    // Quiet: waiting for the user, for a while (what the process says, else what its transcript shows).
    const quiet =
      waiting(process, transcript) &&
      (process.status === null || clock() - process.statusSince >= RETURN_QUIET_MS) &&
      Number.isFinite(written.lastRecordAt) &&
      clock() - written.lastRecordAt >= RETURN_QUIET_MS;
    // Busy again: the wait for its background commands starts over when it is next quiet.
    if (!quiet) {
      holding.delete(key);
      return [];
    }
    // Waiting for background commands helps only a session that can still act on them: one cut
    // off by a limit goes now and is told about them.
    const tasks = cutOff(transcript) ? [] : await openTasks(session, process);
    const since = holding.get(key) ?? clock();
    holding.set(key, since);
    if (tasks.length && clock() - since < RETURN_TASK_WAIT_MS) return [];
    holding.delete(key);
    // A failed return waits in the history for an explicit retry, like a failed stop.
    const offered = offers.get(id);
    if (offered && recordOf(offered)?.status === 'failed') return [];
    const suggestion = offered?.suggestion ?? ask();
    const pending = offers.get(suggestion.id);
    try {
      const result = await acceptNow(suggestion.id, snapshot, 'tools', true);
      const from = measuredOf(snapshot, holder.id);
      return from ? [{ kind: 'returned', from, to: pending?.to ?? to, result, projectDir: session.projectDir }] : [];
    } catch (error) {
      if (error instanceof DispatchDeferred) return !quitting && offers.has(suggestion.id) ? [{ kind: 'suggested', suggestion }] : [];
      return [{ kind: 'failed', from: measured, code: errorCode(error), attempt: 'return' }];
    }
  }
  async function isRunning(id: string, snapshot?: Snapshot): Promise<boolean> {
    const pending = offers.get(id);
    if (!pending) return false;
    if (snapshot) {
      const holder = accountOf(snapshot, pending.holder.id);
      if (!holder) return false;
      pending.holder = holder;
    }
    if (pending.reopening) {
      const found = await reopenLookup(pending.session, snapshot?.settings.accounts ?? [pending.holder]);
      return found.kind !== 'none';
    }
    if (pending.session.providerId === 'claude') {
      const found = await lookup(pending.holder, pending.session);
      // Not knowing, the user is warned as if it ran.
      if (found.kind === 'unknown') return true;
      if (found.kind === 'found') return !pending.stopped && !waiting(found.process, pending.session.file);
    }
    if (pending.stopped) {
      const current = await findStopped(pending.holder).catch(() => []);
      if (current.some(stop => sameSession(stop, pending.session))) return false;
    }
    const current = await recent(pending.holder, RUNNING_SESSION_MS, pending.session);
    return current !== null;
  }
  return {
    observe: (snapshot, { low }) =>
      serial(async () => {
        if (quitting) return [];
        const current = typeof snapshot === 'function' ? await snapshot() : getCurrentSnapshot ? await getCurrentSnapshot() : snapshot;
        return isQuitting() ? [] : observeNow(current, typeof low === 'function' ? low(current) : low);
      }),
    // A stranded stop has no one to continue it: it waits in the history for an explicit retry
    // rather than as a card naming a target that has no quota.
    suggestions: () =>
      [...offers.values()]
        .filter(o => o.suggestion.target.accountId !== null)
        .map(o => ({ ...o.suggestion, target: { ...o.suggestion.target } })),
    transitions: () => {
      const live = liveIds();
      return structuredClone(records).map(record => ({ ...record, retryable: record.status === 'failed' && live.has(record.id) }));
    },
    isRunning,
    accept: (id, snapshot) => serial(() => acceptNow(id, snapshot)),
    retry: (id, snapshot) =>
      serial(() => {
        const record = records.find(r => r.id === id && r.status === 'failed');
        const pending = record && [...offers.values()].find(o => o.transitionId === record.id);
        if (!pending) throw new AppError('suggestion_expired');
        return acceptNow(pending.suggestion.id, snapshot);
      }),
    dismiss: id => {
      const pending = offers.get(id);
      if (pending) {
        status(pending, 'dismissed');
        offers.delete(id);
        if (pending.returning) moved.delete(pending.returning);
        if (pending.reopening) interrupted.delete(pending.reopening);
        void serial(save).catch(() => undefined);
      }
    },
    quit: () => {
      quitting = true;
      try {
        writeFileAtomicSync(file, serialize());
      } catch {
        // Unwritten, the next start takes the sessions gone by then as cut off: it offers them.
      }
    }
  };
}
