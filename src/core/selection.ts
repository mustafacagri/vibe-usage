// Which account or provider can take new work. One rule for every provider: a fresh,
// successful measurement whose relevant windows are all known and above the floor. Unknown
// quota is never treated as available.
import { normalizeProviderOrder, type ProviderId } from '../shared/catalog.ts';
import type { MessageKey } from '../shared/i18n/index.ts';
import type { Account, MeasuredAccount, QuotaWindow, Snapshot } from '../shared/types.ts';
import { AppError } from './errors.ts';
import { isObject } from './files.ts';

export const QUOTA_FLOOR_PERCENT = 5;
const MEASUREMENT_MAX_AGE_MS = 5 * 60 * 1000;
// Model families that providers report as per-model quota scopes.
const MODEL_FAMILIES = ['fable', 'opus', 'sonnet', 'haiku', 'gemini', 'gpt'];
// Fable usage can be billed outside the general windows: without its own scope the quota
// for it is unknown rather than covered by the general limits.
const SCOPE_REQUIRED_FAMILIES = new Set(['fable']);

// The parts of a snapshot selection reads.
export type QuotaState = Pick<Snapshot, 'providers'> & { settings: Pick<Snapshot['settings'], 'accounts' | 'providerOrder'> };

interface Options {
  model?: string | undefined;
  now?: number;
}

function modelFamily(model: string | undefined): string | undefined {
  const name = model?.toLowerCase() ?? '';
  return MODEL_FAMILIES.find(family => name.includes(family));
}

function relevantWindows(account: MeasuredAccount | null, model: string | undefined) {
  const windows = account?.windows ?? [];
  const family = modelFamily(model);
  return {
    family,
    windows: [...windows.filter(w => !w.scope), ...windows.filter(w => w.scope && (!family || w.scope.toLowerCase().includes(family)))],
    scoped: windows.some(w => w.scope && family && w.scope.toLowerCase().includes(family))
  };
}

function isMeasurementFresh(account: MeasuredAccount | null, now: number): account is MeasuredAccount {
  const fetchedAt = Date.parse(account?.fetchedAt ?? '');
  return account?.status === 'ok' && Number.isFinite(fetchedAt) && now - fetchedAt <= MEASUREMENT_MAX_AGE_MS;
}

const isWindowKnown = (window: QuotaWindow): window is QuotaWindow & { remainingPercent: number } =>
  !window.stale && !(window.scope && window.active === false) && window.remainingPercent !== null;

export function isAccountEligible(account: MeasuredAccount | null, { model, now = Date.now() }: Options = {}): boolean {
  if (!isMeasurementFresh(account, now)) return false;
  const { family, windows, scoped } = relevantWindows(account, model);
  if (family && SCOPE_REQUIRED_FAMILIES.has(family) && !scoped) return false;
  return windows.length > 0 && windows.every(w => isWindowKnown(w) && w.remainingPercent > QUOTA_FLOOR_PERCENT);
}

// The tightest relevant limit, i.e. what the user can actually spend.
export function headroomPercent(account: MeasuredAccount | null, model?: string): number | null {
  const values = relevantWindows(account, model)
    .windows.filter(isWindowKnown)
    .map(w => w.remainingPercent);
  return values.length ? Math.min(...values) : null;
}

const primaryFirst = (a: Account, b: Account): number => Number(b.primary) - Number(a.primary);

function configuredAccounts(state: QuotaState, providerId: ProviderId): Account[] {
  return state.settings.accounts.filter(a => a.providerId === providerId && a.enabled);
}

function measuredAccount(state: QuotaState, account: Account): MeasuredAccount | null {
  return state.providers.find(p => p.id === account.providerId)?.accounts.find(a => a.id === account.id) ?? null;
}

// Explicit choice wins; otherwise the primary-first eligible account, or null.
export function selectAccount(
  state: QuotaState,
  providerId: ProviderId,
  { accountId, model, now = Date.now() }: Options & { accountId?: string | undefined } = {}
): Account | null {
  const accounts = configuredAccounts(state, providerId);
  if (accountId) {
    const chosen = accounts.find(a => a.id === accountId);
    if (!chosen) throw new AppError('account_not_found');
    return chosen;
  }
  return accounts.sort(primaryFirst).find(a => isAccountEligible(measuredAccount(state, a), { model, now })) ?? null;
}

// The account a tool uses when nothing is verified: the user's primary, else the first.
export function primaryAccount(state: QuotaState, providerId: ProviderId): Account | null {
  return configuredAccounts(state, providerId).sort(primaryFirst)[0] ?? null;
}

export interface ProviderChoice {
  providerId: ProviderId;
  account: Account | null;
  verified: boolean;
  isFallback: boolean;
  headroomPercent: number | null;
}

// First provider in the user's order with an eligible account. When none qualifies, the
// first provider is returned unverified so the caller can say so instead of guessing.
export function selectProvider(
  state: QuotaState,
  { exclude, now = Date.now() }: { exclude?: ProviderId | null; now?: number } = {}
): ProviderChoice {
  const order = normalizeProviderOrder(state.settings.providerOrder).filter(id => id !== exclude);
  for (const [index, providerId] of order.entries()) {
    const account = selectAccount(state, providerId, { now });
    if (account)
      return {
        providerId,
        account,
        verified: true,
        isFallback: index > 0,
        headroomPercent: headroomPercent(measuredAccount(state, account))
      };
  }
  // `exclude` removes at most one provider, so the order is never empty.
  const [first] = order;
  if (!first) throw new Error('provider order is empty');
  return { providerId: first, account: primaryAccount(state, first), verified: false, isFallback: false, headroomPercent: null };
}

const CREDENTIAL_ENV_PREFIXES = ['ANTHROPIC_', 'CLAUDE_', 'AWS_'];

export interface LaunchWarning {
  key: MessageKey;
  params: Readonly<Record<string, string>>;
}

// Risks of starting Claude Code with a chosen profile. `settingsFiles` maps a display name
// to a parsed Claude settings.json (or null).
export function claudeLaunchWarnings(
  state: QuotaState,
  account: Account,
  { model, settingsFiles = {}, now = Date.now() }: Options & { settingsFiles?: Readonly<Record<string, unknown>> } = {}
): LaunchWarning[] {
  const warnings: LaunchWarning[] = [];
  for (const [file, settings] of Object.entries(settingsFiles)) {
    if (!isObject(settings)) continue;
    const overrides = isObject(settings.env) ? Object.keys(settings.env) : [];
    if (overrides.some(name => CREDENTIAL_ENV_PREFIXES.some(prefix => name.toUpperCase().startsWith(prefix))))
      warnings.push({ key: 'warnSettingsEnvOverride', params: { file } });
    if (settings.apiKeyHelper) warnings.push({ key: 'warnApiKeyHelper', params: { file } });
  }
  const measured = measuredAccount(state, account);
  if (!isAccountEligible(measured, { model, now })) warnings.push({ key: 'warnQuotaUnverified', params: {} });
  if (relevantWindows(measured, model).windows.some(w => w.remainingPercent === 0))
    warnings.push({ key: 'warnQuotaExhausted', params: {} });
  return warnings;
}
