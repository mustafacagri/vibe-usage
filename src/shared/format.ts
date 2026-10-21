// Presentation shared by the renderer and the CLI: turns language-neutral snapshot data into
// display text. Wording comes from the injected `t`; numbers, money and durations from Intl
// in the given locale.
import { hasKey, type MessageKey, type Params, type Translate } from './i18n/index.ts';
import { DURATION_MS, providerById, type ProviderId } from './catalog.ts';
import type { LaunchMode } from './ipc.ts';
import type { Account, Amounts, MeasuredAccount, QuotaWindow, Suggestion } from './types.ts';

export interface FormatContext {
  t: Translate;
  locale: string;
  now?: number;
}

// Countdown granularity: coarser as the distance grows (42m · 3h 11m · 49h · 4d 5h).
const MINUTE_PRECISION_UNTIL_MINUTES = 10 * 60;
const HOURS_ONLY_UNTIL_MINUTES = 72 * 60;
// CLDR's narrow units are ambiguous in some languages (tr: '3s 11d' = 3 hours 11 minutes;
// ja falls back to Latin '3h11m'), so these use the short style.
const SHORT_DURATION_LANGUAGES = /^(tr|de|nl|ja)\b/i;
const AMOUNT_FIELDS = ['used', 'limit', 'remaining', 'bonus'] as const satisfies readonly (keyof Amounts)[];
const AMOUNT_KEYS = { used: 'amountUsed', limit: 'amountLimit', remaining: 'amountRemaining', bonus: 'amountBonus' } as const;
const CENTS_PER_DOLLAR = 100;
const CURRENCY = 'USD';

const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const clampPercent = (value: unknown): number | null => (isNumber(value) ? Math.max(0, Math.min(100, value)) : null);

export function formatPercent(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 }).format(value / 100);
}

function formatMoney(cents: number, locale: string): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency: CURRENCY }).format(cents / CENTS_PER_DOLLAR);
}

function durationParts(ms: number): Partial<Record<Intl.DurationFormatUnit, number>> {
  const minutes = Math.max(1, Math.round(Math.max(0, ms) / DURATION_MS.MINUTE));
  if (minutes < 60) return { minutes };
  if (minutes < MINUTE_PRECISION_UNTIL_MINUTES) return { hours: Math.floor(minutes / 60), minutes: minutes % 60 };
  const hours = Math.round(minutes / 60);
  if (minutes < HOURS_ONLY_UNTIL_MINUTES) return { hours };
  return { days: Math.floor(hours / 24), hours: hours % 24 };
}

export function formatDuration(ms: number, locale: string): string {
  const parts = Object.fromEntries(Object.entries(durationParts(ms)).filter(([, value]) => value));
  const style = SHORT_DURATION_LANGUAGES.test(locale) ? 'short' : 'narrow';
  return new Intl.DurationFormat(locale, { style }).format(parts);
}

function formatDate(date: Date, locale: string): string {
  return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(
    date
  );
}

// A window whose model scope the source marks inactive: its numbers are not an entitlement.
const isPassive = (window: QuotaWindow): boolean => window.active === false && Boolean(window.scope);

function windowLabel(window: QuotaWindow, t: Translate): string {
  const base = window.labelKey ? t(window.labelKey, window.labelParams) : (window.label ?? window.id);
  return window.group === 'team' ? `${t('labelTeam')} · ${base}` : base;
}

function windowValue(window: QuotaWindow, t: Translate, locale: string): string {
  if (isPassive(window)) {
    const used = clampPercent(window.usedPercent);
    return used === null ? t('passiveSource') : t('percentUsed', { n: formatPercent(used, locale) });
  }
  if (window.valueKey) return t(window.valueKey);
  if (window.amounts) {
    const { remaining } = window.amounts;
    return isNumber(remaining) ? t('amountLeft', { n: formatMoney(remaining, locale) }) : t('amountNotReported');
  }
  const remaining = clampPercent(window.remainingPercent);
  return remaining === null ? t('noData') : t('percentRemaining', { n: formatPercent(remaining, locale) });
}

function amountsDetail(amounts: Amounts, t: Translate, locale: string): string {
  return AMOUNT_FIELDS.flatMap(field => {
    const cents = amounts[field];
    return isNumber(cents) ? [t(AMOUNT_KEYS[field], { n: formatMoney(cents, locale) })] : [];
  }).join(' · ');
}

function windowDetail(window: QuotaWindow, t: Translate, locale: string): string {
  if (window.amounts) return amountsDetail(window.amounts, t, locale);
  if (window.detailKey) return t(window.detailKey);
  return isPassive(window) ? t('passiveSourceDetail') : '';
}

export interface WindowView {
  label: string;
  value: string;
  // Drives the bar; null when the value is not a remaining percentage (passive, money, unknown).
  percent: number | null;
  detail: string;
  reset: string;
  resetAt: string;
}

export function describeWindow(window: QuotaWindow, { t, locale, now = Date.now() }: FormatContext): WindowView {
  const resetDate = window.resetsAt ? new Date(window.resetsAt) : null;
  const resetMs = resetDate?.getTime();
  const hasReset = resetDate !== null && isNumber(resetMs);
  const reset = hasReset ? (resetMs - now <= 0 ? t('resetsNow') : t('resetsIn', { time: formatDuration(resetMs - now, locale) })) : '';
  return {
    label: windowLabel(window, t),
    value: windowValue(window, t, locale),
    percent: isPassive(window) || window.amounts || window.valueKey ? null : clampPercent(window.remainingPercent),
    detail: windowDetail(window, t, locale),
    reset,
    resetAt: hasReset ? t('resetsAt', { date: formatDate(resetDate, locale) }) : ''
  };
}

// A name the user typed or the source reported, else the e-mail the tool is signed in with,
// else the app-supplied one.
type AccountNaming = Pick<MeasuredAccount, 'label' | 'labelKey' | 'signedInAs'>;
const FALLBACK_ACCOUNT_NAME = 'defaultAccount' satisfies MessageKey;

export const formatAccountName = (account: AccountNaming, t: Translate): string =>
  account.label ?? account.signedInAs ?? t(account.labelKey ?? FALLBACK_ACCOUNT_NAME);

// Whether the account has a name of its own, rather than the fallback every account shares.
export const hasOwnName = (account: AccountNaming): boolean =>
  account.label !== undefined || account.signedInAs !== undefined || (account.labelKey ?? FALLBACK_ACCOUNT_NAME) !== FALLBACK_ACCOUNT_NAME;

// What is said once a tool started, by how it started.
export const LAUNCH_MESSAGES = { app: 'handoverApp', terminal: 'handoverTerminal' } as const satisfies Record<LaunchMode, MessageKey>;

// A tool, with the model it was started with when one was chosen.
export const toolLabel = (providerId: ProviderId, model: string | null | undefined): string =>
  model ? `${providerById(providerId).name} · ${model}` : providerById(providerId).name;

// What a suggestion's button says, in the window and in its notification.
export const SUGGESTION_BUTTONS = {
  low: 'suggestionContinueBtn',
  return: 'suggestionReturnBtn',
  reopen: 'suggestionReopenBtn'
} as const satisfies Record<Suggestion['kind'], MessageKey>;

// Who continues the work: another account of the same tool by its name, another tool by its.
export function successorName(
  from: ProviderId,
  to: { providerId: ProviderId; accountId: string | null },
  accounts: readonly Account[],
  t: Translate
): string {
  const account = accounts.find(a => a.id === to.accountId);
  return to.providerId === from && account ? formatAccountName(account, t) : providerById(to.providerId).name;
}

export function formatAge(timestamp: number, { t, locale, now = Date.now() }: FormatContext): string {
  const ms = now - timestamp;
  return ms < DURATION_MS.MINUTE ? t('justNow') : t('agoTime', { time: formatDuration(ms, locale) });
}

export function formatFreshness(iso: string | undefined, status: string, context: FormatContext): string {
  const { t } = context;
  if (!iso) return t('notMeasuredYet');
  const fetchedAt = Date.parse(iso);
  if (!Number.isFinite(fetchedAt)) return t('measurementTimeUnknown');
  const age = formatAge(fetchedAt, context);
  return status === 'stale' ? t('staleAge', { age }) : age;
}

// Message for an error or status code: app errors, then provider status codes, then a generic
// line for internal codes that have no user-facing wording. Codes arrive as plain strings
// from other processes, so they are checked against the catalogue at run time.
export function describeCode(code: string, t: Translate, params?: Params): string {
  const error = `error_${code}`;
  const status = `status_${code}`;
  if (hasKey(error)) return t(error, params);
  if (hasKey(status)) return t(status, params);
  return t('error_unexpected');
}

// The times, on the local clock, of a chart's grid lines: every whole `stepHours` mark after
// `start` and before `end` (24 gives the midnights).
export function gridTimes(start: number, end: number, stepHours: number): number[] {
  const times: number[] = [];
  const cursor = new Date(start);
  cursor.setMinutes(0, 0, 0);
  while (cursor.getTime() <= start || cursor.getHours() % stepHours !== 0) cursor.setHours(cursor.getHours() + 1);
  for (; cursor.getTime() < end; cursor.setHours(cursor.getHours() + stepHours)) times.push(cursor.getTime());
  return times;
}
