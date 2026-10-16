'use strict';
const { loadSettings, saveSettings, defaultSettingsPath, DEFAULT_SETTINGS, validateSettings } = require('./settings.cjs');
const { normalizeWindow } = require('./model.cjs');
const { safeError, now, ProviderError } = require('../providers/common.cjs');
const { antigravityAccountId } = require('../providers/antigravity.cjs');

const { AppError } = require('./errors.cjs');
const { providerById, normalizeProviderOrder, ACCOUNT_ID_PATTERN, MAX_DISMISSED_ACCOUNTS } = require('../catalog.cjs');

const FETCH_TIMEOUT_MS = 12000;
const DISCOVERY_INTERVAL_MS = 60 * 1000;
// A discovered account disappears only after this many clean discovery passes without it,
// so a transient read failure never deletes it.
const MISSES_BEFORE_REMOVAL = 3;
const DEFAULT_RATE_LIMIT_COOLDOWN_SECONDS = 120;
// Accounts that mirror running processes rather than files on disk; their absence means
// "app closed", not "account removed".
const PROCESS_BOUND_PROVIDERS = new Set(['antigravity']);
const LEGACY_ANTIGRAVITY_ACCOUNT_ID = 'antigravity:current';

const copy = value => structuredClone(value);

function migrateAntigravityAccounts(currentSettings, found) {
  let modified = false;
  // Migrate any legacy unhashed accounts like antigravity:user@...
  for (const acc of currentSettings.accounts) {
    if (acc.providerId === 'antigravity' && acc.id.startsWith('antigravity:') && acc.id.includes('@')) {
      const email = (acc.email || acc.id.slice(12)).toLowerCase().trim();
      acc.id = antigravityAccountId(email);
      acc.email = email;
      modified = true;
    }
  }

  // The pre-e-mail single account can only be attributed when exactly one account is running.
  const emailAccounts = found.filter(a => a.providerId === 'antigravity' && a.email);
  if (emailAccounts.length === 1) {
    const target = emailAccounts[0];
    const legacy = currentSettings.accounts.find(a => a.id === LEGACY_ANTIGRAVITY_ACCOUNT_ID);
    if (legacy && !currentSettings.accounts.some(a => a.id === target.id)) {
      Object.assign(legacy, { id: target.id, email: target.email });
      // A name the user typed is kept; the app-supplied default becomes the e-mail.
      if (!legacy.label) {
        legacy.label = target.label;
        delete legacy.labelKey;
      }
      modified = true;
    }
  }
  return modified;
}

async function createService(options = {}) {
  const clock = options.clock || Date.now;
  const settingsPath = options.settingsPath || defaultSettingsPath();
  const adapters = options.providers || [
    require('../providers/codex.cjs').createCodexProvider(),
    require('../providers/claude.cjs').createClaudeProvider(),
    require('../providers/cursor.cjs').createCursorProvider(),
    require('../providers/antigravity.cjs').createAntigravityProvider()
  ];

  let settings = await loadSettings(settingsPath) || copy(DEFAULT_SETTINGS);
  let changed = false;

  // Accounts saved before origins were tracked count as user-managed: never auto-removed.
  for (const account of settings.accounts) {
    if (!account.origin) { account.origin = 'user'; changed = true; }
  }
  const order = normalizeProviderOrder(settings.providerOrder);
  if (JSON.stringify(order) !== JSON.stringify(settings.providerOrder)) { settings.providerOrder = order; changed = true; }

  settings = validateSettings(settings);
  if (changed) await saveSettings(settingsPath, settings);

  let providers = adapters.map(p => ({ id: p.id, name: providerById(p.id)?.name || p.id, status: 'pending', accounts: [] }));
  let pendingSave = Promise.resolve();
  const cooldown = new Map();
  const inFlight = new Map(); // providerId -> Promise
  const consecutiveMisses = new Map(); // accountId -> number
  const providerGenerations = new Map(); // providerId -> number
  const accountGenerations = new Map(); // accountId -> number
  let lastDiscoveryTime = now(clock);
  let discoveryRunning = null;

  function rebuild() {
    for (const provider of providers) {
      const old = provider.accounts;
      provider.accounts = settings.accounts
        .filter(a => a.providerId === provider.id && a.enabled !== false)
        .map(a => {
          const previous = old.find(b => b.id === a.id);
          return previous && previous.configDir === a.configDir ? { ...previous, ...a } : { ...a, status: 'pending', windows: [] };
        });
    }
  }

  rebuild();

  function snapshot() {
    return copy({ providers, refreshing: inFlight.size > 0, settings });
  }

  async function reconcileDiscovery() {
    if (discoveryRunning) return discoveryRunning;
    discoveryRunning = (async () => {
      // Step 1: Run discover() on all adapters in parallel outside pendingSave
      const discoveryResults = await Promise.allSettled(adapters.map(async adapter => {
        try {
          const found = await adapter.discover();
          return { adapterId: adapter.id, ok: true, found: Array.isArray(found) ? found : [] };
        } catch (err) {
          return { adapterId: adapter.id, ok: false, error: err };
        }
      }));

      // Step 2: Enter pendingSave solely for fast in-memory reconciliation and atomic file save
      const operation = pendingSave.catch(() => {}).then(async () => {
        let modified = false;
        const currentSettings = copy(settings);
        const dismissed = new Set(currentSettings.dismissedAccountIds || []);

        for (const res of discoveryResults) {
          // A failed discovery says nothing about which accounts exist: never count it as a miss.
          if (res.status !== 'fulfilled' || !res.value.ok) continue;
          const { adapterId, found } = res.value;
          const foundIds = new Set(found.map(a => a.id));

          if (adapterId === 'antigravity') {
            if (migrateAntigravityAccounts(currentSettings, found)) {
              modified = true;
            }
          }

          for (const account of found) {
            consecutiveMisses.delete(account.id);
            // Dismissal is the user's decision; discovery never re-adds those accounts.
            if (dismissed.has(account.id)) continue;

            const existing = currentSettings.accounts.find(a => a.id === account.id);
            if (!existing) {
              currentSettings.accounts.push({
                ...account,
                origin: 'discovered',
                primary: account.primary && !currentSettings.accounts.some(a => a.providerId === adapterId && a.primary)
              });
              modified = true;
            }
          }

          // Only untouched discovered accounts are removed; anything the user disabled or
          // customized stays until the user removes it.
          for (let i = currentSettings.accounts.length - 1; i >= 0; i--) {
            const acc = currentSettings.accounts[i];
            if (!PROCESS_BOUND_PROVIDERS.has(acc.providerId) && acc.providerId === adapterId && acc.origin === 'discovered' && acc.enabled !== false && !foundIds.has(acc.id)) {
              const misses = (consecutiveMisses.get(acc.id) || 0) + 1;
              consecutiveMisses.set(acc.id, misses);
              if (misses >= MISSES_BEFORE_REMOVAL) {
                currentSettings.accounts.splice(i, 1);
                consecutiveMisses.delete(acc.id);
                modified = true;
              }
            }
          }
        }
        if (modified) {
          const next = validateSettings(currentSettings);
          await saveSettings(settingsPath, next);
          settings = next;
          rebuild();
        }
      });
      pendingSave = operation;
      return operation;
    })();
    try {
      return await discoveryRunning;
    } finally {
      discoveryRunning = null;
    }
  }

  // Initial discovery reconciliation runs on startup using the exact same logic
  await reconcileDiscovery().catch(() => {});

  async function refreshSingleProvider(adapter) {
    const provider = providers.find(p => p.id === adapter.id);
    if (!provider) return;
    provider.lastAttemptAt = new Date(now(clock)).toISOString();
    const providerGen = (providerGenerations.get(adapter.id) || 0) + 1;
    providerGenerations.set(adapter.id, providerGen);
    const currentGen = providerGen;

    await Promise.all(provider.accounts.map(async account => {
      const attempt = now(clock);
      if ((cooldown.get(account.id) || 0) > attempt) return;
      account.lastAttemptAt = new Date(attempt).toISOString();

      let timer;
      const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new ProviderError('request_timeout')), FETCH_TIMEOUT_MS);
        timer.unref?.();
      });

      try {
        const result = await Promise.race([
          adapter.fetch(account),
          timeoutPromise
        ]);
        clearTimeout(timer);

        const lastGen = accountGenerations.get(account.id) || 0;
        if (lastGen > currentGen) return; // newer fetch already completed
        accountGenerations.set(account.id, currentGen);

        // The account may have been removed or re-pointed while the read was in flight.
        const currentAccount = settings.accounts.find(a => a.id === account.id);
        if (!currentAccount || currentAccount.configDir !== account.configDir || currentAccount.enabled === false) {
          return;
        }

        const stamp = new Date(now(clock)).toISOString();
        const windows = (result.windows || []).map(normalizeWindow);
        const targetAccount = provider.accounts.find(a => a.id === account.id) || account;

        if (result.status === 'no_limits_reported') {
          targetAccount.windows = [];
          targetAccount.status = 'no_limits_reported';
          targetAccount.messageCode = 'no_limits_reported';
          targetAccount.fetchedAt = stamp;
        } else if (!windows.length) {
          throw new ProviderError('invalid_response');
        } else {
          for (const prior of targetAccount.windows || []) {
            if (!windows.some(w => w.id === prior.id)) {
              windows.push({ ...prior, stale: true, detailKey: 'staleWindowDetail' });
            }
          }
          targetAccount.windows = windows;
          targetAccount.status = 'ok';
          delete targetAccount.messageCode;
          targetAccount.fetchedAt = stamp;
        }
        if (result.plan) targetAccount.plan = result.plan;
      } catch (error) {
        clearTimeout(timer);
        const lastGen = accountGenerations.get(account.id) || 0;
        if (lastGen > currentGen) return;
        accountGenerations.set(account.id, currentGen);

        const currentAccount = settings.accounts.find(a => a.id === account.id);
        if (!currentAccount || currentAccount.configDir !== account.configDir || currentAccount.enabled === false) {
          return;
        }

        const targetAccount = provider.accounts.find(a => a.id === account.id) || account;
        const code = safeError(error);
        targetAccount.status = targetAccount.fetchedAt ? 'stale' : code;
        targetAccount.messageCode = code;
        if (code === 'rate_limited') {
          cooldown.set(account.id, attempt + (error.retryAfterSeconds || DEFAULT_RATE_LIMIT_COOLDOWN_SECONDS) * 1000);
        }
      }
    }));

    const allOk = provider.accounts.length > 0 && provider.accounts.every(a => a.status === 'ok' || a.status === 'no_limits_reported');
    provider.status = allOk ? 'ok' : provider.accounts.some(a => a.fetchedAt) ? 'stale' : (provider.accounts[0]?.status || 'unavailable');
    if (allOk || provider.accounts.some(a => a.status === 'ok')) {
      provider.fetchedAt = new Date(now(clock)).toISOString();
    }
    if (provider.accounts.length) delete provider.messageCode; else provider.messageCode = 'no_accounts';
  }

  function getOrStartProviderRefresh(adapter) {
    if (inFlight.has(adapter.id)) {
      return inFlight.get(adapter.id);
    }
    const promise = refreshSingleProvider(adapter).finally(() => {
      if (inFlight.get(adapter.id) === promise) {
        inFlight.delete(adapter.id);
      }
    });
    inFlight.set(adapter.id, promise);
    return promise;
  }

  async function refresh(providerId) {
    if (providerId !== undefined && !adapters.some(a => a.id === providerId)) {
      throw new AppError('invalid_provider');
    }

    if (now(clock) - lastDiscoveryTime > DISCOVERY_INTERVAL_MS) {
      lastDiscoveryTime = now(clock);
      await reconcileDiscovery().catch(() => {});
    }

    if (providerId !== undefined) {
      const target = adapters.find(a => a.id === providerId);
      await getOrStartProviderRefresh(target);
      return snapshot();
    }

    // Full refresh: ensure all providers are started in parallel and awaited without skipping
    await Promise.allSettled(adapters.map(adapter => getOrStartProviderRefresh(adapter)));
    return snapshot();
  }

  async function dismissAccount(accountId) {
    if (typeof accountId !== 'string' || !ACCOUNT_ID_PATTERN.test(accountId)) throw new AppError('invalid_argument');
    if (!settings.accounts.some(a => a.id === accountId)) throw new AppError('account_not_found');
    const operation = pendingSave.catch(() => {}).then(async () => {
      const currentSettings = copy(settings);
      const dismissed = new Set(currentSettings.dismissedAccountIds || []);
      dismissed.add(accountId);
      currentSettings.dismissedAccountIds = Array.from(dismissed).slice(-MAX_DISMISSED_ACCOUNTS);
      const dismissedAccount = currentSettings.accounts.find(a => a.id === accountId);
      currentSettings.accounts = currentSettings.accounts.filter(a => a.id !== accountId);
      if (dismissedAccount?.primary) {
        const nextPrimary = currentSettings.accounts.find(a => a.providerId === dismissedAccount.providerId && a.enabled !== false);
        if (nextPrimary) nextPrimary.primary = true;
      }
      consecutiveMisses.delete(accountId);
      const next = validateSettings(currentSettings);
      await saveSettings(settingsPath, next);
      settings = next;
      rebuild();
      return snapshot();
    });
    pendingSave = operation;
    return operation;
  }

  async function updateSettings(patch) {
    const operation = pendingSave.catch(() => {}).then(async () => {
      const updatedPatch = { ...patch };
      if (patch.accounts) {
        // Any user edit (label, primary, enabled, reordering) makes the account user-managed.
        const oldOrder = settings.accounts.map(a => a.id);
        const newIds = new Set(patch.accounts.map(a => a.id));
        const oldIds = new Set(oldOrder);
        // Compare relative order of common accounts to avoid false positives on deletion
        const commonOld = oldOrder.filter(id => newIds.has(id));
        const commonNew = patch.accounts.map(a => a.id).filter(id => oldIds.has(id));

        updatedPatch.accounts = patch.accounts.map(acc => {
          const existing = settings.accounts.find(a => a.id === acc.id);
          const existingOrigin = existing?.origin || 'user';
          const labelChanged = acc.label !== undefined && existing && acc.label !== existing.label;
          const primaryChanged = acc.primary !== undefined && existing && acc.primary !== existing.primary;
          const enabledChanged = acc.enabled !== undefined && existing && acc.enabled !== existing.enabled;

          // Check if this specific account's relative position changed
          const oldRel = commonOld.indexOf(acc.id);
          const newRel = commonNew.indexOf(acc.id);
          const thisAccountMoved = oldRel !== -1 && newRel !== -1 && oldRel !== newRel;

          const isUser = labelChanged || primaryChanged || enabledChanged || thisAccountMoved;
          // Origin is NOT trusted from client input
          const origin = isUser ? 'user' : existingOrigin;
          // Client cannot override configDirExplicit
          const configDirExplicit = existing?.configDirExplicit !== undefined ? existing.configDirExplicit : acc.configDirExplicit;
          return { ...acc, ...(configDirExplicit !== undefined ? { configDirExplicit } : {}), origin };
        });
      }
      const next = validateSettings({ ...settings, ...updatedPatch });
      await saveSettings(settingsPath, next);
      settings = next;
      if (patch.accounts) rebuild();
      return snapshot();
    });
    pendingSave = operation;
    return operation;
  }

  async function restoreDismissedAccounts() {
    await updateSettings({ dismissedAccountIds: [] });
    await reconcileDiscovery();
    return snapshot();
  }

  return { snapshot, refresh, updateSettings, dismissAccount, restoreDismissedAccounts, reconcileDiscovery };
}

module.exports = { createService };
