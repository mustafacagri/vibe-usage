'use strict';
const $ = selector => document.querySelector(selector);
const selection = new Map();
let state = null;
let toastTimer;
let settingsMsgTimer;
let cachedModels = null;
let currentSmartPreview = null;

function t(key, params) {
  return window.VibeI18n ? window.VibeI18n.t(key, params) : key;
}

function applyI18n() {
  if (!window.VibeI18n) return;
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.dataset.i18n;
    el.textContent = t(key);
  });
  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    const key = el.dataset.i18nTitle;
    el.title = t(key);
  });
  document.querySelectorAll('[data-i18n-aria]').forEach(el => {
    const key = el.dataset.i18nAria;
    el.setAttribute('aria-label', t(key));
  });
  document.querySelectorAll('.slot-text').forEach(el => {
    const slotIdx = Number(el.dataset.slot);
    el.textContent = t('slotLabel', { n: slotIdx + 1 });
  });
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function toast(message) {
  $('#toast').textContent = message;
  $('#toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 5000);
}

function showSettingsMessage(msg) {
  const el = $('#settings-message');
  if (!el) return;
  el.textContent = msg;
  clearTimeout(settingsMsgTimer);
  settingsMsgTimer = setTimeout(() => {
    if (el) el.textContent = '';
  }, 4000);
}

async function action(fn) {
  try {
    return await fn();
  } catch (err) {
    console.error(err);
    toast('Error completing action. Check session and connectivity.');
  }
}

async function getModels() {
  if (!cachedModels && window.vibe?.getDiscoveredModels) {
    try {
      cachedModels = await window.vibe.getDiscoveredModels();
    } catch {}
  }
  return cachedModels || {
    codex: ['gpt-6-luna', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-reserve', 'o3-mini'],
    claude: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-sonnet-4-5', 'claude-3-7-sonnet'],
    cursor: ['grok-4.7', 'claude-opus-4-7', 'cursor-opus-4.5', 'claude-3.7-sonnet', 'gpt-5', 'cursor-small'],
    antigravity: ['gemini-3.8-flash', 'gemini-3-flash', 'gemini-2.5-pro', 'gemini-2.5-flash']
  };
}

function localizeWindow(win) {
  if (!win) return win;
  let label = win.label || '';
  let detail = win.detail || '';
  let valueText = win.valueText || '';

  // Localize standard labels
  if (/^5 saat$/i.test(label) || /^5 hours?$/i.test(label)) {
    label = t('label5Hours');
  } else if (/^haftal[ıi]k$/i.test(label) || /^weekly$/i.test(label)) {
    label = t('labelWeekly');
  } else if (/^opus\s*·\s*haftal[ıi]k$/i.test(label)) {
    label = `Opus · ${t('labelWeekly').toLowerCase()}`;
  } else if (/^sonnet\s*·\s*haftal[ıi]k$/i.test(label)) {
    label = `Sonnet · ${t('labelWeekly').toLowerCase()}`;
  } else if (/^(\d+)\s*saat$/i.test(label) || /^(\d+)\s*hours?$/i.test(label)) {
    const hours = label.match(/^(\d+)\s*(?:saat|hours?)$/i)[1];
    label = t('labelNHours', { n: hours });
  } else if (/^(\d+)\s*dakika$/i.test(label) || /^(\d+)\s*minutes?$/i.test(label)) {
    const mins = label.match(/^(\d+)\s*(?:dakika|minutes?)$/i)[1];
    label = t('labelNMins', { n: mins });
  } else if (/^auto kapsam[ıi]$/i.test(label) || /^auto scope$/i.test(label)) {
    label = t('labelAutoScope');
  } else if (/^api kapsam[ıi]$/i.test(label) || /^api scope$/i.test(label)) {
    label = t('labelApiScope');
  } else if (/^toplam kullan[ıi]m$/i.test(label) || /^total usage$/i.test(label)) {
    label = t('labelTotalUsage');
  } else if (/^dahil kullan[ıi]m\s*·\s*tutar$/i.test(label)) {
    label = t('labelIncludedSpend');
  } else if (/^ek [üu]cretli kullan[ıi]m$/i.test(label)) {
    label = t('labelOnDemandSpend');
  } else if (/^tak[ıi]m\s*·\s*ek [üu]cretli kullan[ıi]m$/i.test(label)) {
    label = `${t('labelTeam')} · ${t('labelOnDemandSpend')}`;
  } else if (/^d[öo]nem bildirilmedi$/i.test(label)) {
    label = t('labelNoPeriodReported');
  }

  // Localize detail
  if (detail.includes('Bu sınır hesabın bütün modellerde bittiği anlamına gelmez')) {
    detail = t('cursorApiLimitNote');
  } else if (detail.includes('Kaynakta pasif')) {
    detail = t('passiveSourceDetail');
  }

  // Localize valueText if any
  if (valueText.includes('cent kalan')) {
    const num = valueText.replace(/[^0-9.]/g, '');
    valueText = t('centsRemaining', { n: num });
  } else if (valueText === 'Tutar bildirilmedi') {
    valueText = t('amountNotReported');
  } else if (valueText === 'Kapalı') {
    valueText = t('disabled');
  }

  return { ...win, label, detail, valueText };
}

function localizeAccountLabel(label) {
  if (!label) return label;
  if (label === 'Hesap A') return t('accountA');
  if (label === 'Hesap B') return t('accountB');
  if (label === 'Mevcut hesap') return t('defaultAccount');
  return label;
}

function renderQuotaCell(rawWindow, isSingle) {
  const window = localizeWindow(rawWindow);
  const view = VibeFormat.formatWindow(window);
  const quota = element('div', 'quota' + (view.percent !== null && view.percent <= 20 ? ' low' : '') + (isSingle ? ' span-full' : ''));
  const line = element('div', 'quota-line');
  line.append(element('span', 'quota-label', window.label), element('span', 'quota-value', view.value));
  quota.append(line);
  if (view.percent !== null) {
    const track = element('div', 'track');
    const fill = element('div', 'fill');
    fill.style.setProperty('--quota', String(view.percent));
    track.append(fill);
    track.setAttribute('role', 'progressbar');
    track.setAttribute('aria-label', window.label);
    track.setAttribute('aria-valuenow', String(view.percent));
    track.setAttribute('aria-valuemin', '0');
    track.setAttribute('aria-valuemax', '100');
    quota.append(track);
  }
  let desc = '';
  if (window.detail && view.reset) {
    desc = `${window.detail} · ${t('resetsAt', { date: view.reset })}`;
  } else if (view.reset) {
    desc = t('resetsAt', { date: view.reset });
  } else {
    desc = window.detail || view.note || '';
  }
  if (desc) quota.append(element('div', 'quota-description', desc));
  return quota;
}

function accountSection(provider) {
  const section = element('section', 'provider');
  section.dataset.provider = provider.id;
  const heading = element('div', 'provider-heading');
  const brand = element('div', 'provider-brand');
  const avatar = element('span', 'brand-avatar ' + provider.id + '-avatar');
  const avatars = { claude: '◈', cursor: '✦', codex: '✺', antigravity: '▲' };
  avatar.textContent = avatars[provider.id] || '●';
  brand.append(avatar, element('h2', '', provider.name));
  heading.append(brand);

  const accounts = provider.accounts || [];
  let current = accounts.find(a => a.id === selection.get(provider.id)) || accounts.find(a => a.primary) || accounts[0];
  const headerMeta = element('div', 'provider-header-meta');
  if (current?.plan) headerMeta.append(element('span', 'plan-pill', current.plan.toUpperCase()));

  if (accounts.length > 1) {
    const select = element('select', 'account-picker');
    select.setAttribute('aria-label', `${provider.name} ${t('accountLabelPlaceholder')}`);
    for (const account of accounts) {
      const option = element('option', '', `${account.primary ? '★ ' : ''}${localizeAccountLabel(account.label)}`);
      option.value = account.id;
      select.append(option);
    }
    select.value = current.id;
    select.addEventListener('change', () => {
      selection.set(provider.id, select.value);
      render(state);
    });
    headerMeta.append(select);
  } else if (current && current.label) {
    const displayLabel = localizeAccountLabel(current.label);
    if (displayLabel !== t('defaultAccount') && displayLabel !== 'Mevcut hesap' && displayLabel !== 'Default account') {
      headerMeta.append(element('span', 'account-pill', displayLabel));
    }
  }
  heading.append(headerMeta);
  section.append(heading);

  if (current) {
    const scopes = new Map();
    const regularWindows = [];
    const spendingWindows = [];

    for (const window of current.windows || []) {
      if (provider.id === 'cursor' && window.id === 'plan:total') {
        spendingWindows.push({
          ...window,
          detail: t('totalQuotaDesc')
        });
      } else if (window.valueText) {
        spendingWindows.push(window);
      } else if (window.scope) {
        if (!scopes.has(window.scope)) scopes.set(window.scope, []);
        scopes.get(window.scope).push(window);
      } else {
        regularWindows.push(window);
      }
    }

    if (scopes.size > 0) {
      for (const [scopeName, scopeWindows] of scopes) {
        section.append(element('div', 'scope-title', scopeName));
        const grid = element('div', 'quota-grid');
        for (const window of scopeWindows) grid.append(renderQuotaCell(window, scopeWindows.length === 1));
        section.append(grid);
      }
    }

    if (regularWindows.length > 0) {
      const grid = element('div', 'quota-grid');
      for (const window of regularWindows) grid.append(renderQuotaCell(window, regularWindows.length === 1));
      section.append(grid);
    }

    if (spendingWindows.length > 0) {
      const spending = element('details', 'spending');
      spending.append(element('summary', '', t('spendingDetails')));
      for (const window of spendingWindows) {
        spending.append(renderQuotaCell(window, true));
      }
      section.append(spending);
    }

    if (!current.windows?.length) {
      section.append(element('div', 'empty', current.message || provider.message || t('noDataYet')));
    } else if (current.message) {
      section.append(element('div', 'empty', current.message));
    }

    if (provider.id === 'claude' && current.configDir && current.status === 'ok') {
      const launch = element('button', 'launch-button', t('launchClaudeBtn'));
      launch.addEventListener('click', () => action(async () => {
        const response = await window.vibe.launch({ accountId: current.id });
        if (response?.message) toast(response.message);
      }));
      section.append(launch);
      section.append(element('div', 'quota-description', t('safeLocalNote')));
    }

    if (current.status === 'auth_missing' || current.status === 'auth_invalid' || current.status === 'app_closed' || provider.status === 'auth_missing' || !current.windows?.length) {
      const label = current.status === 'app_closed' ? t('launchAppBtn') : t('loginProviderBtn', { name: provider.name });
      const loginBtn = element('button', 'launch-button', label);
      loginBtn.addEventListener('click', () => action(async () => {
        await window.vibe.loginProvider(provider.id);
        toast(t('loginProviderBtn', { name: provider.name }));
      }));
      section.append(loginBtn);
    }
  } else {
    section.append(element('div', 'empty', provider.message || t('noConnectedAccounts')));
    const loginBtn = element('button', 'launch-button', t('loginProviderBtn', { name: provider.name }));
    loginBtn.addEventListener('click', () => action(async () => {
      await window.vibe.loginProvider(provider.id);
      toast(t('loginProviderBtn', { name: provider.name }));
    }));
    section.append(loginBtn);
  }

  const accountStatus = current?.status || provider.status;
  const status = element('div', 'provider-status' + (accountStatus === 'stale' ? ' stale' : ''));
  const statusText = accountStatus === 'loading' ? t('reading') : accountStatus === 'stale' ? t('refreshFailed') : accountStatus === 'ok' ? t('live') : accountStatus === 'auth_missing' ? t('noSession') : '';
  status.append(element('span', '', VibeFormat.formatFreshness(current ? current.fetchedAt : provider.fetchedAt, accountStatus)), element('span', '', statusText));
  section.append(status);
  return section;
}

function render(snapshot) {
  if (!snapshot) return;
  state = snapshot;

  const lang = snapshot.settings?.language || 'en';
  if (window.VibeI18n) window.VibeI18n.setLanguage(lang);
  document.documentElement.lang = lang;
  applyI18n();

  // Dynamic Provider Ordering: respect primaryProvider & providerOrder
  const primary = snapshot.settings?.primaryProvider || 'codex';
  const ALL_PROVIDERS = ['codex', 'claude', 'cursor', 'antigravity'];
  const order = snapshot.settings?.providerOrder || [primary, ...ALL_PROVIDERS.filter(p => p !== primary)];

  const sortedProviders = [...snapshot.providers].sort((a, b) => {
    const indexA = order.indexOf(a.id);
    const indexB = order.indexOf(b.id);
    return (indexA === -1 ? 999 : indexA) - (indexB === -1 ? 999 : indexB);
  });

  $('#providers').replaceChildren(...sortedProviders.map(accountSection));
  $('#overall-status').textContent = snapshot.refreshing ? t('readingQuotas') : t('servicesOnDevice', { n: snapshot.providers.length });
  $('#refresh').disabled = snapshot.refreshing;
  $('#pin').setAttribute('aria-pressed', String(!!snapshot.settings.pinned));
  $('#refresh-label').textContent = t('autoRefresh', { n: snapshot.settings.intervalSeconds / 60 });
  $('#platform-label').textContent = navigator.platform.toLowerCase().includes('mac') ? t('menuBar') : t('systemTray');
}

async function renderSettings() {
  if (!state) return;
  
  // Language
  const langSelect = $('#language-select');
  if (langSelect) {
    langSelect.value = state.settings.language || 'en';
  }

  // Interval
  const interval = $('#interval');
  if (interval) {
    interval.value = String(state.settings.intervalSeconds);
    if (!interval.value) {
      const option = element('option', '', `${state.settings.intervalSeconds}s`);
      option.value = String(state.settings.intervalSeconds);
      interval.append(option);
      interval.value = option.value;
    }
  }

  // Fallback Priority 4-Slot Setup
  const fallbackList = [...(state.settings.fallbackOrder || ['claude', 'codex', 'cursor', 'antigravity'])];
  for (const p of ['claude', 'codex', 'cursor', 'antigravity']) {
    if (!fallbackList.includes(p)) fallbackList.push(p);
  }
  for (let i = 0; i < 4; i++) {
    const slot = $(`#fallback-slot-${i}`);
    if (slot) {
      slot.value = fallbackList[i] || 'claude';
    }
  }

  // Dynamic Model Dropdowns for Preferred Models
  const models = await getModels();
  const prefs = state.settings.preferredModels || {};
  for (const p of ['codex', 'claude', 'cursor', 'antigravity']) {
    const select = $(`#preferred-${p}`);
    if (select) {
      select.replaceChildren();
      const providerModels = models[p] || [];
      for (const m of providerModels) {
        const opt = element('option', '', m);
        opt.value = m;
        select.append(opt);
      }
      if (prefs[p]) select.value = prefs[p];
      else if (providerModels[0]) select.value = providerModels[0];
    }
  }

  // Connected Accounts by Provider Card
  const list = $('#account-settings');
  list.replaceChildren();
  const avatars = { claude: '◈', cursor: '✦', codex: '✺', antigravity: '▲' };
  const providers = (state.providers || []).filter(p => state.settings.accounts.some(a => a.providerId === p.id));
  
  for (const p of providers) {
    const accounts = state.settings.accounts.filter(a => a.providerId === p.id);
    const group = element('div', 'provider-settings-card');
    group.dataset.provider = p.id;

    // Distinct Brand Header for the Provider
    const header = element('div', 'provider-card-header');
    const brandInline = element('div', 'provider-brand-inline');
    const badge = element('span', `brand-avatar-badge ${p.id}-badge`, avatars[p.id] || '●');
    const title = element('strong', 'provider-name-text', p.name);
    brandInline.append(badge, title);
    const countBadge = element('span', 'provider-account-count', t('accountCount', { n: accounts.length }));
    header.append(brandInline, countBadge);
    group.append(header);

    const accountsList = element('div', 'provider-accounts-list');
    for (const account of accounts) {
      const item = element('div', 'account-item');

      // Top Line: [Radio] [Icon] Primary account ... [✕ Remove]
      const topRow = element('div', 'account-item-top');
      const labelWrap = element('label', 'account-radio-label');
      const radio = element('input');
      radio.type = 'radio';
      radio.name = `primary-${p.id}`;
      radio.checked = !!account.primary;
      radio.style.accentColor = `var(--accent-${p.id})`;
      radio.addEventListener('change', () => action(async () => {
        await window.vibe.saveSettings({
          accounts: state.settings.accounts.map(a => a.providerId === p.id ? { ...a, primary: a.id === account.id } : a)
        });
        renderSettings();
      }));

      const miniIcon = element('span', `account-mini-icon ${p.id}-color`, avatars[p.id] || '●');
      const primaryText = element('span', `primary-text${account.primary ? ' is-primary' : ''}`, account.primary ? t('primaryAccount') : t('secondaryAccount'));
      labelWrap.append(radio, miniIcon, primaryText);
      topRow.append(labelWrap);

      const remove = element('button', 'remove-account', t('removeAccount'));
      remove.setAttribute('aria-label', `${account.label} ${t('removeAccount')}`);
      remove.title = t('removeAccount');
      remove.addEventListener('click', () => action(async () => {
        if (confirm(t('confirmRemoveAccount', { label: account.label }))) {
          const next = await window.vibe.dismissAccount(account.id);
          if (next) render(next);
          renderSettings();
        }
      }));
      topRow.append(remove);
      item.append(topRow);

      // Bottom Line: Full width input
      const inputWrap = element('div', 'account-item-input-wrap');
      const input = element('input', 'account-label-input');
      input.type = 'text';
      input.value = account.label;
      input.maxLength = 64;
      input.placeholder = t('accountLabelPlaceholder');
      input.setAttribute('aria-label', `${p.name} ${t('accountLabelPlaceholder')}`);
      input.addEventListener('change', () => action(async () => {
        await window.vibe.saveSettings({
          accounts: state.settings.accounts.map(a => a.id === account.id ? { ...a, label: input.value } : a)
        });
      }));
      inputWrap.append(input);
      item.append(inputWrap);

      accountsList.append(item);
    }
    group.append(accountsList);
    list.append(group);
  }

  if (state.settings.dismissedAccountIds?.length) {
    const restoreBtn = element('button', 'secondary-button', t('restoreAccountsBtn', { n: state.settings.dismissedAccountIds.length }));
    restoreBtn.style.marginTop = '15px';
    restoreBtn.addEventListener('click', () => action(async () => {
      const next = await window.vibe.restoreDismissedAccounts();
      if (next) render(next);
      renderSettings();
    }));
    list.append(restoreBtn);
  }
}

async function updateHandoverModelDropdown(targetProvider) {
  const models = await getModels();
  const select = $('#handover-model');
  if (!select) return;
  select.replaceChildren();
  const providerModels = models[targetProvider] || [];
  const preferred = state?.settings?.preferredModels?.[targetProvider];
  for (const m of providerModels) {
    const opt = element('option', '', m);
    opt.value = m;
    select.append(opt);
  }
  select.value = preferred || providerModels[0] || '';
}

// Handover Modal Events
$('#handover-btn')?.addEventListener('click', async () => {
  const target = $('#handover-to')?.value || 'codex';
  await updateHandoverModelDropdown(target);
  $('#handover-dialog')?.showModal();
});

$('#handover-to')?.addEventListener('change', async (e) => {
  await updateHandoverModelDropdown(e.target.value);
});

$('#handover-cancel-btn')?.addEventListener('click', () => {
  $('#handover-dialog')?.close();
});

$('#handover-execute-btn')?.addEventListener('click', () => action(async () => {
  const fromProvider = $('#handover-from')?.value || 'auto';
  const toProvider = $('#handover-to')?.value || 'codex';
  const targetModel = $('#handover-model')?.value || '';
  $('#handover-dialog')?.close();
  const res = await window.vibe.executeHandover({ fromProvider, toProvider, targetModel });
  if (res?.message) toast(res.message);
}));

// Smart Launch Modal Events
$('#smart-launch-btn')?.addEventListener('click', () => action(async () => {
  const preview = await window.vibe.previewSmartLaunch();
  currentSmartPreview = preview;
  if (preview) {
    $('#sl-provider').textContent = `${preview.providerName} ${preview.isFallback ? t('fallbackActive') : t('primaryChoice')}`;
    $('#sl-quota').textContent = typeof preview.remaining === 'number' ? t('percentAvailable', { n: preview.remaining }) : t('readyToUse');
    $('#sl-model').textContent = `${preview.recommendedModel} (${preview.tierName || 'Auto Tier'})`;
    $('#sl-reason').textContent = preview.reason || 'Quotas and priority order analyzed.';
    $('#smart-launch-dialog')?.showModal();
  }
}));

$('#sl-cancel-btn')?.addEventListener('click', () => {
  $('#smart-launch-dialog')?.close();
});

$('#sl-confirm-btn')?.addEventListener('click', () => action(async () => {
  $('#smart-launch-dialog')?.close();
  const res = await window.vibe.smartLaunch({ targetModel: currentSmartPreview?.recommendedModel });
  if (res?.message) toast(res.message);
}));

// Settings Controls
$('#language-select')?.addEventListener('change', e => action(async () => {
  const lang = e.target.value;
  if (window.VibeI18n) window.VibeI18n.setLanguage(lang);
  document.documentElement.lang = lang;
  applyI18n();
  const next = await window.vibe.saveSettings({ language: lang });
  if (next) render(next);
  renderSettings();
}));

for (let i = 0; i < 4; i++) {
  $(`#fallback-slot-${i}`)?.addEventListener('change', e => {
    action(async () => {
      const selectedValue = e.target.value;
      let order = [...(state.settings.fallbackOrder || ['claude', 'codex', 'cursor', 'antigravity'])];
      for (const p of ['claude', 'codex', 'cursor', 'antigravity']) {
        if (!order.includes(p)) order.push(p);
      }
      const existingIndex = order.indexOf(selectedValue);
      if (existingIndex !== -1 && existingIndex !== i) {
        const temp = order[i];
        order[i] = selectedValue;
        order[existingIndex] = temp;
      } else {
        order[i] = selectedValue;
      }
      for (let j = 0; j < 4; j++) {
        const slot = $(`#fallback-slot-${j}`);
        if (slot) slot.value = order[j];
      }
      const next = await window.vibe.saveSettings({
        fallbackOrder: order,
        providerOrder: order,
        primaryProvider: order[0]
      });
      if (next) render(next);
    });
  });
}

for (const p of ['codex', 'claude', 'cursor', 'antigravity']) {
  $(`#preferred-${p}`)?.addEventListener('change', () => action(async () => {
    const currentPrefs = { ...(state?.settings?.preferredModels || {}) };
    currentPrefs[p] = $(`#preferred-${p}`).value;
    const next = await window.vibe.saveSettings({ preferredModels: currentPrefs });
    if (next) render(next);
  }));
}

$('#refresh').addEventListener('click', () => action(() => window.vibe.refresh()));
$('#pin').addEventListener('click', () => action(() => window.vibe.pin()));
$('#hide').addEventListener('click', () => action(() => window.vibe.hide()));

$('#settings-button').addEventListener('click', async () => {
  if (state) {
    const el = $('#settings-message');
    if (el) el.textContent = '';
    await renderSettings();
    $('#settings-dialog').showModal();
  }
});
$('#interval').addEventListener('change', event => action(() => window.vibe.saveSettings({ intervalSeconds: Number(event.target.value) })));
$('#add-profile').addEventListener('click', () => action(async () => {
  const response = await window.vibe.addClaudeProfile();
  if (response?.message && !response?.canceled && response.message !== 'İptal edildi.') {
    showSettingsMessage(response.message);
  }
  renderSettings();
}));

window.vibe.onSnapshot(render);
action(async () => render(await window.vibe.snapshot()));
