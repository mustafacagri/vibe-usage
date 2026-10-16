'use strict';

const percent = value => typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : null;
function isoDate(value, unixSeconds = false) {
  if (value === null || value === undefined || value === '') return null;
  if (unixSeconds && (typeof value !== 'number' || !Number.isFinite(value))) return null;
  if (!unixSeconds && typeof value !== 'string' && !(value instanceof Date)) return null;
  const date = new Date(unixSeconds ? value * 1000 : value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
function safeText(value, fallback = '', max = 160) {
  return typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, '').slice(0, max) : fallback;
}
// Quota window contract. Text we word ourselves travels as i18n keys (labelKey, detailKey,
// valueKey + params); `label` and `scope` carry only names reported by the source (model or
// group names), which are shown verbatim. Money stays numeric in `amounts` (USD cents).
// `section: 'details'` marks secondary windows the UI collapses (spend, combined totals).
const AMOUNT_FIELDS = ['used', 'limit', 'remaining', 'bonus'];
const KEY_MAX = 60;
// Plan names come from the provider and are shown as a badge; anything unusual is dropped.
function safePlan(value) {
  return typeof value === 'string' && /^[a-zA-Z][a-zA-Z0-9_ -]{0,40}$/.test(value) ? value : undefined;
}
function normalizeWindow(input = {}) {
  let usedPercent = percent(input.usedPercent), remainingPercent = percent(input.remainingPercent);
  if (usedPercent === null && remainingPercent !== null) usedPercent = 100 - remainingPercent;
  if (remainingPercent === null && usedPercent !== null) remainingPercent = 100 - usedPercent;
  const result = { id: safeText(input.id, 'unknown'), usedPercent, remainingPercent, resetsAt: isoDate(input.resetsAt) };
  if (typeof input.label === 'string' && input.label) result.label = safeText(input.label);
  for (const key of ['labelKey', 'detailKey', 'valueKey']) {
    if (typeof input[key] === 'string' && input[key]) result[key] = safeText(input[key], '', KEY_MAX);
  }
  if (input.labelParams && typeof input.labelParams === 'object') result.labelParams = input.labelParams;
  if (typeof input.durationMinutes === 'number' && Number.isFinite(input.durationMinutes)) result.durationMinutes = input.durationMinutes;
  if (typeof input.scope === 'string' && input.scope) result.scope = safeText(input.scope);
  if (typeof input.active === 'boolean') result.active = input.active;
  if (input.group === 'team') result.group = 'team';
  if (input.section === 'details') result.section = 'details';
  if (input.amounts && typeof input.amounts === 'object') {
    const amounts = Object.fromEntries(AMOUNT_FIELDS.filter(k => Number.isFinite(input.amounts[k])).map(k => [k, input.amounts[k]]));
    if (Object.keys(amounts).length) result.amounts = amounts;
  }
  return result;
}
module.exports = { percent, isoDate, safeText, safePlan, normalizeWindow };
