import os from 'node:os';
import path from 'node:path';
import { ProviderError } from '../core/errors.ts';
import { asArray, isObject, readJson, samePath, type JsonObject } from '../core/files.ts';
import { normalizeWindow, safeEmail, safePlan, safeText } from '../core/model.ts';
import { accountId, DEFAULT_ACCOUNT_KEY, durationLabel, MINUTES, PROFILE_DIRS, type PeriodLabel } from '../shared/catalog.ts';
import type { Account, QuotaWindow } from '../shared/types.ts';
import { readClaudeKeychain } from './claude-keychain.ts';
import {
  getJson as defaultGetJson,
  isExpired,
  QUOTA_ENDPOINTS,
  readCredentialFile,
  remainingTimeout,
  USER_AGENT,
  type Clock,
  type GetJson,
  type RunProcess
} from './common.ts';
import { defaultProfileDir, isRegularFile, profileAccountId, profileFolders, profileLabel, shortHash } from './profiles.ts';
import { type Discovery, type DiscoveredAccount, type ParsedQuota, type ProviderAdapter, type RefreshContext } from './types.ts';

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
  const removedWindowIds: string[] = [];
  const limits = asArray(usage.limits).filter(isObject);
  const listed = new Set(limits.map(record => CANONICAL_LIMIT_KINDS[safeText(record.kind)]).filter(Boolean));
  for (const [id, spec] of Object.entries(USAGE_WINDOWS)) {
    const value = usage[id];
    const reported = isObject(value) ? value : undefined;
    // Reported as null and absent from the limits too: the plan has no such limit (no weekly one,
    // say), which is not a limit of unknown size.
    const none = value === null && limits.length > 0 && !listed.has(id);
    if (none || (!spec.required && value === null)) removedWindowIds.push(id);
    if ((!spec.required && !reported) || none) continue;
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
  const complete =
    (usage.limits === undefined || (Array.isArray(usage.limits) && usage.limits.every(isObject))) &&
    Object.entries(USAGE_WINDOWS).every(([id, spec]) => !spec.required || isObject(usage[id]) || usage[id] === null);
  return { windows, completeness: complete ? 'complete' : 'partial', removedWindowIds };
}

const SECONDARY_PROFILE_DIR = `${PROFILE_DIRS.claude}-secondary`;
export const DEFAULT_ACCOUNT_ID = accountId('claude', DEFAULT_ACCOUNT_KEY);
const SECONDARY_ACCOUNT_ID = accountId('claude', 'secondary');
// Model name Claude Code records on messages it generated itself (API errors, limit notices).
export const SYNTHETIC_MODEL = '<synthetic>';
// What Claude Code keeps in a profile folder (and in a project's own `.claude` folder).
export const CLAUDE_FILES = {
  credentials: '.credentials.json',
  settings: 'settings.json',
  localSettings: 'settings.local.json',
  // The state file, which records the signed-in account.
  state: '.claude.json',
  // One folder of session transcripts per project.
  projects: 'projects',
  // The running processes, each listing itself (see claude-processes.ts).
  sessions: 'sessions'
} as const;

interface OAuthCredentials {
  accessToken: string;
  expiresAt?: unknown;
  subscriptionType?: unknown;
}

// The section of Claude Code's credentials (file or Keychain item) that holds its sign-in.
export const claudeOAuthSection = (credentials: unknown): JsonObject | null =>
  isObject(credentials) && isObject(credentials.claudeAiOauth) ? credentials.claudeAiOauth : null;

// The OAuth section of a credentials document, when it holds an access token.
function oauthCredentials(credentials: unknown): OAuthCredentials | null {
  const oauth = claudeOAuthSection(credentials);
  if (!oauth || typeof oauth.accessToken !== 'string' || !oauth.accessToken.trim()) return null;
  return { accessToken: oauth.accessToken, expiresAt: oauth.expiresAt, subscriptionType: oauth.subscriptionType };
}

// The account a Claude profile folder holds. Any folder but the default one is explicit: Claude
// Code then runs with CLAUDE_CONFIG_DIR set, which selects a different Keychain item on macOS.
export function claudeProfile(configDir: string, home: string): DiscoveredAccount {
  const resolved = path.resolve(configDir);
  const configDirExplicit = resolved !== path.resolve(defaultProfileDir('claude', home));
  const isSecondary = path.basename(configDir) === SECONDARY_PROFILE_DIR;
  const id = !configDirExplicit ? DEFAULT_ACCOUNT_ID : isSecondary ? SECONDARY_ACCOUNT_ID : profileAccountId('claude', resolved);
  const naming = !configDirExplicit
    ? { labelKey: 'accountA' as const }
    : isSecondary
      ? { labelKey: 'accountB' as const }
      : { label: profileLabel('claude', resolved) };
  return {
    id,
    providerId: 'claude',
    ...naming,
    configDir: resolved,
    configDirExplicit,
    primary: !configDirExplicit,
    enabled: true
  };
}

// A profile counts when it holds a signed-in credentials file. On macOS credentials live in
// the Keychain, so a configured profile (settings.json present) counts as well.
export async function isSignedInProfile(root: string, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  if (platform === 'darwin' && (await isRegularFile(path.join(root, CLAUDE_FILES.settings)))) return true;
  const file = path.join(root, CLAUDE_FILES.credentials);
  if (!(await isRegularFile(file))) return false;
  return oauthCredentials(await readCredentialFile(file)) !== null;
}

// Default first, then the secondary profile, then the rest by id.
const PROFILE_RANK: Readonly<Record<string, number>> = { [DEFAULT_ACCOUNT_ID]: 0, [SECONDARY_ACCOUNT_ID]: 1 };
const rank = (account: DiscoveredAccount): number => PROFILE_RANK[account.id] ?? 2;

// One profile that cannot be read (a half-written or locked credentials file) must not hide the
// others, and must not count as absent either: the discovery is then reported as unknown.
export async function discoverClaudeProfiles({
  home = os.homedir(),
  platform = process.platform
}: { home?: string; platform?: NodeJS.Platform } = {}): Promise<Discovery> {
  const accounts: DiscoveredAccount[] = [];
  let complete = true;
  for (const root of await profileFolders('claude', home)) {
    try {
      if (await isSignedInProfile(root, platform)) accounts.push(claudeProfile(root, home));
    } catch {
      complete = false;
    }
  }
  // The default profile always exists on macOS (its Keychain entry may hold the sign-in),
  // and is the fallback everywhere when nothing was found.
  if (!accounts.some(a => a.id === DEFAULT_ACCOUNT_ID) && (platform === 'darwin' || !accounts.length))
    accounts.push(claudeProfile(defaultProfileDir('claude', home), home));
  accounts.sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));
  const [first] = accounts;
  if (first && !accounts.some(a => a.primary)) first.primary = true;
  return { kind: complete ? 'complete' : 'unknown', accounts };
}

export async function discoverClaudeAccounts(options: { home?: string; platform?: NodeJS.Platform } = {}): Promise<DiscoveredAccount[]> {
  return (await discoverClaudeProfiles(options)).accounts;
}

export interface ClaudeProviderOptions {
  home?: string;
  platform?: NodeJS.Platform;
  clock?: Clock;
  getJson?: GetJson;
  runProcess?: RunProcess;
  readCredentials?: (account: Account, context?: RefreshContext) => Promise<unknown>;
}

export async function readClaudeCredentials(
  account: Account,
  options: ClaudeProviderOptions,
  context?: RefreshContext
): Promise<JsonObject> {
  const { platform = process.platform, home = os.homedir() } = options;
  const configDir = account.configDir ?? defaultProfileDir('claude', home);
  if (platform === 'darwin') {
    const configDirExplicit = account.configDirExplicit ?? account.id !== DEFAULT_ACCOUNT_ID;
    const stored = await readClaudeKeychain({
      configDir,
      configDirExplicit,
      platform,
      ...context,
      ...(options.runProcess ? { runProcess: options.runProcess } : {})
    }).catch(() => null);
    // Without a usable token in the Keychain, the credentials file is the documented fallback.
    if (stored && oauthCredentials(stored)) return stored;
  }
  try {
    return await readCredentialFile(path.join(configDir, CLAUDE_FILES.credentials), context);
  } catch (error) {
    if (platform !== 'darwin' || !(error instanceof ProviderError) || error.code !== 'auth_missing') throw error;
    const isDefaultDir = samePath(configDir, defaultProfileDir('claude', home));
    throw new ProviderError(isDefaultDir ? 'keychain_unavailable' : 'unsupported_profile');
  }
}

// The default profile keeps its state file in the home folder; any other in the profile folder.
export function claudeStateFile(account: Account, home = os.homedir()): string {
  const explicit = account.configDirExplicit ?? account.id !== DEFAULT_ACCOUNT_ID;
  return path.join(explicit && account.configDir ? account.configDir : home, CLAUDE_FILES.state);
}

async function readSignedInEmail(account: Account, { home = os.homedir() }: ClaudeProviderOptions): Promise<string | undefined> {
  const state = await readJson(claudeStateFile(account, home));
  return safeEmail(isObject(state) && isObject(state.oauthAccount) ? state.oauthAccount.emailAddress : undefined);
}

export function createClaudeProvider(options: ClaudeProviderOptions = {}): ProviderAdapter {
  const getJson = options.getJson ?? defaultGetJson;
  const readCredentials =
    options.readCredentials ?? ((account: Account, context?: RefreshContext) => readClaudeCredentials(account, options, context));
  return {
    id: 'claude',
    // Keychain (8s), then HTTPS (15s), plus bounded local work, share this budget.
    fetchTimeoutMs: 25000,
    discover: () => discoverClaudeProfiles(options).catch((): Discovery => ({ kind: 'unknown', accounts: [] })),
    async fetch(account, context) {
      remainingTimeout(25000, context);
      const oauth = oauthCredentials(await readCredentials(account, context));
      if (!oauth) throw new ProviderError('auth_missing');
      if (isExpired(oauth.expiresAt, options.clock)) throw new ProviderError('auth_expired');
      const usage = await getJson(QUOTA_ENDPOINTS.claude, {
        ...context,
        headers: {
          Authorization: `Bearer ${oauth.accessToken}`,
          'anthropic-beta': OAUTH_BETA,
          'User-Agent': USER_AGENT,
          Accept: 'application/json'
        }
      });
      const result = parseClaudeUsage(usage);
      const plan = safePlan(oauth.subscriptionType);
      const signedInAs = await readSignedInEmail(account, options);
      remainingTimeout(25000, context);
      return { ...result, ...(plan ? { plan } : {}), ...(signedInAs ? { signedInAs } : {}) };
    }
  };
}
