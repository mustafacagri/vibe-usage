'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { normalizeWindow, safeText, safePlan } = require('../core/model.cjs');
const common = require('./common.cjs');
const { readClaudeKeychain } = require('./claude-keychain.cjs');
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
    windows.push(
      normalizeWindow({
        id,
        ...durationLabel(spec.minutes),
        usedPercent: usage[id]?.utilization,
        resetsAt: usage[id]?.resets_at,
        ...(spec.scope ? { scope: spec.scope } : {})
      })
    );
  }
  for (const record of Array.isArray(usage.limits) ? usage.limits : []) {
    if (!record || typeof record !== 'object') continue;
    const kind = safeText(record.kind, 'unknown');
    const model = record.scope?.model;
    const scope = safeText(model?.display_name || model?.id || (typeof record.scope === 'string' ? record.scope : ''), '');
    const canonical = scope ? null : CANONICAL_LIMIT_KINDS[kind];
    const identity = String(record.id || model?.id || scope || record.window || record.period || 'general');
    const stableId = crypto.createHash('sha256').update(identity).digest('hex').slice(0, ID_HASH_LENGTH);
    const window = normalizeWindow({
      id: canonical || `limit:${kind}:${stableId}`,
      ...limitPeriod(kind),
      usedPercent: record.percent,
      resetsAt: record.resets_at,
      ...(scope ? { scope } : {}),
      active: record.is_active
    });
    if (!canonical) {
      windows.push(window);
      continue;
    }
    const current = windows.find(w => w.id === canonical);
    if (current.usedPercent === null && window.usedPercent !== null) Object.assign(current, window);
    else if (typeof record.is_active === 'boolean') current.active = record.is_active;
  }
  return { windows };
}

const DEFAULT_PROFILE_DIR = '.claude';
const SECONDARY_PROFILE_DIR = '.claude-secondary';
const DEFAULT_ACCOUNT_ID = 'claude:default';
const SECONDARY_ACCOUNT_ID = 'claude:secondary';
const CREDENTIALS_FILE = '.credentials.json';
// Model name Claude Code records on messages it generated itself (API errors, limit notices).
const SYNTHETIC_MODEL = '<synthetic>';
const SETTINGS_FILE = 'settings.json';
// Profile folders Claude Code creates (`~/.claude`, `~/.claude-<name>`), minus copies.
const PROFILE_DIR = /^\.claude(?:-[a-zA-Z0-9_-]+)?$/;
const COPY_DIR = /(?:^|[-_])(backup|backups|history|old|archive|copy|bak)(?:[-_]|$)/i;

// The OAuth access token in a credentials document, or null.
function oauthToken(credentials) {
  const token = credentials?.claudeAiOauth?.accessToken;
  return typeof token === 'string' && token.trim() ? token : null;
}

function profileAccount(configDir, defaultDir, configDirExplicit) {
  const isDefault = path.resolve(configDir) === path.resolve(defaultDir) && !configDirExplicit;
  const isSecondary = path.basename(configDir) === SECONDARY_PROFILE_DIR;
  const id = isDefault
    ? DEFAULT_ACCOUNT_ID
    : isSecondary
      ? SECONDARY_ACCOUNT_ID
      : `claude:${crypto.createHash('sha256').update(path.resolve(configDir)).digest('hex').slice(0, ID_HASH_LENGTH)}`;
  const naming = isDefault
    ? { labelKey: 'accountA' }
    : isSecondary
      ? { labelKey: 'accountB' }
      : { label: path.basename(configDir).replace(/^\.claude-?/, '') || path.resolve(configDir) };
  return {
    id,
    providerId: 'claude',
    ...naming,
    configDir: path.resolve(configDir),
    ...(configDirExplicit !== undefined ? { configDirExplicit } : {}),
    primary: isDefault,
    enabled: true
  };
}

const isFile = file =>
  fs.stat(file).then(
    stat => stat.isFile(),
    () => false
  );

// A profile counts when it holds a signed-in credentials file. On macOS credentials live in
// the Keychain, so a configured profile (settings.json present) counts as well.
async function isSignedInProfile(root, platform) {
  if (platform === 'darwin' && (await isFile(path.join(root, SETTINGS_FILE)))) return true;
  const file = path.join(root, CREDENTIALS_FILE);
  if (!(await fs.lstat(file).catch(() => null))?.isFile()) return false;
  return Boolean(oauthToken(await common.readJson(file).catch(() => null)));
}

// Default first, then the secondary profile, then the rest by id.
const PROFILE_RANK = { [DEFAULT_ACCOUNT_ID]: 0, [SECONDARY_ACCOUNT_ID]: 1 };
const rank = account => PROFILE_RANK[account.id] ?? 2;

async function discoverClaudeAccounts({ home = os.homedir(), platform = process.platform } = {}) {
  const defaultDir = path.join(home, DEFAULT_PROFILE_DIR);
  const entries = await fs.readdir(home, { withFileTypes: true }).catch(() => []);
  const roots = entries
    .filter(e => e.isDirectory() && PROFILE_DIR.test(e.name) && !COPY_DIR.test(e.name))
    .map(e => path.join(home, e.name));
  const accounts = [];
  for (const root of roots) {
    const explicit = path.resolve(root) !== path.resolve(defaultDir);
    if (await isSignedInProfile(root, platform)) accounts.push(profileAccount(root, defaultDir, explicit));
  }
  // The default profile always exists on macOS (its Keychain entry may hold the sign-in),
  // and is the fallback everywhere when nothing was found.
  if (!accounts.some(a => a.id === DEFAULT_ACCOUNT_ID) && (platform === 'darwin' || !accounts.length))
    accounts.push(profileAccount(defaultDir, defaultDir, false));
  accounts.sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));
  if (!accounts.some(a => a.primary)) accounts[0].primary = true;
  return accounts;
}

async function readClaudeCredentials(account, options = {}) {
  if (options.readCredentials) return options.readCredentials(account);
  const platform = options.platform || process.platform,
    home = options.home || os.homedir();
  const configDir = account.configDir || path.join(home, DEFAULT_PROFILE_DIR);
  // Source: CodexBar ClaudeOAuth/ClaudeOAuthCredentials.swift, service constant
  // `Claude Code-credentials`. Read only; neither refresh nor Keychain write.
  if (platform === 'darwin') {
    const configDirExplicit = account.configDirExplicit ?? account.id !== DEFAULT_ACCOUNT_ID;
    const stored = await readClaudeKeychain({ configDir, configDirExplicit, platform, runProcess: options.runProcess }).catch(() => null);
    // Without a usable token in the Keychain, the credentials file is the documented fallback.
    if (oauthToken(stored)) return stored;
  }
  try {
    return await common.readJson(path.join(configDir, CREDENTIALS_FILE));
  } catch (error) {
    if (platform !== 'darwin' || error.code !== 'auth_missing') throw error;
    const isDefaultDir = path.resolve(configDir) === path.resolve(home, DEFAULT_PROFILE_DIR);
    throw new common.ProviderError(isDefaultDir ? 'keychain_unavailable' : 'unsupported_profile');
  }
}

function createClaudeProvider(options = {}) {
  return {
    id: 'claude',
    discover: () => discoverClaudeAccounts(options),
    async fetch(account) {
      const credentials = await readClaudeCredentials(account, options);
      const token = oauthToken(credentials);
      if (!token) throw new common.ProviderError('auth_missing');
      const oauth = credentials.claudeAiOauth;
      if (common.isExpired(oauth.expiresAt, options.clock)) throw new common.ProviderError('auth_expired');
      const usage = await (options.getJson || common.getJson)(common.QUOTA_ENDPOINTS.claude, {
        headers: {
          Authorization: `Bearer ${token}`,
          'anthropic-beta': OAUTH_BETA,
          'User-Agent': common.USER_AGENT,
          Accept: 'application/json'
        }
      });
      const result = parseClaudeUsage(usage);
      const plan = safePlan(oauth.subscriptionType);
      if (plan) result.plan = plan;
      return result;
    }
  };
}
module.exports = {
  DEFAULT_ACCOUNT_ID,
  DEFAULT_PROFILE_DIR,
  CREDENTIALS_FILE,
  SYNTHETIC_MODEL,
  oauthToken,
  parseClaudeUsage,
  profileAccount,
  discoverClaudeAccounts,
  createClaudeProvider
};
