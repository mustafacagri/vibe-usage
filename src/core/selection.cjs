'use strict';
// Which account or provider can take new work. One rule for every provider: a fresh,
// successful measurement whose relevant windows are all known and above the floor.
// Unknown quota is never treated as available.
const { normalizeProviderOrder } = require('../catalog.cjs');
const { AppError } = require('./errors.cjs');

const QUOTA_FLOOR_PERCENT = 5;
const MEASUREMENT_MAX_AGE_MS = 5 * 60 * 1000;
// Model families that providers report as per-model quota scopes.
const MODEL_FAMILIES = ['fable', 'opus', 'sonnet', 'haiku', 'gemini', 'gpt'];
// Fable usage can be billed outside the general windows: without its own scope the
// quota for it is unknown rather than covered by the general limits.
const SCOPE_REQUIRED_FAMILIES = ['fable'];

function modelFamily(model) {
  const name = String(model || '').toLowerCase();
  return MODEL_FAMILIES.find(family => name.includes(family)) || null;
}

function relevantWindows(account, model) {
  const windows = account?.windows || [];
  const family = modelFamily(model);
  return {
    family,
    general: windows.filter(w => !w.scope),
    scoped: windows.filter(w => w.scope && (!family || w.scope.toLowerCase().includes(family)))
  };
}

function isMeasurementFresh(account, now) {
  const fetchedAt = Date.parse(account?.fetchedAt);
  return account?.status === 'ok' && Number.isFinite(fetchedAt) && now - fetchedAt <= MEASUREMENT_MAX_AGE_MS;
}

function isWindowKnown(window) {
  return !window.stale && !(window.scope && window.active === false) && Number.isFinite(window.remainingPercent);
}

function isAccountEligible(account, { model, now = Date.now() } = {}) {
  if (!isMeasurementFresh(account, now)) return false;
  const { family, general, scoped } = relevantWindows(account, model);
  if (SCOPE_REQUIRED_FAMILIES.includes(family) && !scoped.length) return false;
  const relevant = [...general, ...scoped];
  return relevant.length > 0 && relevant.every(w => isWindowKnown(w) && w.remainingPercent > QUOTA_FLOOR_PERCENT);
}

// The tightest relevant limit, i.e. what the user can actually spend.
function headroomPercent(account, model) {
  const { general, scoped } = relevantWindows(account, model);
  const values = [...general, ...scoped].filter(isWindowKnown).map(w => w.remainingPercent);
  return values.length ? Math.min(...values) : null;
}

const primaryFirst = (a, b) => Number(b.primary) - Number(a.primary);

function configuredAccounts(snapshot, providerId) {
  return snapshot.settings.accounts.filter(a => a.providerId === providerId && a.enabled !== false);
}

function measuredAccount(snapshot, account) {
  return snapshot.providers.find(p => p.id === account.providerId)?.accounts.find(a => a.id === account.id) || null;
}

// Explicit choice wins; otherwise the primary-first eligible account, or null.
function selectAccount(snapshot, providerId, { accountId, model, now = Date.now() } = {}) {
  const accounts = configuredAccounts(snapshot, providerId);
  if (accountId) {
    const chosen = accounts.find(a => a.id === accountId);
    if (!chosen) throw new AppError('account_not_found');
    return chosen;
  }
  return [...accounts].sort(primaryFirst).find(a => isAccountEligible(measuredAccount(snapshot, a), { model, now })) || null;
}

// The account a tool uses when nothing is verified: the user's primary, else the first.
function primaryAccount(snapshot, providerId) {
  return [...configuredAccounts(snapshot, providerId)].sort(primaryFirst)[0] || null;
}

// First provider in the user's order with an eligible account. When none qualifies, the
// first provider is returned unverified so the caller can say so instead of guessing.
function selectProvider(snapshot, { exclude, now = Date.now() } = {}) {
  const order = normalizeProviderOrder(snapshot.settings.providerOrder).filter(id => id !== exclude);
  for (const [index, providerId] of order.entries()) {
    const account = selectAccount(snapshot, providerId, { now });
    if (account) {
      return {
        providerId,
        account,
        verified: true,
        isFallback: index > 0,
        headroomPercent: headroomPercent(measuredAccount(snapshot, account))
      };
    }
  }
  return { providerId: order[0], account: primaryAccount(snapshot, order[0]), verified: false, isFallback: false, headroomPercent: null };
}

const CREDENTIAL_ENV_PREFIXES = ['ANTHROPIC_', 'CLAUDE_', 'AWS_'];

// Risks of starting Claude Code with a chosen profile, as i18n keys with params.
// `settingsFiles` maps a display name to a parsed Claude settings.json (or null).
function claudeLaunchWarnings(snapshot, account, { model, settingsFiles = {}, now = Date.now() } = {}) {
  const warnings = [];
  for (const [file, settings] of Object.entries(settingsFiles)) {
    if (settings?.env && Object.keys(settings.env).some(k => CREDENTIAL_ENV_PREFIXES.some(prefix => k.toUpperCase().startsWith(prefix)))) {
      warnings.push({ key: 'warnSettingsEnvOverride', params: { file } });
    }
    if (settings?.apiKeyHelper) warnings.push({ key: 'warnApiKeyHelper', params: { file } });
  }
  const measured = measuredAccount(snapshot, account);
  if (!isAccountEligible(measured, { model, now })) warnings.push({ key: 'warnQuotaUnverified', params: {} });
  const { general, scoped } = relevantWindows(measured, model);
  if ([...general, ...scoped].some(w => w.remainingPercent === 0)) warnings.push({ key: 'warnQuotaExhausted', params: {} });
  return warnings;
}

module.exports = {
  QUOTA_FLOOR_PERCENT,
  isAccountEligible,
  headroomPercent,
  selectAccount,
  primaryAccount,
  selectProvider,
  claudeLaunchWarnings
};
