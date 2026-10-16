'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { normalizeWindow, safeText, safePlan } = require('../core/model.cjs');
const common = require('./common.cjs');
const { MINUTES, durationLabel } = require('../catalog.cjs');

// Required by the OAuth usage endpoint.
const OAUTH_BETA = 'oauth-2025-04-20';
// Fixed windows the usage endpoint reports at top level; Opus/Sonnet are per-model scopes.
const USAGE_WINDOWS = {
  five_hour: { minutes: MINUTES.FIVE_HOURS, required: true },
  seven_day: { minutes: MINUTES.WEEK, required: true },
  seven_day_opus: { minutes: MINUTES.WEEK, scope: 'Opus' },
  seven_day_sonnet: { minutes: MINUTES.WEEK, scope: 'Sonnet' }
};
// `limits[].kind` values that duplicate a top-level window when they carry no model scope.
const CANONICAL_LIMIT_KINDS = { session: 'five_hour', weekly_all: 'seven_day' };
const LIMIT_KIND_MINUTES = { session: MINUTES.FIVE_HOURS };
const WEEKLY_KIND_PREFIX = 'weekly';
const ID_HASH_LENGTH = 12;

function limitPeriod(kind) {
  if (kind.startsWith(WEEKLY_KIND_PREFIX)) return durationLabel(MINUTES.WEEK);
  if (LIMIT_KIND_MINUTES[kind]) return durationLabel(LIMIT_KIND_MINUTES[kind]);
  return { label: kind.replace(/_/g, ' ') };
}

function parseClaudeUsage(usage) {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) throw new common.ProviderError('invalid_response');
  const windows = [];
  for (const [id, spec] of Object.entries(USAGE_WINDOWS)) {
    if (!spec.required && !usage[id]) continue;
    windows.push(normalizeWindow({ id, ...durationLabel(spec.minutes), usedPercent: usage[id]?.utilization, resetsAt: usage[id]?.resets_at, ...(spec.scope ? { scope: spec.scope } : {}) }));
  }
  for (const record of (Array.isArray(usage.limits) ? usage.limits : [])) {
    if (!record || typeof record !== 'object') continue;
    const kind = safeText(record.kind, 'unknown');
    const model = record.scope?.model;
    const scope = safeText(model?.display_name || model?.id || (typeof record.scope === 'string' ? record.scope : ''), '');
    const canonical = scope ? null : CANONICAL_LIMIT_KINDS[kind];
    const identity = String(record.id || model?.id || scope || record.window || record.period || 'general');
    const stableId = crypto.createHash('sha256').update(identity).digest('hex').slice(0, ID_HASH_LENGTH);
    const window = normalizeWindow({ id: canonical || `limit:${kind}:${stableId}`, ...limitPeriod(kind), usedPercent: record.percent, resetsAt: record.resets_at, ...(scope ? { scope } : {}), active: record.is_active });
    if (!canonical) { windows.push(window); continue; }
    const current = windows.find(w => w.id === canonical);
    if (current.usedPercent === null && window.usedPercent !== null) Object.assign(current, window);
    else if (typeof record.is_active === 'boolean') current.active = record.is_active;
  }
  return { windows };
}

const SECONDARY_PROFILE_DIR = '.claude-secondary';
function profileAccount(configDir, defaultDir, configDirExplicit) {
  const isDefault = path.resolve(configDir) === path.resolve(defaultDir) && !configDirExplicit;
  const isSecondary = path.basename(configDir) === SECONDARY_PROFILE_DIR;
  const suffix = isDefault ? 'default' : isSecondary ? 'secondary' : crypto.createHash('sha256').update(path.resolve(configDir)).digest('hex').slice(0, ID_HASH_LENGTH);
  const naming = isDefault ? { labelKey: 'accountA' } : isSecondary ? { labelKey: 'accountB' } : { label: path.basename(configDir).replace(/^\.claude-?/, '') || path.resolve(configDir) };
  return { id: `claude:${suffix}`, providerId: 'claude', ...naming, configDir: path.resolve(configDir), ...(configDirExplicit !== undefined ? { configDirExplicit } : {}), primary: isDefault, enabled: true };
}
async function discoverClaudeAccounts({ home = os.homedir(), platform = process.platform } = {}) {
  const defaultDir = path.join(home, '.claude');
  const entries = await fs.readdir(home, { withFileTypes: true }).catch(() => []);
  const roots = entries.filter(e => e.isDirectory() && /^\.claude(?:-[a-zA-Z0-9_-]+)?$/.test(e.name) && !/(?:^|[-_])(backup|backups|history|old|archive|copy|bak)(?:[-_]|$)/i.test(e.name)).map(e => path.join(home, e.name));
  const accounts = [];
  for (const root of roots) {
    try {
      const file = path.join(root, '.credentials.json');
      const isDefault = path.resolve(root) === path.resolve(defaultDir);
      if (platform === 'darwin') {
        const configured = await fs.stat(path.join(root,'settings.json')).then(s=>s.isFile()).catch(()=>false);
        if (configured) { accounts.push(profileAccount(root, defaultDir, isDefault ? false : true)); continue; }
      }
      if (!(await fs.lstat(file)).isFile()) continue;
      const auth = await common.readJson(file);
      if (typeof auth.claudeAiOauth?.accessToken === 'string' && auth.claudeAiOauth.accessToken.trim()) accounts.push(profileAccount(root, defaultDir, isDefault ? false : true));
    } catch { /* No history, backups, or raw credential values are exposed. */ }
  }
  // Only the default service name has been verified in primary source. A custom
  // Mac profile is never silently assigned the default profile's Keychain entry.
  if (platform === 'darwin' && !accounts.some(a => a.id === 'claude:default')) accounts.unshift(profileAccount(defaultDir, defaultDir, false));
  accounts.sort((a, b) => (a.id === 'claude:default' ? -1 : b.id === 'claude:default' ? 1 : a.id === 'claude:secondary' ? -1 : b.id === 'claude:secondary' ? 1 : a.id.localeCompare(b.id)));
  if (!accounts.length) accounts.push(profileAccount(defaultDir, defaultDir, false));
  if (!accounts.some(a => a.primary)) accounts[0].primary = true;
  return accounts;
}
async function readClaudeCredentials(account, options = {}) {
  if (options.readCredentials) return options.readCredentials(account);
  const platform = options.platform || process.platform, home = options.home || os.homedir();
  const configDir = account.configDir || path.join(home, '.claude');
  // Source: CodexBar ClaudeOAuth/ClaudeOAuthCredentials.swift, service constant
  // `Claude Code-credentials`. Read only; neither refresh nor Keychain write.
  if (platform === 'darwin') {
    const isExplicit = account.configDirExplicit !== undefined ? Boolean(account.configDirExplicit) : (account.id !== 'claude:default');
    try { return await require('./claude-keychain.cjs').readClaudeKeychain({configDir, configDirExplicit: isExplicit, platform, runProcess: options.runProcess}); } catch { /* Documented file fallback below. */ }
  }
  try { return await common.readJson(path.join(configDir, '.credentials.json')); }
  catch (error) { if (platform === 'darwin' && error.code === 'auth_missing') throw new common.ProviderError(path.resolve(configDir) === path.resolve(home, '.claude') ? 'keychain_unavailable' : 'unsupported_profile'); throw error; }
}
function createClaudeProvider(options = {}) {
  return { id: 'claude', discover: () => discoverClaudeAccounts(options), async fetch(account) {
    const credentials = await readClaudeCredentials(account, options);
    const oauth = credentials.claudeAiOauth;
    if (typeof oauth?.accessToken !== 'string' || !oauth.accessToken.trim()) throw new common.ProviderError('auth_missing');
    if (common.isExpired(oauth.expiresAt, options.clock)) throw new common.ProviderError('auth_expired');
    const usage = await (options.getJson || common.getJson)(common.QUOTA_ENDPOINTS.claude, { headers: { Authorization: `Bearer ${oauth.accessToken}`, 'anthropic-beta': OAUTH_BETA, 'User-Agent': common.USER_AGENT, Accept: 'application/json' } });
    const result = parseClaudeUsage(usage);
    const plan = safePlan(oauth.subscriptionType);
    if (plan) result.plan = plan;
    return result;
  } };
}
module.exports = { parseClaudeUsage, profileAccount, discoverClaudeAccounts, createClaudeProvider };
