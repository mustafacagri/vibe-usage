'use strict';
const { loadSettings, saveSettings, defaultSettingsPath, DEFAULT_SETTINGS, validateSettings } = require('./settings.cjs');
const { normalizeWindow } = require('./model.cjs');
const { safeError, now, ProviderError } = require('../providers/common.cjs');
const { antigravityAccountId } = require('../providers/antigravity.cjs');

const MESSAGES = {
  auth_missing: 'Bu cihazda giriş bulunamadı.',
  auth_expired: 'Oturum süresi dolmuş; sağlayıcıda yeniden giriş gerekli.',
  auth_invalid: 'Kayıtlı oturum okunamadı.',
  auth_rejected: 'Sağlayıcı oturumu kabul etmedi.',
  rate_limited: 'Okuma sıklığı sınırlandı; yeniden denemeden önce bekleniyor.',
  app_closed: 'Kota için Antigravity uygulamasını açın.',
  unsupported_platform: 'Bu işletim sisteminde bu veri kaynağı henüz desteklenmiyor.',
  unsupported_profile: 'Bu profilin kimlik deposu henüz desteklenmiyor.',
  keychain_unavailable: 'Keychain girişi okunamadı.',
  binary_missing: 'Gerekli yerel uygulama veya CLI bulunamadı.',
  transport_error: 'Sağlayıcıya bağlanılamadı.',
  local_service_unavailable: 'Antigravity yerel servisine ulaşılamadı.',
  tls_certificate_error: 'TLS sertifikası doğrulanamadı. Ağın ve sistemin sertifika güvenini kontrol edin.',
  trust_store_unavailable: 'İşletim sisteminin sertifika deposu okunamadı. Kurulumu ve desteklenen Node.js sürümünü kontrol edin.',
  no_limits_reported: 'Bu hesap için bildirilen aktif kota limiti bulunmuyor.',
  invalid_response: 'Kota verisi ayrıştırılamadı veya boş yanıt alındı.',
  request_timeout: 'İstek zaman aşımına uğradı.'
};

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

  // Only migrate antigravity:current if EXACTLY 1 email account was discovered
  // (per Claude's finding: do not arbitrarily migrate if multiple distinct accounts exist)
  const emailAccounts = found.filter(a => a.providerId === 'antigravity' && a.email);
  if (emailAccounts.length === 1) {
    const target = emailAccounts[0];
    const legacy = currentSettings.accounts.find(a => a.id === 'antigravity:current');
    if (legacy && !currentSettings.accounts.some(a => a.id === target.id)) {
      legacy.id = target.id;
      legacy.email = target.email;
      if (!legacy.label || legacy.label === 'Mevcut uygulama') legacy.label = target.label;
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

  // Migrate legacy accounts without origin to origin: 'user'
  for (const a of settings.accounts) {
    if (!a.origin) {
      a.origin = 'user';
      changed = true;
    }
  }

  // Ensure fallbackOrder contains all providers including Claude
  if (!settings.fallbackOrder || !Array.isArray(settings.fallbackOrder) || settings.fallbackOrder.length < 4 || !settings.fallbackOrder.includes('claude')) {
    const list = Array.isArray(settings.fallbackOrder) ? [...settings.fallbackOrder] : [];
    for (const p of ['claude', 'codex', 'cursor', 'antigravity']) {
      if (!list.includes(p)) list.push(p);
    }
    settings.fallbackOrder = list;
    changed = true;
  }

  settings = validateSettings(settings);
  if (changed) await saveSettings(settingsPath, settings);

  let providers = adapters.map(p => ({ id: p.id, name: p.name, status: 'pending', accounts: [] }));
  let pendingSave = Promise.resolve();
  const cooldown = new Map();
  const inFlight = new Map(); // providerId -> Promise
  const consecutiveMisses = new Map(); // accountId -> number
  const providerGenerations = new Map(); // providerId -> number
  const accountGenerations = new Map(); // accountId -> number
  let lastDiscoveryTime = now(clock);
  let discoveryRunning = null;
  let settingsRevision = 0;

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
          if (res.status !== 'fulfilled' || !res.value.ok) {
            // R1 / E4: Adapter unavailable or errored. Never increment misses on error!
            continue;
          }
          const { adapterId, found } = res.value;
          const foundIds = new Set(found.map(a => a.id));

          if (adapterId === 'antigravity') {
            if (migrateAntigravityAccounts(currentSettings, found)) {
              modified = true;
            }
          }

          for (const account of found) {
            consecutiveMisses.delete(account.id);
            // E1 & R3: User dismissed accounts are NEVER auto re-added
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

          // Reconcile missing accounts: only auto-delete active discovered accounts after 3 consecutive clean misses
          // R4: NEVER delete an account that was disabled by user (enabled === false) or customized (origin === 'user')!
          // F1: Antigravity accounts reflect running processes, not disk configs. NEVER auto-delete Antigravity accounts!
          for (let i = currentSettings.accounts.length - 1; i >= 0; i--) {
            const acc = currentSettings.accounts[i];
            if (acc.providerId !== 'antigravity' && acc.providerId === adapterId && acc.origin === 'discovered' && acc.enabled !== false && !foundIds.has(acc.id)) {
              const misses = (consecutiveMisses.get(acc.id) || 0) + 1;
              consecutiveMisses.set(acc.id, misses);
              if (misses >= 3) {
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
        timer = setTimeout(() => reject(new ProviderError('request_timeout')), 12000);
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

        // B4: verify account still exists in settings.accounts with matching configDir
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
          targetAccount.message = MESSAGES.no_limits_reported;
          targetAccount.messageCode = 'no_limits_reported';
          targetAccount.fetchedAt = stamp;
        } else if (!windows.length) {
          throw new ProviderError('invalid_response');
        } else {
          for (const prior of targetAccount.windows || []) {
            if (!windows.some(w => w.id === prior.id)) {
              windows.push({ ...prior, stale: true, detailKey: 'staleWindowDetail', detail: 'Önceki ölçüm; son yanıtta bu kapsam bildirilmedi.' });
            }
          }
          targetAccount.windows = windows;
          targetAccount.status = 'ok';
          targetAccount.message = result.message || '';
          delete targetAccount.messageCode;
          targetAccount.fetchedAt = stamp;
        }
        if (result.plan) targetAccount.plan = result.plan;
      } catch (error) {
        clearTimeout(timer);
        const lastGen = accountGenerations.get(account.id) || 0;
        if (lastGen > currentGen) return;
        accountGenerations.set(account.id, currentGen);

        // B4: verify account still exists in settings.accounts
        const currentAccount = settings.accounts.find(a => a.id === account.id);
        if (!currentAccount || currentAccount.configDir !== account.configDir || currentAccount.enabled === false) {
          return;
        }

        const targetAccount = provider.accounts.find(a => a.id === account.id) || account;
        const code = safeError(error);
        targetAccount.status = targetAccount.fetchedAt ? 'stale' : code;
        targetAccount.message = MESSAGES[code] || 'Kullanım verisi okunamadı. Bir sonraki yenilemede tekrar denenecek.';
        targetAccount.messageCode = MESSAGES[code] ? code : 'unknown';
        if (code === 'rate_limited') {
          cooldown.set(account.id, attempt + (error.retryAfterSeconds || 120) * 1000);
        }
      }
    }));

    const allOk = provider.accounts.length > 0 && provider.accounts.every(a => a.status === 'ok' || a.status === 'no_limits_reported');
    provider.status = allOk ? 'ok' : provider.accounts.some(a => a.fetchedAt) ? 'stale' : (provider.accounts[0]?.status || 'unavailable');
    if (allOk || provider.accounts.some(a => a.status === 'ok')) {
      provider.fetchedAt = new Date(now(clock)).toISOString();
    }
    provider.message = provider.accounts.length ? '' : 'Bağlı hesap bulunamadı.';
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
      throw Error('invalid_provider');
    }

    // Periodic discovery reconciliation (every 60s)
    if (now(clock) - lastDiscoveryTime > 60000) {
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
    if (typeof accountId !== 'string' || !/^[a-zA-Z0-9:@._+-]{1,120}$/.test(accountId)) {
      throw new Error('invalid_account');
    }
    const operation = pendingSave.catch(() => {}).then(async () => {
      settingsRevision++;
      const currentSettings = copy(settings);
      const dismissed = new Set(currentSettings.dismissedAccountIds || []);
      dismissed.add(accountId);
      currentSettings.dismissedAccountIds = Array.from(dismissed).slice(-100);
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
      settingsRevision++;
      let updatedPatch = { ...patch };
      if (patch.dismissedAccountIds !== undefined) {
        updatedPatch.dismissedAccountIds = [...new Set(patch.dismissedAccountIds.filter(id => typeof id === 'string' && /^[a-zA-Z0-9:@._+-]{1,120}$/.test(id)))].slice(-100);
      }
      if (patch.accounts) {
        // R4: Preserve origin and mark user customizations (label, primary, enabled, true order change) as origin = 'user'
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
