// Quota readings over the last week, kept on disk: the history chart and the "runs out at this
// pace" forecast come from them. Only percentages are stored, never tokens or names.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { DURATION_MS } from '../shared/catalog.ts';
import type { MeasuredAccount, QuotaWindow, Snapshot } from '../shared/types.ts';
import { isObject, writeFileAtomic } from './files.ts';

const HISTORY_FILE = 'history.json';
export const HISTORY_RETENTION_MS = DURATION_MS.WEEK;
// A reading is kept when the value changed, or at least this long after the previous one.
const SAMPLE_INTERVAL_MS = 10 * DURATION_MS.MINUTE;
// The pace is taken over the last hour of the current period...
const PACE_WINDOW_MS = DURATION_MS.HOUR;
// ...and needs readings at least this far apart to mean anything.
const PACE_MIN_SPAN_MS = 10 * DURATION_MS.MINUTE;
const SAVE_DELAY_MS = 30 * 1000;
const PERCENT_MAX = 100;

// [time in ms, used percent]
export type Sample = readonly [number, number];

export interface WindowSeries {
  accountId: string;
  windowId: string;
  samples: Sample[];
}

export interface History {
  record(snapshot: Snapshot): void;
  // The snapshot with each window's forecast filled in.
  annotate(snapshot: Snapshot): Snapshot;
  series(accountIds: readonly string[]): WindowSeries[];
  flush(): Promise<void>;
}

type Store = Map<string, Map<string, Sample[]>>;

const isSample = (value: unknown): value is Sample =>
  Array.isArray(value) && value.length === 2 && value.every(n => typeof n === 'number' && Number.isFinite(n));

// A damaged or foreign file starts an empty history rather than failing the app.
function parseStore(document: unknown, now: number): Store {
  const store: Store = new Map();
  if (!isObject(document) || !isObject(document.accounts)) return store;
  for (const [accountId, windows] of Object.entries(document.accounts)) {
    if (!isObject(windows)) continue;
    const byWindow = new Map<string, Sample[]>();
    for (const [windowId, samples] of Object.entries(windows)) {
      const kept = Array.isArray(samples) ? samples.filter(isSample).filter(([time]) => now - time <= HISTORY_RETENTION_MS) : [];
      if (kept.length) byWindow.set(windowId, kept);
    }
    if (byWindow.size) store.set(accountId, byWindow);
  }
  return store;
}

const usedPercent = (window: QuotaWindow): number | null =>
  window.stale || window.amounts || window.usedPercent === null ? null : Math.min(Math.max(window.usedPercent, 0), PERCENT_MAX);

const isMeasured = (account: MeasuredAccount): boolean => account.status === 'ok';

// The readings since the window last reset: usage only grows within a period, so the period
// starts after the last drop.
function currentPeriod(samples: readonly Sample[]): readonly Sample[] {
  let start = samples.length - 1;
  while (start > 0 && (samples[start - 1]?.[1] ?? 0) <= (samples[start]?.[1] ?? 0)) start--;
  return samples.slice(Math.max(start, 0));
}

// When usage reaches 100% at the pace of the last hour of this period; null when it does not
// grow, there is too little to tell, or it resets first.
export function forecastExhaustion(samples: readonly Sample[], window: QuotaWindow, now: number): number | null {
  const used = usedPercent(window);
  if (used === null || used >= PERCENT_MAX) return null;
  const period = currentPeriod([...samples, [now, used]]);
  const recent = period.filter(([time]) => now - time <= PACE_WINDOW_MS);
  const from = (recent.length >= 2 && now - (recent[0]?.[0] ?? now) >= PACE_MIN_SPAN_MS ? recent : period)[0];
  if (!from || now - from[0] < PACE_MIN_SPAN_MS || used <= from[1]) return null;
  const perMs = (used - from[1]) / (now - from[0]);
  const exhaustsAt = now + (PERCENT_MAX - used) / perMs;
  const resetsAt = window.resetsAt ? Date.parse(window.resetsAt) : NaN;
  return Number.isFinite(resetsAt) && exhaustsAt >= resetsAt ? null : exhaustsAt;
}

export async function createHistory({ dataDir, clock = Date.now }: { dataDir: string; clock?: () => number }): Promise<History> {
  const file = path.join(dataDir, HISTORY_FILE);
  const text = await fsp.readFile(file, 'utf8').catch(() => '');
  let document: unknown = null;
  try {
    document = text ? JSON.parse(text) : null;
  } catch {
    // Unreadable history is dropped below.
  }
  const store = parseStore(document, clock());
  let saveTimer: NodeJS.Timeout | undefined;
  let pending: Promise<void> = Promise.resolve();

  const samplesOf = (accountId: string, windowId: string): Sample[] => store.get(accountId)?.get(windowId) ?? [];

  function save(): Promise<void> {
    clearTimeout(saveTimer);
    saveTimer = undefined;
    const accounts = Object.fromEntries([...store].map(([accountId, windows]) => [accountId, Object.fromEntries(windows)]));
    pending = pending.then(() => writeFileAtomic(file, JSON.stringify({ version: 1, accounts }))).catch(() => undefined);
    return pending;
  }

  function scheduleSave(): void {
    saveTimer ??= setTimeout(() => void save(), SAVE_DELAY_MS);
    saveTimer.unref();
  }

  function record(snapshot: Snapshot): void {
    const now = clock();
    let changed = false;
    for (const account of snapshot.providers.flatMap(p => p.accounts).filter(isMeasured)) {
      const at = Date.parse(account.fetchedAt ?? '');
      const time = Number.isFinite(at) ? at : now;
      for (const window of account.windows) {
        const used = usedPercent(window);
        if (used === null) continue;
        const windows = store.get(account.id) ?? new Map<string, Sample[]>();
        const samples = (windows.get(window.id) ?? []).filter(([t]) => now - t <= HISTORY_RETENTION_MS);
        const last = samples.at(-1);
        if (last && (time <= last[0] || (last[1] === used && time - last[0] < SAMPLE_INTERVAL_MS))) continue;
        samples.push([time, used]);
        windows.set(window.id, samples);
        store.set(account.id, windows);
        changed = true;
      }
    }
    if (changed) scheduleSave();
  }

  function annotate(snapshot: Snapshot): Snapshot {
    const now = clock();
    for (const account of snapshot.providers.flatMap(p => p.accounts).filter(isMeasured)) {
      for (const window of account.windows) {
        const exhaustsAt = forecastExhaustion(samplesOf(account.id, window.id), window, now);
        if (exhaustsAt === null) delete window.exhaustsAt;
        else window.exhaustsAt = new Date(exhaustsAt).toISOString();
      }
    }
    return snapshot;
  }

  function series(accountIds: readonly string[]): WindowSeries[] {
    const now = clock();
    return accountIds.flatMap(accountId =>
      [...(store.get(accountId) ?? [])].map(([windowId, samples]) => ({
        accountId,
        windowId,
        samples: samples.filter(([time]) => now - time <= HISTORY_RETENTION_MS)
      }))
    );
  }

  return { record, annotate, series, flush: save };
}
