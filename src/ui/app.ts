import {
  AUTO,
  AUTO_CONTINUE,
  AUTOMATION_MODES,
  displayOrder,
  DURATION_MS,
  INHERIT,
  isProfileProvider,
  LOW_QUOTA_RANGE,
  normalizeProviderOrder,
  PROVIDER_IDS,
  providerById,
  PROVIDERS,
  REFRESH_INTERVAL_SECONDS,
  type ProfileProviderId,
  type Provider,
  type ProviderId,
  visibleProviders,
  WORK_PROVIDER_IDS
} from '../shared/catalog.ts';
import { compactLines, isLowQuota, needsSignIn, type CompactLine, type CompactNote, type KnownWindow } from '../shared/account-state.ts';
import {
  describeCode,
  describeWindow,
  formatAccountName,
  formatAge,
  formatDuration,
  formatFreshness,
  formatPercent,
  gridTimes,
  hasOwnName,
  LAUNCH_MESSAGES,
  SUGGESTION_BUTTONS,
  successorName,
  toolLabel,
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
import { createPreviewState } from '../shared/preview-state.ts';
import type {
  ContinueOutcome,
  HandoverPreview,
  HandoverRequest,
  ModelCatalog,
  SessionSummary,
  SettingsPatch,
  SmartLaunchPreview,
  VibeApi
} from '../shared/ipc.ts';
import type {
  Account,
  AutoContinue,
  AutomationMode,
  Diagnostics,
  MeasuredAccount,
  ProjectPreference,
  ProviderState,
  ProviderStatus,
  QuotaWindow,
  SettingsNotice,
  AccountTokens,
  ServiceIssue,
  Snapshot,
  Suggestion,
  TokenTotals,
  TransitionRecord,
  UpdateInfo,
  UpdateInstall,
  UpdateUnsupportedReason
} from '../shared/types.ts';

declare global {
  interface Window {
    readonly vibe: VibeApi;
  }
}

const TOAST_MS = 5000;
const SETTINGS_MESSAGE_MS = 4000;
// Countdowns and ages are relative to now; re-render this often between snapshots.
const CLOCK_TICK_MS = 30 * 1000;
const BYTES_PER_MEGABYTE = 1024 * 1024;
const SHORT_ID_LENGTH = 8;
const SERVICE_STATUS_TEXT = {
  degraded_performance: 'serviceDegraded',
  partial_outage: 'servicePartial',
  major_outage: 'serviceMajor'
} as const satisfies Record<ServiceIssue['status'], MessageKey>;

const STATUS_TEXT: Partial<Record<ProviderStatus, MessageKey>> = {
  pending: 'reading',
  ok: 'live',
  stale: 'refreshFailed',
  auth_missing: 'noSession'
};
const DETAILS_SECTION = 'details';
// The folded sections of a provider card, by class; an open one stays open across renders.
const CARD_SECTIONS = { spending: 'spending', history: 'history', tokens: 'tokens' } as const;
// What a toast says once a tool started, by how it started.
// Room below the last row of the compact view.
const COMPACT_BOTTOM_PADDING = 12;
const AUTO_CONTINUE_LABELS: Readonly<Record<AutoContinue, MessageKey>> = {
  off: 'autoContinueOff',
  accounts: 'autoContinueAccounts',
  tools: 'autoContinueTools'
};
const RETURN_TO_PRIMARY_LABELS: Readonly<Record<AutomationMode, MessageKey>> = {
  off: 'returnToPrimaryOff',
  ask: 'returnToPrimaryAsk',
  auto: 'returnToPrimaryAuto'
};
const REOPEN_AFTER_RESTART_LABELS: Readonly<Record<AutomationMode, MessageKey>> = {
  off: 'reopenAfterRestartOff',
  ask: 'reopenAfterRestartAsk',
  auto: 'reopenAfterRestartAuto'
};
const DEFAULT_QUIET_HOURS = { start: '22:00', end: '07:00' };
const PROJECT_AUTO_CONTINUE: readonly (readonly [ProjectPreference['autoContinue'], MessageKey])[] = [
  [INHERIT, 'projectAutoInherit'],
  ...AUTO_CONTINUE.map(value => [value, AUTO_CONTINUE_LABELS[value]] as const)
];
const UNSUPPORTED_UPDATE: Readonly<Record<UpdateUnsupportedReason, MessageKey>> = {
  unpackaged: 'updateUnsupportedUnpackaged',
  portable: 'updateUnsupportedPortable',
  unsigned: 'updateUnsupportedUnsigned',
  platform: 'updateUnsupportedPlatform'
};
const NOTICE_TEXT: Readonly<Record<SettingsNotice, MessageKey>> = {
  recovered: 'settingsNoticeRecovered',
  unrecoverable: 'settingsNoticeUnrecoverable',
  future: 'settingsNoticeFuture'
};
const TRANSITION_STATUS: Readonly<Record<TransitionRecord['status'], MessageKey>> = {
  offered: 'transitionOffered',
  dispatching: 'transitionDispatching',
  dispatched: 'transitionDispatched',
  failed: 'transitionFailed',
  interrupted: 'transitionInterrupted',
  dismissed: 'transitionDismissed'
};

const { vibe } = window;

// The element for `selector`; a missing or differently typed element is a bug in index.html.
function $<T extends Element>(selector: string, type: abstract new () => T): T {
  const node = document.querySelector(selector);
  if (!(node instanceof type)) throw new Error(`${selector} is not a ${type.name}`);
  return node;
}

// The elements for `selector` that are of `type`, under `root`.
const $$ = <T extends Element>(selector: string, type: abstract new () => T, root: ParentNode = document): T[] =>
  [...root.querySelectorAll(selector)].filter((node): node is T => node instanceof type);

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
  openAtLoginRow: $('#open-at-login-row', HTMLElement),
  openAtLogin: $('#open-at-login', HTMLInputElement),
  notifications: $('#notifications', HTMLInputElement),
  notificationsLabel: $('#notifications-label', HTMLElement),
  compareAccounts: $('#compare-accounts', HTMLInputElement),
  checkUpdates: $('#check-updates', HTMLInputElement),
  checkServiceStatus: $('#check-service-status', HTMLInputElement),
  lowQuota: $('#low-quota', HTMLSelectElement),
  quietHours: $('#quiet-hours', HTMLInputElement),
  quietHoursTimes: $('#quiet-hours-times', HTMLElement),
  quietStart: $('#quiet-start', HTMLInputElement),
  quietEnd: $('#quiet-end', HTMLInputElement),
  projectPreferences: $('#project-preferences', HTMLElement),
  addProject: $('#add-project', HTMLButtonElement),
  transitionsButton: $('#transitions-button', HTMLButtonElement),
  transitionsDialog: $('#transitions-dialog', HTMLDialogElement),
  transitionsList: $('#transitions-list', HTMLElement),
  diagnosticsButton: $('#diagnostics-button', HTMLButtonElement),
  diagnosticsDialog: $('#diagnostics-dialog', HTMLDialogElement),
  diagnosticsList: $('#diagnostics-list', HTMLElement),
  diagnosticsCopy: $('#diagnostics-copy', HTMLButtonElement),
  diagnosticsExport: $('#diagnostics-export', HTMLButtonElement),
  exportSettings: $('#export-settings', HTMLButtonElement),
  importSettings: $('#import-settings', HTMLButtonElement),
  resetSettings: $('#reset-settings', HTMLButtonElement),
  settingsNotice: $('#settings-notice', HTMLElement),
  settingsNoticeText: $('#settings-notice-text', HTMLElement),
  settingsNoticeAction: $('#settings-notice-action', HTMLButtonElement),
  autoContinue: $('#auto-continue', HTMLElement),
  returnToPrimary: $('#return-to-primary', HTMLElement),
  reopenAfterRestart: $('#reopen-after-restart', HTMLElement),
  compactButton: $('#compact-button', HTMLButtonElement),
  suggestions: $('#suggestions', HTMLElement),
  updateBanner: $('#update-banner', HTMLElement),
  updateText: $('#update-text', HTMLElement),
  updateOpen: $('#update-open', HTMLButtonElement),
  updateInstall: $('#update-install', HTMLButtonElement),
  updateDismiss: $('#update-dismiss', HTMLButtonElement),
  updateNote: $('#update-note', HTMLElement),
  homeOrder: $('#home-order', HTMLElement),
  interval: $('#interval', HTMLSelectElement),
  providerOrder: $('#provider-order', HTMLElement),
  preferredModels: $('#preferred-models', HTMLElement),
  accountSettings: $('#account-settings', HTMLElement),
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
  handoverPreviewButton: $('#handover-preview-btn', HTMLButtonElement),
  handoverPreviewBox: $('#handover-preview-box', HTMLElement),
  handoverPreviewSummary: $('#handover-preview-summary', HTMLElement),
  handoverPreview: $('#handover-preview', HTMLElement),
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
let handoverProjectDir = '';
// What the user last previewed; execution hands over exactly that, and any change clears it.
const handoverPreview = createPreviewState<HandoverRequest, HandoverPreview>(request => JSON.stringify(request));
const handoverSources = new Map<string, SessionSummary>();
// Only the latest session request may fill the list; slower earlier answers are dropped.
let sessionRequest = 0;
let modelRequest = 0;
const selectedAccount = new Map<ProviderId, string>();
// The last history read, so a rebuilt card draws its charts at once and then updates them.
let history: Awaited<ReturnType<VibeApi['history']>> | null = null;
// The last token read, so an opened card shows it at once and then updates it.
let tokenUsage: Awaited<ReturnType<VibeApi['tokenUsage']>> | null = null;
// Cards left as they are while the user works a control in them (see renderCards).
let cardsStale = false;
let toastTimer: number | undefined;
let settingsMessageTimer: number | undefined;

const t = (key: MessageKey, params?: Params): string => translate(language, key, params);
const format = (): FormatContext => ({ t, locale: language, now: Date.now() });
const accountName = (account: Account): string => formatAccountName(account, t);
const providerLabel = (id: ProviderId): string => `${providerById(id).glyph} ${providerById(id).name}`;
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

// A refresh interval to the second (90 s is not "2m"), in the window's language.
const formatInterval = (seconds: number, style: 'long' | 'narrow'): string =>
  new Intl.DurationFormat(language, { style }).format({ minutes: Math.floor(seconds / 60), seconds: seconds % 60 });

// The offered choices with the saved value among them, in order: one set in an imported file
// shows as itself rather than as another choice.
const withSaved = (choices: readonly number[], saved: number): number[] => [...new Set([...choices, saved])].sort((a, b) => a - b);

// A tool's model choices: its default, the models it offers, and the saved one when the tool no
// longer lists it (it shows as itself, and stays chosen, rather than as the default).
const modelChoices = (available: readonly string[], saved: string | undefined): (readonly [string, string])[] => [
  ['', t('toolDefault')],
  ...[...available, ...(saved && !available.includes(saved) ? [saved] : [])].map(m => [m, m] as const)
];

function fillSelect(select: HTMLSelectElement, entries: readonly (readonly [string, string])[], value?: string): void {
  select.replaceChildren(...entries.map(([key, text]) => option(key, text)));
  if (value !== undefined && entries.some(([key]) => key === value)) select.value = value;
}

// A toast is a popover: shown again each time, it goes on top of the top layer, above an open
// dialog and its backdrop, which would otherwise cover it.
function toast(message: string): void {
  ui.toast.textContent = message;
  if (ui.toast.matches(':popover-open')) ui.toast.hidePopover();
  ui.toast.showPopover();
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    ui.toast.hidePopover();
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

// Opens the dialog as soon as `render` has put in what it has at hand; what takes longer (models
// that may be fetched, sessions read from disk) fills in while the dialog is open, so a click
// never looks unanswered.
async function openDialog(dialog: HTMLDialogElement, render: () => Promise<void>): Promise<void> {
  const rendering = render();
  // The compact window is only as tall as its rows: it grows as far as it may for the dialog,
  // and fits its rows again once the dialog closes (see the dialogs' close listener).
  if (current().settings.compact) {
    compactHeight = 0;
    void action(() => vibe.fitHeight(window.screen.availHeight));
  }
  dialog.showModal();
  await rendering;
}

// What a list shows while its content is on the way.
const loadingNote = (tag: 'p' | 'li' = 'p'): HTMLElement => element(tag, 'help', t('reading'));

function applyStaticText(): void {
  for (const node of $$('[data-i18n]', HTMLElement)) node.textContent = staticText(node.dataset.i18n);
  for (const node of $$('[data-i18n-title]', HTMLElement)) node.title = staticText(node.dataset.i18nTitle);
  for (const node of $$('[data-i18n-aria]', HTMLElement)) node.setAttribute('aria-label', staticText(node.dataset.i18nAria));
}

// Keys written in index.html; an unknown one renders as itself so the UI check catches it.
const staticText = (key = ''): string => (hasKey(key) ? t(key) : key);

async function getModels(): Promise<ModelCatalog> {
  models ??= await vibe.getModels();
  return models;
}

// ---------------------------------------------------------------- quota cards

function quotaLine(label: string, value: string): HTMLElement {
  const line = element('div', 'quota-line');
  const name = element('span', 'quota-label', label);
  name.title = label;
  line.append(name, element('span', 'quota-value', value));
  return line;
}

// The bar of what is left, for the eye and for assistive technology.
function quotaBar(percent: number, label: string): HTMLElement {
  const track = element('div', 'track');
  const fill = element('div', 'fill');
  fill.style.setProperty('--quota', String(percent));
  track.append(fill);
  track.setAttribute('role', 'progressbar');
  track.setAttribute('aria-label', label);
  track.setAttribute('aria-valuenow', String(percent));
  track.setAttribute('aria-valuemin', '0');
  track.setAttribute('aria-valuemax', '100');
  return track;
}

// The spending limits, folded away under the account's quota.
function spendingDetails(rows: readonly HTMLElement[]): HTMLElement {
  const details = element('details', CARD_SECTIONS.spending);
  details.append(element('summary', '', t('spendingDetails')), ...rows);
  return details;
}

// `label` replaces the window's name, e.g. with the account's when accounts are compared.
function quotaCell(window: QuotaWindow, fullWidth: boolean, label?: string): HTMLElement {
  const view = describeWindow(window, format());
  const low = isLowQuota(view.percent, current().settings.lowQuotaPercent);
  const cell = element('div', ['quota', low ? 'low' : '', fullWidth ? 'span-full' : ''].filter(Boolean).join(' '));
  cell.append(quotaLine(label ?? view.label, view.value));
  if (view.percent !== null) cell.append(quotaBar(view.percent, view.label));
  // The countdown comes first so truncation never hides it; the full text is the tooltip.
  const description = [view.reset, view.detail].filter(Boolean).join(' · ');
  if (description) {
    const node = element('div', 'quota-description', description);
    node.title = [view.detail, view.resetAt].filter(Boolean).join('\n');
    cell.append(node);
  }
  const runsOutInMs = window.exhaustsAt ? Date.parse(window.exhaustsAt) - Date.now() : NaN;
  if (runsOutInMs > 0) cell.append(element('div', 'quota-forecast', t('forecastRunsOut', { time: formatDuration(runsOutInMs, language) })));
  return cell;
}

function quotaGrid(windows: readonly QuotaWindow[]): HTMLElement {
  const grid = element('div', 'quota-grid');
  grid.append(...windows.map(window => quotaCell(window, windows.length === 1)));
  return grid;
}

// The choices of a project preference that may be left unset.
type ProjectChoice = 'tool' | 'model' | 'accountId';

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

// What the toast says once work went on: the session itself, or a new one from a brief.
const continuedMessage = (result: ContinueOutcome, target: string): string =>
  result.resumed ? t('continuedResumed', { target }) : t(LAUNCH_MESSAGES[result.mode], { tool: target });

const statusMessage = (entity: { messageCode?: string } | undefined): string => (entity?.messageCode ? describe(entity.messageCode) : '');

// Opens the sign-in of the account's own profile; without an account, the tool's default one.
async function openSignIn(provider: Provider, account?: Account): Promise<void> {
  await vibe.signIn(provider.id, account?.id);
  toast(t('signInOpened', { tool: provider.name }));
}

function signInButton(
  provider: Provider,
  account?: MeasuredAccount,
  label = t('loginProviderBtn', { name: provider.name })
): HTMLButtonElement {
  const button = element('button', 'launch-button', account?.status === 'app_closed' ? t('launchAppBtn') : label);
  onClick(button, () => openSignIn(provider, account));
  return button;
}

// Claude Code in a terminal, signed in as `account`.
function launchButton(
  provider: Provider,
  account: MeasuredAccount,
  label = t('launchAccountBtn', { name: accountName(account) })
): HTMLButtonElement {
  const button = element('button', 'launch-button', label);
  button.title = `${t('launchClaudeBtn')}\n${accountName(account)}`;
  onClick(button, async () => {
    const result = await vibe.launchClaude(account.id);
    if (result.status === 'launched') toast(t('launchedTerminal', { tool: provider.name }));
  });
  return button;
}

const canLaunch = (provider: Provider, account: MeasuredAccount): boolean =>
  provider.id === 'claude' && Boolean(account.configDir) && account.status === 'ok';
const pickerName = (account: Account): string => `${account.primary ? '★ ' : ''}${accountName(account)}`;

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
      accounts.map(a => [a.id, pickerName(a)] as const),
      shown?.id
    );
    picker.addEventListener('change', () => {
      selectedAccount.set(provider.id, picker.value);
      // Chosen: the picker is done with, and the cards show the account picked.
      picker.blur();
      render(current());
    });
    meta.append(picker);
  } else if (shown && hasOwnName(shown)) {
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
  if (groups.details.length) nodes.push(spendingDetails(groups.details.map(w => quotaCell(w, true))));
  const message = statusMessage(shown) || (shown.windows.length ? '' : t('noDataYet'));
  if (message) nodes.push(element('div', 'empty', message));
  if (canLaunch(provider, shown)) nodes.push(launchButton(provider, shown));
  if (needsSignIn(shown)) nodes.push(signInButton(provider, shown));
  return nodes;
}

// One limit across accounts: its name, then a column per account.
function compareRow(sample: QuotaWindow, accounts: readonly MeasuredAccount[]): HTMLElement {
  const row = element('div', 'compare');
  const columns = element('div', 'compare-columns');
  columns.append(
    ...accounts.map(account => {
      const window = account.windows.find(w => w.id === sample.id);
      if (window) return quotaCell(window, false, pickerName(account));
      const cell = element('div', 'quota missing');
      cell.append(quotaLine(pickerName(account), t('noData')));
      return cell;
    })
  );
  row.append(element('div', 'compare-title', describeWindow(sample, format()).label), columns);
  return row;
}

// Each account's status and next step, under its own column.
function compareActions(provider: Provider, account: MeasuredAccount): HTMLElement {
  const column = element('div', 'compare-action');
  const name = accountName(account);
  const message = statusMessage(account);
  if (message) column.append(element('div', 'empty', message));
  if (canLaunch(provider, account)) {
    const launch = launchButton(provider, account, t('launchAccountBtn', { name }));
    column.append(launch);
  }
  if (needsSignIn(account)) column.append(signInButton(provider, account, t('signInAccountBtn', { name })));
  return column;
}

// Every limit any account reports, once, in the order the accounts report them. An account
// without any (signed out, not read yet) gets no column, only its status and next step.
function compareBody(provider: Provider, accounts: readonly MeasuredAccount[]): HTMLElement[] {
  const measured = accounts.filter(a => a.windows.length);
  const samples = new Map<string, QuotaWindow>();
  for (const window of measured.flatMap(a => a.windows)) if (!samples.has(window.id)) samples.set(window.id, window);
  const groups = groupWindows([...samples.values()]);
  const rows = (windows: readonly QuotaWindow[]): HTMLElement[] => windows.map(w => compareRow(w, measured));
  const nodes = rows(groups.general);
  for (const [scope, scoped] of groups.scopes) nodes.push(element('div', 'scope-title', scope), ...rows(scoped));
  if (groups.details.length) nodes.push(spendingDetails(rows(groups.details)));
  const actions = accounts.map(account => compareActions(provider, account));
  if (actions.some(column => column.childElementCount)) {
    const row = element('div', 'compare-columns compare-actions');
    row.append(...actions);
    nodes.push(row);
  }
  return nodes;
}

// ------------------------------------------------------------------- history

// The two charts of the history section: the grid falls every `stepHours` of the local clock, and
// its labels name the weekday in the middle of a day or the hour at each mark.
interface HistorySpan {
  durationMs: number;
  stepHours: number;
  title: MessageKey;
  // How a grid mark is named, and whether the name sits between two marks (a day) or on one.
  markFormat: Intl.DateTimeFormatOptions;
  nameBetween: boolean;
}
const HISTORY_SPANS: readonly HistorySpan[] = [
  { durationMs: 7 * DURATION_MS.DAY, stepHours: 24, title: 'historyTitle', markFormat: { weekday: 'short' }, nameBetween: true },
  { durationMs: DURATION_MS.DAY, stepHours: 4, title: 'historyDayTitle', markFormat: { hour: 'numeric' }, nameBetween: false }
];
// Readings further apart than this mean the app was not running: the line breaks there.
const HISTORY_GAP_MS = 3 * DURATION_MS.HOUR;
// Categorical slots 1–3 stepped for the dark surface, validated (CVD and contrast) against it.
const SERIES_COLORS = ['#3987e5', '#d95926', '#199e70'];
const CHART = { width: 320, height: 120, left: 30, right: 34, top: 8, bottom: 18 };
const LABEL_MIN_GAP = 10;
const SVG_NS = 'http://www.w3.org/2000/svg';

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attributes: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value));
  return node;
}

interface ChartSeries {
  label: string;
  color: string;
  samples: readonly (readonly [number, number])[];
}

// Used percent of each limit over the last week: one line per limit, the latest value written
// at its end, and a crosshair that reads every line at the pointer.
function historyChart(series: readonly ChartSeries[], now: number, span: HistorySpan): HTMLElement {
  const start = now - span.durationMs;
  const plotWidth = CHART.width - CHART.left - CHART.right;
  const plotHeight = CHART.height - CHART.top - CHART.bottom;
  const x = (time: number): number => CHART.left + ((time - start) / (now - start)) * plotWidth;
  const y = (percent: number): number => CHART.top + (1 - percent / 100) * plotHeight;
  const figure = element('figure', 'history-chart');
  const chart = svg('svg', { viewBox: `0 0 ${CHART.width} ${CHART.height}`, role: 'img' });
  chart.setAttribute('aria-label', series.map(s => `${s.label}: ${formatPercent(s.samples.at(-1)?.[1] ?? 0, language)}`).join(', '));
  for (const percent of [0, 50, 100]) {
    chart.append(svg('line', { class: 'grid', x1: CHART.left, x2: CHART.width - CHART.right, y1: y(percent), y2: y(percent) }));
    const label = svg('text', { class: 'axis', x: CHART.left - 4, y: y(percent) + 3, 'text-anchor': 'end' });
    label.textContent = formatPercent(percent, language);
    chart.append(label);
  }
  const markFormat = new Intl.DateTimeFormat(language, span.markFormat);
  const stepMs = span.stepHours * DURATION_MS.HOUR;
  for (const mark of gridTimes(start, now, span.stepHours)) {
    const labelAt = span.nameBetween ? mark + stepMs / 2 : mark;
    const label = svg('text', { class: 'axis', x: x(labelAt), y: CHART.height - 4, 'text-anchor': 'middle' });
    if (labelAt < now) label.textContent = markFormat.format(labelAt);
    chart.append(svg('line', { class: 'grid day', x1: x(mark), x2: x(mark), y1: CHART.top, y2: CHART.top + plotHeight }), label);
  }
  const ends: { y: number; text: string }[] = [];
  for (const { color, samples } of series) {
    const visible = samples.filter(([time]) => time >= start);
    const d = visible.map(
      ([time, used], i) => `${i && time - (visible[i - 1]?.[0] ?? time) <= HISTORY_GAP_MS ? 'L' : 'M'}${x(time)},${y(used)}`
    );
    chart.append(svg('path', { class: 'series', d: d.join(''), stroke: color }));
    const last = visible.at(-1);
    if (last) ends.push({ y: y(last[1]), text: formatPercent(last[1], language) });
  }
  // End labels are pushed apart so that close lines never print on top of each other.
  ends.sort((a, b) => a.y - b.y);
  ends.forEach((end, i) => {
    const above = ends[i - 1];
    if (above && end.y - above.y < LABEL_MIN_GAP) end.y = above.y + LABEL_MIN_GAP;
    const label = svg('text', { class: 'end-label', x: CHART.width - CHART.right + 4, y: end.y + 3 });
    label.textContent = end.text;
    chart.append(label);
  });
  const crosshair = svg('line', { class: 'crosshair', y1: CHART.top, y2: CHART.top + plotHeight, visibility: 'hidden' });
  chart.append(crosshair);
  const tooltip = element('div', 'chart-tooltip');
  tooltip.hidden = true;
  const when = new Intl.DateTimeFormat(language, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  chart.addEventListener('pointermove', event => {
    const box = chart.getBoundingClientRect();
    const time = start + (((event.clientX - box.left) / box.width) * CHART.width - CHART.left) * ((now - start) / plotWidth);
    if (time < start || time > now) return;
    const rows = series.flatMap(({ label, color, samples }) => {
      const nearest = samples.reduce<readonly [number, number] | null>(
        (best, sample) => (best && Math.abs(best[0] - time) <= Math.abs(sample[0] - time) ? best : sample),
        null
      );
      return nearest && Math.abs(nearest[0] - time) <= HISTORY_GAP_MS ? [{ label, color, used: nearest[1] }] : [];
    });
    crosshair.setAttribute('x1', String(x(time)));
    crosshair.setAttribute('x2', String(x(time)));
    crosshair.setAttribute('visibility', rows.length ? 'visible' : 'hidden');
    tooltip.hidden = !rows.length;
    tooltip.replaceChildren(
      element('div', 'chart-tooltip-time', when.format(time)),
      ...rows.map(row => {
        const line = element('div', 'chart-tooltip-row');
        const key = element('span', 'line-key');
        key.style.setProperty('--series', row.color);
        line.append(key, element('strong', '', formatPercent(row.used, language)), element('span', '', row.label));
        return line;
      })
    );
    tooltip.style.setProperty('--left', `${Math.min(event.clientX - box.left + 8, box.width - 120)}px`);
  });
  chart.addEventListener('pointerleave', () => {
    crosshair.setAttribute('visibility', 'hidden');
    tooltip.hidden = true;
  });
  const legend = element('div', 'history-legend');
  legend.append(
    ...series.map(({ label, color }) => {
      const item = element('span', 'legend-item');
      const key = element('span', 'line-key');
      key.style.setProperty('--series', color);
      item.append(key, document.createTextNode(label));
      return item;
    })
  );
  figure.append(legend, chart, tooltip);
  return figure;
}

// The account-wide percentage limits, one line each (per-model scopes and spend are left out).
const chartedWindows = (account: MeasuredAccount): QuotaWindow[] =>
  account.windows.filter(w => !w.scope && w.section !== DETAILS_SECTION && w.usedPercent !== null).slice(0, SERIES_COLORS.length);

// Draws the charts from the last history read, if any, then from a fresh one.
async function fillHistory(details: HTMLDetailsElement, accounts: readonly MeasuredAccount[]): Promise<void> {
  if (history) drawHistory(details, accounts, history);
  history = await vibe.history();
  drawHistory(details, accounts, history);
}

function drawHistory(details: HTMLDetailsElement, accounts: readonly MeasuredAccount[], read: NonNullable<typeof history>): void {
  const now = Date.now();
  const charts = accounts.flatMap(account => {
    const series = chartedWindows(account).flatMap((window, i) => {
      const samples = read.find(s => s.accountId === account.id && s.windowId === window.id)?.samples ?? [];
      return samples.length ? [{ label: describeWindow(window, format()).label, color: SERIES_COLORS[i] ?? '', samples }] : [];
    });
    return HISTORY_SPANS.flatMap(span => {
      // A chart of the day needs a reading inside it: older lines would only be empty axes.
      const shown = series.filter(line => line.samples.some(([time]) => time >= now - span.durationMs));
      if (!shown.length) return [];
      const chart = historyChart(shown, now, span);
      chart.prepend(element('figcaption', '', accounts.length > 1 ? `${pickerName(account)} · ${t(span.title)}` : t(span.title)));
      return [chart];
    });
  });
  const summary = details.querySelector('summary');
  details.replaceChildren(...(summary ? [summary] : []), ...(charts.length ? charts : [element('div', 'empty', t('historyEmpty'))]));
}

function historySection(accounts: readonly MeasuredAccount[]): HTMLDetailsElement {
  const details = element('details', CARD_SECTIONS.history);
  details.append(element('summary', '', t('historySection')));
  details.addEventListener('toggle', () => {
    if (details.open) void action(() => fillHistory(details, accounts));
  });
  return details;
}

// ------------------------------------------------------------------- tokens

const TOKEN_COLUMNS = [
  ['input', 'tokenInput'],
  ['output', 'tokenOutput'],
  ['cacheRead', 'tokenCacheRead'],
  ['cacheWrite', 'tokenCacheWrite']
] as const satisfies readonly (readonly [keyof TokenTotals, MessageKey])[];

interface TokenRow {
  name: string;
  tokens: TokenTotals;
}

function tokenTable(heading: string, rows: readonly TokenRow[]): HTMLTableElement {
  const numbers = new Intl.NumberFormat(language, { notation: 'compact', maximumFractionDigits: 1 });
  const table = element('table', 'token-table');
  const head = element('tr');
  head.append(element('th', '', heading), ...TOKEN_COLUMNS.map(([, key]) => element('th', 'number', t(key))));
  for (const cell of head.children) cell.setAttribute('scope', 'col');
  table.append(head);
  for (const { name, tokens } of rows) {
    const row = element('tr');
    const label = element('th', 'name', name);
    label.setAttribute('scope', 'row');
    row.append(label, ...TOKEN_COLUMNS.map(([field]) => element('td', 'number', numbers.format(tokens[field]))));
    table.append(row);
  }
  return table;
}

// Draws what the tool's logs add up to, from the last read if any, then from a fresh one.
async function fillTokens(details: HTMLDetailsElement, accounts: readonly MeasuredAccount[]): Promise<void> {
  if (tokenUsage) drawTokens(details, accounts, tokenUsage);
  else details.append(loadingNote());
  tokenUsage = await vibe.tokenUsage();
  drawTokens(details, accounts, tokenUsage);
}

function drawTokens(details: HTMLDetailsElement, accounts: readonly MeasuredAccount[], read: readonly AccountTokens[]): void {
  const blocks = accounts.flatMap(account => {
    const tokens = read.find(entry => entry.accountId === account.id);
    if (!tokens?.models.length) return [];
    const block = element('div', 'token-block');
    if (accounts.length > 1) block.append(element('div', 'token-caption', pickerName(account)));
    block.append(
      tokenTable('', [
        { name: t('tokenToday'), tokens: tokens.today },
        { name: t('historyTitle'), tokens: tokens.week }
      ]),
      tokenTable(
        t('tokenModels'),
        tokens.models.map(({ model, tokens: used }) => ({ name: model || t('tokenModelUnknown'), tokens: used }))
      )
    );
    return [block];
  });
  const summary = details.querySelector('summary');
  details.replaceChildren(...(summary ? [summary] : []), ...(blocks.length ? blocks : [element('div', 'empty', t('tokensEmpty'))]));
}

function tokensSection(accounts: readonly MeasuredAccount[]): HTMLDetailsElement {
  const details = element('details', CARD_SECTIONS.tokens);
  details.append(element('summary', '', t('tokensTitle')));
  details.addEventListener('toggle', () => {
    if (details.open) void action(() => fillTokens(details, accounts));
  });
  return details;
}

// -------------------------------------------------------------- compact view

const COMPACT_NOTES: Readonly<Record<CompactNote, MessageKey>> = {
  reading: 'compactReading',
  waiting: 'compactWaiting',
  signIn: 'compactSignIn',
  openApp: 'compactOpenApp',
  noLimits: 'compactNoLimits',
  noData: 'compactNoData'
};

// What is left of an account's limit, and when it resets; a limit not started yet shows its
// length instead (a fresh 5-hour window reads "5h").
function compactWhen(window: KnownWindow): string {
  const resetMs = window.resetsAt ? Date.parse(window.resetsAt) - Date.now() : NaN;
  if (resetMs > 0) return formatDuration(resetMs, language);
  return window.durationMinutes ? formatDuration(window.durationMinutes * DURATION_MS.MINUTE, language) : '';
}

// One account's part of the row: its name when the tool has several, then its limit as a bar
// with what is left and when it resets, or a short note on why there is no number (signing in
// is one click away).
function compactSegment(provider: Provider, line: CompactLine, many: boolean): HTMLElement {
  const classes = ['compact-segment', line.low ? 'low' : '', line.stale ? 'stale' : ''].filter(Boolean).join(' ');
  const segment = element('div', classes);
  if (many) segment.append(element('span', 'compact-account', pickerName(line.account)));
  const { window } = line;
  if (!window) {
    const note = line.note ?? 'noData';
    const actionable = note === 'signIn' || note === 'openApp';
    const cell = element(actionable ? 'button' : 'span', `compact-note ${note}`, t(COMPACT_NOTES[note]));
    segment.title = [many ? accountName(line.account) : '', statusMessage(line.account) || t('noDataYet')].filter(Boolean).join(' · ');
    if (actionable) onClick(cell, () => openSignIn(provider, line.account));
    segment.append(cell);
    return segment;
  }
  const view = describeWindow(window, format());
  segment.append(
    quotaBar(window.remainingPercent, view.label),
    element('span', 'quota-value', formatPercent(window.remainingPercent, language)),
    element('span', 'compact-reset', compactWhen(window))
  );
  const details = [view.label, view.reset];
  // The account's other limit is named beside the session one: quietly, or marked when it runs
  // out first.
  if (line.other) {
    const other = describeWindow(line.other, format());
    const marks = [line.tighter ? 'tighter' : '', line.tighterLow ? 'low' : ''].filter(Boolean);
    segment.append(
      element('span', ['compact-other', ...marks].join(' '), `${other.label} ${formatPercent(line.other.remainingPercent, language)}`)
    );
    details.push(`${other.label}: ${other.value}`, other.reset);
  }
  const freshness = line.stale ? formatFreshness(line.account.fetchedAt, 'stale', format()) : '';
  segment.title = [many ? accountName(line.account) : '', ...details, freshness].filter(Boolean).join(' · ');
  return segment;
}

// One row per tool: its bar split into one part per account, main account first.
function compactRow(state: ProviderState): HTMLElement {
  const provider = providerById(state.id);
  const lines = compactLines(state, current().settings.lowQuotaPercent);
  const row = element('section', 'provider compact-row');
  row.dataset.provider = provider.id;
  const segments = element('div', 'compact-segments');
  if (lines.length) segments.append(...lines.map(line => compactSegment(provider, line, lines.length > 1)));
  else segments.append(element('span', 'compact-note noData', statusMessage(state) || t('status_no_accounts')));
  row.append(element('span', 'brand-avatar', provider.glyph), element('span', 'compact-name', provider.name), segments);
  return row;
}

let compactHeight = 0;
// The compact window is as tall as what it shows.
for (const dialog of $$('dialog', HTMLDialogElement)) {
  dialog.addEventListener('close', () => {
    fitCompactWindow(current().settings.compact);
  });
}

function fitCompactWindow(compact: boolean): void {
  if (!compact) {
    compactHeight = 0;
    return;
  }
  requestAnimationFrame(() => {
    const height = Math.ceil(ui.providers.getBoundingClientRect().bottom + COMPACT_BOTTOM_PADDING);
    if (height === compactHeight) return;
    compactHeight = height;
    void action(() => vibe.fitHeight(height));
  });
}

// --------------------------------------------------------------- suggestions

const folderName = (dir: string): string => dir.split(/[\\/]/).filter(Boolean).at(-1) ?? dir;

function suggestionCard(suggestion: Suggestion): HTMLElement {
  const { accounts } = current().settings;
  const account = accounts.find(a => a.id === suggestion.accountId);
  const name = `${providerById(suggestion.providerId).name}${account ? ` · ${accountName(account)}` : ''}`;
  const project = folderName(suggestion.projectDir);
  const target = successorName(suggestion.providerId, suggestion.target, accounts, t);
  const card = element('div', `suggestion ${suggestion.kind}`);
  card.dataset.provider = suggestion.target.providerId;
  const text = element('div', 'suggestion-text');
  text.title = suggestion.projectDir;
  text.append(
    element(
      'strong',
      '',
      suggestion.kind === 'return'
        ? t('suggestionReturnTitle', { name })
        : suggestion.kind === 'reopen'
          ? t('suggestionReopenTitle', { name })
          : t('suggestionLowTitle', { name, quota: formatPercent(suggestion.remainingPercent, language) })
    ),
    element(
      'span',
      '',
      suggestion.kind === 'return'
        ? t('suggestionReturnBody', { project })
        : suggestion.kind === 'reopen'
          ? t('suggestionReopenBody', { project, target })
          : t('suggestionLowBody', { project, target })
    )
  );
  const go = element('button', 'suggestion-action', t(SUGGESTION_BUTTONS[suggestion.kind]));
  onClick(go, async () => {
    const result = await vibe.continueWork(suggestion.id);
    if (result.status === 'canceled') return;
    toast(continuedMessage(result, target));
  });
  const dismiss = element('button', 'suggestion-dismiss', '✕');
  dismiss.title = t('dismissSuggestion');
  dismiss.setAttribute('aria-label', dismiss.title);
  onClick(dismiss, async () => {
    render(await vibe.dismissSuggestion(suggestion.id));
  });
  card.append(text, go, dismiss);
  return card;
}

function renderSuggestions(snapshot: Snapshot): void {
  ui.suggestions.replaceChildren(...(snapshot.suggestions ?? []).map(suggestionCard));
}

// What the tool's maker reports about its service: a slow or failing tool may not be the user's limit.
function serviceIssueNotes(providerId: ProviderId): HTMLElement[] {
  return (current().serviceIssues ?? [])
    .filter(issue => issue.providerId === providerId)
    .map(issue => {
      const note = element('div', `service-issue ${issue.status}`);
      note.setAttribute('role', 'status');
      note.append(element('span', '', t('serviceIssue', { component: issue.component, state: t(SERVICE_STATUS_TEXT[issue.status]) })));
      return note;
    });
}

function providerCard(state: ProviderState): HTMLElement {
  const provider = providerById(state.id);
  const section = element('section', 'provider');
  section.dataset.provider = provider.id;
  const { accounts } = state;
  const compare = current().settings.compareAccounts && accounts.length > 1;
  const shown = compare
    ? undefined
    : (accounts.find(a => a.id === selectedAccount.get(provider.id)) ?? accounts.find(a => a.primary) ?? accounts[0]);
  section.append(cardHeader(provider, compare ? [] : accounts, shown), ...serviceIssueNotes(provider.id));
  if (compare) section.append(...compareBody(provider, accounts));
  else if (shown) section.append(...accountBody(provider, shown));
  else section.append(element('div', 'empty', statusMessage(state) || t('status_no_accounts')), signInButton(provider));
  const charted = (compare ? accounts : shown ? [shown] : []).filter(a => chartedWindows(a).length);
  if (charted.length) section.append(historySection(charted));
  const counted = compare ? accounts : shown ? [shown] : [];
  if (isProfileProvider(provider.id) && counted.length) section.append(tokensSection(counted));

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

// Where the copy can update itself: download, then restart into it. Elsewhere the release page
// stays the way, with the reason, and Download opens this machine's installer when the release
// has one.
// The release whose banner was closed; a newer release shows it again. Storage can be unavailable.
const DISMISSED_UPDATE_KEY = 'vibe.dismissedUpdate';
const dismissedUpdate = (): string | null => {
  try {
    return localStorage.getItem(DISMISSED_UPDATE_KEY);
  } catch {
    return null;
  }
};
let dismissedThisRun: string | undefined;

function renderUpdateInstall(install: UpdateInstall | undefined, update: UpdateInfo | undefined): void {
  const byHand = install?.state === 'unsupported' && Boolean(update?.download);
  ui.updateInstall.hidden = !install || (install.state === 'unsupported' && !byHand);
  ui.updateNote.hidden = install?.state !== 'unsupported';
  ui.updateNote.textContent = install?.state === 'unsupported' ? t(UNSUPPORTED_UPDATE[install.reason]) : '';
  ui.updateInstall.disabled = install?.state === 'downloading';
  if (byHand) ui.updateInstall.textContent = t('updateDownload');
  if (!install || install.state === 'unsupported') return;
  ui.updateInstall.textContent =
    install.state === 'downloading'
      ? t('updateDownloading', { n: formatPercent(install.percent, language) })
      : t(install.state === 'downloaded' ? 'updateRestart' : install.state === 'failed' ? 'updateRetry' : 'updateDownload');
}

// A control the user is working in a card (an account picker, open or focused) is not torn
// down under them: the cards are rebuilt once it loses focus.
const workingInCards = (focused: Element | null): boolean => focused instanceof HTMLSelectElement && ui.providers.contains(focused);

// `focused` is the element that has the focus, or is getting it.
function renderCards(providers: readonly ProviderState[], compact: boolean, focused: Element | null): void {
  cardsStale = workingInCards(focused);
  if (cardsStale) return;
  // Rebuilding the cards would collapse expanded detail sections; keep them open.
  const openSections = (selector: string): Set<string | undefined> =>
    new Set(
      $$(selector, HTMLDetailsElement).map(details => {
        const card = details.closest('.provider');
        return card instanceof HTMLElement ? card.dataset.provider : undefined;
      })
    );
  const open = Object.values(CARD_SECTIONS).map(section => [section, openSections(`.provider details.${section}[open]`)] as const);
  ui.providers.replaceChildren(...providers.map(compact ? compactRow : providerCard));
  for (const card of $$('.provider', HTMLElement, ui.providers)) {
    for (const [section, providerIds] of open) {
      const details = card.querySelector(`details.${section}`);
      if (details instanceof HTMLDetailsElement && providerIds.has(card.dataset.provider)) details.open = true;
    }
  }
}

// While focus leaves, the active element is still the one it leaves: what gets it decides.
ui.providers.addEventListener('focusout', event => {
  const next = event.relatedTarget instanceof Element ? event.relatedTarget : null;
  if (cardsStale && !workingInCards(next)) render(current(), next);
});

function render(snapshot: Snapshot, focused: Element | null = document.activeElement): void {
  state = snapshot;
  language = isLanguage(snapshot.settings.language) ? snapshot.settings.language : DEFAULT_LANGUAGE;
  document.documentElement.lang = language;
  applyStaticText();

  const order = visibleProviders(snapshot.settings);
  // A tool that only reports its quota has a card once there is a sign-in to read it with.
  const providers = snapshot.providers
    .filter(p => order.includes(p.id) && (providerById(p.id).runsWork || p.accounts.length))
    .sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  const { compact } = snapshot.settings;
  document.body.classList.toggle('compact', compact);
  renderCards(providers, compact, focused);
  renderSuggestions(snapshot);
  const notice = snapshot.settingsNotice;
  ui.settingsNotice.hidden = !notice;
  ui.settingsNoticeText.textContent = notice ? t(NOTICE_TEXT[notice]) : '';
  // Restored settings only need to be acknowledged; the others need a decision in Settings.
  ui.settingsNoticeAction.textContent = t(notice === 'recovered' ? 'dismissSuggestion' : 'settings');
  ui.updateBanner.hidden = !snapshot.update || snapshot.update.version === (dismissedThisRun ?? dismissedUpdate());
  ui.updateText.textContent = snapshot.update ? t('updateAvailable', { version: snapshot.update.version }) : '';
  renderUpdateInstall(snapshot.updateInstall, snapshot.update);
  ui.overallStatus.textContent = snapshot.refreshing ? t('readingQuotas') : t('servicesOnDevice', { n: providers.length });
  ui.refresh.disabled = snapshot.refreshing;
  ui.pin.setAttribute('aria-pressed', String(snapshot.settings.pinned));
  ui.compactButton.setAttribute('aria-pressed', String(compact));
  ui.compactButton.title = t(compact ? 'fullView' : 'compactView');
  ui.compactButton.setAttribute('aria-label', ui.compactButton.title);
  fitCompactWindow(compact);
  ui.refreshLabel.textContent = t('autoRefresh', { time: formatInterval(snapshot.settings.intervalSeconds, 'narrow') });
  ui.platformLabel.textContent = t(vibe.platform === 'darwin' ? 'menuBar' : 'systemTray');
}

// ------------------------------------------------------------------- settings

// A rejected change would leave the control showing what the user picked; the settings are
// drawn again from what is stored.
async function changeSettings(task: () => Promise<void>): Promise<void> {
  try {
    await task();
  } catch (error) {
    await renderSettings();
    throw error;
  }
}

const saveSettings = (patch: SettingsPatch): Promise<void> =>
  changeSettings(async () => {
    render(await vibe.saveSettings(patch));
  });

function renderProviderOrder(): void {
  const order = normalizeProviderOrder(current().settings.providerOrder);
  ui.providerOrder.replaceChildren(
    ...order.map((providerId, slot) => {
      const row = element('div', 'fallback-slot');
      const select = element('select');
      select.id = `provider-slot-${slot}`;
      fillSelect(
        select,
        WORK_PROVIDER_IDS.map(id => [id, providerLabel(id)] as const),
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
        // Without an order of its own, the window follows this one.
        renderHomeOrder();
      });
      row.append(label, select);
      return row;
    })
  );
}

// The window's own order: moving a tool swaps it with its neighbour.
function renderHomeOrder(): void {
  const order = displayOrder(current().settings);
  ui.homeOrder.replaceChildren(
    ...order.map((providerId, slot) => {
      const row = element('div', 'home-order-row');
      row.dataset.provider = providerId;
      const move = (offset: number, arrow: string, labelKey: MessageKey): HTMLButtonElement => {
        const button = element('button', 'order-button', arrow);
        button.type = 'button';
        button.title = t(labelKey, { name: providerById(providerId).name });
        button.setAttribute('aria-label', button.title);
        const neighbour = order[slot + offset];
        button.disabled = !neighbour;
        onClick(button, async () => {
          if (!neighbour) return;
          const next = [...order];
          next[slot] = neighbour;
          next[slot + offset] = providerId;
          await saveSettings({ homeOrder: next });
          renderHomeOrder();
        });
        return button;
      };
      const { hiddenProviders } = current().settings;
      const hidden = hiddenProviders.includes(providerId);
      const toggle = element('button', 'order-button', hidden ? '🚫' : '👁');
      toggle.type = 'button';
      toggle.title = t(hidden ? 'showTool' : 'hideTool', { name: providerById(providerId).name });
      toggle.setAttribute('aria-label', toggle.title);
      toggle.setAttribute('aria-pressed', String(hidden));
      // One tool always stays: the window would have nothing to show.
      toggle.disabled = !hidden && hiddenProviders.length >= order.length - 1;
      onClick(toggle, async () => {
        await saveSettings({
          hiddenProviders: hidden ? hiddenProviders.filter(id => id !== providerId) : [...hiddenProviders, providerId]
        });
        renderHomeOrder();
      });
      row.classList.toggle('hidden-tool', hidden);
      row.append(element('span', 'home-order-name', providerLabel(providerId)), move(-1, '↑', 'moveUp'), move(1, '↓', 'moveDown'), toggle);
      return row;
    })
  );
}

async function renderPreferredModels(): Promise<void> {
  if (!models) ui.preferredModels.replaceChildren(loadingNote());
  const available = await getModels();
  const { preferredModels } = current().settings;
  ui.preferredModels.replaceChildren(
    ...PROVIDERS.filter(p => p.acceptsModel).map(provider => {
      const row = element('div', 'model-dropdown-row');
      row.dataset.provider = provider.id;
      const select = element('select', 'model-select');
      select.id = `preferred-${provider.id}`;
      fillSelect(select, modelChoices(available[provider.id], preferredModels[provider.id]), preferredModels[provider.id] ?? '');
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

// One row per project: its tool, model, account and continuation, each optional. A choice the
// tool no longer offers (a removed account) still shows, so the user sees it and can change it.
// Changes go to the preference by its folder (one per folder), not by its row: a row's place
// can change between its rendering and a click.
async function projectRow(preference: ProjectPreference): Promise<HTMLElement> {
  const isThis = (p: ProjectPreference): boolean => p.projectDir === preference.projectDir;
  const row = element('div', 'project-item');
  const name = folderName(preference.projectDir);
  const title = element('div', 'project-item-top');
  const label = element('strong', 'project-name', name);
  label.title = preference.projectDir;
  const remove = element('button', 'remove-account', t('removeProject'));
  remove.type = 'button';
  remove.setAttribute('aria-label', `${name} ${t('removeProject')}`);
  onClick(remove, async () => {
    await saveSettings({ projectPreferences: current().settings.projectPreferences.filter(p => !isThis(p)) });
    await renderProjectPreferences();
  });
  title.append(label, remove);

  // Applies `change` and drops the optional choices in `clear`.
  const update = async (change: Partial<ProjectPreference>, clear: readonly ProjectChoice[] = []): Promise<void> => {
    const kept = (key: ProjectChoice): boolean => !clear.includes(key);
    const next = current().settings.projectPreferences.map((p): ProjectPreference => {
      if (!isThis(p)) return p;
      const { tool, model, accountId, ...rest } = { ...p, ...change };
      return {
        ...rest,
        ...(tool !== undefined && kept('tool') ? { tool } : {}),
        ...(model !== undefined && kept('model') ? { model } : {}),
        ...(accountId !== undefined && kept('accountId') ? { accountId } : {})
      };
    });
    await saveSettings({ projectPreferences: next });
    await renderProjectPreferences();
  };
  const field = (labelKey: MessageKey, select: HTMLSelectElement): HTMLLabelElement => {
    const wrapper = element('label', 'field');
    select.setAttribute('aria-label', `${name} · ${t(labelKey)}`);
    wrapper.append(element('span', '', t(labelKey)), select);
    return wrapper;
  };

  const tool = element('select');
  fillSelect(tool, [['', t('projectAnyTool')], ...WORK_PROVIDER_IDS.map(id => [id, providerLabel(id)] as const)], preference.tool ?? '');
  onChange(tool, () => {
    const chosen = selectedProvider(tool);
    // A model or account belongs to one tool; changing the tool drops them.
    return chosen ? update({ tool: chosen }, ['model', 'accountId']) : update({}, ['tool', 'model', 'accountId']);
  });
  const fields = [field('projectTool', tool)];

  if (preference.tool) {
    const toolId = preference.tool;
    if (providerById(toolId).acceptsModel) {
      const available = (await getModels())[toolId];
      const model = element('select');
      const choices = [...new Set([...available, ...(preference.model ? [preference.model] : [])])];
      fillSelect(model, [['', t('toolDefault')], ...choices.map(m => [m, m] as const)], preference.model ?? '');
      onChange(model, () => (model.value ? update({ model: model.value }) : update({}, ['model'])));
      fields.push(field('projectModel', model));
    }
    const accounts = current().settings.accounts.filter(a => a.providerId === toolId);
    const account = element('select');
    const entries: (readonly [string, string])[] = [['', t('projectAnyAccount')], ...accounts.map(a => [a.id, accountName(a)] as const)];
    if (preference.accountId && !accounts.some(a => a.id === preference.accountId))
      entries.push([preference.accountId, t('projectMissingAccount')]);
    fillSelect(account, entries, preference.accountId ?? '');
    onChange(account, () => (account.value ? update({ accountId: account.value }) : update({}, ['accountId'])));
    fields.push(field('projectAccount', account));
  }

  const auto = element('select');
  fillSelect(
    auto,
    PROJECT_AUTO_CONTINUE.map(([value, key]) => [value, t(key)] as const),
    preference.autoContinue
  );
  onChange(auto, () => {
    const chosen = PROJECT_AUTO_CONTINUE.find(([value]) => value === auto.value)?.[0];
    return chosen ? update({ autoContinue: chosen }) : Promise.resolve();
  });
  fields.push(field('projectAutoContinue', auto));

  const grid = element('div', 'project-fields');
  grid.append(...fields);
  row.append(title, grid);
  return row;
}

async function renderProjectPreferences(): Promise<void> {
  const { projectPreferences } = current().settings;
  const rows = await Promise.all(projectPreferences.map(preference => projectRow(preference)));
  ui.projectPreferences.replaceChildren(...(rows.length ? rows : [element('p', 'help', t('projectPreferencesEmpty'))]));
}

// ---------------------------------------------------------------- transitions

function transitionItem(record: TransitionRecord): HTMLElement {
  const item = element('li', `record-item status-${record.status}`);
  const project = folderName(record.projectDir);
  const top = element('div', 'record-top');
  top.append(element('strong', '', project), element('span', 'record-status', t(TRANSITION_STATUS[record.status])));
  const accounts = current().settings.accounts;
  const route = `${successorName(record.source.providerId, { providerId: record.source.providerId, accountId: record.source.accountId }, accounts, t)} → ${successorName(record.source.providerId, record.target, accounts, t)}`;
  const details = element('div', 'record-detail', `${route} · ${formatAge(record.updatedAt, format())}`);
  item.append(top, details);
  if (record.errorCode) item.append(element('div', 'record-error', describe(record.errorCode)));
  // Only a failure the app can try again gets the button: one with its offer still there.
  if (record.retryable) {
    const retry = element('button', 'secondary-button gap-top-sm', t('retryTransition'));
    retry.type = 'button';
    onClick(retry, async () => {
      const result = await vibe.retryTransition(record.id);
      if (result.status === 'continued') {
        const target = successorName(record.source.providerId, { providerId: result.to, accountId: result.accountId }, accounts, t);
        toast(continuedMessage(result, target));
      }
      await renderTransitions();
    });
    item.append(retry);
  }
  return item;
}

async function renderTransitions(): Promise<void> {
  const records = (await vibe.transitions()).sort((a, b) => b.updatedAt - a.updatedAt);
  ui.transitionsList.replaceChildren(...(records.length ? records.map(transitionItem) : [element('li', 'help', t('transitionsEmpty'))]));
}

onClick(ui.transitionsButton, () => {
  ui.transitionsList.replaceChildren(loadingNote('li'));
  return openDialog(ui.transitionsDialog, renderTransitions);
});

// ---------------------------------------------------------------- diagnostics

function installedText(installed: boolean | null): string {
  if (installed === null) return t('installedUnknown');
  return t(installed ? 'installedYes' : 'installedNo');
}

function diagnosticsCard(entry: Diagnostics['providers'][number]): HTMLElement {
  const card = element('section', 'record-item');
  card.dataset.provider = entry.id;
  const top = element('div', 'record-top');
  top.append(element('strong', '', providerLabel(entry.id)), element('span', 'record-status', installedText(entry.installed)));
  card.append(top);
  if (!entry.accounts.length) card.append(element('div', 'record-detail', t('status_no_accounts')));
  for (const account of entry.accounts) {
    const line = element('div', `record-detail${account.stale ? ' stale' : ''}`);
    const state = account.messageCode ? describe(account.messageCode) : t(STATUS_TEXT[account.status] ?? 'reading');
    const age = account.ageMs === null ? t('notMeasuredYet') : formatAge(Date.now() - account.ageMs, format());
    line.textContent = `${t('accountOrdinal', { n: account.ordinal })}${account.enabled ? '' : ` (${t('accountDisabled')})`} · ${state} · ${account.stale ? t('staleAge', { age }) : age}`;
    card.append(line);
    if (account.remedy) card.append(element('div', 'record-remedy', `${t('nextStep')}: ${t(account.remedy)}`));
  }
  if (entry.remedy && !entry.accounts.some(a => a.remedy === entry.remedy))
    card.append(element('div', 'record-remedy', `${t('nextStep')}: ${t(entry.remedy)}`));
  return card;
}

onClick(ui.diagnosticsButton, () => {
  ui.diagnosticsList.replaceChildren(loadingNote());
  return openDialog(ui.diagnosticsDialog, async () => {
    const diagnostics = await vibe.diagnostics();
    ui.diagnosticsList.replaceChildren(...diagnostics.providers.map(diagnosticsCard));
  });
});
onClick(ui.diagnosticsCopy, async () => {
  await vibe.copyDiagnostics();
  toast(t('reportCopied'));
});
onClick(ui.diagnosticsExport, async () => {
  if ((await vibe.exportDiagnostics()).status === 'saved') toast(t('reportSaved'));
});

// The latest reading of a configured account, when there is one.
const measuredAccount = (account: Account): MeasuredAccount | undefined =>
  current()
    .providers.find(p => p.id === account.providerId)
    ?.accounts.find(a => a.id === account.id);

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
  // Without a typed name the account is named by its sign-in, so that is the placeholder.
  input.placeholder = measuredAccount(account)?.signedInAs ?? (account.labelKey ? t(account.labelKey) : t('accountLabelPlaceholder'));
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

function addAccountButton(providerId: ProfileProviderId): HTMLButtonElement {
  const tool = providerById(providerId).name;
  const button = element('button', 'secondary-button gap-top-sm', t('addAccountBtn', { tool }));
  onClick(button, async () => {
    render(await vibe.addAccount(providerId));
    showSettingsMessage(t('signInOpened', { tool }));
    await renderSettings();
  });
  return button;
}

function renderAccounts(): void {
  const { accounts, dismissedAccountIds } = current().settings;
  const cards = PROVIDERS.filter(p => isProfileProvider(p.id) || accounts.some(a => a.providerId === p.id)).map(provider => {
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
    if (isProfileProvider(provider.id)) card.append(addAccountButton(provider.id));
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

  fillSelect(
    ui.interval,
    withSaved(REFRESH_INTERVAL_SECONDS.choices, settings.intervalSeconds).map(s => [String(s), formatInterval(s, 'long')] as const),
    String(settings.intervalSeconds)
  );
  const loginItem = await vibe.loginItem();
  ui.openAtLoginRow.hidden = !loginItem.supported;
  ui.openAtLogin.checked = loginItem.enabled;
  ui.notifications.checked = settings.notifications;
  ui.notificationsLabel.textContent = t('quotaNotifications', { n: formatPercent(settings.lowQuotaPercent, language) });
  fillSelect(
    ui.lowQuota,
    withSaved(LOW_QUOTA_RANGE.choices, settings.lowQuotaPercent).map(n => [String(n), formatPercent(n, language)] as const),
    String(settings.lowQuotaPercent)
  );
  ui.quietHours.checked = settings.quietHours !== undefined;
  ui.quietHoursTimes.hidden = !settings.quietHours;
  ui.quietStart.value = settings.quietHours?.start ?? DEFAULT_QUIET_HOURS.start;
  ui.quietEnd.value = settings.quietHours?.end ?? DEFAULT_QUIET_HOURS.end;
  ui.compareAccounts.checked = settings.compareAccounts;
  ui.checkUpdates.checked = settings.checkUpdates;
  ui.checkServiceStatus.checked = settings.checkServiceStatus;
  showAutoContinue(settings.autoContinue);
  showReturnToPrimary(settings.returnToPrimary);
  showReopenAfterRestart(settings.reopenAfterRestart);
  renderHomeOrder();
  renderProviderOrder();
  renderAccounts();
  await renderPreferredModels();
  await renderProjectPreferences();
}

function openSettings(): Promise<void> {
  ui.settingsMessage.textContent = '';
  return openDialog(ui.settingsDialog, renderSettings);
}

onClick(ui.settingsButton, openSettings);
onChange(ui.language, async () => {
  if (!isLanguage(ui.language.value)) return;
  await saveSettings({ language: ui.language.value });
  await renderSettings();
});
onChange(ui.interval, () => saveSettings({ intervalSeconds: Number(ui.interval.value) }));
// The system may refuse the change (macOS can require approval): show what it settled on.
onChange(ui.openAtLogin, () =>
  changeSettings(async () => {
    ui.openAtLogin.checked = (await vibe.setLoginItem(ui.openAtLogin.checked)).enabled;
  })
);
onChange(ui.notifications, () => saveSettings({ notifications: ui.notifications.checked }));
onChange(ui.compareAccounts, () => saveSettings({ compareAccounts: ui.compareAccounts.checked }));
onChange(ui.checkUpdates, () => saveSettings({ checkUpdates: ui.checkUpdates.checked }));
onChange(ui.checkServiceStatus, () => saveSettings({ checkServiceStatus: ui.checkServiceStatus.checked }));
onChange(ui.lowQuota, () => saveSettings({ lowQuotaPercent: Number(ui.lowQuota.value) }));
// Quiet hours are saved once both times are valid and different; the inputs keep the choice.
function saveQuietHours(): Promise<void> {
  ui.quietHoursTimes.hidden = !ui.quietHours.checked;
  if (!ui.quietHours.checked) return saveSettings({ quietHours: null });
  const quietHours = { start: ui.quietStart.value, end: ui.quietEnd.value };
  if (!quietHours.start || !quietHours.end || quietHours.start === quietHours.end) return Promise.resolve();
  return saveSettings({ quietHours });
}
onChange(ui.quietHours, saveQuietHours);
onChange(ui.quietStart, saveQuietHours);
onChange(ui.quietEnd, saveQuietHours);
onClick(ui.addProject, async () => {
  const projectDir = await vibe.selectDirectory({});
  if (!projectDir) return;
  const { projectPreferences } = current().settings;
  if (!projectPreferences.some(p => p.projectDir === projectDir))
    await saveSettings({ projectPreferences: [...projectPreferences, { projectDir, autoContinue: INHERIT }] });
  await renderProjectPreferences();
});
onClick(ui.exportSettings, async () => {
  if ((await vibe.exportSettings()).status === 'saved') showSettingsMessage(t('settingsExported'));
});
onClick(ui.importSettings, async () => {
  if ((await vibe.importSettings()).status !== 'imported') return;
  render(await vibe.snapshot());
  await renderSettings();
  showSettingsMessage(t('settingsImported'));
});
onClick(ui.resetSettings, async () => {
  render(await vibe.resetSettings());
  await renderSettings();
});
onClick(ui.settingsNoticeAction, async () => {
  if (current().settingsNotice === 'recovered') {
    render(await vibe.dismissSettingsNotice());
    return;
  }
  await openSettings();
});
// A setting chosen from a row of radio buttons, built from its values and their labels so that
// the two never part. The result shows the saved choice.
function radioGroup<T extends string>(
  container: HTMLElement,
  values: readonly T[],
  labels: Readonly<Record<T, MessageKey>>,
  save: (value: T) => Promise<unknown>
): (chosen: T) => void {
  const choices = values.map(value => {
    const input = element('input');
    input.type = 'radio';
    input.name = container.id;
    input.value = value;
    const text = element('span');
    text.dataset.i18n = labels[value];
    const row = element('label', 'toggle-row');
    row.append(input, text);
    return { value, input, row };
  });
  container.replaceChildren(...choices.map(choice => choice.row));
  onChange(container, async () => {
    const chosen = choices.find(choice => choice.input.checked);
    if (chosen) await save(chosen.value);
  });
  return chosen => {
    for (const choice of choices) choice.input.checked = choice.value === chosen;
  };
}

const showAutoContinue = radioGroup(ui.autoContinue, AUTO_CONTINUE, AUTO_CONTINUE_LABELS, autoContinue => saveSettings({ autoContinue }));
const showReturnToPrimary = radioGroup(ui.returnToPrimary, AUTOMATION_MODES, RETURN_TO_PRIMARY_LABELS, returnToPrimary =>
  saveSettings({ returnToPrimary })
);
const showReopenAfterRestart = radioGroup(ui.reopenAfterRestart, AUTOMATION_MODES, REOPEN_AFTER_RESTART_LABELS, reopenAfterRestart =>
  saveSettings({ reopenAfterRestart })
);

// ------------------------------------------------------------------- handover

function sessionLabel(session: SessionSummary, showProvider: boolean): string {
  const size = new Intl.NumberFormat(language, { style: 'unit', unit: 'megabyte', maximumFractionDigits: 1 });
  const sourceAccount = current().settings.accounts.find(account => account.id === session.source.accountId);
  const parts = [
    sourceAccount ? accountName(sourceAccount) : '',
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
  handoverSources.clear();
  const fromProvider = selectedProvider(ui.handoverFrom) ?? AUTO;
  const mostRecent = option(AUTO, t('mostRecentSession'));
  if (!handoverProjectDir) {
    ui.handoverSession.replaceChildren(mostRecent);
    return;
  }
  const loading = option('', t('reading'));
  loading.disabled = true;
  ui.handoverSession.replaceChildren(mostRecent, loading);
  let sessions: SessionSummary[];
  try {
    sessions = await vibe.listSessions({ providerId: fromProvider, projectDir: handoverProjectDir });
  } catch (error) {
    if (request === sessionRequest) throw error;
    return;
  }
  if (request !== sessionRequest) return;
  loading.remove();
  if (!sessions.length) {
    const empty = option('', t('noSessionsFound'));
    empty.disabled = true;
    ui.handoverSession.append(empty);
    return;
  }
  ui.handoverSession.append(
    ...sessions.map(session => {
      handoverSources.set(session.source.id, session);
      const node = option(session.source.id, sessionLabel(session, fromProvider === AUTO));
      node.dataset.provider = session.providerId;
      return node;
    })
  );
}

async function refreshHandoverModels(): Promise<void> {
  const request = ++modelRequest;
  const target = selectedProvider(ui.handoverTo);
  const accepts = target !== undefined && providerById(target).acceptsModel;
  ui.handoverModelField.hidden = !accepts;
  if (!target || !accepts) return;
  // The tool's default holds the place until the models are in.
  if (!models) fillSelect(ui.handoverModel, [['', t('toolDefault')]]);
  const saved = current().settings.preferredModels[target];
  let catalog: ModelCatalog;
  try {
    catalog = await getModels();
  } catch (error) {
    if (request === modelRequest) throw error;
    return;
  }
  if (request !== modelRequest || target !== selectedProvider(ui.handoverTo)) return;
  clearHandoverPreview();
  fillSelect(ui.handoverModel, modelChoices(catalog[target], saved), saved ?? '');
}

// A task is handed to a different tool: the source (the chosen tool, else the provider of the
// chosen session) is never left as the target.
function syncHandoverTarget(): void {
  const from = selectedProvider(ui.handoverFrom) ?? ui.handoverSession.selectedOptions[0]?.dataset.provider;
  if (from && ui.handoverTo.value === from) ui.handoverTo.value = WORK_PROVIDER_IDS.find(id => id !== from) ?? '';
}

function setHandoverProject(dir: string): void {
  handoverProjectDir = dir;
  ui.handoverProject.value = dir;
  clearHandoverPreview();
}

function clearHandoverPreview(): void {
  handoverPreview.clear();
  ui.handoverPreviewBox.hidden = true;
  ui.handoverPreview.textContent = '';
  ui.handoverExecute.disabled = true;
}

function handoverRequest(): HandoverRequest {
  const session = handoverSources.get(ui.handoverSession.value);
  const sessionId = session?.id ?? AUTO;
  const targetModel = ui.handoverModelField.hidden ? '' : ui.handoverModel.value;
  return {
    projectDir: handoverProjectDir,
    fromProvider: selectedProvider(ui.handoverFrom) ?? AUTO,
    toProvider: selectedProvider(ui.handoverTo) ?? AUTO,
    sessionId,
    ...(targetModel ? { targetModel } : {}),
    ...(session ? { sessionProvider: session.providerId, sessionSource: session.source } : {})
  };
}

onClick(ui.handoverButton, async () => {
  if (!handoverProjectDir) setHandoverProject(await vibe.defaultProjectDir());
  fillSelect(ui.handoverFrom, [[AUTO, t('autoDetectSession')], ...WORK_PROVIDER_IDS.map(id => [id, providerLabel(id)] as const)], AUTO);
  fillSelect(
    ui.handoverTo,
    WORK_PROVIDER_IDS.map(id => [id, providerLabel(id)] as const),
    normalizeProviderOrder(current().settings.providerOrder)[0]
  );
  clearHandoverPreview();
  await openDialog(ui.handoverDialog, async () => {
    await Promise.all([refreshHandoverModels(), refreshHandoverSessions()]);
  });
});
onClick(ui.handoverBrowse, async () => {
  const dir = await vibe.selectDirectory({ defaultPath: handoverProjectDir });
  if (!dir) return;
  setHandoverProject(dir);
  await refreshHandoverSessions();
});
onChange(ui.handoverFrom, async () => {
  clearHandoverPreview();
  syncHandoverTarget();
  // These reads are independent. Start both under this form's generation so a late
  // model reply cannot start a new session read after the dialog was closed.
  await Promise.all([refreshHandoverModels(), refreshHandoverSessions()]);
});
onChange(ui.handoverSession, async () => {
  clearHandoverPreview();
  syncHandoverTarget();
  await refreshHandoverModels();
});
onChange(ui.handoverTo, async () => {
  clearHandoverPreview();
  await refreshHandoverModels();
});
onChange(ui.handoverModel, async () => {
  clearHandoverPreview();
  return Promise.resolve();
});
onClick(ui.handoverPreviewButton, async () => {
  const request = handoverRequest();
  clearHandoverPreview();
  const preview = await handoverPreview.load(request, request => vibe.previewHandover(request), handoverRequest);
  if (!preview || !ui.handoverDialog.open) return;
  const from = preview.from ? providerById(preview.from).name : t('autoDetectSession');
  ui.handoverPreviewSummary.textContent = t('previewSummary', { from, to: toolLabel(preview.to, preview.model) });
  ui.handoverPreview.textContent = preview.brief;
  ui.handoverPreviewBox.hidden = false;
  ui.handoverExecute.disabled = false;
});
ui.handoverCancel.addEventListener('click', () => {
  clearHandoverPreview();
  ui.handoverDialog.close();
});
ui.handoverDialog.addEventListener('cancel', clearHandoverPreview);
ui.handoverDialog.addEventListener('close', () => {
  clearHandoverPreview();
  sessionRequest++;
  modelRequest++;
});
// The previewed session is handed over as shown: an automatic session choice is pinned to what
// the preview resolved, so a newer session cannot slip in.
onClick(ui.handoverExecute, async () => {
  const reviewed = handoverPreview.read(handoverRequest());
  if (!reviewed || !ui.handoverDialog.open) return;
  const { request, preview } = reviewed;
  clearHandoverPreview();
  ui.handoverDialog.close();
  // An automatic target is decided again from the quota at execution time.
  const result = await vibe.executeHandover({
    ...request,
    ...(preview.sessionId && preview.sessionProvider ? { sessionId: preview.sessionId, sessionProvider: preview.sessionProvider } : {}),
    sessionSource: preview.sessionSource ?? null
  });
  toast(t(LAUNCH_MESSAGES[result.mode], { tool: toolLabel(result.to, result.model) }));
});

// --------------------------------------------------------------- smart launch

function smartReason(preview: SmartLaunchPreview): string {
  if (!preview.verified) return t('reasonUnverified');
  return t(preview.isFallback ? 'reasonFallback' : 'reasonPrimary');
}

onClick(ui.smartButton, () => {
  for (const field of [ui.smartProvider, ui.smartQuota, ui.smartModel, ui.smartReason]) field.textContent = t('reading');
  return openDialog(ui.smartDialog, async () => {
    const preview = await vibe.previewSmartLaunch();
    ui.smartProvider.textContent = providerById(preview.providerId).name;
    ui.smartQuota.textContent =
      preview.headroomPercent === null
        ? t('quotaUnverified')
        : t('percentRemaining', { n: formatPercent(preview.headroomPercent, language) });
    ui.smartModel.textContent = preview.model ?? t('toolDefault');
    ui.smartReason.textContent = smartReason(preview);
  });
});
ui.smartCancel.addEventListener('click', () => {
  ui.smartDialog.close();
});
onClick(ui.smartConfirm, async () => {
  ui.smartDialog.close();
  const result = await vibe.smartLaunch();
  if (result.status === 'launched')
    toast(t(result.mode === 'app' ? 'launchedApp' : 'launchedTerminal', { tool: toolLabel(result.to, result.model) }));
});

// ------------------------------------------------------------------- titlebar

onClick(ui.refresh, () => vibe.refresh());
onClick(ui.pin, () => vibe.pin());
onClick(ui.compactButton, () => saveSettings({ compact: !current().settings.compact }));
onClick(ui.updateOpen, () => vibe.openUpdate());
onClick(ui.updateDismiss, () => {
  const version = current().update?.version;
  if (!version) return Promise.resolve();
  dismissedThisRun = version;
  try {
    localStorage.setItem(DISMISSED_UPDATE_KEY, version);
  } catch {
    // The banner stays closed for this run only.
  }
  render(current());
  return Promise.resolve();
});
onClick(ui.updateInstall, () => (current().updateInstall?.state === 'downloaded' ? vibe.installUpdate() : vibe.downloadUpdate()));
onClick(ui.hide, () => vibe.hide());

applyStaticText();
vibe.onSnapshot(render);
window.setInterval(() => {
  if (state && !document.hidden) render(state);
}, CLOCK_TICK_MS);
void action(async () => {
  render(await vibe.snapshot());
});
