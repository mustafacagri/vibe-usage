// The quota service: owns the settings, discovers accounts, reads quotas and hands out
// snapshots. Settings writes are serialized; reads run per provider, deduplicated.
import { antigravityAccountId, createAntigravityProvider } from '../providers/antigravity.ts';
import { createClaudeProvider } from '../providers/claude.ts';
import { createCodexProvider } from '../providers/codex.ts';
import type { Clock } from '../providers/common.ts';
import { createCursorProvider } from '../providers/cursor.ts';
import type { DiscoveredAccount, FetchResult, ProviderAdapter } from '../providers/types.ts';
import { ACCOUNT_ID_PATTERN, MAX_DISMISSED_ACCOUNTS, normalizeProviderOrder, PROVIDER_IDS, type ProviderId } from '../shared/catalog.ts';
import type { Account, MeasuredAccount, ProviderState, Settings, Snapshot } from '../shared/types.ts';
import { AppError, ProviderError, providerErrorCode } from './errors.ts';
import { normalizeWindow } from './model.ts';
import { defaultSettings, loadSettings, saveSettings, validateSettings } from './settings.ts';

const ADAPTER_FACTORIES: Readonly<Record<ProviderId, () => ProviderAdapter>> = {
  claude: () => createClaudeProvider(),
  codex: () => createCodexProvider(),
  cursor: () => createCursorProvider(),
  antigravity: () => createAntigravityProvider()
};

const FETCH_TIMEOUT_MS = 12000;
const DISCOVERY_INTERVAL_MS = 60 * 1000;
// A discovered account disappears only after this many clean discovery passes without it,
// so a transient read failure never deletes it.
const MISSES_BEFORE_REMOVAL = 3;
const DEFAULT_RATE_LIMIT_COOLDOWN_SECONDS = 120;
// Accounts that mirror running processes rather than files on disk; their absence means
// "app closed", not "account removed".
const PROCESS_BOUND_PROVIDERS: ReadonlySet<ProviderId> = new Set(['antigravity']);
const LEGACY_ANTIGRAVITY_ACCOUNT_ID = 'antigravity:current';
const ANTIGRAVITY_ID_PREFIX = 'antigravity:';

// Rejects with request_timeout if `promise` has not settled within `ms`.
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new ProviderError('request_timeout'));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(timer);
  });
}

// Rewrites Antigravity accounts saved by earlier versions in place; true when any changed.
function migrateAntigravityAccounts(settings: Settings, found: readonly DiscoveredAccount[]): boolean {
  let modified = false;
  // Early ids embedded the e-mail (antigravity:user@…); current ids hash it.
  for (const account of settings.accounts) {
    if (account.providerId === 'antigravity' && account.id.startsWith(ANTIGRAVITY_ID_PREFIX) && account.id.includes('@')) {
      const email = (account.email ?? account.id.slice(ANTIGRAVITY_ID_PREFIX.length)).toLowerCase().trim();
      account.id = antigravityAccountId(email);
      account.email = email;
      modified = true;
    }
  }
  // The pre-e-mail single account can only be attributed when exactly one account is running.
  const running = found.filter(a => a.providerId === 'antigravity' && a.email);
  const [target] = running;
  const legacy = settings.accounts.find(a => a.id === LEGACY_ANTIGRAVITY_ACCOUNT_ID);
  if (running.length === 1 && target?.email && legacy && !settings.accounts.some(a => a.id === target.id)) {
    legacy.id = target.id;
    legacy.email = target.email;
    // A name the user typed is kept; the app-supplied default becomes the e-mail.
    if (!legacy.label && target.label) {
      legacy.label = target.label;
      delete legacy.labelKey;
    }
    modified = true;
  }
  return modified;
}

// Any user edit (name, primary, enabled, position) makes an account user-managed. Origin and
// configDirExplicit are never taken from the client.
function mergeAccountEdits(current: readonly Account[], edited: readonly Account[]): Account[] {
  const editedIds = new Set(edited.map(a => a.id));
  const currentIds = new Set(current.map(a => a.id));
  // Relative order of the accounts present in both, so a removal is not seen as a move.
  const before = current.map(a => a.id).filter(id => editedIds.has(id));
  const after = edited.map(a => a.id).filter(id => currentIds.has(id));
  return edited.map(account => {
    const existing = current.find(a => a.id === account.id);
    const { origin: _origin, configDirExplicit: _explicit, ...fields } = account;
    const configDirExplicit = existing ? existing.configDirExplicit : account.configDirExplicit;
    const userEdited =
      existing !== undefined &&
      (account.label !== existing.label ||
        account.labelKey !== existing.labelKey ||
        account.primary !== existing.primary ||
        account.enabled !== existing.enabled ||
        before.indexOf(account.id) !== after.indexOf(account.id));
    return {
      ...fields,
      ...(configDirExplicit === undefined ? {} : { configDirExplicit }),
      origin: userEdited ? 'user' : (existing?.origin ?? 'user')
    };
  });
}

export interface ServiceOptions {
  settingsPath: string;
  providers?: ProviderAdapter[];
  clock?: Clock;
}

export interface Service {
  snapshot(): Snapshot;
  refresh(providerId?: ProviderId): Promise<Snapshot>;
  // `patch` is validated together with the current settings.
  updateSettings(patch: object): Promise<Snapshot>;
  dismissAccount(accountId: unknown): Promise<Snapshot>;
  restoreDismissedAccounts(): Promise<Snapshot>;
  reconcileDiscovery(): Promise<void>;
}

type DiscoveryResult = { adapter: ProviderAdapter; found: DiscoveredAccount[] } | null;

export async function createService({ settingsPath, providers: injected, clock = Date.now }: ServiceOptions): Promise<Service> {
  const adapters = injected ?? PROVIDER_IDS.map(id => ADAPTER_FACTORIES[id]());
  const stored = await loadSettings(settingsPath);
  // Accounts saved before origins were tracked count as user-managed: never auto-removed.
  let settings = validateSettings({
    ...(stored ?? defaultSettings()),
    providerOrder: normalizeProviderOrder(stored?.providerOrder),
    accounts: (stored?.accounts ?? []).map(account => ({ ...account, origin: account.origin ?? 'user' }))
  });
  if (stored && JSON.stringify(settings) !== JSON.stringify(stored)) await saveSettings(settingsPath, settings);

  const providers: ProviderState[] = adapters.map(adapter => ({ id: adapter.id, status: 'pending', accounts: [] }));
  let pendingSave: Promise<unknown> = Promise.resolve();
  const cooldownUntil = new Map<string, number>();
  const inFlight = new Map<ProviderId, Promise<void>>();
  const consecutiveMisses = new Map<string, number>();
  const providerGenerations = new Map<ProviderId, number>();
  const accountGenerations = new Map<string, number>();
  let lastDiscovery = clock();
  let discoveryRunning: Promise<void> | null = null;
  const stamp = (): string => new Date(clock()).toISOString();

  // Settings writes run one at a time, each on the result of the previous one; a failed write
  // does not block the next.
  function serialized<T>(task: () => Promise<T>): Promise<T> {
    const run = pendingSave.catch(() => undefined).then(task);
    pendingSave = run;
    return run;
  }

  function rebuild(): void {
    for (const provider of providers) {
      const previous = provider.accounts;
      provider.accounts = settings.accounts
        .filter(a => a.providerId === provider.id && a.enabled)
        .map((account): MeasuredAccount => {
          const measured = previous.find(b => b.id === account.id);
          return measured && measured.configDir === account.configDir
            ? { ...measured, ...account }
            : { ...account, status: 'pending', windows: [] };
        });
    }
  }

  function snapshot(): Snapshot {
    return structuredClone({ providers, refreshing: inFlight.size > 0, settings });
  }

  async function commit(next: unknown): Promise<Snapshot> {
    settings = await saveSettings(settingsPath, next);
    rebuild();
    return snapshot();
  }

  rebuild();

  // Merges one adapter's discovery into `next`; true when anything changed.
  function reconcile(next: Settings, { adapter, found }: NonNullable<DiscoveryResult>): boolean {
    let modified = adapter.id === 'antigravity' && migrateAntigravityAccounts(next, found);
    const dismissed = new Set(next.dismissedAccountIds);
    const foundIds = new Set(found.map(a => a.id));
    for (const account of found) {
      consecutiveMisses.delete(account.id);
      // Dismissal is the user's decision; discovery never re-adds those accounts.
      if (dismissed.has(account.id) || next.accounts.some(a => a.id === account.id)) continue;
      const hasPrimary = next.accounts.some(a => a.providerId === adapter.id && a.primary);
      next.accounts.push({ ...account, origin: 'discovered', primary: account.primary && !hasPrimary });
      modified = true;
    }
    // Only untouched discovered accounts are removed; anything the user disabled or customized
    // stays until the user removes it.
    const vanished = next.accounts.filter(
      a =>
        a.providerId === adapter.id &&
        !PROCESS_BOUND_PROVIDERS.has(a.providerId) &&
        a.origin === 'discovered' &&
        a.enabled &&
        !foundIds.has(a.id)
    );
    for (const account of vanished) {
      const misses = (consecutiveMisses.get(account.id) ?? 0) + 1;
      consecutiveMisses.set(account.id, misses);
      if (misses < MISSES_BEFORE_REMOVAL) continue;
      next.accounts = next.accounts.filter(a => a !== account);
      consecutiveMisses.delete(account.id);
      modified = true;
    }
    return modified;
  }

  async function runDiscovery(): Promise<void> {
    // A failed discovery says nothing about which accounts exist: it never counts as a miss.
    const results: DiscoveryResult[] = await Promise.all(
      adapters.map(adapter =>
        adapter.discover().then(
          found => ({ adapter, found }),
          () => null
        )
      )
    );
    // Discovery runs outside the write queue; only the reconciliation is serialized.
    await serialized(async () => {
      const next = structuredClone(settings);
      let modified = false;
      for (const result of results) if (result) modified = reconcile(next, result) || modified;
      if (modified) await commit(next);
    });
  }

  function reconcileDiscovery(): Promise<void> {
    discoveryRunning ??= runDiscovery().finally(() => {
      discoveryRunning = null;
    });
    return discoveryRunning;
  }

  await reconcileDiscovery().catch(() => undefined);

  // The account as configured now, or null when it was removed, disabled or re-pointed while
  // a read was in flight, or a newer read already reported.
  function currentTarget(provider: ProviderState, account: MeasuredAccount, generation: number): MeasuredAccount | null {
    if ((accountGenerations.get(account.id) ?? 0) > generation) return null;
    accountGenerations.set(account.id, generation);
    const configured = settings.accounts.find(a => a.id === account.id);
    if (!configured || configured.configDir !== account.configDir || !configured.enabled) return null;
    return provider.accounts.find(a => a.id === account.id) ?? account;
  }

  function applyResult(target: MeasuredAccount, result: FetchResult, fetchedAt: string): void {
    const windows = result.windows.map(normalizeWindow);
    if (!windows.length && result.status !== 'no_limits_reported') throw new ProviderError('invalid_response');
    if (result.plan) target.plan = result.plan;
    if (result.status === 'no_limits_reported') {
      Object.assign(target, { windows: [], status: 'no_limits_reported', messageCode: 'no_limits_reported', fetchedAt });
      return;
    }
    // A window missing from this response keeps its last value, marked stale.
    for (const prior of target.windows) {
      if (!windows.some(w => w.id === prior.id)) windows.push({ ...prior, stale: true, detailKey: 'staleWindowDetail' });
    }
    Object.assign(target, { windows, status: 'ok', fetchedAt });
    delete target.messageCode;
  }

  function applyFailure(target: MeasuredAccount, error: unknown, attemptedAt: number): void {
    const code = providerErrorCode(error);
    // A failed read keeps the last good measurement, labelled stale.
    target.status = target.fetchedAt ? 'stale' : code;
    target.messageCode = code;
    if (code === 'rate_limited') {
      const seconds = (error instanceof ProviderError ? error.retryAfterSeconds : undefined) ?? DEFAULT_RATE_LIMIT_COOLDOWN_SECONDS;
      cooldownUntil.set(target.id, attemptedAt + seconds * 1000);
    }
  }

  async function refreshAccount(
    adapter: ProviderAdapter,
    provider: ProviderState,
    account: MeasuredAccount,
    generation: number
  ): Promise<void> {
    const attemptedAt = clock();
    if ((cooldownUntil.get(account.id) ?? 0) > attemptedAt) return;
    const outcome = await withTimeout(adapter.fetch(account), FETCH_TIMEOUT_MS).then(
      result => ({ result }),
      (error: unknown) => ({ error })
    );
    const target = currentTarget(provider, account, generation);
    if (!target) return;
    try {
      if ('error' in outcome) throw outcome.error;
      applyResult(target, outcome.result, stamp());
    } catch (error) {
      applyFailure(target, error, attemptedAt);
    }
  }

  const isHealthy = (account: MeasuredAccount): boolean => account.status === 'ok' || account.status === 'no_limits_reported';

  async function refreshProvider(adapter: ProviderAdapter): Promise<void> {
    const provider = providers.find(p => p.id === adapter.id);
    if (!provider) return;
    const generation = (providerGenerations.get(adapter.id) ?? 0) + 1;
    providerGenerations.set(adapter.id, generation);
    await Promise.all(provider.accounts.map(account => refreshAccount(adapter, provider, account, generation)));

    const { accounts } = provider;
    const allHealthy = accounts.length > 0 && accounts.every(isHealthy);
    provider.status = allHealthy ? 'ok' : accounts.some(a => a.fetchedAt) ? 'stale' : (accounts[0]?.status ?? 'unavailable');
    if (allHealthy || accounts.some(a => a.status === 'ok')) provider.fetchedAt = stamp();
    if (accounts.length) delete provider.messageCode;
    else provider.messageCode = 'no_accounts';
  }

  function startRefresh(adapter: ProviderAdapter): Promise<void> {
    const running = inFlight.get(adapter.id);
    if (running) return running;
    const promise = refreshProvider(adapter).finally(() => {
      if (inFlight.get(adapter.id) === promise) inFlight.delete(adapter.id);
    });
    inFlight.set(adapter.id, promise);
    return promise;
  }

  async function refresh(providerId?: ProviderId): Promise<Snapshot> {
    const targets = providerId === undefined ? adapters : adapters.filter(a => a.id === providerId);
    if (!targets.length) throw new AppError('invalid_provider');
    if (clock() - lastDiscovery > DISCOVERY_INTERVAL_MS) {
      lastDiscovery = clock();
      await reconcileDiscovery().catch(() => undefined);
    }
    // Every provider is started and awaited, also those a narrower refresh already started.
    await Promise.allSettled(targets.map(startRefresh));
    return snapshot();
  }

  async function dismissAccount(accountId: unknown): Promise<Snapshot> {
    if (typeof accountId !== 'string' || !ACCOUNT_ID_PATTERN.test(accountId)) throw new AppError('invalid_argument');
    if (!settings.accounts.some(a => a.id === accountId)) throw new AppError('account_not_found');
    return serialized(() => {
      const next = structuredClone(settings);
      const dismissed = next.accounts.find(a => a.id === accountId);
      next.dismissedAccountIds = [...new Set([...next.dismissedAccountIds, accountId])].slice(-MAX_DISMISSED_ACCOUNTS);
      next.accounts = next.accounts.filter(a => a.id !== accountId);
      if (dismissed?.primary) {
        const successor = next.accounts.find(a => a.providerId === dismissed.providerId && a.enabled);
        if (successor) successor.primary = true;
      }
      consecutiveMisses.delete(accountId);
      return commit(next);
    });
  }

  function updateSettings(patch: object): Promise<Snapshot> {
    return serialized(() => {
      const next = validateSettings({ ...settings, ...patch });
      return commit({ ...next, accounts: mergeAccountEdits(settings.accounts, next.accounts) });
    });
  }

  async function restoreDismissedAccounts(): Promise<Snapshot> {
    await updateSettings({ dismissedAccountIds: [] });
    await reconcileDiscovery();
    return snapshot();
  }

  return { snapshot, refresh, updateSettings, dismissAccount, restoreDismissedAccounts, reconcileDiscovery };
}
