'use strict';
const path = require('node:path');
const os = require('node:os');
const { normalizeWindow, safePlan } = require('../core/model.cjs');
const common = require('./common.cjs');

const USAGE_TIMEOUT_MS = 20000;
const SQLITE_TIMEOUT_MS = 5000;
// Percent-based plan scopes reported as `<scope>PercentUsed`.
const PLAN_SCOPES = {
  auto: { labelKey: 'labelAutoScope' },
  api: { labelKey: 'labelApiScope', detailKey: 'cursorApiLimitNote' },
  total: { labelKey: 'labelTotalUsage', detailKey: 'totalQuotaDesc', section: 'details' }
};
// Money pools reported in USD cents per usage group.
const SPEND_POOLS = { onDemand: 'labelOnDemandSpend', overall: 'labelOverallSpend', pooled: 'labelPooledSpend' };
const USAGE_GROUPS = ['individual', 'team'];

function poolAmounts(pool) {
  return { used: pool.used, limit: pool.limit, remaining: pool.remaining };
}

// Without a remaining amount the value says so; the UI words amounts it does have.
function poolValueKey(pool) {
  if (pool.enabled === false) return 'disabled';
  return Number.isFinite(pool.remaining) ? undefined : 'amountNotReported';
}

function parseCursorUsage(summary) {
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) throw new common.ProviderError('invalid_response');
  const hasKnownFields = ['individualUsage', 'teamUsage', 'membershipType', 'billingCycleEnd'].some(k => summary[k] !== undefined);
  if (!hasKnownFields) throw new common.ProviderError('invalid_response');
  const resetsAt = summary.billingCycleEnd;
  const windows = [];
  const plan = summary.individualUsage?.plan;
  if (plan) {
    for (const [scope, keys] of Object.entries(PLAN_SCOPES)) {
      windows.push(normalizeWindow({ id: `plan:${scope}`, ...keys, usedPercent: plan[`${scope}PercentUsed`], resetsAt }));
    }
    windows.push(normalizeWindow({
      id: 'plan:spend', labelKey: 'labelIncludedSpend', section: 'details', resetsAt,
      amounts: { ...poolAmounts(plan), bonus: plan.breakdown?.bonus },
      ...(poolValueKey(plan) ? { valueKey: poolValueKey(plan) } : {})
    }));
  }
  for (const group of USAGE_GROUPS) {
    const usage = summary[`${group}Usage`];
    for (const [key, labelKey] of Object.entries(SPEND_POOLS)) {
      const pool = usage?.[key];
      if (!pool) continue;
      const valueKey = poolValueKey(pool);
      windows.push(normalizeWindow({ id: `${group}:${key}`, labelKey, group, section: 'details', resetsAt, amounts: poolAmounts(pool), ...(valueKey ? { valueKey } : {}) }));
    }
  }
  const result = { windows };
  const membership = safePlan(summary.membershipType);
  if (membership) result.plan = membership;
  if (!windows.length) result.status = 'no_limits_reported';
  return result;
}

async function readAccessToken({ home, platform, env, runProcess }) {
  if (platform === 'win32') {
    return (await common.readJson(path.join(env.APPDATA || path.join(home, 'AppData/Roaming'), 'Cursor/auth.json'))).accessToken;
  }
  if (platform !== 'darwin') throw new common.ProviderError('unsupported_platform');
  // Source: CodexBar CursorAppAuth.swift, resolveDefaultDBPath/loadSession. `immutable=1`
  // reads Cursor's live database without locking or mutating it.
  const db = path.join(home, 'Library/Application Support/Cursor/User/globalStorage/state.vscdb');
  try {
    const query = "SELECT value FROM ItemTable WHERE key = 'cursorAuth/accessToken' LIMIT 1;";
    return (await runProcess('/usr/bin/sqlite3', ['-readonly', `file:${db}?immutable=1`, query], { timeoutMs: SQLITE_TIMEOUT_MS })).trim();
  } catch {
    throw new common.ProviderError('auth_missing');
  }
}

// The session cookie is `<user id>::<token>`; the user id is the last `|` segment of `sub`.
function sessionCookie(token, clock) {
  const claims = common.jwtClaims(token);
  const user = typeof claims.sub === 'string' ? claims.sub.split('|').at(-1) : '';
  if (!/^[A-Za-z0-9._-]+$/.test(user) || !Number.isFinite(claims.exp)) throw new common.ProviderError('auth_invalid');
  if (common.isExpired(claims.exp * 1000, clock)) throw new common.ProviderError('auth_expired');
  return `WorkosCursorSessionToken=${user}%3A%3A${token}`;
}

function createCursorProvider(options = {}) {
  const context = {
    home: options.home || os.homedir(),
    platform: options.platform || process.platform,
    env: options.env || process.env,
    runProcess: options.runProcess || common.runProcess
  };
  return {
    id: 'cursor',
    discover: async () => [{ id: 'cursor:default', providerId: 'cursor', labelKey: 'defaultAccount', primary: true, enabled: true }],
    async fetch(account) {
      if (account.configDir) throw new common.ProviderError('unsupported_profile');
      const token = await readAccessToken(context);
      if (typeof token !== 'string' || !token.trim()) throw new common.ProviderError('auth_missing');
      const usage = await (options.getJson || common.getJson)(common.QUOTA_ENDPOINTS.cursor, {
        headers: { Accept: 'application/json', Cookie: sessionCookie(token, options.clock) },
        timeoutMs: USAGE_TIMEOUT_MS
      });
      return parseCursorUsage(usage);
    }
  };
}

module.exports = { parseCursorUsage, createCursorProvider };
