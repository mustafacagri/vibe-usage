// The last good reading of each account, kept on disk. After a restart the app shows it,
// labelled stale, until the first fresh read: a source that is rate limited or offline at that
// moment then leaves the last known quota in view instead of an empty card. Only what the
// readings say about quota is kept, never tokens, emails or names.
import { hasKey, type MessageKey } from '../shared/i18n/index.ts';
import type { MeasuredAccount, QuotaWindow } from '../shared/types.ts';
import { isObject, readJson, writeFileAtomic } from './files.ts';
import { normalizeWindow } from './model.ts';
import { DURATION_MS } from '../shared/catalog.ts';
import { accountSourceKey } from './account-source.ts';

export const MEASUREMENTS_FILE = 'measurements.json';
// A reading older than this says too little about the quota now to be worth showing.
const KEPT_READING_MAX_AGE_MS = 7 * DURATION_MS.DAY;
const MAX_WINDOWS = 50;

export interface SavedMeasurement {
  // The profile the reading was for: a changed folder is another account.
  configDir: string | null;
  // Older readings have no source proof and are not restored into a configured account.
  sourceKey?: string;
  fetchedAt: string;
  plan?: string;
  windows: QuotaWindow[];
}

// A message key from the file counts only when it is one the app knows.
const isKnownKey = (value: unknown): value is MessageKey => typeof value === 'string' && hasKey(value);

function savedWindow(value: unknown): QuotaWindow | null {
  if (!isObject(value) || typeof value.id !== 'string') return null;
  const n = isObject(value.labelParams) ? value.labelParams.n : undefined;
  return normalizeWindow({
    id: value.id,
    usedPercent: value.usedPercent,
    remainingPercent: value.remainingPercent,
    resetsAt: value.resetsAt,
    ...(typeof value.label === 'string' ? { label: value.label } : {}),
    ...(isKnownKey(value.labelKey) ? { labelKey: value.labelKey } : {}),
    ...(typeof n === 'number' && Number.isFinite(n) ? { labelParams: { n } } : {}),
    ...(isKnownKey(value.detailKey) ? { detailKey: value.detailKey } : {}),
    ...(isKnownKey(value.valueKey) ? { valueKey: value.valueKey } : {}),
    ...(typeof value.durationMinutes === 'number' ? { durationMinutes: value.durationMinutes } : {}),
    ...(typeof value.scope === 'string' ? { scope: value.scope } : {}),
    active: value.active,
    ...(typeof value.group === 'string' ? { group: value.group } : {}),
    ...(value.section === 'details' ? { section: 'details' as const } : {}),
    ...(value.partial === true ? { partial: true } : {}),
    except: value.except,
    amounts: value.amounts
  });
}

// The saved readings by account id; a damaged or foreign file gives none.
export async function loadMeasurements(file: string, now = Date.now()): Promise<Map<string, SavedMeasurement>> {
  const document = await readJson(file);
  const saved = new Map<string, SavedMeasurement>();
  if (!isObject(document) || !isObject(document.accounts)) return saved;
  for (const [id, entry] of Object.entries(document.accounts)) {
    if (!isObject(entry) || typeof entry.fetchedAt !== 'string' || !Array.isArray(entry.windows)) continue;
    const at = Date.parse(entry.fetchedAt);
    if (!Number.isFinite(at) || at > now || now - at > KEPT_READING_MAX_AGE_MS) continue;
    const windows = entry.windows
      .slice(0, MAX_WINDOWS)
      .map(savedWindow)
      .filter(w => w !== null);
    if (!windows.length) continue;
    saved.set(id, {
      configDir: typeof entry.configDir === 'string' ? entry.configDir : null,
      ...(typeof entry.sourceKey === 'string' && /^[a-f0-9]{64}$/.test(entry.sourceKey) ? { sourceKey: entry.sourceKey } : {}),
      fetchedAt: new Date(at).toISOString(),
      ...(typeof entry.plan === 'string' ? { plan: entry.plan } : {}),
      windows
    });
  }
  return saved;
}

// The reading worth keeping from an account: a good one, without what was carried over.
export function measurementOf(account: MeasuredAccount): SavedMeasurement | null {
  const windows = account.windows.filter(w => !w.stale).map(({ exhaustsAt: _forecast, ...window }) => window);
  if (account.status !== 'ok' || !account.fetchedAt || !windows.length) return null;
  return {
    configDir: account.configDir ?? null,
    sourceKey: accountSourceKey(account),
    fetchedAt: account.fetchedAt,
    ...(account.plan ? { plan: account.plan } : {}),
    windows
  };
}

export function saveMeasurements(file: string, saved: ReadonlyMap<string, SavedMeasurement>): Promise<void> {
  return writeFileAtomic(file, JSON.stringify({ version: 1, accounts: Object.fromEntries(saved) }));
}
