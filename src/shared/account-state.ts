// What an account's state means for what the window shows: when signing in is the next step,
// and the one line per account the compact view gives.
import type { AccountStatus, MeasuredAccount, ProviderState, ProviderStatus, QuotaWindow } from './types.ts';

// States of an account read just now with a working sign-in: quota, or none to report.
export const HEALTHY_STATUSES: ReadonlySet<AccountStatus> = new Set(['ok', 'no_limits_reported']);

// Whether a limit with `remaining` percent left is low at the user's threshold.
export const isLowQuota = (remaining: number | null, threshold: number): boolean => remaining !== null && remaining <= threshold;

// States where the useful next step is signing in or opening the provider's app.
const SIGN_IN_STATUSES: ReadonlySet<AccountStatus> = new Set([
  'auth_missing',
  'auth_invalid',
  'auth_expired',
  'auth_rejected',
  'keychain_unavailable',
  'app_closed'
]);

// States where the tool itself is not found: signing in cannot start without it, finding it can.
const NOT_FOUND_STATUSES: ReadonlySet<ProviderStatus> = new Set(['binary_missing', 'invalid_binary']);

export const toolNotFound = (state: { status: ProviderStatus }): boolean => NOT_FOUND_STATUSES.has(state.status);

// States that pass by themselves: the next read is already on its way.
const WAITING_STATUSES: ReadonlySet<AccountStatus> = new Set([
  'pending',
  'rate_limited',
  'transport_error',
  'request_timeout',
  'server_closed',
  'rpc_timeout',
  'process_timeout',
  'local_service_unavailable'
]);

// Signing in helps when the source said so, or when an account was never read for a reason
// that does not pass by itself.
export const needsSignIn = (account: MeasuredAccount): boolean =>
  !toolNotFound(account) && (SIGN_IN_STATUSES.has(account.status) || (!account.windows.length && !WAITING_STATUSES.has(account.status)));

export type KnownWindow = QuotaWindow & { remainingPercent: number };

// Why a compact line shows no number.
export type CompactNote = 'reading' | 'waiting' | 'signIn' | 'openApp' | 'notFound' | 'noLimits' | 'noData';

export interface CompactLine {
  account: MeasuredAccount;
  // The account's session limit: its shortest window that covers the whole account (a spent
  // per-model or per-API limit leaves the rest working).
  window: KnownWindow | null;
  // The account's other limit with the least left (the weekly one, say), shown beside it.
  other: KnownWindow | null;
  // The other limit, when it has less left than the session one: it runs out first.
  tighter: KnownWindow | null;
  // The number is the last one known, not a fresh reading.
  stale: boolean;
  // At or below the user's low line: the session limit, and the tighter one.
  low: boolean;
  tighterLow: boolean;
  note: CompactNote | null;
}

// `active` is the source's headline choice, not whether the limit binds (see selection.ts).
const isKnown = (window: QuotaWindow): window is KnownWindow =>
  !window.stale && window.section !== 'details' && window.remainingPercent !== null;

const tightest = (windows: readonly KnownWindow[]): KnownWindow | null =>
  [...windows].sort((p, q) => p.remainingPercent - q.remainingPercent)[0] ?? null;

// A window without a reported length counts as the longest.
const length = (window: KnownWindow): number => window.durationMinutes ?? Number.POSITIVE_INFINITY;

function limits(account: MeasuredAccount): Pick<CompactLine, 'window' | 'other' | 'tighter'> {
  const known = account.windows.filter(isKnown);
  const whole = known.filter(w => !w.scope && !w.partial);
  const pool = whole.length ? whole : known;
  const shortest = Math.min(...pool.map(length));
  const window = tightest(pool.filter(w => length(w) === shortest));
  // The other limit may be one model's or part of the account's: spent, it stops that work, so
  // it is shown. Only a limit on the whole account runs the account out first, though.
  const other = window ? tightest(known.filter(w => w !== window)) : null;
  const tighter = window && other && !other.partial && other.remainingPercent < window.remainingPercent ? other : null;
  return { window, other, tighter };
}

function noteFor(account: MeasuredAccount): CompactNote {
  if (account.status === 'pending') return 'reading';
  if (account.status === 'app_closed') return 'openApp';
  if (toolNotFound(account)) return 'notFound';
  if (account.status === 'no_limits_reported') return 'noLimits';
  if (WAITING_STATUSES.has(account.status)) return 'waiting';
  return needsSignIn(account) ? 'signIn' : 'noData';
}

// One line per account of the tool, its main account first.
export function compactLines(state: ProviderState, lowQuotaPercent: number): CompactLine[] {
  return [...state.accounts]
    .sort((a, b) => Number(b.primary) - Number(a.primary))
    .map(account => {
      const measured = account.status === 'ok' || (account.status === 'stale' && Boolean(account.fetchedAt));
      const { window, other, tighter } = measured ? limits(account) : { window: null, other: null, tighter: null };
      const isLow = (limit: KnownWindow | null): boolean => isLowQuota(limit?.remainingPercent ?? null, lowQuotaPercent);
      return {
        account,
        window,
        other,
        tighter,
        stale: account.status === 'stale',
        low: isLow(window),
        tighterLow: isLow(tighter),
        note: window ? null : noteFor(account)
      };
    });
}
