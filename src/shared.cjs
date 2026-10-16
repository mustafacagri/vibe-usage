// Presentation shared by the renderer and the CLI: turns language-neutral snapshot data
// into display text. Wording comes from the injected `t`; numbers, money and durations
// from Intl in the given locale. Loaded in the renderer as a classic script (UMD).
(function (root) {
  'use strict';

  const MINUTE_MS = 60 * 1000;
  // Countdown granularity: coarser as the distance grows (42m · 3h 11m · 49h · 4d 5h).
  const MINUTE_PRECISION_UNTIL_MINUTES = 10 * 60;
  const HOURS_ONLY_UNTIL_MINUTES = 72 * 60;
  // CLDR's narrow units are ambiguous in some languages (tr: '3s 11d' = 3 hours 11 minutes;
  // ja falls back to Latin '3h11m'), so these use the short style.
  const SHORT_DURATION_LANGUAGES = /^(tr|de|nl|ja)\b/i;
  const AMOUNT_KEYS = { used: 'amountUsed', limit: 'amountLimit', remaining: 'amountRemaining', bonus: 'amountBonus' };
  const CENTS_PER_DOLLAR = 100;
  const CURRENCY = 'USD';

  const isNumber = value => typeof value === 'number' && Number.isFinite(value);
  const clampPercent = value => (isNumber(value) ? Math.max(0, Math.min(100, value)) : null);

  function formatPercent(value, locale) {
    return new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 }).format(value / 100);
  }

  function formatMoney(cents, locale) {
    return new Intl.NumberFormat(locale, { style: 'currency', currency: CURRENCY }).format(cents / CENTS_PER_DOLLAR);
  }

  function durationParts(ms) {
    const minutes = Math.max(1, Math.round(Math.max(0, ms) / MINUTE_MS));
    if (minutes < 60) return { minutes };
    if (minutes < MINUTE_PRECISION_UNTIL_MINUTES) return { hours: Math.floor(minutes / 60), minutes: minutes % 60 };
    const hours = Math.round(minutes / 60);
    if (minutes < HOURS_ONLY_UNTIL_MINUTES) return { hours };
    return { days: Math.floor(hours / 24), hours: hours % 24 };
  }

  function formatDuration(ms, locale) {
    const parts = Object.fromEntries(Object.entries(durationParts(ms)).filter(([, value]) => value));
    const style = SHORT_DURATION_LANGUAGES.test(locale) ? 'short' : 'narrow';
    return new Intl.DurationFormat(locale, { style }).format(parts);
  }

  function formatDate(date, locale) {
    return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(
      date
    );
  }

  // A window whose model scope the source marks inactive: its numbers are not an entitlement.
  const isPassive = window => window.active === false && Boolean(window.scope);

  function windowLabel(window, t) {
    const base = window.labelKey ? t(window.labelKey, window.labelParams || {}) : window.label || window.id;
    return window.group === 'team' ? `${t('labelTeam')} · ${base}` : base;
  }

  function windowValue(window, t, locale) {
    const remaining = clampPercent(window.remainingPercent);
    if (isPassive(window)) {
      const used = clampPercent(window.usedPercent);
      return used === null ? t('passiveSource') : t('percentUsed', { n: formatPercent(used, locale) });
    }
    if (window.valueKey) return t(window.valueKey);
    if (isNumber(window.amounts?.remaining)) return t('amountLeft', { n: formatMoney(window.amounts.remaining, locale) });
    if (window.amounts) return t('amountNotReported');
    return remaining === null ? t('noData') : t('percentRemaining', { n: formatPercent(remaining, locale) });
  }

  function windowDetail(window, t, locale) {
    if (window.amounts) {
      return Object.entries(AMOUNT_KEYS)
        .filter(([field]) => isNumber(window.amounts[field]))
        .map(([field, key]) => t(key, { n: formatMoney(window.amounts[field], locale) }))
        .join(' · ');
    }
    if (window.detailKey) return t(window.detailKey);
    return isPassive(window) ? t('passiveSourceDetail') : '';
  }

  // Everything a quota row shows. `percent` drives the bar and is null when the value is
  // not a remaining percentage (passive scopes, money, unknown).
  function describeWindow(window, { t, locale, now = Date.now() }) {
    const resetDate = window.resetsAt ? new Date(window.resetsAt) : null;
    const hasReset = Boolean(resetDate && Number.isFinite(resetDate.getTime()));
    const resetInMs = hasReset ? resetDate.getTime() - now : null;
    return {
      label: windowLabel(window, t),
      value: windowValue(window, t, locale),
      percent: isPassive(window) || window.amounts || window.valueKey ? null : clampPercent(window.remainingPercent),
      detail: windowDetail(window, t, locale),
      reset: hasReset ? (resetInMs <= 0 ? t('resetsNow') : t('resetsIn', { time: formatDuration(resetInMs, locale) })) : '',
      resetAt: hasReset ? t('resetsAt', { date: formatDate(resetDate, locale) }) : ''
    };
  }

  function formatAge(timestamp, { t, locale, now = Date.now() }) {
    const ms = now - timestamp;
    return ms < MINUTE_MS ? t('justNow') : t('agoTime', { time: formatDuration(ms, locale) });
  }

  function formatFreshness(iso, status, { t, locale, now = Date.now() }) {
    if (!iso) return t('notMeasuredYet');
    const fetchedAt = Date.parse(iso);
    if (!Number.isFinite(fetchedAt)) return t('measurementTimeUnknown');
    const age = formatAge(fetchedAt, { t, locale, now });
    return status === 'stale' ? t('staleAge', { age }) : age;
  }

  // Message for an error or status code: app errors, then provider status codes, then a
  // generic line for internal codes that have no user-facing wording.
  function describeCode(code, { t, has }, params = {}) {
    if (has(`error_${code}`)) return t(`error_${code}`, params);
    if (has(`status_${code}`)) return t(`status_${code}`, params);
    return t('error_unexpected');
  }

  const api = { formatPercent, formatDuration, describeWindow, formatAge, formatFreshness, describeCode };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.VibeFormat = api;
})(globalThis);
