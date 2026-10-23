// Which account or provider can take new work. One rule for every provider: a fresh,
// successful measurement whose relevant windows are all known and above the floor. Unknown
// quota is never treated as available.
import { DURATION_MS, normalizeProviderOrder, type ProviderId } from '../shared/catalog.ts';
import type { MessageKey } from '../shared/i18n/index.ts';
import type { Account, AutoContinue, MeasuredAccount, PassedOver, PassOverReason, QuotaWindow, Snapshot } from '../shared/types.ts';
import { AppError } from './errors.ts';
import { isObject } from './files.ts';
import { nameMatchesFamily, quotaScopeFamily } from './model-families.ts';

export const QUOTA_FLOOR_PERCENT = 5;
// How old a reading may be to count as the quota now (eligibility, moves). Kept readings are a
// separate matter (measurements.ts).
const FRESH_READING_MAX_AGE_MS = 5 * DURATION_MS.MINUTE;

// The parts of a snapshot selection reads.
export type QuotaState = Pick<Snapshot, 'providers'> & { settings: Pick<Snapshot['settings'], 'accounts' | 'providerOrder'> };

interface Options {
  model?: string | undefined;
  now?: number;
}

// A partial limit that does not cover the model (Cursor's API pool for Auto).
const exempts = (window: QuotaWindow, model: string | undefined): boolean =>
  Boolean(window.partial && model && window.except?.includes(model.toLowerCase()));

// The limits that decide whether the account can take work with `model`. Secondary windows
// (spend, combined totals) never do; a partial limit does unless it does not cover the model,
// so without a known model it counts.
function relevantWindows(account: MeasuredAccount | null, model: string | undefined) {
  const windows = (account?.windows ?? []).filter(w => w.section !== 'details' && !exempts(w, model));
  const family = quotaScopeFamily(model);
  const covers = (scope: string): boolean => !family || nameMatchesFamily(scope, family.name);
  return {
    family,
    // Without a model every model scope counts: the work may be for any of them.
    windows: [...windows.filter(w => !w.scope), ...windows.filter(w => w.scope && covers(w.scope))],
    scoped: family !== undefined && windows.some(w => w.scope && covers(w.scope))
  };
}

export function isMeasurementFresh(account: MeasuredAccount | null, now: number): account is MeasuredAccount {
  const fetchedAt = Date.parse(account?.fetchedAt ?? '');
  const age = now - fetchedAt;
  return account?.status === 'ok' && Number.isFinite(fetchedAt) && age >= 0 && age <= FRESH_READING_MAX_AGE_MS;
}

export type KnownWindow = QuotaWindow & { remainingPercent: number };

// A window's `active` is the source's choice of headline row, not whether the limit applies:
// Claude's weekly rows are reported inactive while they still bind. It says nothing here.
const isWindowKnown = (window: QuotaWindow): window is KnownWindow => !window.stale && window.remainingPercent !== null;

export function isAccountEligible(account: MeasuredAccount | null, { model, now = Date.now() }: Options = {}): boolean {
  if (!isMeasurementFresh(account, now)) return false;
  const { family, windows, scoped } = relevantWindows(account, model);
  if (family?.scopeRequired && !scoped) return false;
  return windows.length > 0 && windows.every(w => isWindowKnown(w) && w.remainingPercent > QUOTA_FLOOR_PERCENT);
}

// The relevant window with the least left, i.e. the limit that decides what the user can spend.
export function tightestWindow(account: MeasuredAccount | null, model?: string): KnownWindow | null {
  return relevantWindows(account, model)
    .windows.filter(isWindowKnown)
    .reduce<KnownWindow | null>((tightest, w) => (tightest && tightest.remainingPercent <= w.remainingPercent ? tightest : w), null);
}

export const headroomPercent = (account: MeasuredAccount | null, model?: string): number | null =>
  tightestWindow(account, model)?.remainingPercent ?? null;

// The model the account can take the work with: the one planned when it has quota for it, else
// one its spent partial limits do not cover (Cursor's Auto once the API pool is spent); null
// when none. `{ model: undefined }` is the account's own default.
export function usableModel(
  account: MeasuredAccount | null,
  model: string | undefined,
  now = Date.now()
): { model: string | undefined } | null {
  if (isAccountEligible(account, { model, now })) return { model };
  const alternatives = new Set((account?.windows ?? []).filter(w => w.partial).flatMap(w => w.except ?? []));
  for (const alternative of alternatives)
    if (alternative !== model?.toLowerCase() && isAccountEligible(account, { model: alternative, now })) return { model: alternative };
  return null;
}

const primaryFirst = (a: Account, b: Account): number => Number(b.primary) - Number(a.primary);

function configuredAccounts(state: QuotaState, providerId: ProviderId): Account[] {
  return state.settings.accounts.filter(a => a.providerId === providerId && a.enabled);
}

// A project's preferred tool and account. The account narrows its tool's candidates to itself
// while it is still configured; a removed one no longer counts.
export interface Preference {
  tool?: ProviderId | undefined;
  accountId?: string | undefined;
}

function candidates(state: QuotaState, providerId: ProviderId, prefer: Preference = {}): Account[] {
  const accounts = configuredAccounts(state, providerId);
  const preferred = accounts.filter(a => a.id === prefer.accountId);
  return preferred.length ? preferred : accounts;
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

// Why the tool's account, its primary first, cannot take the work with `model`.
function passOverReason(state: QuotaState, account: Account | undefined, model: string | undefined, now: number): PassOverReason {
  if (!account) return { kind: 'no_account' };
  const measured = measuredAccount(state, account);
  if (measured?.messageCode) return { kind: 'status', code: measured.messageCode };
  const tightest = isMeasurementFresh(measured, now) ? tightestWindow(measured, model) : null;
  return tightest && tightest.remainingPercent <= QUOTA_FLOOR_PERCENT
    ? { kind: 'low', percent: tightest.remainingPercent }
    : { kind: 'unverified' };
}

export interface ProviderChoice {
  providerId: ProviderId;
  account: Account | null;
  // The model to launch it with, when one was planned or had to change for the quota.
  model?: string | undefined;
  verified: boolean;
  isFallback: boolean;
  headroomPercent: number | null;
  // The tools ahead of it in the order, and why each did not take the work; every tool when none could.
  passedOver: PassedOver[];
}

// First provider in the user's order with an eligible account. When none qualifies, the
// first provider is returned unverified so the caller can say so instead of guessing. A
// preferred tool is the only candidate.
export function selectProvider(
  state: QuotaState,
  {
    exclude,
    now = Date.now(),
    models = {},
    prefer = {}
  }: { exclude?: ProviderId | null; now?: number; models?: Partial<Record<ProviderId, string>>; prefer?: Preference } = {}
): ProviderChoice {
  const order = normalizeProviderOrder(state.settings.providerOrder).filter(
    id => id !== exclude && (!prefer.tool || id === prefer.tool || prefer.tool === exclude)
  );
  const passedOver: PassedOver[] = [];
  for (const [index, providerId] of order.entries()) {
    const accounts = candidates(state, providerId, prefer).sort(primaryFirst);
    for (const account of accounts) {
      const usable = usableModel(measuredAccount(state, account), models[providerId], now);
      if (usable)
        return {
          providerId,
          account,
          ...(usable.model ? { model: usable.model } : {}),
          verified: true,
          isFallback: index > 0,
          headroomPercent: headroomPercent(measuredAccount(state, account), usable.model),
          passedOver
        };
    }
    passedOver.push({ providerId, reason: passOverReason(state, accounts[0], models[providerId], now) });
  }
  // `exclude` removes at most one provider, so the order is never empty.
  const [first] = order;
  if (!first) throw new Error('provider order is empty');
  return {
    providerId: first,
    account: primaryAccount(state, first),
    verified: false,
    isFallback: false,
    headroomPercent: null,
    passedOver
  };
}

// How far work may move when an account runs out: to the tool's other accounts only, or on to
// the other tools in the fallback order once none of them has quota.
export type ContinueScope = Exclude<AutoContinue, 'off'>;
// The scope for a setting: with auto-continue off, work is offered rather than moved, and the
// offer looks within every tool.
export const continueScope = (setting: AutoContinue): ContinueScope => (setting === 'off' ? 'tools' : setting);

export interface Successor {
  providerId: ProviderId;
  account: Account | null;
  model?: string | null;
}

// Work only moves to an account with real room left: one just above the floor would run out
// again within minutes and bounce the work on.
export const SUCCESSOR_MIN_HEADROOM_PERCENT = 20;

// The tool's eligible account with the most headroom, at least `minHeadroom`, and the model it
// takes the work with.
function roomiest(
  state: QuotaState,
  accounts: readonly Account[],
  minHeadroom: number,
  now: number,
  model?: string
): { account: Account; model: string | undefined } | null {
  return (
    accounts
      .map(account => {
        const measured = measuredAccount(state, account);
        const usable = usableModel(measured, model, now);
        return { account, model: usable?.model, headroom: usable ? (headroomPercent(measured, usable.model) ?? 0) : -1 };
      })
      .filter(candidate => candidate.headroom >= minHeadroom)
      .sort((a, b) => b.headroom - a.headroom)[0] ?? null
  );
}

// Who takes over from `from`: the same tool's other account with the most verified headroom,
// else, within `scope`, the first other tool in the fallback order with such an account. A
// preferred tool comes first among the other tools.
export function chooseSuccessor(
  state: QuotaState,
  from: Account,
  scope: ContinueScope,
  {
    now = Date.now(),
    minHeadroom = SUCCESSOR_MIN_HEADROOM_PERCENT,
    models = {},
    prefer = {}
  }: { now?: number; minHeadroom?: number; models?: Partial<Record<ProviderId, string>>; prefer?: Preference } = {}
): Successor | null {
  // The preferred account running out leaves its tool's other accounts to take over.
  const narrowed = prefer.accountId === from.id ? { tool: prefer.tool } : prefer;
  const others = (providerId: ProviderId) => candidates(state, providerId, narrowed).filter(a => a.id !== from.id);
  const sibling = roomiest(state, others(from.providerId), minHeadroom, now, models[from.providerId]);
  if (sibling) return { providerId: from.providerId, account: sibling.account, ...(sibling.model ? { model: sibling.model } : {}) };
  if (scope === 'accounts') return null;
  const order = normalizeProviderOrder(state.settings.providerOrder).filter(id => id !== from.providerId);
  const preferred = order.filter(id => id === prefer.tool);
  for (const providerId of [...preferred, ...order.filter(id => id !== prefer.tool)]) {
    const found = roomiest(state, others(providerId), minHeadroom, now, models[providerId]);
    if (found) return { providerId, account: found.account, ...(found.model ? { model: found.model } : {}) };
  }
  return null;
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
