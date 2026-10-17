// Presentation shared by the renderer and the CLI: turns language-neutral snapshot data into
// display text. Wording comes from the injected `t`; numbers, money and durations from Intl
// in the given locale.
import { hasKey, type Params, type Translate } from './i18n/index.ts';
import type { Amounts, QuotaWindow } from './types.ts';

export interface FormatContext {
  t: Translate;
  locale: string;
  now?: number;
}

const MINUTE_MS = 60 * 1000;
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
  const minutes = Math.max(1, Math.round(Math.max(0, ms) / MINUTE_MS));
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

export function formatAge(timestamp: number, { t, locale, now = Date.now() }: FormatContext): string {
  const ms = now - timestamp;
  return ms < MINUTE_MS ? t('justNow') : t('agoTime', { time: formatDuration(ms, locale) });
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
