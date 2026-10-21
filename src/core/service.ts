// The quota service: owns the settings, discovers accounts, reads quotas and hands out
// snapshots. Settings writes are serialized; reads run per provider, deduplicated.
import os from 'node:os';
import { createAntigravityProvider } from '../providers/antigravity.ts';
import { createCopilotProvider } from '../providers/copilot.ts';
import { createClaudeProvider } from '../providers/claude.ts';
import { createCodexProvider } from '../providers/codex.ts';
import type { Clock } from '../providers/common.ts';
import { createCursorProvider } from '../providers/cursor.ts';
import {
  providerReading,
  type DiscoveredAccount,
  type FetchResult,
  type ProviderAdapter,
  type ProviderReading,
  type RefreshContext
} from '../providers/types.ts';
import { HEALTHY_STATUSES } from '../shared/account-state.ts';
import {
  ACCOUNT_ID_PATTERN,
  DURATION_MS,
  MAX_DISMISSED_ACCOUNTS,
  PROFILE_PROVIDER_IDS,
  PROVIDER_IDS,
  type ProviderId
} from '../shared/catalog.ts';
import { profileFolders } from '../providers/profiles.ts';
import type { Account, MeasuredAccount, ProviderState, Settings, SettingsNotice, Snapshot } from '../shared/types.ts';
import { AppError, ProviderError, providerErrorCode } from './errors.ts';
import type { SettingsPatch } from '../shared/ipc.ts';
import { isObject, pathKey, type JsonObject } from './files.ts';
import { loadMeasurements, measurementOf, saveMeasurements, type SavedMeasurement } from './measurements.ts';
import { normalizeWindow } from './model.ts';
import { defaultSettings, loadSettingsWithRecovery, transactSettings, validateSettings, type SettingsTransaction } from './settings.ts';
import { accountSourceKey, sameAccountSource } from './account-source.ts';

const ADAPTER_FACTORIES: Readonly<Record<ProviderId, () => ProviderAdapter>> = {
  claude: () => createClaudeProvider(),
  codex: () => createCodexProvider(),
  cursor: () => createCursorProvider(),
  antigravity: () => createAntigravityProvider(),
  copilot: () => createCopilotProvider()
};

const FETCH_TIMEOUT_MS = 12000;
// Cancellation stops transports immediately; allow an owned child to report close before
// another refresh starts. A broken adapter must still not keep the service waiting forever.
const READ_CLEANUP_MS = 2000;
const DISCOVERY_INTERVAL_MS = DURATION_MS.MINUTE;
// A discovered account disappears only after this many clean discovery passes without it,
// so a transient read failure never deletes it.
const MISSES_BEFORE_REMOVAL = 3;
const DEFAULT_RATE_LIMIT_COOLDOWN_SECONDS = 120;
// An expired sign-in that could not be renewed is tried again after this.
const RENEW_INTERVAL_MS = 30 * DURATION_MS.MINUTE;
// Accounts that mirror running processes rather than files on disk; their absence means
// "app closed", not "account removed".
const PROCESS_BOUND_PROVIDERS: ReadonlySet<ProviderId> = new Set(['antigravity']);
// A sign-in finishes in the browser at the user's pace; a pending account waits this long for it.
export const SIGN_IN_WINDOW_MS = 10 * DURATION_MS.MINUTE;

// Whether the app may move work to an account by itself: continuing work that ran out, taking it
// back to the main account, or opening it again after a restart. Such an account is read first.
const movesWorkOnItsOwn = (settings: Settings): boolean =>
  settings.autoContinue !== 'off' || settings.returnToPrimary === 'auto' || settings.reopenAfterRestart === 'auto';

// Any user edit (name, primary, enabled, position) makes an account user-managed, except a
// pending one: it waits for its sign-in whatever the user changed, and discovery makes it the
// user's. Origin, configDirExplicit and a pending sign-in's time are never taken from the
// client. A pending account missing from the edit was added after the client's view of the
// list was taken (accounts are removed by dismissal, not by an edit): it is kept.
function mergeAccountEdits(current: readonly Account[], edited: readonly Account[]): Account[] {
  const editedIds = new Set(edited.map(a => a.id));
  const currentIds = new Set(current.map(a => a.id));
  // Relative order of the accounts present in both, so a removal is not seen as a move.
  const before = current.map(a => a.id).filter(id => editedIds.has(id));
  const after = edited.map(a => a.id).filter(id => currentIds.has(id));
  const addedSince = current.filter(a => a.origin === 'pending' && !editedIds.has(a.id));
  const merged = edited.map((account): Account => {
    const existing = current.find(a => a.id === account.id);
    const { origin: _origin, configDirExplicit: _explicit, signInUntil: _signInUntil, ...fields } = account;
    const configDirExplicit = existing ? existing.configDirExplicit : account.configDirExplicit;
    const userEdited =
      existing !== undefined &&
      (account.label !== existing.label ||
        account.labelKey !== existing.labelKey ||
        account.primary !== existing.primary ||
        account.enabled !== existing.enabled ||
        before.indexOf(account.id) !== after.indexOf(account.id));
    const origin = existing?.origin === 'pending' ? 'pending' : userEdited ? 'user' : (existing?.origin ?? 'user');
    return {
      ...fields,
      ...(configDirExplicit === undefined ? {} : { configDirExplicit }),
      origin,
      ...(origin === 'pending' && existing?.signInUntil !== undefined ? { signInUntil: existing.signInUntil } : {})
    };
  });
  return [...merged, ...addedSince];
}

// An account list is a patch relative to the caller's view. Keep unrelated changes made by
// another process while the edit waited for the lock, including additions and removals.
function rebaseAccountEdits(base: readonly Account[], current: readonly Account[], edited: readonly Account[]): Account[] {
  const result: Account[] = [];
  for (const account of edited) {
    const before = base.find(a => a.id === account.id);
    const latest = current.find(a => a.id === account.id);
    if (before && !latest) continue;
    if (!before || !latest) {
      result.push(account);
      continue;
    }
    const beforeFields: JsonObject = { ...before };
    const editedFields: JsonObject = { ...account };
    const changes = Object.fromEntries(
      Object.keys({ ...before, ...account })
        .filter(key => JSON.stringify(beforeFields[key]) !== JSON.stringify(editedFields[key]))
        .map(key => [key, editedFields[key]])
    );
    result.push({ ...latest, ...changes });
  }
  result.push(...current.filter(a => !base.some(b => b.id === a.id) && !result.some(b => b.id === a.id)));
  return result;
}

export interface ServiceOptions {
  settingsPath: string;
  // Where each account's last good reading is kept across restarts; none without it.
  measurementsPath?: string;
  // For each tool that can, gets a fresh sign-in from the tool itself for an account whose saved
  // one expired; true when it did. A tool without one keeps an expired sign-in until it runs there.
  renewSignIn?: Partial<Record<ProviderId, (account: Account) => Promise<boolean>>>;
  // Called when the state changed outside a refresh (an account read again after its renewal).
  onChange?: () => void;
  providers?: ProviderAdapter[];
  clock?: Clock;
  // The home folder the tools keep their profile folders in.
  home?: string;
}

export interface RefreshOptions {
  fresh?: boolean;
  // A refresh of every tool leaves out the ones the user hid.
  skipHidden?: boolean;
}

export interface Service {
  snapshot(): Snapshot;
  // Re-read settings written by another process before making settings-driven decisions.
  syncSettings(): Promise<Snapshot>;
  // Cancels quota transports during application shutdown.
  dispose(): void;
  // A read already under way is joined; with `fresh`, one begun after the call is waited for
  // (a sign-in just written must not be answered by a read that started before it).
  refresh(providerId?: ProviderId, options?: RefreshOptions): Promise<Snapshot>;
  // `patch` is validated together with the current settings.
  updateSettings(patch: SettingsPatch): Promise<Snapshot>;
  // The same for a change from outside the process (the window), whose shape is unknown.
  updateSettingsFrom(input: unknown): Promise<Snapshot>;
  dismissAccount(accountId: unknown): Promise<Snapshot>;
  // Adds a `pending` account, the provider's primary when it has none, with its sign-in open.
  addPendingAccount(account: Omit<DiscoveredAccount, 'primary'>): Promise<Snapshot>;
  // A sign-in opened for the account: a pending one waits another SIGN_IN_WINDOW_MS for it.
  signInOpened(accountId: string): Promise<Snapshot>;
  // Removes a pending account at once, as when its sign-in could not be opened at all.
  withdrawPendingAccount(accountId: string): Promise<Snapshot>;
  // Replaces the settings with the defaults, also when the saved file is unreadable (it is
  // kept aside); never over a newer version's file.
  resetSettings(): Promise<Snapshot>;
  // Replaces the settings with a complete exported document; the window keeps its place.
  importSettings(document: unknown): Promise<Snapshot>;
  // The settings as a document to keep or move; the window's place belongs to this screen.
  exportSettings(): Omit<Settings, 'window'>;
  dismissSettingsNotice(): Snapshot;
  restoreDismissedAccounts(): Promise<Snapshot>;
  reconcileDiscovery(): Promise<void>;
}

type DiscoveryResult = { adapter: ProviderAdapter; found: DiscoveredAccount[]; complete: boolean } | null;

export async function createService({
  settingsPath,
  measurementsPath,
  renewSignIn,
  onChange,
  providers: injected,
  clock = Date.now,
  home = os.homedir()
}: ServiceOptions): Promise<Service> {
  const adapters = injected ?? PROVIDER_IDS.map(id => ADAPTER_FACTORIES[id]());
  const loaded = await loadSettingsWithRecovery(settingsPath);
  let settings = loaded.settings;
  let notice: SettingsNotice | undefined = loaded.notice;
  let revision = loaded.revision;
  let transaction: SettingsTransaction | undefined;
  // Unreadable or newer settings are not overwritten by ordinary changes: the app runs on
  // defaults in memory until the user resets or imports.
  const locked = (): boolean => notice === 'unrecoverable' || notice === 'future';

  const providers: ProviderState[] = adapters.map(adapter => ({ id: adapter.id, status: 'pending', accounts: [] }));
  const saved = measurementsPath ? await loadMeasurements(measurementsPath, clock()) : new Map<string, SavedMeasurement>();
  let savingMeasurements: Promise<unknown> = Promise.resolve();
  const lastRenewal = new Map<string, number>();
  const renewing = new Set<string>();
  let pendingSave: Promise<unknown> = Promise.resolve();
  const cooldownUntil = new Map<string, number>();
  const inFlight = new Map<ProviderId, Promise<void>>();
  const consecutiveMisses = new Map<string, number>();
  const providerGenerations = new Map<ProviderId, number>();
  const accountGenerations = new Map<string, number>();
  const activeReads = new Map<AbortController, readonly Account[]>();
  let disposed = false;
  let lastDiscovery = clock();
  let discoveryRunning: Promise<void> | null = null;
  const stamp = (): string => new Date(clock()).toISOString();

  // Settings writes run one at a time, each on the result of the previous one; a failed write
  // does not block the next.
  function serialized<T>(task: () => Promise<T>): Promise<T> {
    const run = pendingSave
      .catch(() => undefined)
      .then(() =>
        transactSettings(settingsPath, async current => {
          if (current.revision !== revision) {
            settings = current.settings;
            notice = current.notice;
            revision = current.revision;
            rebuild();
            keepMeasurements();
            onChange?.();
          }
          transaction = current;
          try {
            return await task();
          } finally {
            transaction = undefined;
          }
        })
      );
    pendingSave = run;
    return run;
  }

  function rebuild(): void {
    for (const [controller, targets] of activeReads) {
      if (targets.some(target => !settings.accounts.some(a => a.id === target.id && a.enabled && sameAccountSource(a, target))))
        controller.abort();
    }
    const previousAccounts = providers.flatMap(provider => provider.accounts);
    for (const account of settings.accounts) {
      const previous = previousAccounts.find(a => a.id === account.id);
      if (previous && !sameAccountSource(previous, account)) {
        accountGenerations.delete(account.id);
        cooldownUntil.delete(account.id);
        lastRenewal.delete(account.id);
      }
    }
    for (const [id, reading] of saved) {
      const account = settings.accounts.find(a => a.id === id);
      if (!account || reading.sourceKey !== accountSourceKey(account)) saved.delete(id);
    }
    for (const provider of providers) {
      const previous = provider.accounts;
      provider.accounts = settings.accounts
        .filter(a => a.providerId === provider.id && a.enabled)
        .map((account): MeasuredAccount => {
          const measured = previous.find(b => b.id === account.id);
          if (measured && sameAccountSource(measured, account)) return { ...measured, ...account };
          // Not read yet in this run: the last good reading, as stale. It shows the quota last
          // known; nothing acts on it, as only a fresh, ok reading counts as quota.
          const last = saved.get(account.id);
          return last?.sourceKey === accountSourceKey(account)
            ? {
                ...account,
                status: 'stale',
                windows: structuredClone(last.windows),
                fetchedAt: last.fetchedAt,
                ...(last.plan ? { plan: last.plan } : {})
              }
            : { ...account, status: 'pending', windows: [] };
        });
      if (previous.some(before => !provider.accounts.some(after => before.id === after.id && sameAccountSource(before, after)))) {
        provider.status = provider.accounts.some(a => a.fetchedAt) ? 'stale' : 'pending';
        if (!provider.accounts.some(a => a.fetchedAt)) delete provider.fetchedAt;
      }
      if (provider.status === 'pending' && provider.accounts.some(a => a.status === 'stale')) provider.status = 'stale';
    }
  }

  // Each account's latest good reading is written after every read, one write at a time.
  function keepMeasurements(): void {
    if (!measurementsPath) return;
    for (const id of saved.keys()) if (!settings.accounts.some(account => account.id === id)) saved.delete(id);
    for (const account of providers.flatMap(p => p.accounts)) {
      const reading = measurementOf(account);
      if (reading) saved.set(account.id, reading);
      else if (account.status === 'no_limits_reported') saved.delete(account.id);
    }
    savingMeasurements = savingMeasurements.then(() => saveMeasurements(measurementsPath, saved)).catch(() => undefined);
  }

  function snapshot(): Snapshot {
    return structuredClone({ providers, refreshing: inFlight.size > 0, settings, ...(notice ? { settingsNotice: notice } : {}) });
  }

  // Discovery still shows the accounts it finds while the settings are locked, in memory only.
  async function commit(next: unknown, { discovered = false } = {}): Promise<Snapshot> {
    if (locked() && !discovered) throw new AppError('settings_locked');
    if (locked()) settings = validateSettings(next);
    else {
      if (!transaction) throw new AppError('settings_locked');
      const written = await transaction.save(next);
      settings = written.settings;
      revision = written.revision;
    }
    rebuild();
    keepMeasurements();
    return snapshot();
  }

  // An explicit replacement may write over an unreadable file (which is kept aside).
  async function replace(next: unknown): Promise<Snapshot> {
    if (notice === 'future') throw new AppError('settings_locked');
    if (!transaction) throw new AppError('settings_locked');
    const written = await transaction.save(next);
    settings = written.settings;
    revision = written.revision;
    notice = undefined;
    rebuild();
    keepMeasurements();
    return snapshot();
  }

  rebuild();

  // Removes the account from `next`; the provider's next enabled account becomes primary in its place.
  function removeAccount(next: Settings, accountId: string): void {
    const removed = next.accounts.find(a => a.id === accountId);
    next.accounts = next.accounts.filter(a => a.id !== accountId);
    consecutiveMisses.delete(accountId);
    if (!removed?.primary) return;
    const successor = next.accounts.find(a => a.providerId === removed.providerId && a.enabled);
    if (successor) successor.primary = true;
  }

  // Merges one adapter's discovery, made from `seenAt`, into `next`; true when anything changed.
  function reconcile(next: Settings, { adapter, found, complete }: NonNullable<DiscoveryResult>, seenAt: number): boolean {
    let modified = false;
    const dismissed = new Set(next.dismissedAccountIds);
    const foundIds = new Set(found.map(a => a.id));
    for (const account of found) {
      consecutiveMisses.delete(account.id);
      const existing = next.accounts.find(a => a.id === account.id);
      // Its sign-in is done: the account the user added is theirs from now on.
      if (existing?.origin === 'pending') {
        existing.origin = 'user';
        delete existing.signInUntil;
        modified = true;
      }
      // Dismissal is the user's decision; discovery never re-adds those accounts.
      if (existing || dismissed.has(account.id)) continue;
      const hasPrimary = next.accounts.some(a => a.providerId === adapter.id && a.primary);
      next.accounts.push({ ...account, origin: 'discovered', primary: account.primary && !hasPrimary });
      modified = true;
    }
    if (!complete) return modified;
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
      removeAccount(next, account.id);
      modified = true;
    }
    // A pending account not found by a look made after its sign-in closed never held a sign-in;
    // a look begun before then may predate a sign-in finished since.
    const withdrawn = next.accounts.filter(
      a => a.providerId === adapter.id && a.origin === 'pending' && !foundIds.has(a.id) && (a.signInUntil ?? 0) <= seenAt
    );
    for (const account of withdrawn) removeAccount(next, account.id);
    return modified || withdrawn.length > 0;
  }

  async function runDiscovery(): Promise<void> {
    const seenAt = clock();
    // A failed discovery says nothing about which accounts exist: it never counts as a miss.
    const results: DiscoveryResult[] = await Promise.all(
      adapters.map(adapter =>
        adapter.discover().then(
          discovery =>
            Array.isArray(discovery)
              ? { adapter, found: discovery, complete: true }
              : { adapter, found: discovery.accounts, complete: discovery.kind === 'complete' },
          () => null
        )
      )
    );
    // Discovery runs outside the write queue; only the reconciliation is serialized.
    await serialized(async () => {
      const next = structuredClone(settings);
      let modified = false;
      for (const result of results) if (result) modified = reconcile(next, result, seenAt) || modified;
      if (modified) await commit(next, { discovered: true });
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
    const configured = settings.accounts.find(a => a.id === account.id);
    if (!configured || !configured.enabled || !sameAccountSource(configured, account)) return null;
    if ((accountGenerations.get(account.id) ?? 0) > generation) return null;
    accountGenerations.set(account.id, generation);
    return provider.accounts.find(a => a.id === account.id && sameAccountSource(a, account)) ?? null;
  }

  function applyResult(target: MeasuredAccount, result: FetchResult, fetchedAt: string): void {
    const windows = result.windows.map(normalizeWindow);
    if (!windows.length && result.status !== 'no_limits_reported') throw new ProviderError('invalid_response');
    if (result.plan) target.plan = result.plan;
    if (result.signedInAs) target.signedInAs = result.signedInAs;
    else delete target.signedInAs;
    if (result.status === 'no_limits_reported') {
      Object.assign(target, { windows: [], status: 'no_limits_reported', messageCode: 'no_limits_reported', fetchedAt });
      return;
    }
    // A window missing from this response keeps its last value, marked stale.
    // One that never had a value has nothing to keep.
    for (const prior of result.completeness === 'complete' ? [] : target.windows) {
      if (!result.removedWindowIds?.includes(prior.id) && !windows.some(w => w.id === prior.id) && prior.remainingPercent !== null)
        windows.push({ ...prior, stale: true, detailKey: 'staleWindowDetail' });
    }
    // An explicitly incomplete response cannot establish that all binding limits are known,
    // including on a first read or after a restart with no previous window to carry forward.
    Object.assign(target, { windows, status: result.completeness === 'partial' ? 'stale' : 'ok', fetchedAt });
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

  // An expired sign-in is renewed when work may move to the account on its own (it could not
  // take it over unread): once at a time per account, at most once in a while. It runs beside the
  // refresh, which reports the expiry meanwhile and does not wait; once renewed, the tool's
  // accounts are read again and the change announced.
  function renewInBackground(adapter: ProviderAdapter, account: MeasuredAccount, error: unknown): void {
    const renew = renewSignIn?.[account.providerId];
    if (!renew || !movesWorkOnItsOwn(settings) || providerErrorCode(error) !== 'auth_expired' || renewing.has(account.id)) return;
    if (clock() - (lastRenewal.get(account.id) ?? Number.NEGATIVE_INFINITY) < RENEW_INTERVAL_MS) return;
    lastRenewal.set(account.id, clock());
    renewing.add(account.id);
    void renew(account)
      .catch(() => false)
      .then(async renewed => {
        if (!renewed) return;
        // A read already under way may predate the renewal: the tool is read again after it.
        await inFlight.get(adapter.id)?.catch(() => undefined);
        await startRefresh(adapter);
        onChange?.();
      })
      .finally(() => renewing.delete(account.id));
  }

  async function readWithinBudget<T>(
    adapter: ProviderAdapter,
    accounts: readonly Account[],
    read: (context: RefreshContext) => Promise<T>
  ): Promise<T> {
    if (disposed) throw new ProviderError('request_timeout');
    const controller = new AbortController();
    activeReads.set(controller, accounts);
    const timeoutMs = adapter.fetchTimeoutMs ?? FETCH_TIMEOUT_MS;
    const context = { deadline: Date.now() + timeoutMs, signal: controller.signal };
    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => {
        reject(new ProviderError('request_timeout'));
      };
      controller.signal.addEventListener('abort', onAbort, { once: true });
    });
    const pending = Promise.resolve().then(() => read(context));
    try {
      return await Promise.race([pending, aborted]);
    } finally {
      clearTimeout(timer);
      if (onAbort) controller.signal.removeEventListener('abort', onAbort);
      if (controller.signal.aborted) {
        let cleanupTimer: NodeJS.Timeout | undefined;
        await Promise.race([
          pending.catch(() => undefined),
          new Promise<void>(resolve => {
            cleanupTimer = setTimeout(resolve, READ_CLEANUP_MS);
          })
        ]);
        clearTimeout(cleanupTimer);
      }
      activeReads.delete(controller);
    }
  }

  function applyReading(
    adapter: ProviderAdapter,
    provider: ProviderState,
    account: MeasuredAccount,
    generation: number,
    reading: ProviderReading,
    attemptedAt: number
  ): void {
    const target = currentTarget(provider, account, generation);
    if (!target) return;
    try {
      if (reading.kind === 'failed') throw reading.error;
      applyResult(target, reading.result, stamp());
    } catch (error) {
      applyFailure(target, error, attemptedAt);
      renewInBackground(adapter, target, error);
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
    const reading = await readWithinBudget(adapter, [account], context => adapter.fetch(account, context)).then(
      providerReading,
      (error: unknown): ProviderReading => ({ kind: 'failed', error })
    );
    applyReading(adapter, provider, account, generation, reading, attemptedAt);
  }

  const isHealthy = (account: MeasuredAccount): boolean => HEALTHY_STATUSES.has(account.status);

  async function refreshProvider(adapter: ProviderAdapter): Promise<void> {
    const provider = providers.find(p => p.id === adapter.id);
    if (!provider) return;
    const generation = (providerGenerations.get(adapter.id) ?? 0) + 1;
    providerGenerations.set(adapter.id, generation);
    const fetchAll = adapter.fetchAll?.bind(adapter);
    if (fetchAll) {
      const attemptedAt = clock();
      const accounts = provider.accounts.filter(a => (cooldownUntil.get(a.id) ?? 0) <= attemptedAt);
      if (accounts.length) {
        const readings = await readWithinBudget(adapter, accounts, context => fetchAll(accounts, context)).catch(
          (error: unknown) => new Map(accounts.map(a => [a.id, { kind: 'failed' as const, error }]))
        );
        for (const account of accounts) {
          const reading = readings.get(account.id) ?? { kind: 'failed', error: new ProviderError('invalid_response') };
          applyReading(adapter, provider, account, generation, reading, attemptedAt);
        }
      }
    } else await Promise.all(provider.accounts.map(account => refreshAccount(adapter, provider, account, generation)));

    const { accounts } = provider;
    const allHealthy = accounts.length > 0 && accounts.every(isHealthy);
    provider.status = allHealthy ? 'ok' : accounts.some(a => a.fetchedAt) ? 'stale' : (accounts[0]?.status ?? 'unavailable');
    if (allHealthy || accounts.some(a => a.status === 'ok')) provider.fetchedAt = stamp();
    if (accounts.length) delete provider.messageCode;
    else provider.messageCode = 'no_accounts';
  }

  function startRefresh(adapter: ProviderAdapter, fresh = false): Promise<void> {
    const running = inFlight.get(adapter.id);
    // Callers wanting a fresh read share the one that starts after the running one.
    if (running && fresh) return running.catch(() => undefined).then(() => startRefresh(adapter));
    if (running) return running;
    // Reserve this refresh immediately, before settings I/O, so concurrent callers join it
    // and a requested fresh read still starts after the reserved read finishes.
    const promise = serialized(() => Promise.resolve())
      .then(() => refreshProvider(adapter))
      .finally(() => {
        if (inFlight.get(adapter.id) === promise) inFlight.delete(adapter.id);
        keepMeasurements();
      });
    inFlight.set(adapter.id, promise);
    return promise;
  }

  async function refresh(providerId?: ProviderId, { fresh = false, skipHidden = false }: RefreshOptions = {}): Promise<Snapshot> {
    const targets =
      providerId === undefined
        ? adapters.filter(a => !(skipHidden && settings.hiddenProviders.includes(a.id)))
        : adapters.filter(a => a.id === providerId);
    if (!targets.length) throw new AppError('invalid_provider');
    if (clock() - lastDiscovery > DISCOVERY_INTERVAL_MS) {
      lastDiscovery = clock();
      await reconcileDiscovery().catch(() => undefined);
    }
    // Every provider is started and awaited, also those a narrower refresh already started.
    await Promise.allSettled(targets.map(adapter => startRefresh(adapter, fresh)));
    // A CLI command may have changed settings while the network request was in flight.
    await serialized(() => Promise.resolve());
    // The readings just taken are on disk before the refresh counts as done.
    await savingMeasurements;
    return snapshot();
  }

  async function dismissAccount(accountId: unknown): Promise<Snapshot> {
    if (typeof accountId !== 'string' || !ACCOUNT_ID_PATTERN.test(accountId)) throw new AppError('invalid_argument');
    if (!settings.accounts.some(a => a.id === accountId)) throw new AppError('account_not_found');
    return serialized(() => {
      const next = structuredClone(settings);
      next.dismissedAccountIds = [...new Set([...next.dismissedAccountIds, accountId])].slice(-MAX_DISMISSED_ACCOUNTS);
      removeAccount(next, accountId);
      return commit(next);
    });
  }

  function addPendingAccount(account: Omit<DiscoveredAccount, 'primary'>): Promise<Snapshot> {
    return serialized(() => {
      const next = structuredClone(settings);
      const primary = !next.accounts.some(a => a.providerId === account.providerId);
      next.accounts.push({ ...account, primary, origin: 'pending', signInUntil: clock() + SIGN_IN_WINDOW_MS });
      // Adding it again undoes an earlier dismissal of the same folder.
      next.dismissedAccountIds = next.dismissedAccountIds.filter(id => id !== account.id);
      return commit(next);
    });
  }

  function withdrawPendingAccount(accountId: string): Promise<Snapshot> {
    return serialized(() => {
      if (!settings.accounts.some(a => a.id === accountId && a.origin === 'pending')) return Promise.resolve(snapshot());
      const next = structuredClone(settings);
      removeAccount(next, accountId);
      return commit(next);
    });
  }

  function signInOpened(accountId: string): Promise<Snapshot> {
    return serialized(() => {
      const pending = settings.accounts.find(a => a.id === accountId && a.origin === 'pending');
      if (!pending) return Promise.resolve(snapshot());
      const next = structuredClone(settings);
      next.accounts = next.accounts.map(a => (a.id === accountId ? { ...a, signInUntil: clock() + SIGN_IN_WINDOW_MS } : a));
      return commit(next);
    });
  }

  // Typed or not, every change takes this one validated path.
  function applySettings(patch: JsonObject | SettingsPatch): Promise<Snapshot> {
    const base = structuredClone(settings.accounts);
    return serialized(() => {
      const next = validateSettings({ ...settings, ...patch });
      const accounts = 'accounts' in patch ? rebaseAccountEdits(base, settings.accounts, next.accounts) : next.accounts;
      return commit({ ...next, accounts: mergeAccountEdits(settings.accounts, accounts) });
    });
  }

  const updateSettings = (patch: SettingsPatch): Promise<Snapshot> => applySettings(patch);

  function updateSettingsFrom(input: unknown): Promise<Snapshot> {
    if (!isObject(input)) throw new AppError('invalid_argument');
    return applySettings(input);
  }

  async function resetSettings(): Promise<Snapshot> {
    await serialized(() => replace({ ...defaultSettings(), ...(settings.window ? { window: settings.window } : {}) }));
    consecutiveMisses.clear();
    await reconcileDiscovery();
    return snapshot();
  }

  async function importSettings(document: unknown): Promise<Snapshot> {
    if (!isObject(document)) throw new AppError('invalid_settings');
    const { window: _ignored, ...imported } = document;
    const next = validateSettings({ ...imported, ...(settings.window ? { window: settings.window } : {}) });
    // An imported account is kept only when its folder is a profile folder of this computer, as
    // discovery finds them. Another computer's paths mean nothing here, and a folder named by a
    // file someone handed over would have the app run the tool there, with that folder's
    // settings and hooks. Discovery adds back each local account it finds.
    const local = new Set((await Promise.all(PROFILE_PROVIDER_IDS.map(id => profileFolders(id, home)))).flat().map(dir => pathKey(dir)));
    next.accounts = next.accounts.filter(a => a.configDir === undefined || local.has(pathKey(a.configDir)));
    await serialized(() => replace({ ...next, ...(settings.window ? { window: settings.window } : {}) }));
    await reconcileDiscovery();
    return snapshot();
  }

  function exportSettings(): Omit<Settings, 'window'> {
    const { window: _window, ...document } = structuredClone(settings);
    return document;
  }

  function dismissSettingsNotice(): Snapshot {
    if (notice === 'recovered') notice = undefined;
    return snapshot();
  }

  async function restoreDismissedAccounts(): Promise<Snapshot> {
    await updateSettings({ dismissedAccountIds: [] });
    await reconcileDiscovery();
    return snapshot();
  }

  return {
    snapshot,
    syncSettings: () => serialized(() => Promise.resolve(snapshot())),
    dispose: () => {
      disposed = true;
      for (const controller of activeReads.keys()) controller.abort();
    },
    refresh,
    updateSettings,
    updateSettingsFrom,
    dismissAccount,
    addPendingAccount,
    signInOpened,
    withdrawPendingAccount,
    resetSettings,
    importSettings,
    exportSettings,
    dismissSettingsNotice,
    restoreDismissedAccounts,
    reconcileDiscovery
  };
}
