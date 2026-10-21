// The data model the main process, the CLI and the renderer exchange. Text the app words
// itself travels as i18n keys; names reported by a source (models, groups) travel verbatim.
import type {
  ACCOUNT_LABEL_KEYS,
  ACCOUNT_ORIGINS,
  AUTO_CONTINUE,
  AUTOMATION_MODES,
  INHERIT,
  ProviderId,
  SERVICE_STATUSES,
  SUGGESTION_KINDS,
  TRANSITION_STATUSES
} from './catalog.ts';
import type { Language, MessageKey } from './i18n/index.ts';

// Failures the user can act on; each has an `error_<code>` message.
export type AppErrorCode =
  | 'unexpected'
  | 'account_not_found'
  | 'invalid_provider'
  | 'invalid_argument'
  | 'invalid_settings'
  | 'folder_not_found'
  | 'file_not_found'
  | 'invalid_path'
  | 'session_not_found'
  | 'handover_file_tracked'
  | 'handover_exclusion_failed'
  | 'handover_sensitive_context'
  | 'launch_failed'
  | 'app_not_found'
  | 'sender_rejected'
  | 'no_verified_quota'
  | 'no_cli'
  | 'unknown_command'
  | 'suggestion_expired'
  | 'settings_locked'
  | 'session_newer_elsewhere'
  | 'session_still_running'
  | 'process_unknown'
  | 'not_picked_up'
  | 'bypass_not_consented'
  | 'session_unsaved';

// Why a quota read failed. Codes with a `status_<code>` message are shown as such; the
// others are internal and shown as a generic failure.
export type ProviderErrorCode =
  | 'auth_missing'
  | 'auth_expired'
  | 'auth_invalid'
  | 'auth_rejected'
  | 'rate_limited'
  | 'transport_error'
  | 'request_timeout'
  | 'response_too_large'
  | 'invalid_response'
  | 'http_rejected'
  | 'endpoint_not_allowed'
  | 'binary_missing'
  | 'invalid_binary'
  | 'process_failed'
  | 'process_timeout'
  | 'rpc_error'
  | 'rpc_timeout'
  | 'server_closed'
  | 'app_closed'
  | 'local_service_unavailable'
  | 'unsupported_platform'
  | 'unsupported_profile'
  | 'keychain_unavailable'
  | 'provider_failed'
  | 'tls_certificate_error'
  | 'trust_store_unavailable';

export type ErrorCode = AppErrorCode | ProviderErrorCode;

// An error as it crosses the IPC boundary.
export interface ErrorPayload {
  code: ErrorCode;
  params: Readonly<Record<string, string>>;
}

// Money in USD cents.
export interface Amounts {
  used?: number;
  limit?: number;
  remaining?: number;
  bonus?: number;
}

export interface QuotaWindow {
  id: string;
  usedPercent: number | null;
  remainingPercent: number | null;
  resetsAt: string | null;
  // `label` and `scope` are names reported by the source, shown verbatim.
  label?: string;
  labelKey?: MessageKey;
  labelParams?: { n: number };
  detailKey?: MessageKey;
  valueKey?: MessageKey;
  durationMinutes?: number;
  scope?: string;
  // false when the source marks the model scope inactive: its numbers are no entitlement.
  active?: boolean;
  group?: 'team';
  // Secondary windows the UI collapses (spend, combined totals).
  section?: 'details';
  // The limit covers only part of the account's use (some APIs or models): spent, the account
  // still works for the rest.
  partial?: boolean;
  // The models a partial limit does not cover (lower case), when the source says which.
  except?: string[];
  amounts?: Amounts;
  // Kept from an earlier reading because the latest response no longer reported it.
  stale?: boolean;
  // When the window runs out at the recent pace, if that comes before it resets.
  exhaustsAt?: string;
}

export type AccountLabelKey = (typeof ACCOUNT_LABEL_KEYS)[number];
// `discovered` accounts may be removed again by discovery; `user` accounts never are. A
// `pending` account was added by the user and waits for its first sign-in until `signInUntil`:
// it becomes `user` once discovery finds that sign-in, and is withdrawn when the time is up.
export type AccountOrigin = (typeof ACCOUNT_ORIGINS)[number];

export interface Account {
  id: string;
  providerId: ProviderId;
  // A name the user typed or the source reported; otherwise `labelKey` names the account.
  label?: string;
  labelKey?: AccountLabelKey;
  configDir?: string;
  // Whether `configDir` was chosen explicitly (it then selects a different Claude Keychain item).
  configDirExplicit?: boolean;
  origin?: AccountOrigin;
  // When a pending account's sign-in closes (ms since the epoch); kept so that it outlasts a restart.
  signInUntil?: number;
  email?: string;
  primary: boolean;
  enabled: boolean;
}

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Whether work moves on by itself when an account runs out: never, to the tool's other
// accounts, or also on to the other tools in the fallback order.
export type AutoContinue = (typeof AUTO_CONTINUE)[number];
export type AutomationMode = (typeof AUTOMATION_MODES)[number];
// Whether work moved off a tool's main account goes back to it once that account has room again.
export type ReturnToPrimary = AutomationMode;
// Whether the sessions that ended with the system (a restart, a crash, a power cut) open again.
export type ReopenAfterRestart = AutomationMode;

// A project's own choices. Each one narrows what the app may pick for the project; none of
// them lets work start without verified quota.
export interface ProjectPreference {
  // Absolute and normalized: the folder the project's sessions run in.
  projectDir: string;
  tool?: ProviderId;
  model?: string;
  accountId?: string;
  // `inherit` follows the global setting; `off` wins over a global opt-in.
  autoContinue: AutoContinue | typeof INHERIT;
}

// Local wall-clock times, `HH:MM`. An end before the start runs past midnight.
export interface QuietHours {
  start: string;
  end: string;
}

export interface Settings {
  // Documents written before versioning have none and are read as version 1.
  schemaVersion: number;
  pinned: boolean;
  intervalSeconds: number;
  accounts: Account[];
  dismissedAccountIds: string[];
  providerOrder: ProviderId[];
  // The order the window and the tray list tools in; without one, `providerOrder`.
  homeOrder?: ProviderId[];
  // Tools the window and the tray leave out: their quota is not read and they raise no alerts.
  // At least one tool stays visible.
  hiddenProviders: ProviderId[];
  preferredModels: Partial<Record<ProviderId, string>>;
  language: Language;
  // Notify when an account's tightest limit runs low or becomes available again.
  notifications: boolean;
  // Show a tool's accounts side by side, one column each, instead of picking one to show.
  compareAccounts: boolean;
  autoContinue: AutoContinue;
  returnToPrimary: ReturnToPrimary;
  reopenAfterRestart: ReopenAfterRestart;
  // A system-wide shortcut that shows or hides the window.
  // The window as a small list: one line per tool.
  compact: boolean;
  // Look for a newer release on GitHub once a day.
  checkUpdates: boolean;
  // Ask the tools' status pages whether their service has a problem.
  checkServiceStatus: boolean;
  projectPreferences: ProjectPreference[];
  // The headroom at or below which an account counts as running low.
  lowQuotaPercent: number;
  // No optional notifications in this span; quota is still read and work still continues.
  quietHours?: QuietHours;
  window?: WindowBounds;
}

// Why the settings in use are not simply the saved file: restored from the backup, unreadable
// with no usable backup, or written by a newer version. The last two are never overwritten
// without an explicit reset or import.
export type SettingsNotice = 'recovered' | 'unrecoverable' | 'future';

export type StatusCode = ProviderErrorCode | 'no_limits_reported' | 'no_accounts';
export type AccountStatus = 'pending' | 'ok' | 'stale' | 'no_limits_reported' | ProviderErrorCode;
export type ProviderStatus = AccountStatus | 'unavailable';

export interface MeasuredAccount extends Account {
  status: AccountStatus;
  windows: QuotaWindow[];
  fetchedAt?: string;
  plan?: string;
  // From the latest reading; kept in memory only, never in the settings file.
  signedInAs?: string;
  messageCode?: StatusCode;
}

export interface ProviderState {
  id: ProviderId;
  status: ProviderStatus;
  accounts: MeasuredAccount[];
  fetchedAt?: string;
  messageCode?: StatusCode;
}

// A one-click way to keep working, offered when an account runs low or has quota again, or
// when work was cut off by the system going down.
export interface Suggestion {
  id: string;
  kind: (typeof SUGGESTION_KINDS)[number];
  // The account that ran low, that has quota again, or that ran the session cut off.
  providerId: ProviderId;
  accountId: string;
  remainingPercent: number;
  // Who continues the work; for 'return', the account that is back.
  target: { providerId: ProviderId; accountId: string | null };
  projectDir: string;
  sessionProvider: ProviderId;
}

// Dispatch confirms that the launcher accepted the request, not that the agent ran it.
export interface TransitionRecord {
  id: string;
  suggestionId: string;
  createdAt: number;
  updatedAt: number;
  projectDir: string;
  source: { providerId: ProviderId; accountId: string; sessionId: string };
  target: { providerId: ProviderId; accountId: string | null; sessionId: string | null };
  status: (typeof TRANSITION_STATUSES)[number];
  errorCode: ErrorCode | null;
  // A failed move the app can try again: its offer is still there. One that failed after it
  // went off (never seen running) has none.
  retryable?: boolean;
}

// A problem a tool's maker reports on its status page: the worst state of the components that carry its work.
export interface ServiceIssue {
  providerId: ProviderId;
  status: (typeof SERVICE_STATUSES)[number];
}

// Tokens an account's tool used, as its own logs count them. `input` is what was not read from
// the cache.
export interface TokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ModelTokens {
  // As the log names it; empty when the log never said.
  model: string;
  tokens: TokenTotals;
}

// What an account used since midnight and over the last seven days, the latter by model, most
// used first.
export interface AccountTokens {
  accountId: string;
  today: TokenTotals;
  week: TokenTotals;
  models: ModelTokens[];
}

export interface UpdateInfo {
  version: string;
  // The release page.
  url: string;
  // The release's installer for this machine, for a copy that installs it by hand (an unsigned
  // macOS app opens the disk image for its processor).
  download?: string;
}

// Why this copy cannot install an update itself: a development build, a portable zip, an
// unsigned macOS app, or a platform without an updater.
export type UpdateUnsupportedReason = 'unpackaged' | 'portable' | 'unsigned' | 'platform';

// Installing a newer release from inside the app; `ready` means nothing is downloaded yet.
export type UpdateInstall =
  | { state: 'unsupported'; reason: UpdateUnsupportedReason }
  | { state: 'ready' }
  | { state: 'downloading'; percent: number }
  | { state: 'downloaded'; version: string }
  | { state: 'failed' };

export interface Snapshot {
  providers: ProviderState[];
  refreshing: boolean;
  settings: Settings;
  settingsNotice?: SettingsNotice;
  // Added by the desktop app; the service and the CLI leave them out.
  suggestions?: Suggestion[];
  serviceIssues?: ServiceIssue[];
  update?: UpdateInfo;
  updateInstall?: UpdateInstall;
}

// The diagnostics screen and its report. Accounts appear only as ordinals: nothing here
// carries a label, address, path or token. Each remedy has a message: the one step most
// likely to fix the state.
export type Remedy =
  | 'remedyInstallTool'
  | 'remedyInstallCli'
  | 'remedySignIn'
  | 'remedyOpenApp'
  | 'remedyUnlockKeychain'
  | 'remedyWaitRateLimit'
  | 'remedyCheckNetwork'
  | 'remedyCheckCertificates'
  | 'remedyNotSupported'
  | 'remedyAddAccount'
  | 'remedyWaitForRefresh'
  | 'remedyUpdateTool'
  | 'remedyRetryLater'
  | 'remedyReportIssue';

export interface AccountDiagnostics {
  // 1-based position within the tool, shown as "Account 1".
  ordinal: number;
  enabled: boolean;
  primary: boolean;
  status: AccountStatus;
  messageCode: StatusCode | null;
  // Age of the latest successful reading; null when there is none.
  ageMs: number | null;
  stale: boolean;
  remedy: Remedy | null;
}

export interface ProviderDiagnostics {
  id: ProviderId;
  installed: boolean | null;
  status: ProviderStatus;
  messageCode: StatusCode | null;
  accountCount: number;
  enabledCount: number;
  ageMs: number | null;
  stale: boolean;
  remedy: Remedy | null;
  accounts: AccountDiagnostics[];
}

export interface Diagnostics {
  generatedAt: number;
  intervalSeconds: number;
  refreshing: boolean;
  providers: ProviderDiagnostics[];
}
