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
function normalizeWindow(input = {}) {
  let usedPercent = percent(input.usedPercent), remainingPercent = percent(input.remainingPercent);
  if (usedPercent === null && remainingPercent !== null) usedPercent = 100 - remainingPercent;
  if (remainingPercent === null && usedPercent !== null) remainingPercent = 100 - usedPercent;
  const result = { id: safeText(input.id, 'unknown'), label: safeText(input.label, safeText(input.id, 'Unknown')), usedPercent, remainingPercent, resetsAt: isoDate(input.resetsAt) };
  if (typeof input.labelKey === 'string') result.labelKey = safeText(input.labelKey, '', 60);
  if (typeof input.detailKey === 'string') result.detailKey = safeText(input.detailKey, '', 60);
  if (input.labelParams && typeof input.labelParams === 'object') result.labelParams = input.labelParams;
  if (typeof input.durationMinutes === 'number' && Number.isFinite(input.durationMinutes)) result.durationMinutes = input.durationMinutes;
  if (typeof input.scope === 'string') result.scope = safeText(input.scope);
  if (typeof input.active === 'boolean') result.active = input.active;
  if (typeof input.detail === 'string') result.detail = safeText(input.detail, '', 360);
  if (typeof input.valueText === 'string') result.valueText = safeText(input.valueText, '', 100);
  return result;
}
// Passive/absent model metadata does not establish entitlement. This helper only
// qualifies measured, active windows; callers still need a supported launch path.
function isAccountEligible(account, model) {
  if (!account || account.status !== 'ok' || !Array.isArray(account.windows) || account.windows.length === 0) return false;
  const general = account.windows.filter(w => !w.scope);
  const scoped = model ? account.windows.filter(w => w.scope?.toLowerCase() === model.toLowerCase()) : [];
  if (model && scoped.length === 0) return false;
  const relevant = [...general, ...scoped];
  return relevant.length > 0 && relevant.every(w => !(w.scope && w.active === false) && !w.stale && percent(w.remainingPercent) !== null && w.remainingPercent > 0);
}
module.exports = { percent, isoDate, safeText, normalizeWindow, isAccountEligible };
