import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProviderError } from '../core/errors.ts';
import { asArray, isFile, isObject, type JsonObject } from '../core/files.ts';
import { normalizeWindow, safePlan, safeText } from '../core/model.ts';
import { durationLabel, MINUTES, type PeriodLabel } from '../shared/catalog.ts';
import type { Account, QuotaWindow } from '../shared/types.ts';
import { readClaudeKeychain } from './claude-keychain.ts';
import {
  getJson as defaultGetJson,
  isExpired,
  QUOTA_ENDPOINTS,
  readCredentialFile,
  USER_AGENT,
  type Clock,
  type GetJson,
  type RunProcess
} from './common.ts';
import type { DiscoveredAccount, ParsedQuota, ProviderAdapter } from './types.ts';

// Required by the OAuth usage endpoint.
const OAUTH_BETA = 'oauth-2025-04-20';
// Fixed windows the usage endpoint reports at top level; Opus/Sonnet are per-model scopes.
const USAGE_WINDOWS: Readonly<Record<string, { minutes: number; required?: true; scope?: string }>> = {
  five_hour: { minutes: MINUTES.FIVE_HOURS, required: true },
  seven_day: { minutes: MINUTES.WEEK, required: true },
  seven_day_opus: { minutes: MINUTES.WEEK, scope: 'Opus' },
  seven_day_sonnet: { minutes: MINUTES.WEEK, scope: 'Sonnet' }
};
// `limits[].kind` values that duplicate a top-level window when they carry no model scope.
const CANONICAL_LIMIT_KINDS: Readonly<Record<string, string>> = { session: 'five_hour', weekly_all: 'seven_day' };
const LIMIT_KIND_MINUTES: Readonly<Record<string, number>> = { session: MINUTES.FIVE_HOURS };
const WEEKLY_KIND_PREFIX = 'weekly';
const ID_HASH_LENGTH = 12;

const shortHash = (value: string): string => crypto.createHash('sha256').update(value).digest('hex').slice(0, ID_HASH_LENGTH);

function limitPeriod(kind: string): PeriodLabel | { label: string } {
  if (kind.startsWith(WEEKLY_KIND_PREFIX)) return durationLabel(MINUTES.WEEK);
  const minutes = LIMIT_KIND_MINUTES[kind];
  return minutes ? durationLabel(minutes) : { label: kind.replaceAll('_', ' ') };
}

// A limit's model scope: the model's display name or id, or a plain scope string.
function limitScope(record: JsonObject): { scope: string; modelId: unknown } {
  if (typeof record.scope === 'string') return { scope: safeText(record.scope), modelId: undefined };
  const model = isObject(record.scope) && isObject(record.scope.model) ? record.scope.model : {};
  return { scope: safeText(model.display_name) || safeText(model.id), modelId: model.id };
}

export function parseClaudeUsage(usage: unknown): ParsedQuota {
  if (!isObject(usage)) throw new ProviderError('invalid_response');
  const windows: QuotaWindow[] = [];
  for (const [id, spec] of Object.entries(USAGE_WINDOWS)) {
    const value = usage[id];
    const reported = isObject(value) ? value : undefined;
    if (!spec.required && !reported) continue;
    windows.push(
      normalizeWindow({
        id,
        ...durationLabel(spec.minutes),
        usedPercent: reported?.utilization,
        resetsAt: reported?.resets_at,
        ...(spec.scope ? { scope: spec.scope } : {})
      })
    );
  }
  const limits = asArray(usage.limits).filter(isObject);
  for (const record of limits) {
    const kind = safeText(record.kind, 'unknown');
    const { scope, modelId } = limitScope(record);
    const canonicalId = scope ? undefined : CANONICAL_LIMIT_KINDS[kind];
    const identity = [record.id, modelId, scope, record.window, record.period].find(
      (value): value is string | number => (typeof value === 'string' || typeof value === 'number') && Boolean(value)
    );
    const window = normalizeWindow({
      id: canonicalId ?? `limit:${kind}:${shortHash(String(identity ?? 'general'))}`,
      ...limitPeriod(kind),
      usedPercent: record.percent,
      resetsAt: record.resets_at,
      ...(scope ? { scope } : {}),
      active: record.is_active
    });
    const canonical = canonicalId ? windows.find(w => w.id === canonicalId) : undefined;
    if (!canonical) windows.push(window);
    else if (canonical.usedPercent === null && window.usedPercent !== null) Object.assign(canonical, window);
    else if (typeof record.is_active === 'boolean') canonical.active = record.is_active;
  }
  return { windows };
}

export const DEFAULT_PROFILE_DIR = '.claude';
const SECONDARY_PROFILE_DIR = '.claude-secondary';
export const DEFAULT_ACCOUNT_ID = 'claude:default';
const SECONDARY_ACCOUNT_ID = 'claude:secondary';
export const CREDENTIALS_FILE = '.credentials.json';
// Model name Claude Code records on messages it generated itself (API errors, limit notices).
export const SYNTHETIC_MODEL = '<synthetic>';
const SETTINGS_FILE = 'settings.json';
// Profile folders Claude Code creates (`~/.claude`, `~/.claude-<name>`), minus copies.
const PROFILE_DIR = /^\.claude(?:-[a-zA-Z0-9_-]+)?$/;
const COPY_DIR = /(?:^|[-_])(backup|backups|history|old|archive|copy|bak)(?:[-_]|$)/i;

interface OAuthCredentials {
  accessToken: string;
  expiresAt?: unknown;
  subscriptionType?: unknown;
}

// The OAuth section of a credentials document, when it holds an access token.
function oauthCredentials(credentials: unknown): OAuthCredentials | null {
  const oauth = isObject(credentials) ? credentials.claudeAiOauth : undefined;
  if (!isObject(oauth) || typeof oauth.accessToken !== 'string' || !oauth.accessToken.trim()) return null;
  return { accessToken: oauth.accessToken, expiresAt: oauth.expiresAt, subscriptionType: oauth.subscriptionType };
}

export function profileAccount(configDir: string, defaultDir: string, configDirExplicit?: boolean): DiscoveredAccount {
  const resolved = path.resolve(configDir);
  const isDefault = resolved === path.resolve(defaultDir) && !configDirExplicit;
  const isSecondary = path.basename(configDir) === SECONDARY_PROFILE_DIR;
  const id = isDefault ? DEFAULT_ACCOUNT_ID : isSecondary ? SECONDARY_ACCOUNT_ID : `claude:${shortHash(resolved)}`;
  const naming = isDefault
    ? { labelKey: 'accountA' as const }
    : isSecondary
      ? { labelKey: 'accountB' as const }
      : { label: path.basename(configDir).replace(/^\.claude-?/, '') || resolved };
  return {
    id,
    providerId: 'claude',
    ...naming,
    configDir: resolved,
    ...(configDirExplicit === undefined ? {} : { configDirExplicit }),
    primary: isDefault,
    enabled: true
  };
}

// A profile counts when it holds a signed-in credentials file. On macOS credentials live in
// the Keychain, so a configured profile (settings.json present) counts as well.
async function isSignedInProfile(root: string, platform: NodeJS.Platform): Promise<boolean> {
  if (platform === 'darwin' && (await isFile(path.join(root, SETTINGS_FILE)))) return true;
  const file = path.join(root, CREDENTIALS_FILE);
  // A symlinked credentials file could point anywhere; only a regular file counts.
  const stat = await fsp.lstat(file).catch(() => null);
  if (!stat?.isFile()) return false;
  return oauthCredentials(await readCredentialFile(file).catch(() => null)) !== null;
}

// Default first, then the secondary profile, then the rest by id.
const PROFILE_RANK: Readonly<Record<string, number>> = { [DEFAULT_ACCOUNT_ID]: 0, [SECONDARY_ACCOUNT_ID]: 1 };
const rank = (account: DiscoveredAccount): number => PROFILE_RANK[account.id] ?? 2;

export async function discoverClaudeAccounts({
  home = os.homedir(),
  platform = process.platform
}: { home?: string; platform?: NodeJS.Platform } = {}): Promise<DiscoveredAccount[]> {
  const defaultDir = path.join(home, DEFAULT_PROFILE_DIR);
  const entries = await fsp.readdir(home, { withFileTypes: true }).catch(() => []);
  const roots = entries
    .filter(e => e.isDirectory() && PROFILE_DIR.test(e.name) && !COPY_DIR.test(e.name))
    .map(e => path.join(home, e.name));
  const accounts: DiscoveredAccount[] = [];
  for (const root of roots) {
    const explicit = path.resolve(root) !== path.resolve(defaultDir);
    if (await isSignedInProfile(root, platform)) accounts.push(profileAccount(root, defaultDir, explicit));
  }
  // The default profile always exists on macOS (its Keychain entry may hold the sign-in),
  // and is the fallback everywhere when nothing was found.
  if (!accounts.some(a => a.id === DEFAULT_ACCOUNT_ID) && (platform === 'darwin' || !accounts.length))
    accounts.push(profileAccount(defaultDir, defaultDir, false));
  accounts.sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));
  const [first] = accounts;
  if (first && !accounts.some(a => a.primary)) first.primary = true;
  return accounts;
}

export interface ClaudeProviderOptions {
  home?: string;
  platform?: NodeJS.Platform;
  clock?: Clock;
  getJson?: GetJson;
  runProcess?: RunProcess;
  readCredentials?: (account: Account) => Promise<unknown>;
}

async function readClaudeCredentials(account: Account, options: ClaudeProviderOptions): Promise<JsonObject> {
  const { platform = process.platform, home = os.homedir() } = options;
  const configDir = account.configDir ?? path.join(home, DEFAULT_PROFILE_DIR);
  if (platform === 'darwin') {
    const configDirExplicit = account.configDirExplicit ?? account.id !== DEFAULT_ACCOUNT_ID;
    const stored = await readClaudeKeychain({
      configDir,
      configDirExplicit,
      platform,
      ...(options.runProcess ? { runProcess: options.runProcess } : {})
    }).catch(() => null);
    // Without a usable token in the Keychain, the credentials file is the documented fallback.
    if (stored && oauthCredentials(stored)) return stored;
  }
  try {
    return await readCredentialFile(path.join(configDir, CREDENTIALS_FILE));
  } catch (error) {
    if (platform !== 'darwin' || !(error instanceof ProviderError) || error.code !== 'auth_missing') throw error;
    const isDefaultDir = path.resolve(configDir) === path.resolve(home, DEFAULT_PROFILE_DIR);
    throw new ProviderError(isDefaultDir ? 'keychain_unavailable' : 'unsupported_profile');
  }
}

export function createClaudeProvider(options: ClaudeProviderOptions = {}): ProviderAdapter {
  const getJson = options.getJson ?? defaultGetJson;
  const readCredentials = options.readCredentials ?? ((account: Account) => readClaudeCredentials(account, options));
  return {
    id: 'claude',
    discover: () => discoverClaudeAccounts(options),
    async fetch(account) {
      const oauth = oauthCredentials(await readCredentials(account));
      if (!oauth) throw new ProviderError('auth_missing');
      if (isExpired(oauth.expiresAt, options.clock)) throw new ProviderError('auth_expired');
      const usage = await getJson(QUOTA_ENDPOINTS.claude, {
        headers: {
          Authorization: `Bearer ${oauth.accessToken}`,
          'anthropic-beta': OAUTH_BETA,
          'User-Agent': USER_AGENT,
          Accept: 'application/json'
        }
      });
      const result = parseClaudeUsage(usage);
      const plan = safePlan(oauth.subscriptionType);
      return plan ? { ...result, plan } : result;
    }
  };
}
