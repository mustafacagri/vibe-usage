import os from 'node:os';
import path from 'node:path';
import type { Environment } from '../core/environment.ts';
import { ProviderError } from '../core/errors.ts';
import { isObject, type JsonObject } from '../core/files.ts';
import { normalizeWindow, safePlan } from '../core/model.ts';
import type { MessageKey } from '../shared/i18n/index.ts';
import type { QuotaWindow } from '../shared/types.ts';
import {
  findBinary,
  getJson as defaultGetJson,
  isExpired,
  jwtClaims,
  QUOTA_ENDPOINTS,
  readCredentialFile,
  runProcess as defaultRunProcess,
  type Clock,
  type GetJson,
  type RunProcess
} from './common.ts';
import type { ParsedQuota, ProviderAdapter } from './types.ts';

const USAGE_TIMEOUT_MS = 20000;
const SQLITE_TIMEOUT_MS = 5000;
// Percent-based plan scopes reported as `<scope>PercentUsed`.
const PLAN_SCOPES: Readonly<Record<string, { labelKey: MessageKey; detailKey?: MessageKey; section?: 'details' }>> = {
  auto: { labelKey: 'labelAutoScope' },
  api: { labelKey: 'labelApiScope', detailKey: 'cursorApiLimitNote' },
  total: { labelKey: 'labelTotalUsage', detailKey: 'totalQuotaDesc', section: 'details' }
};
// Money pools reported in USD cents per usage group.
const SPEND_POOLS: Readonly<Record<string, MessageKey>> = {
  onDemand: 'labelOnDemandSpend',
  overall: 'labelOverallSpend',
  pooled: 'labelPooledSpend'
};
const USAGE_GROUPS = ['individual', 'team'] as const;
const SUMMARY_FIELDS = ['individualUsage', 'teamUsage', 'membershipType', 'billingCycleEnd'];

const poolAmounts = (pool: JsonObject): JsonObject => ({ used: pool.used, limit: pool.limit, remaining: pool.remaining });

// Without a remaining amount the value says so; the UI words amounts it does have.
function poolValue(pool: JsonObject): { valueKey?: MessageKey } {
  if (pool.enabled === false) return { valueKey: 'disabled' };
  return typeof pool.remaining === 'number' && Number.isFinite(pool.remaining) ? {} : { valueKey: 'amountNotReported' };
}

export function parseCursorUsage(summary: unknown): ParsedQuota {
  if (!isObject(summary) || !SUMMARY_FIELDS.some(field => summary[field] !== undefined)) throw new ProviderError('invalid_response');
  const resetsAt = summary.billingCycleEnd;
  const windows: QuotaWindow[] = [];
  const individual = isObject(summary.individualUsage) ? summary.individualUsage : {};
  if (isObject(individual.plan)) {
    const plan = individual.plan;
    for (const [scope, keys] of Object.entries(PLAN_SCOPES)) {
      windows.push(normalizeWindow({ id: `plan:${scope}`, ...keys, usedPercent: plan[`${scope}PercentUsed`], resetsAt }));
    }
    const bonus = isObject(plan.breakdown) ? plan.breakdown.bonus : undefined;
    windows.push(
      normalizeWindow({
        id: 'plan:spend',
        labelKey: 'labelIncludedSpend',
        section: 'details',
        resetsAt,
        amounts: { ...poolAmounts(plan), bonus },
        ...poolValue(plan)
      })
    );
  }
  for (const group of USAGE_GROUPS) {
    const usage = summary[`${group}Usage`];
    for (const [key, labelKey] of Object.entries(SPEND_POOLS)) {
      const pool = isObject(usage) ? usage[key] : undefined;
      if (!isObject(pool)) continue;
      windows.push(
        normalizeWindow({
          id: `${group}:${key}`,
          labelKey,
          group,
          section: 'details',
          resetsAt,
          amounts: poolAmounts(pool),
          ...poolValue(pool)
        })
      );
    }
  }
  const membership = safePlan(summary.membershipType);
  return {
    windows,
    ...(membership ? { plan: membership } : {}),
    ...(windows.length ? {} : { status: 'no_limits_reported' as const })
  };
}

interface TokenSource {
  home: string;
  platform: NodeJS.Platform;
  env: Environment;
  runProcess: RunProcess;
}

async function readAccessToken({ home, platform, env, runProcess }: TokenSource): Promise<unknown> {
  if (platform === 'win32') {
    const auth = await readCredentialFile(path.join(env.APPDATA ?? path.join(home, 'AppData/Roaming'), 'Cursor/auth.json'));
    return auth.accessToken;
  }
  if (platform !== 'darwin') throw new ProviderError('unsupported_platform');
  // Source: CodexBar CursorAppAuth.swift, resolveDefaultDBPath/loadSession. `immutable=1`
  // reads Cursor's live database without locking or mutating it.
  const db = path.join(home, 'Library/Application Support/Cursor/User/globalStorage/state.vscdb');
  const query = "SELECT value FROM ItemTable WHERE key = 'cursorAuth/accessToken' LIMIT 1;";
  try {
    return (await runProcess('/usr/bin/sqlite3', ['-readonly', `file:${db}?immutable=1`, query], { timeoutMs: SQLITE_TIMEOUT_MS })).trim();
  } catch (error) {
    throw new ProviderError('auth_missing', { cause: error });
  }
}

const COOKIE_USER = /^[A-Za-z0-9._-]+$/;

// The session cookie is `<user id>::<token>`; the user id is the last `|` segment of `sub`.
function sessionCookie(token: string, clock?: Clock): string {
  const { sub, exp } = jwtClaims(token);
  const user = typeof sub === 'string' ? (sub.split('|').at(-1) ?? '') : '';
  if (!COOKIE_USER.test(user) || typeof exp !== 'number' || !Number.isFinite(exp)) throw new ProviderError('auth_invalid');
  if (isExpired(exp * 1000, clock)) throw new ProviderError('auth_expired');
  return `WorkosCursorSessionToken=${user}%3A%3A${token}`;
}

// The Cursor Agent CLI; older installs only have the `agent` name. Null when not installed.
export async function findCursorAgent(): Promise<string | null> {
  for (const name of ['cursor-agent', 'agent']) {
    const binary = await findBinary(name).catch(() => null);
    if (binary) return binary;
  }
  return null;
}

export interface CursorProviderOptions {
  home?: string;
  platform?: NodeJS.Platform;
  env?: Environment;
  clock?: Clock;
  getJson?: GetJson;
  runProcess?: RunProcess;
}

export function createCursorProvider(options: CursorProviderOptions = {}): ProviderAdapter {
  const source: TokenSource = {
    home: options.home ?? os.homedir(),
    platform: options.platform ?? process.platform,
    env: options.env ?? process.env,
    runProcess: options.runProcess ?? defaultRunProcess
  };
  const getJson = options.getJson ?? defaultGetJson;
  return {
    id: 'cursor',
    discover: () =>
      Promise.resolve([{ id: 'cursor:default', providerId: 'cursor', labelKey: 'defaultAccount', primary: true, enabled: true }]),
    async fetch(account) {
      if (account.configDir) throw new ProviderError('unsupported_profile');
      const token = await readAccessToken(source);
      if (typeof token !== 'string' || !token.trim()) throw new ProviderError('auth_missing');
      const usage = await getJson(QUOTA_ENDPOINTS.cursor, {
        headers: { Accept: 'application/json', Cookie: sessionCookie(token, options.clock) },
        timeoutMs: USAGE_TIMEOUT_MS
      });
      return parseCursorUsage(usage);
    }
  };
}
