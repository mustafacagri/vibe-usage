import { AUTO, normalizeProviderOrder, PROVIDER_IDS, PROVIDERS, providerById, type Provider, type ProviderId } from '../shared/catalog.ts';
import {
  describeCode,
  describeWindow,
  formatAge,
  formatDuration,
  formatFreshness,
  formatPercent,
  type FormatContext
} from '../shared/format.ts';
import {
  DEFAULT_LANGUAGE,
  hasKey,
  isLanguage,
  LOCALES,
  SUPPORTED_LANGUAGES,
  translate,
  type Language,
  type MessageKey,
  type Params
} from '../shared/i18n/index.ts';
import type { ModelCatalog, SessionSummary, SmartLaunchPreview, VibeApi } from '../shared/ipc.ts';
import type { Account, AccountStatus, MeasuredAccount, ProviderState, QuotaWindow, Snapshot } from '../shared/types.ts';

declare global {
  interface Window {
    readonly vibe: VibeApi;
  }
}

const TOAST_MS = 5000;
const SETTINGS_MESSAGE_MS = 4000;
// Countdowns and ages are relative to now; re-render this often between snapshots.
const CLOCK_TICK_MS = 30 * 1000;
const LOW_QUOTA_PERCENT = 20;
const INTERVAL_CHOICES_SECONDS = [60, 120, 300, 600];
const BYTES_PER_MEGABYTE = 1024 * 1024;
const SHORT_ID_LENGTH = 8;
const STATUS_TEXT: Partial<Record<string, MessageKey>> = {
  pending: 'reading',
  ok: 'live',
  stale: 'refreshFailed',
  auth_missing: 'noSession'
};
// States where the useful next step is signing in or opening the provider's app.
const SIGN_IN_STATUSES: ReadonlySet<AccountStatus> = new Set([
  'auth_missing',
  'auth_invalid',
  'auth_expired',
  'auth_rejected',
  'keychain_unavailable',
  'app_closed'
]);
const PROFILE_MESSAGES: Partial<Record<string, MessageKey>> = {
  added: 'profileAdded',
  exists: 'profileExists',
  missing_credentials: 'profileMissingCredentials'
};
const DETAILS_SECTION = 'details';

const { vibe } = window;

// The element for `selector`; a missing or differently typed element is a bug in index.html.
function $<T extends Element>(selector: string, type: abstract new () => T): T {
  const node = document.querySelector(selector);
  if (!(node instanceof type)) throw new Error(`${selector} is not a ${type.name}`);
  return node;
}

const ui = {
  toast: $('#toast', HTMLElement),
  settingsMessage: $('#settings-message', HTMLElement),
  providers: $('#providers', HTMLElement),
  overallStatus: $('#overall-status', HTMLElement),
  refresh: $('#refresh', HTMLButtonElement),
  pin: $('#pin', HTMLButtonElement),
  hide: $('#hide', HTMLButtonElement),
  refreshLabel: $('#refresh-label', HTMLElement),
  platformLabel: $('#platform-label', HTMLElement),
  settingsButton: $('#settings-button', HTMLButtonElement),
  settingsDialog: $('#settings-dialog', HTMLDialogElement),
  language: $('#language-select', HTMLSelectElement),
  interval: $('#interval', HTMLSelectElement),
  providerOrder: $('#provider-order', HTMLElement),
  preferredModels: $('#preferred-models', HTMLElement),
  accountSettings: $('#account-settings', HTMLElement),
  addProfile: $('#add-profile', HTMLButtonElement),
  handoverButton: $('#handover-btn', HTMLButtonElement),
  handoverDialog: $('#handover-dialog', HTMLDialogElement),
  handoverProject: $('#handover-project-input', HTMLInputElement),
  handoverBrowse: $('#handover-browse-btn', HTMLButtonElement),
  handoverFrom: $('#handover-from', HTMLSelectElement),
  handoverSession: $('#handover-session-select', HTMLSelectElement),
  handoverTo: $('#handover-to', HTMLSelectElement),
  handoverModelField: $('#handover-model-field', HTMLElement),
  handoverModel: $('#handover-model', HTMLSelectElement),
  handoverCancel: $('#handover-cancel-btn', HTMLButtonElement),
  handoverExecute: $('#handover-execute-btn', HTMLButtonElement),
  smartButton: $('#smart-launch-btn', HTMLButtonElement),
  smartDialog: $('#smart-launch-dialog', HTMLDialogElement),
  smartProvider: $('#sl-provider', HTMLElement),
  smartQuota: $('#sl-quota', HTMLElement),
  smartModel: $('#sl-model', HTMLElement),
  smartReason: $('#sl-reason', HTMLElement),
  smartCancel: $('#sl-cancel-btn', HTMLButtonElement),
  smartConfirm: $('#sl-confirm-btn', HTMLButtonElement)
};

let language: Language = DEFAULT_LANGUAGE;
let state: Snapshot | null = null;
let models: ModelCatalog | null = null;
let smartPreview: SmartLaunchPreview | null = null;
let handoverProjectDir = '';
// Only the latest session request may fill the list; slower earlier answers are dropped.
let sessionRequest = 0;
const selectedAccount = new Map<ProviderId, string>();
let toastTimer: number | undefined;
let settingsMessageTimer: number | undefined;

const t = (key: MessageKey, params?: Params): string => translate(language, key, params);
const format = (): FormatContext => ({ t, locale: language, now: Date.now() });
const accountName = (account: Account): string => account.label ?? t(account.labelKey ?? 'defaultAccount');
const providerLabel = (id: ProviderId): string => `${providerById(id).glyph} ${providerById(id).name}`;
const toolLabel = (id: ProviderId, model: string | null): string => (model ? `${providerById(id).name} · ${model}` : providerById(id).name);
const describe = (code: string, params?: Params): string => describeCode(code, t, params);

// The snapshot every view renders; views open only after the first one arrived.
function current(): Snapshot {
  if (!state) throw new Error('no snapshot yet');
  return state;
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function option(value: string, text: string): HTMLOptionElement {
  const node = element('option', '', text);
  node.value = value;
  return node;
}

function fillSelect(select: HTMLSelectElement, entries: readonly (readonly [string, string])[], value?: string): void {
  select.replaceChildren(...entries.map(([key, text]) => option(key, text)));
  if (value !== undefined && entries.some(([key]) => key === value)) select.value = value;
}

function toast(message: string): void {
  ui.toast.textContent = message;
  ui.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    ui.toast.hidden = true;
  }, TOAST_MS);
}

function showSettingsMessage(message: string): void {
  ui.settingsMessage.textContent = message;
  clearTimeout(settingsMessageTimer);
  settingsMessageTimer = window.setTimeout(() => {
    ui.settingsMessage.textContent = '';
  }, SETTINGS_MESSAGE_MS);
}

// Errors from the main process carry the code and params of its error envelope.
const isCodedError = (error: unknown): error is { code: string; params?: Params } =>
  error instanceof Error && 'code' in error && typeof error.code === 'string';

// Runs a user action; a failure is shown as a toast with the error's message.
async function action(task: () => Promise<unknown>): Promise<void> {
  try {
    await task();
  } catch (error) {
    toast(isCodedError(error) ? describe(error.code, error.params) : describe('unexpected'));
  }
}

const onClick = (button: HTMLElement, task: () => Promise<unknown>): void => {
  button.addEventListener('click', () => void action(task));
};
const onChange = (control: HTMLElement, task: () => Promise<unknown>): void => {
  control.addEventListener('change', () => void action(task));
};

function applyStaticText(): void {
  for (const node of document.querySelectorAll<HTMLElement>('[data-i18n]')) node.textContent = staticText(node.dataset.i18n);
  for (const node of document.querySelectorAll<HTMLElement>('[data-i18n-title]')) node.title = staticText(node.dataset.i18nTitle);
  for (const node of document.querySelectorAll<HTMLElement>('[data-i18n-aria]'))
    node.setAttribute('aria-label', staticText(node.dataset.i18nAria));
}

// Keys written in index.html; an unknown one renders as itself so the UI check catches it.
const staticText = (key = ''): string => (hasKey(key) ? t(key) : key);

async function getModels(): Promise<ModelCatalog> {
  models ??= await vibe.getModels();
  return models;
}

// ---------------------------------------------------------------- quota cards

function quotaCell(window: QuotaWindow, fullWidth: boolean): HTMLElement {
  const view = describeWindow(window, format());
  const low = view.percent !== null && view.percent <= LOW_QUOTA_PERCENT;
  const cell = element('div', ['quota', low ? 'low' : '', fullWidth ? 'span-full' : ''].filter(Boolean).join(' '));
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

function quotaGrid(windows: readonly QuotaWindow[]): HTMLElement {
  const grid = element('div', 'quota-grid');
  grid.append(...windows.map(window => quotaCell(window, windows.length === 1)));
  return grid;
}

interface WindowGroups {
  general: QuotaWindow[];
  scopes: Map<string, QuotaWindow[]>;
  details: QuotaWindow[];
}

function groupWindows(windows: readonly QuotaWindow[]): WindowGroups {
  const groups: WindowGroups = { general: [], scopes: new Map(), details: [] };
  for (const window of windows) {
    if (window.section === DETAILS_SECTION) groups.details.push(window);
    else if (window.scope) groups.scopes.set(window.scope, [...(groups.scopes.get(window.scope) ?? []), window]);
    else groups.general.push(window);
  }
  return groups;
}

const statusMessage = (entity: { messageCode?: string } | undefined): string => (entity?.messageCode ? describe(entity.messageCode) : '');

function signInButton(provider: Provider, status?: AccountStatus): HTMLButtonElement {
  const label = status === 'app_closed' ? t('launchAppBtn') : t('loginProviderBtn', { name: provider.name });
  const button = element('button', 'launch-button', label);
  onClick(button, async () => {
    await vibe.signIn(provider.id);
    toast(t('signInOpened', { tool: provider.name }));
  });
  return button;
}

function cardHeader(provider: Provider, accounts: readonly MeasuredAccount[], shown: MeasuredAccount | undefined): HTMLElement {
  const heading = element('div', 'provider-heading');
  const brand = element('div', 'provider-brand');
  brand.append(element('span', 'brand-avatar', provider.glyph), element('h2', '', provider.name));
  const meta = element('div', 'provider-header-meta');
  if (shown?.plan) meta.append(element('span', 'plan-pill', shown.plan.toUpperCase()));
  if (accounts.length > 1) {
    const picker = element('select', 'account-picker');
    picker.setAttribute('aria-label', `${provider.name} ${t('accountLabelPlaceholder')}`);
    fillSelect(
      picker,
      accounts.map(a => [a.id, `${a.primary ? '★ ' : ''}${accountName(a)}`] as const),
      shown?.id
    );
    picker.addEventListener('change', () => {
      selectedAccount.set(provider.id, picker.value);
      render(current());
    });
    meta.append(picker);
  } else if (shown && shown.labelKey !== 'defaultAccount') {
    meta.append(element('span', 'account-pill', accountName(shown)));
  }
  heading.append(brand, meta);
  return heading;
}

function accountBody(provider: Provider, shown: MeasuredAccount): HTMLElement[] {
  const nodes: HTMLElement[] = [];
  const groups = groupWindows(shown.windows);
  // Account-wide limits first; per-model scopes follow under their own headings.
  if (groups.general.length) nodes.push(quotaGrid(groups.general));
  for (const [scope, scoped] of groups.scopes) nodes.push(element('div', 'scope-title', scope), quotaGrid(scoped));
  if (groups.details.length) {
    const details = element('details', 'spending');
    details.append(element('summary', '', t('spendingDetails')), ...groups.details.map(w => quotaCell(w, true)));
    nodes.push(details);
  }
  const message = statusMessage(shown) || (shown.windows.length ? '' : t('noDataYet'));
  if (message) nodes.push(element('div', 'empty', message));
  if (provider.id === 'claude' && shown.configDir && shown.status === 'ok') {
    const launch = element('button', 'launch-button', t('launchClaudeBtn'));
    onClick(launch, async () => {
      const result = await vibe.launchClaude(shown.id);
      if (result.status === 'launched') toast(t('launchedTerminal', { tool: provider.name }));
    });
    nodes.push(launch);
  }
  if (SIGN_IN_STATUSES.has(shown.status) || !shown.windows.length) nodes.push(signInButton(provider, shown.status));
  return nodes;
}

function providerCard(state: ProviderState): HTMLElement {
  const provider = providerById(state.id);
  const section = element('section', 'provider');
  section.dataset.provider = provider.id;
  const { accounts } = state;
  const shown = accounts.find(a => a.id === selectedAccount.get(provider.id)) ?? accounts.find(a => a.primary) ?? accounts[0];
  section.append(cardHeader(provider, accounts, shown));
  if (shown) section.append(...accountBody(provider, shown));
  else section.append(element('div', 'empty', statusMessage(state) || t('status_no_accounts')), signInButton(provider));

  const status = shown?.status ?? state.status;
  const footer = element('div', `provider-status${status === 'stale' ? ' stale' : ''}`);
  const statusKey = STATUS_TEXT[status];
  footer.append(
    element('span', '', formatFreshness(shown ? shown.fetchedAt : state.fetchedAt, status, format())),
    element('span', '', statusKey ? t(statusKey) : '')
  );
  section.append(footer);
  return section;
}

function render(snapshot: Snapshot): void {
  state = snapshot;
  language = isLanguage(snapshot.settings.language) ? snapshot.settings.language : DEFAULT_LANGUAGE;
  document.documentElement.lang = language;
  applyStaticText();

  const order = normalizeProviderOrder(snapshot.settings.providerOrder);
  const providers = [...snapshot.providers].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  // Rebuilding the cards would collapse expanded detail sections; keep them open.
  const open = new Set(
    [...document.querySelectorAll<HTMLDetailsElement>('.provider details.spending[open]')].map(
      details => details.closest<HTMLElement>('.provider')?.dataset.provider
    )
  );
  ui.providers.replaceChildren(...providers.map(providerCard));
  for (const card of ui.providers.querySelectorAll<HTMLElement>('.provider')) {
    const details = card.querySelector('details.spending');
    if (details instanceof HTMLDetailsElement && open.has(card.dataset.provider)) details.open = true;
  }
  ui.overallStatus.textContent = snapshot.refreshing ? t('readingQuotas') : t('servicesOnDevice', { n: snapshot.providers.length });
  ui.refresh.disabled = snapshot.refreshing;
  ui.pin.setAttribute('aria-pressed', String(snapshot.settings.pinned));
  ui.refreshLabel.textContent = t('autoRefresh', { time: formatDuration(snapshot.settings.intervalSeconds * 1000, language) });
  ui.platformLabel.textContent = t(vibe.platform === 'darwin' ? 'menuBar' : 'systemTray');
}

// ------------------------------------------------------------------- settings

const saveSettings = async (patch: Partial<Snapshot['settings']>): Promise<void> => {
  render(await vibe.saveSettings(patch));
};

function renderProviderOrder(): void {
  const order = normalizeProviderOrder(current().settings.providerOrder);
  ui.providerOrder.replaceChildren(
    ...order.map((providerId, slot) => {
      const row = element('div', 'fallback-slot');
      const select = element('select');
      select.id = `provider-slot-${slot}`;
      fillSelect(
        select,
        PROVIDER_IDS.map(id => [id, providerLabel(id)] as const),
        providerId
      );
      select.setAttribute('aria-label', t('slotLabel', { n: slot + 1 }));
      const label = element('label');
      label.htmlFor = select.id;
      label.append(element('span', 'fallback-slot-badge', String(slot + 1)));
      // Choosing a provider for a slot swaps it with the slot that held it.
      onChange(select, async () => {
        const chosen = order.find(id => id === select.value);
        if (!chosen) return;
        const next = [...order];
        next[order.indexOf(chosen)] = providerId;
        next[slot] = chosen;
        await saveSettings({ providerOrder: next });
        renderProviderOrder();
      });
      row.append(label, select);
      return row;
    })
  );
}

async function renderPreferredModels(): Promise<void> {
  const available = await getModels();
  const { preferredModels } = current().settings;
  ui.preferredModels.replaceChildren(
    ...PROVIDERS.filter(p => p.acceptsModel).map(provider => {
      const row = element('div', 'model-dropdown-row');
      row.dataset.provider = provider.id;
      const select = element('select', 'model-select');
      select.id = `preferred-${provider.id}`;
      fillSelect(select, [['', t('toolDefault')], ...available[provider.id].map(m => [m, m] as const)], preferredModels[provider.id] ?? '');
      onChange(select, async () => {
        const { [provider.id]: _previous, ...others } = current().settings.preferredModels;
        await saveSettings({ preferredModels: select.value ? { ...others, [provider.id]: select.value } : others });
      });
      const label = element('label');
      label.htmlFor = select.id;
      label.append(element('span', 'badge-icon-mini provider-color', provider.glyph), ` ${provider.name}`);
      row.append(label, select);
      return row;
    })
  );
}

function accountRow(provider: Provider, account: Account): HTMLElement {
  const item = element('div', 'account-item');
  const top = element('div', 'account-item-top');
  const radioLabel = element('label', 'account-radio-label');
  const radio = element('input');
  radio.type = 'radio';
  radio.name = `primary-${provider.id}`;
  radio.checked = account.primary;
  onChange(radio, async () => {
    await saveSettings({
      accounts: current().settings.accounts.map(a => (a.providerId === provider.id ? { ...a, primary: a.id === account.id } : a))
    });
    await renderSettings();
  });
  radioLabel.append(
    radio,
    element('span', 'account-mini-icon provider-color', provider.glyph),
    element('span', `primary-text${account.primary ? ' is-primary' : ''}`, t(account.primary ? 'primaryAccount' : 'secondaryAccount'))
  );
  const remove = element('button', 'remove-account', t('removeAccount'));
  remove.setAttribute('aria-label', `${accountName(account)} ${t('removeAccount')}`);
  onClick(remove, async () => {
    if (!confirm(t('confirmRemoveAccount', { label: accountName(account) }))) return;
    render(await vibe.dismissAccount(account.id));
    await renderSettings();
  });
  top.append(radioLabel, remove);

  const input = element('input', 'account-label-input');
  input.type = 'text';
  input.value = account.label ?? '';
  input.placeholder = account.labelKey ? t(account.labelKey) : t('accountLabelPlaceholder');
  input.maxLength = 64;
  input.setAttribute('aria-label', `${provider.name} ${t('accountLabelPlaceholder')}`);
  // Clearing a custom name restores the app-supplied one when there is one.
  onChange(input, async () => {
    const label = input.value.trim();
    await saveSettings({
      accounts: current().settings.accounts.map(a => {
        if (a.id !== account.id) return a;
        const { label: _old, ...rest } = a;
        return label ? { ...rest, label } : rest;
      })
    });
  });
  const inputWrap = element('div', 'account-item-input-wrap');
  inputWrap.append(input);
  item.append(top, inputWrap);
  return item;
}

function renderAccounts(): void {
  const { accounts, dismissedAccountIds } = current().settings;
  const cards = PROVIDERS.filter(p => accounts.some(a => a.providerId === p.id)).map(provider => {
    const owned = accounts.filter(a => a.providerId === provider.id);
    const card = element('div', 'provider-settings-card');
    card.dataset.provider = provider.id;
    const header = element('div', 'provider-card-header');
    const brand = element('div', 'provider-brand-inline');
    brand.append(element('span', 'brand-avatar-badge', provider.glyph), element('strong', 'provider-name-text', provider.name));
    header.append(brand, element('span', 'provider-account-count', t('accountCount', { n: owned.length })));
    const rows = element('div', 'provider-accounts-list');
    rows.append(...owned.map(account => accountRow(provider, account)));
    card.append(header, rows);
    return card;
  });
  ui.accountSettings.replaceChildren(...cards);
  if (dismissedAccountIds.length) {
    const restore = element('button', 'secondary-button gap-top-md', t('restoreAccountsBtn', { n: dismissedAccountIds.length }));
    onClick(restore, async () => {
      render(await vibe.restoreDismissedAccounts());
      await renderSettings();
    });
    ui.accountSettings.append(restore);
  }
}

async function renderSettings(): Promise<void> {
  const { settings } = current();
  fillSelect(
    ui.language,
    SUPPORTED_LANGUAGES.map(code => [code, LOCALES[code].name] as const),
    settings.language
  );
  const minutes = new Intl.DurationFormat(language, { style: 'long' });
  fillSelect(
    ui.interval,
    INTERVAL_CHOICES_SECONDS.map(s => [String(s), minutes.format({ minutes: s / 60 })] as const),
    String(settings.intervalSeconds)
  );
  renderProviderOrder();
  renderAccounts();
  await renderPreferredModels();
}

onClick(ui.settingsButton, async () => {
  ui.settingsMessage.textContent = '';
  await renderSettings();
  ui.settingsDialog.showModal();
});
onChange(ui.language, async () => {
  if (!isLanguage(ui.language.value)) return;
  await saveSettings({ language: ui.language.value });
  await renderSettings();
});
onChange(ui.interval, () => saveSettings({ intervalSeconds: Number(ui.interval.value) }));
onClick(ui.addProfile, async () => {
  const { status } = await vibe.addClaudeProfile();
  const message = PROFILE_MESSAGES[status];
  if (message) showSettingsMessage(t(message));
  await renderSettings();
});

// ------------------------------------------------------------------- handover

function sessionLabel(session: SessionSummary, showProvider: boolean): string {
  const size = new Intl.NumberFormat(language, { style: 'unit', unit: 'megabyte', maximumFractionDigits: 1 });
  const parts = [
    formatAge(session.updatedAt, format()),
    session.turnCount ? t('turnsCount', { n: session.turnCount }) : '',
    session.model,
    session.sizeBytes ? size.format(session.sizeBytes / BYTES_PER_MEGABYTE) : ''
  ].filter(Boolean);
  const title = session.title || t('untitledSession', { id: session.id.slice(0, SHORT_ID_LENGTH) });
  return `${showProvider ? `${providerLabel(session.providerId)} · ` : ''}${title} (${parts.join(' · ')})`;
}

const selectedProvider = (select: HTMLSelectElement): ProviderId | undefined => PROVIDER_IDS.find(id => id === select.value);

async function refreshHandoverSessions(): Promise<void> {
  const request = ++sessionRequest;
  const fromProvider = selectedProvider(ui.handoverFrom) ?? AUTO;
  ui.handoverSession.replaceChildren(option(AUTO, t('mostRecentSession')));
  if (!handoverProjectDir) return;
  const sessions = await vibe.listSessions({ providerId: fromProvider, projectDir: handoverProjectDir });
  if (request !== sessionRequest) return;
  if (!sessions.length) {
    const empty = option('', t('noSessionsFound'));
    empty.disabled = true;
    ui.handoverSession.append(empty);
    return;
  }
  ui.handoverSession.append(
    ...sessions.map(session => {
      const node = option(session.id, sessionLabel(session, fromProvider === AUTO));
      node.dataset.provider = session.providerId;
      return node;
    })
  );
}

async function refreshHandoverModels(): Promise<void> {
  const target = selectedProvider(ui.handoverTo);
  const accepts = target !== undefined && providerById(target).acceptsModel;
  ui.handoverModelField.hidden = !accepts;
  if (!target || !accepts) return;
  const available = (await getModels())[target];
  fillSelect(
    ui.handoverModel,
    [['', t('toolDefault')], ...available.map(m => [m, m] as const)],
    current().settings.preferredModels[target] ?? ''
  );
}

// A task is handed to a different tool: never offer the source as the target.
function syncHandoverTarget(): void {
  const from = ui.handoverFrom.value;
  if (ui.handoverTo.value === from) ui.handoverTo.value = PROVIDER_IDS.find(id => id !== from) ?? '';
}

function setHandoverProject(dir: string): void {
  handoverProjectDir = dir;
  ui.handoverProject.value = dir;
}

onClick(ui.handoverButton, async () => {
  if (!handoverProjectDir) setHandoverProject(await vibe.defaultProjectDir());
  fillSelect(ui.handoverFrom, [[AUTO, t('autoDetectSession')], ...PROVIDER_IDS.map(id => [id, providerLabel(id)] as const)], AUTO);
  fillSelect(
    ui.handoverTo,
    PROVIDER_IDS.map(id => [id, providerLabel(id)] as const),
    normalizeProviderOrder(current().settings.providerOrder)[0]
  );
  await refreshHandoverModels();
  await refreshHandoverSessions();
  ui.handoverDialog.showModal();
});
onClick(ui.handoverBrowse, async () => {
  const dir = await vibe.selectDirectory({ defaultPath: handoverProjectDir });
  if (!dir) return;
  setHandoverProject(dir);
  await refreshHandoverSessions();
});
onChange(ui.handoverFrom, async () => {
  syncHandoverTarget();
  await refreshHandoverModels();
  await refreshHandoverSessions();
});
onChange(ui.handoverTo, refreshHandoverModels);
ui.handoverCancel.addEventListener('click', () => {
  ui.handoverDialog.close();
});
onClick(ui.handoverExecute, async () => {
  const session = ui.handoverSession.selectedOptions[0];
  const sessionId = session?.value || AUTO;
  const sessionProvider = PROVIDER_IDS.find(id => id === session?.dataset.provider);
  const targetModel = ui.handoverModelField.hidden ? '' : ui.handoverModel.value;
  ui.handoverDialog.close();
  const result = await vibe.executeHandover({
    projectDir: handoverProjectDir,
    fromProvider: selectedProvider(ui.handoverFrom) ?? AUTO,
    toProvider: selectedProvider(ui.handoverTo) ?? AUTO,
    sessionId,
    ...(targetModel ? { targetModel } : {}),
    ...(sessionId !== AUTO && sessionProvider ? { sessionProvider } : {})
  });
  toast(t(result.mode === 'app' ? 'handoverApp' : 'handoverTerminal', { tool: toolLabel(result.to, result.model) }));
});

// --------------------------------------------------------------- smart launch

function smartReason(preview: SmartLaunchPreview): string {
  if (!preview.verified) return t('reasonUnverified');
  return t(preview.isFallback ? 'reasonFallback' : 'reasonPrimary');
}

onClick(ui.smartButton, async () => {
  const preview = await vibe.previewSmartLaunch();
  smartPreview = preview;
  ui.smartProvider.textContent = providerById(preview.providerId).name;
  ui.smartQuota.textContent =
    preview.headroomPercent === null
      ? t('quotaUnverified')
      : t('percentRemaining', { n: formatPercent(preview.headroomPercent, language) });
  ui.smartModel.textContent = preview.model ?? t('toolDefault');
  ui.smartReason.textContent = smartReason(preview);
  ui.smartDialog.showModal();
});
ui.smartCancel.addEventListener('click', () => {
  ui.smartDialog.close();
});
onClick(ui.smartConfirm, async () => {
  ui.smartDialog.close();
  const model = smartPreview?.model;
  const result = await vibe.smartLaunch(model ? { targetModel: model } : {});
  if (result.status === 'launched')
    toast(t(result.mode === 'app' ? 'launchedApp' : 'launchedTerminal', { tool: toolLabel(result.to, result.model) }));
});

// ------------------------------------------------------------------- titlebar

onClick(ui.refresh, () => vibe.refresh());
onClick(ui.pin, () => vibe.pin());
onClick(ui.hide, () => vibe.hide());

applyStaticText();
vibe.onSnapshot(render);
window.setInterval(() => {
  if (state && !document.hidden) render(state);
}, CLOCK_TICK_MS);
void action(async () => {
  render(await vibe.snapshot());
});
