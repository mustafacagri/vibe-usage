import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import type { Environment } from '../core/environment.ts';
import { ProviderError } from '../core/errors.ts';
import { isFile, isObject, type JsonObject } from '../core/files.ts';
import { normalizeWindow, safePlan } from '../core/model.ts';
import { accountId, DEFAULT_ACCOUNT_KEY } from '../shared/catalog.ts';
import type { MessageKey } from '../shared/i18n/index.ts';
import type { QuotaWindow } from '../shared/types.ts';
import {
  findBinary,
  getJson as defaultGetJson,
  isExpired,
  jwtClaims,
  QUOTA_ENDPOINTS,
  readCredentialFile,
  remainingTimeout,
  runProcess as defaultRunProcess,
  TOOL_INSTALLS,
  type Clock,
  type GetJson,
  type RunProcess
} from './common.ts';
import type { ParsedQuota, ProviderAdapter, RefreshContext } from './types.ts';

const USAGE_TIMEOUT_MS = 20000;
const SQLITE_TIMEOUT_MS = 5000;
// Percent-based plan scopes reported as `<scope>PercentUsed`.
const PLAN_SCOPES: Readonly<
  Record<string, { labelKey: MessageKey; detailKey?: MessageKey; section?: 'details'; partial?: true; except?: string[] }>
> = {
  auto: { labelKey: 'labelAutoScope' },
  // Spent, it stops the API-priced models only; Auto goes on.
  api: { labelKey: 'labelApiScope', detailKey: 'cursorApiLimitNote', partial: true, except: ['auto'] },
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
  for (const group of USAGE_GROUPS) {
    const usage = summary[`${group}Usage`];
    if (usage !== undefined && usage !== null && !isObject(usage)) throw new ProviderError('invalid_response');
  }
  const resetsAt = summary.billingCycleEnd;
  const windows: QuotaWindow[] = [];
  const individual = isObject(summary.individualUsage) ? summary.individualUsage : {};
  if (individual.plan !== undefined && individual.plan !== null && !isObject(individual.plan)) throw new ProviderError('invalid_response');
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
      if (pool !== undefined && pool !== null && !isObject(pool)) throw new ProviderError('invalid_response');
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
    completeness: 'complete',
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

const TOKEN_KEY = 'cursorAuth/accessToken';
const APP_STORE = 'User/globalStorage/state.vscdb';

// The token the Cursor app keeps in its own database, read without taking part in its writes.
// This is a live WAL database: read-only mode includes committed WAL frames, whereas immutable
// mode would ignore them and could use a previous account's token after a sign-in change.
async function readAppStoreToken(file: string, context?: RefreshContext): Promise<unknown> {
  remainingTimeout(SQLITE_TIMEOUT_MS, context);
  if (!(await isFile(file))) throw new ProviderError('auth_missing');
  try {
    const database = new DatabaseSync(file, { readOnly: true, timeout: SQLITE_TIMEOUT_MS });
    try {
      return database.prepare('SELECT value FROM ItemTable WHERE key = ? LIMIT 1').get(TOKEN_KEY)?.value;
    } finally {
      database.close();
    }
  } catch (error) {
    throw new ProviderError('process_failed', { cause: error });
  }
}

// The signed-in sessions this machine holds, most authoritative first. On Windows that is the
// app's own sign-in, then the one the Cursor Agent CLI keeps in auth.json: either can be the
// only one present, and either can be the one that is still valid.
async function readAccessTokens({ home, platform, env, runProcess }: TokenSource, context?: RefreshContext): Promise<unknown[]> {
  if (platform === 'win32') {
    const roaming = env.APPDATA ?? path.join(home, 'AppData/Roaming');
    const reads = [
      () => readAppStoreToken(path.join(roaming, 'Cursor', APP_STORE), context),
      async () => (await readCredentialFile(path.join(roaming, 'Cursor/auth.json'), context)).accessToken
    ];
    const tokens: unknown[] = [];
    let failure: ProviderError | undefined;
    for (const read of reads) {
      try {
        tokens.push(await read());
      } catch (error) {
        // A missing store is the normal state of a machine that never used it.
        if (!(error instanceof ProviderError)) throw error;
        if (error.code !== 'auth_missing') failure ??= error;
      }
    }
    if (!tokens.length && failure) throw failure;
    return tokens;
  }
  if (platform !== 'darwin') throw new ProviderError('unsupported_platform');
  const uri = pathToFileURL(path.join(home, 'Library/Application Support/Cursor', APP_STORE));
  uri.searchParams.set('mode', 'ro');
  const query = `SELECT value FROM ItemTable WHERE key = '${TOKEN_KEY}' LIMIT 1;`;
  try {
    return [(await runProcess('/usr/bin/sqlite3', ['-readonly', uri.href, query], { timeoutMs: SQLITE_TIMEOUT_MS, ...context })).trim()];
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError('process_failed', { cause: error });
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

// How to start the Cursor Agent CLI: the program and the arguments that come before the user's.
export interface CursorAgentCommand {
  binary: string;
  args: readonly string[];
}

// The folder names the CLI's own launcher accepts (not the `.previous` copy kept beside an update).
const VERSION_FOLDER = /^\d{4}\.\d{1,2}\.\d{1,2}(-\d{2}-\d{2}-\d{2})?-[a-f0-9]+$/;

// The date a version folder is named after (2026.10.14-0f9edde, or with a build time after the
// day), as a number that orders the folders; the CLI's own launcher picks the newest the same way.
function versionDay(name: string): number {
  const [year = '', month = '', day = ''] = (name.split('-')[0] ?? '').split('.');
  const value = Number(`${year}${month.padStart(2, '0')}${day.padStart(2, '0')}`);
  return Number.isFinite(value) ? value : 0;
}

// On Windows the CLI is installed as .cmd and .ps1 wrappers, which are never started. They run
// the node.exe and index.js of the newest version folder; those are started directly.
export async function findWindowsCursorAgent(env: Environment = process.env, home = os.homedir()): Promise<CursorAgentCommand | null> {
  const root = path.join(env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), 'cursor-agent');
  const versions = (await fsp.readdir(path.join(root, 'versions')).catch(() => []))
    .filter(name => VERSION_FOLDER.test(name))
    .sort((a, b) => versionDay(b) - versionDay(a) || b.localeCompare(a));
  for (const directory of [root, ...versions.map(name => path.join(root, 'versions', name))]) {
    const binary = path.join(directory, 'node.exe');
    const script = path.join(directory, 'index.js');
    if ((await isFile(binary)) && (await isFile(script))) return { binary, args: [script] };
  }
  return null;
}

// The Cursor Agent CLI; null when not installed.
export async function findCursorAgent(env: Environment = process.env, home = os.homedir()): Promise<CursorAgentCommand | null> {
  for (const name of TOOL_INSTALLS.cursor.binaries) {
    const binary = await findBinary(name, { env, home }).catch(() => null);
    if (binary) return { binary, args: [] };
  }
  return process.platform === 'win32' ? findWindowsCursorAgent(env, home) : null;
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
    fetchTimeoutMs: SQLITE_TIMEOUT_MS + USAGE_TIMEOUT_MS,
    discover: () =>
      Promise.resolve([
        { id: accountId('cursor', DEFAULT_ACCOUNT_KEY), providerId: 'cursor', labelKey: 'defaultAccount', primary: true, enabled: true }
      ]),
    async fetch(account, context) {
      if (account.configDir) throw new ProviderError('unsupported_profile');
      const tokens = await readAccessTokens(source, context);
      remainingTimeout(USAGE_TIMEOUT_MS, context);
      // The first session that is still usable; if none is, the first one's reason.
      let cookie: string | undefined;
      let failure: Error = new ProviderError('auth_missing');
      let reason = false;
      for (const token of tokens) {
        if (typeof token !== 'string' || !token.trim()) continue;
        try {
          cookie = sessionCookie(token, options.clock);
          break;
        } catch (error) {
          if (!reason && error instanceof Error) failure = error;
          reason = true;
        }
      }
      if (!cookie) throw failure;
      const usage = await getJson(QUOTA_ENDPOINTS.cursor, {
        headers: { Accept: 'application/json', Cookie: cookie },
        timeoutMs: USAGE_TIMEOUT_MS,
        ...context
      });
      return parseCursorUsage(usage);
    }
  };
}
