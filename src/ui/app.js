'use strict';
const { PROVIDERS, PROVIDER_IDS, AUTO, providerById, normalizeProviderOrder } = window.VibeCatalog;
const { describeWindow, formatAge, formatFreshness, describeCode, formatDuration, formatPercent } = window.VibeFormat;
const i18n = window.VibeI18n;

const TOAST_MS = 5000;
const SETTINGS_MESSAGE_MS = 4000;
// Countdowns and ages are relative to now; re-render this often between snapshots.
const CLOCK_TICK_MS = 30 * 1000;
const LOW_QUOTA_PERCENT = 20;
const INTERVAL_CHOICES_SECONDS = [60, 120, 300, 600];
const BYTES_PER_MEGABYTE = 1024 * 1024;
const SHORT_ID_LENGTH = 8;
const STATUS_TEXT = { pending: 'reading', ok: 'live', stale: 'refreshFailed', auth_missing: 'noSession' };
// States where the useful next step is signing in or opening the provider's app.
const SIGN_IN_STATUSES = new Set(['auth_missing', 'auth_invalid', 'auth_expired', 'auth_rejected', 'keychain_unavailable', 'app_closed']);
const DETAILS_SECTION = 'details';

const $ = selector => document.querySelector(selector);
const t = (key, params) => i18n.t(key, params);
const format = () => ({ t, locale: i18n.getCurrentLanguage(), now: Date.now() });
const accountName = account => account.label || t(account.labelKey);
const providerLabel = id => `${providerById(id).glyph} ${providerById(id).name}`;
const toolLabel = (id, model) => (model ? `${providerById(id).name} · ${model}` : providerById(id).name);

const selectedAccount = new Map();
let state = null;
let models = null;
let smartPreview = null;
let handoverProjectDir = '';
// Only the latest session request may fill the list; slower earlier answers are dropped.
let sessionRequest = 0;
let toastTimer, settingsMessageTimer;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function option(value, text) {
  const node = element('option', '', text);
  node.value = value;
  return node;
}

function fillSelect(select, entries, value) {
  select.replaceChildren(...entries.map(([key, text]) => option(key, text)));
  if (value !== undefined && entries.some(([key]) => key === value)) select.value = value;
}

function toast(message) {
  const node = $('#toast');
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    node.hidden = true;
  }, TOAST_MS);
}

function showSettingsMessage(message) {
  const node = $('#settings-message');
  node.textContent = message;
  clearTimeout(settingsMessageTimer);
  settingsMessageTimer = setTimeout(() => {
    node.textContent = '';
  }, SETTINGS_MESSAGE_MS);
}

const describe = (code, params) => describeCode(code, { t, has: i18n.hasKey }, params);

async function action(fn) {
  try {
    return await fn();
  } catch (error) {
    toast(describe(error.code, error.params));
    return undefined;
  }
}

function applyStaticText() {
  for (const node of document.querySelectorAll('[data-i18n]')) node.textContent = t(node.dataset.i18n);
  for (const node of document.querySelectorAll('[data-i18n-title]')) node.title = t(node.dataset.i18nTitle);
  for (const node of document.querySelectorAll('[data-i18n-aria]')) node.setAttribute('aria-label', t(node.dataset.i18nAria));
}

async function getModels() {
  if (!models) models = await window.vibe.getModels();
  return models;
}

// ---------------------------------------------------------------- quota cards

function quotaCell(window, fullWidth) {
  const view = describeWindow(window, format());
  const cell = element(
    'div',
    ['quota', view.percent !== null && view.percent <= LOW_QUOTA_PERCENT ? 'low' : '', fullWidth ? 'span-full' : '']
      .filter(Boolean)
      .join(' ')
  );
  const line = element('div', 'quota-line');
  line.append(element('span', 'quota-label', view.label), element('span', 'quota-value', view.value));
  cell.append(line);
  if (view.percent !== null) {
    const track = element('div', 'track');
    const fill = element('div', 'fill');
    fill.style.setProperty('--quota', String(view.percent));
    track.append(fill);
    track.setAttribute('role', 'progressbar');
    track.setAttribute('aria-label', view.label);
    track.setAttribute('aria-valuenow', String(view.percent));
    track.setAttribute('aria-valuemin', '0');
    track.setAttribute('aria-valuemax', '100');
    cell.append(track);
  }
  // The countdown comes first so truncation never hides it; the full text is the tooltip.
  const description = [view.reset, view.detail].filter(Boolean).join(' · ');
  if (description) {
    const node = element('div', 'quota-description', description);
    node.title = [view.detail, view.resetAt].filter(Boolean).join('\n');
    cell.append(node);
  }
  return cell;
}

function quotaGrid(windows) {
  const grid = element('div', 'quota-grid');
  grid.append(...windows.map(window => quotaCell(window, windows.length === 1)));
  return grid;
}

function groupWindows(windows) {
  const groups = { general: [], scopes: new Map(), details: [] };
  for (const window of windows) {
    if (window.section === DETAILS_SECTION) groups.details.push(window);
    else if (window.scope) groups.scopes.set(window.scope, [...(groups.scopes.get(window.scope) || []), window]);
    else groups.general.push(window);
  }
  return groups;
}

function statusMessage(entity) {
  return entity?.messageCode ? describe(entity.messageCode) : '';
}

function signInButton(provider, status) {
  const button = element(
    'button',
    'launch-button',
    status === 'app_closed' ? t('launchAppBtn') : t('loginProviderBtn', { name: provider.name })
  );
  button.addEventListener('click', () =>
    action(async () => {
      await window.vibe.signIn(provider.id);
      toast(t('signInOpened', { tool: provider.name }));
    })
  );
  return button;
}

function cardHeader(provider, accounts, current) {
  const heading = element('div', 'provider-heading');
  const brand = element('div', 'provider-brand');
  brand.append(element('span', 'brand-avatar', providerById(provider.id).glyph), element('h2', '', provider.name));
  const meta = element('div', 'provider-header-meta');
  if (current?.plan) meta.append(element('span', 'plan-pill', current.plan.toUpperCase()));
  if (accounts.length > 1) {
    const picker = element('select', 'account-picker');
    picker.setAttribute('aria-label', `${provider.name} ${t('accountLabelPlaceholder')}`);
    fillSelect(
      picker,
      accounts.map(a => [a.id, `${a.primary ? '★ ' : ''}${accountName(a)}`]),
      current.id
    );
    picker.addEventListener('change', () => {
      selectedAccount.set(provider.id, picker.value);
      render(state);
    });
    meta.append(picker);
  } else if (current && current.labelKey !== 'defaultAccount') {
    meta.append(element('span', 'account-pill', accountName(current)));
  }
  heading.append(brand, meta);
  return heading;
}

function providerCard(provider) {
  const section = element('section', 'provider');
  section.dataset.provider = provider.id;
  const accounts = provider.accounts || [];
  const current = accounts.find(a => a.id === selectedAccount.get(provider.id)) || accounts.find(a => a.primary) || accounts[0];
  section.append(cardHeader(provider, accounts, current));

  if (!current) {
    section.append(element('div', 'empty', statusMessage(provider) || t('status_no_accounts')), signInButton(provider));
  } else {
    const windows = current.windows || [];
    const groups = groupWindows(windows);
    // Account-wide limits first; per-model scopes follow under their own headings.
    if (groups.general.length) section.append(quotaGrid(groups.general));
    for (const [scope, scoped] of groups.scopes) section.append(element('div', 'scope-title', scope), quotaGrid(scoped));
    if (groups.details.length) {
      const details = element('details', 'spending');
      details.append(element('summary', '', t('spendingDetails')), ...groups.details.map(w => quotaCell(w, true)));
      section.append(details);
    }
    const message = statusMessage(current) || (windows.length ? '' : t('noDataYet'));
    if (message) section.append(element('div', 'empty', message));
    if (provider.id === 'claude' && current.configDir && current.status === 'ok') {
      const launch = element('button', 'launch-button', t('launchClaudeBtn'));
      launch.addEventListener('click', () =>
        action(async () => {
          const result = await window.vibe.launchClaude(current.id);
          if (result.status === 'launched') toast(t('launchedTerminal', { tool: provider.name }));
        })
      );
      section.append(launch);
    }
    if (SIGN_IN_STATUSES.has(current.status) || !windows.length) section.append(signInButton(provider, current.status));
  }

  const status = current?.status || provider.status;
  const footer = element('div', `provider-status${status === 'stale' ? ' stale' : ''}`);
  footer.append(
    element('span', '', formatFreshness(current ? current.fetchedAt : provider.fetchedAt, status, format())),
    element('span', '', STATUS_TEXT[status] ? t(STATUS_TEXT[status]) : '')
  );
  section.append(footer);
  return section;
}

function render(snapshot) {
  if (!snapshot) return;
  state = snapshot;
  i18n.setLanguage(snapshot.settings.language);
  document.documentElement.lang = i18n.getCurrentLanguage();
  applyStaticText();

  const order = normalizeProviderOrder(snapshot.settings.providerOrder);
  const providers = [...snapshot.providers].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  // Rebuilding the cards would collapse expanded detail sections; keep them open.
  const open = new Set(
    [...document.querySelectorAll('.provider details.spending[open]')].map(d => d.closest('.provider').dataset.provider)
  );
  $('#providers').replaceChildren(...providers.map(providerCard));
  for (const id of open) {
    const details = document.querySelector(`.provider[data-provider="${id}"] details.spending`);
    if (details) details.open = true;
  }
  $('#overall-status').textContent = snapshot.refreshing ? t('readingQuotas') : t('servicesOnDevice', { n: snapshot.providers.length });
  $('#refresh').disabled = snapshot.refreshing;
  $('#pin').setAttribute('aria-pressed', String(snapshot.settings.pinned));
  $('#refresh-label').textContent = t('autoRefresh', {
    time: formatDuration(snapshot.settings.intervalSeconds * 1000, i18n.getCurrentLanguage())
  });
  $('#platform-label').textContent = t(window.vibe.platform === 'darwin' ? 'menuBar' : 'systemTray');
}

// ------------------------------------------------------------------- settings

const saveSettings = async patch => render(await window.vibe.saveSettings(patch));

function renderProviderOrder() {
  const order = normalizeProviderOrder(state.settings.providerOrder);
  const grid = $('#provider-order');
  grid.replaceChildren(
    ...order.map((providerId, slot) => {
      const row = element('div', 'fallback-slot');
      const select = element('select');
      select.id = `provider-slot-${slot}`;
      fillSelect(
        select,
        PROVIDER_IDS.map(id => [id, providerLabel(id)]),
        providerId
      );
      select.setAttribute('aria-label', t('slotLabel', { n: slot + 1 }));
      const label = element('label');
      label.htmlFor = select.id;
      label.append(element('span', 'fallback-slot-badge', String(slot + 1)));
      // Choosing a provider for a slot swaps it with the slot that held it.
      select.addEventListener('change', () =>
        action(async () => {
          const next = [...order];
          next[order.indexOf(select.value)] = order[slot];
          next[slot] = select.value;
          await saveSettings({ providerOrder: next });
          renderProviderOrder();
        })
      );
      row.append(label, select);
      return row;
    })
  );
}

async function renderPreferredModels() {
  const available = await getModels();
  const container = $('#preferred-models');
  container.replaceChildren(
    ...PROVIDERS.filter(p => p.acceptsModel).map(provider => {
      const row = element('div', 'model-dropdown-row');
      row.dataset.provider = provider.id;
      const select = element('select', 'model-select');
      select.id = `preferred-${provider.id}`;
      const preferred = state.settings.preferredModels[provider.id];
      fillSelect(select, [['', t('toolDefault')], ...(available[provider.id] || []).map(m => [m, m])], preferred || '');
      select.addEventListener('change', () =>
        action(async () => {
          const { [provider.id]: _previous, ...others } = state.settings.preferredModels;
          await saveSettings({ preferredModels: select.value ? { ...others, [provider.id]: select.value } : others });
        })
      );
      const label = element('label');
      label.htmlFor = select.id;
      label.append(element('span', 'badge-icon-mini provider-color', provider.glyph), ` ${provider.name}`);
      row.append(label, select);
      return row;
    })
  );
}

function accountRow(provider, account) {
  const item = element('div', 'account-item');
  const top = element('div', 'account-item-top');
  const radioLabel = element('label', 'account-radio-label');
  const radio = element('input');
  radio.type = 'radio';
  radio.name = `primary-${provider.id}`;
  radio.checked = account.primary;
  radio.addEventListener('change', () =>
    action(async () => {
      await saveSettings({
        accounts: state.settings.accounts.map(a => (a.providerId === provider.id ? { ...a, primary: a.id === account.id } : a))
      });
      renderSettings();
    })
  );
  radioLabel.append(
    radio,
    element('span', 'account-mini-icon provider-color', provider.glyph),
    element('span', `primary-text${account.primary ? ' is-primary' : ''}`, t(account.primary ? 'primaryAccount' : 'secondaryAccount'))
  );
  const remove = element('button', 'remove-account', t('removeAccount'));
  remove.setAttribute('aria-label', `${accountName(account)} ${t('removeAccount')}`);
  remove.addEventListener('click', () =>
    action(async () => {
      if (!confirm(t('confirmRemoveAccount', { label: accountName(account) }))) return;
      render(await window.vibe.dismissAccount(account.id));
      renderSettings();
    })
  );
  top.append(radioLabel, remove);

  const input = element('input', 'account-label-input');
  input.type = 'text';
  input.value = account.label || '';
  input.placeholder = account.labelKey ? t(account.labelKey) : t('accountLabelPlaceholder');
  input.maxLength = 64;
  input.setAttribute('aria-label', `${provider.name} ${t('accountLabelPlaceholder')}`);
  // Clearing a custom name restores the app-supplied one when there is one.
  input.addEventListener('change', () =>
    action(async () => {
      const label = input.value.trim();
      await saveSettings({
        accounts: state.settings.accounts.map(a => {
          if (a.id !== account.id) return a;
          const { label: _old, ...rest } = a;
          return label ? { ...rest, label } : rest;
        })
      });
    })
  );
  const inputWrap = element('div', 'account-item-input-wrap');
  inputWrap.append(input);
  item.append(top, inputWrap);
  return item;
}

function renderAccounts() {
  const list = $('#account-settings');
  const cards = PROVIDERS.filter(p => state.settings.accounts.some(a => a.providerId === p.id)).map(provider => {
    const accounts = state.settings.accounts.filter(a => a.providerId === provider.id);
    const card = element('div', 'provider-settings-card');
    card.dataset.provider = provider.id;
    const header = element('div', 'provider-card-header');
    const brand = element('div', 'provider-brand-inline');
    brand.append(element('span', 'brand-avatar-badge', provider.glyph), element('strong', 'provider-name-text', provider.name));
    header.append(brand, element('span', 'provider-account-count', t('accountCount', { n: accounts.length })));
    const rows = element('div', 'provider-accounts-list');
    rows.append(...accounts.map(account => accountRow(provider, account)));
    card.append(header, rows);
    return card;
  });
  list.replaceChildren(...cards);
  const dismissed = state.settings.dismissedAccountIds?.length || 0;
  if (dismissed) {
    const restore = element('button', 'secondary-button gap-top-md', t('restoreAccountsBtn', { n: dismissed }));
    restore.addEventListener('click', () =>
      action(async () => {
        render(await window.vibe.restoreDismissedAccounts());
        renderSettings();
      })
    );
    list.append(restore);
  }
}

async function renderSettings() {
  fillSelect(
    $('#language-select'),
    i18n.SUPPORTED_LANGUAGES.map(code => [code, i18n.I18N[code].name]),
    state.settings.language
  );
  const locale = i18n.getCurrentLanguage();
  fillSelect(
    $('#interval'),
    INTERVAL_CHOICES_SECONDS.map(s => [String(s), new Intl.DurationFormat(locale, { style: 'long' }).format({ minutes: s / 60 })]),
    String(state.settings.intervalSeconds)
  );
  renderProviderOrder();
  renderAccounts();
  await renderPreferredModels();
}

$('#settings-button').addEventListener('click', () =>
  action(async () => {
    $('#settings-message').textContent = '';
    await renderSettings();
    $('#settings-dialog').showModal();
  })
);
$('#language-select').addEventListener('change', event =>
  action(async () => {
    await saveSettings({ language: event.target.value });
    await renderSettings();
  })
);
$('#interval').addEventListener('change', event => action(() => saveSettings({ intervalSeconds: Number(event.target.value) })));
$('#add-profile').addEventListener('click', () =>
  action(async () => {
    const { status } = await window.vibe.addClaudeProfile();
    const messages = { added: 'profileAdded', exists: 'profileExists', missing_credentials: 'profileMissingCredentials' };
    if (messages[status]) showSettingsMessage(t(messages[status]));
    await renderSettings();
  })
);

// ------------------------------------------------------------------- handover

function sessionLabel(session, showProvider) {
  const { locale } = format();
  const parts = [
    formatAge(session.updatedAt, format()),
    session.turnCount ? t('turnsCount', { n: session.turnCount }) : '',
    session.model,
    session.sizeBytes
      ? new Intl.NumberFormat(locale, { style: 'unit', unit: 'megabyte', maximumFractionDigits: 1 }).format(
          session.sizeBytes / BYTES_PER_MEGABYTE
        )
      : ''
  ].filter(Boolean);
  const title = session.title || t('untitledSession', { id: session.id.slice(0, SHORT_ID_LENGTH) });
  return `${showProvider ? `${providerLabel(session.providerId)} · ` : ''}${title} (${parts.join(' · ')})`;
}

async function refreshHandoverSessions() {
  const request = ++sessionRequest;
  const select = $('#handover-session-select');
  const fromProvider = $('#handover-from').value;
  select.replaceChildren(option(AUTO, t('mostRecentSession')));
  if (!handoverProjectDir) return;
  const sessions = await window.vibe.listSessions({ providerId: fromProvider, projectDir: handoverProjectDir });
  if (request !== sessionRequest) return;
  if (!sessions.length) {
    const empty = option('', t('noSessionsFound'));
    empty.disabled = true;
    select.append(empty);
    return;
  }
  select.append(
    ...sessions.map(session => {
      const node = option(session.id, sessionLabel(session, fromProvider === AUTO));
      node.dataset.provider = session.providerId;
      return node;
    })
  );
}

async function refreshHandoverModels() {
  const target = $('#handover-to').value;
  const accepts = providerById(target).acceptsModel;
  $('#handover-model-field').hidden = !accepts;
  if (!accepts) return;
  const available = (await getModels())[target] || [];
  fillSelect($('#handover-model'), [['', t('toolDefault')], ...available.map(m => [m, m])], state.settings.preferredModels[target] || '');
}

// A task is handed to a different tool: never offer the source as the target.
function syncHandoverTarget() {
  const from = $('#handover-from').value;
  const to = $('#handover-to');
  if (to.value === from) to.value = PROVIDER_IDS.find(id => id !== from);
}

function setHandoverProject(dir) {
  handoverProjectDir = dir;
  $('#handover-project-input').value = dir;
}

$('#handover-btn').addEventListener('click', () =>
  action(async () => {
    if (!handoverProjectDir) setHandoverProject(await window.vibe.defaultProjectDir());
    fillSelect($('#handover-from'), [[AUTO, t('autoDetectSession')], ...PROVIDER_IDS.map(id => [id, providerLabel(id)])], AUTO);
    fillSelect(
      $('#handover-to'),
      PROVIDER_IDS.map(id => [id, providerLabel(id)]),
      normalizeProviderOrder(state.settings.providerOrder)[0]
    );
    await refreshHandoverModels();
    await refreshHandoverSessions();
    $('#handover-dialog').showModal();
  })
);
$('#handover-browse-btn').addEventListener('click', () =>
  action(async () => {
    const dir = await window.vibe.selectDirectory({ defaultPath: handoverProjectDir });
    if (!dir) return;
    setHandoverProject(dir);
    await refreshHandoverSessions();
  })
);
$('#handover-from').addEventListener('change', () =>
  action(async () => {
    syncHandoverTarget();
    await refreshHandoverModels();
    await refreshHandoverSessions();
  })
);
$('#handover-to').addEventListener('change', () => action(refreshHandoverModels));
$('#handover-cancel-btn').addEventListener('click', () => $('#handover-dialog').close());
$('#handover-execute-btn').addEventListener('click', () =>
  action(async () => {
    const session = $('#handover-session-select').selectedOptions[0];
    const sessionId = session?.value || AUTO;
    $('#handover-dialog').close();
    const result = await window.vibe.executeHandover({
      projectDir: handoverProjectDir,
      fromProvider: $('#handover-from').value,
      toProvider: $('#handover-to').value,
      targetModel: $('#handover-model-field').hidden ? undefined : $('#handover-model').value || undefined,
      sessionId,
      sessionProvider: sessionId === AUTO ? undefined : session.dataset.provider
    });
    toast(t(result.mode === 'app' ? 'handoverApp' : 'handoverTerminal', { tool: toolLabel(result.to, result.model) }));
  })
);

// --------------------------------------------------------------- smart launch

function smartReason(preview) {
  if (!preview.verified) return t('reasonUnverified');
  return t(preview.isFallback ? 'reasonFallback' : 'reasonPrimary');
}

$('#smart-launch-btn').addEventListener('click', () =>
  action(async () => {
    smartPreview = await window.vibe.previewSmartLaunch();
    $('#sl-provider').textContent = providerById(smartPreview.providerId).name;
    $('#sl-quota').textContent =
      smartPreview.headroomPercent === null
        ? t('quotaUnverified')
        : t('percentRemaining', { n: formatPercent(smartPreview.headroomPercent, i18n.getCurrentLanguage()) });
    $('#sl-model').textContent = smartPreview.model || t('toolDefault');
    $('#sl-reason').textContent = smartReason(smartPreview);
    $('#smart-launch-dialog').showModal();
  })
);
$('#sl-cancel-btn').addEventListener('click', () => $('#smart-launch-dialog').close());
$('#sl-confirm-btn').addEventListener('click', () =>
  action(async () => {
    $('#smart-launch-dialog').close();
    const result = await window.vibe.smartLaunch({ targetModel: smartPreview?.model || undefined });
    if (result.status === 'launched')
      toast(t(result.mode === 'app' ? 'launchedApp' : 'launchedTerminal', { tool: toolLabel(result.to, result.model) }));
  })
);

// ------------------------------------------------------------------- titlebar

$('#refresh').addEventListener('click', () => action(() => window.vibe.refresh()));
$('#pin').addEventListener('click', () => action(() => window.vibe.pin()));
$('#hide').addEventListener('click', () => action(() => window.vibe.hide()));

applyStaticText();
window.vibe.onSnapshot(render);
setInterval(() => {
  if (state && !document.hidden) render(state);
}, CLOCK_TICK_MS);
action(async () => render(await window.vibe.snapshot()));
