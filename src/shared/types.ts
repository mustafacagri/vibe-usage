// The data model the main process, the CLI and the renderer exchange. Text the app words
// itself travels as i18n keys; names reported by a source (models, groups) travel verbatim.
import type { ProviderId } from './catalog.ts';
import type { Language, MessageKey } from './i18n/index.ts';

// Failures the user can act on; each has an `error_<code>` message.
export type AppErrorCode =
  | 'unexpected'
  | 'account_not_found'
  | 'invalid_provider'
  | 'invalid_argument'
  | 'invalid_settings'
  | 'folder_not_found'
  | 'invalid_path'
  | 'session_not_found'
  | 'launch_failed'
  | 'app_not_found'
  | 'sender_rejected'
  | 'no_verified_quota'
  | 'no_cli'
  | 'unknown_command';

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
  amounts?: Amounts;
  // Kept from an earlier reading because the latest response no longer reported it.
  stale?: boolean;
}

export type AccountLabelKey = 'accountA' | 'accountB' | 'defaultAccount';
// `discovered` accounts may be removed again by discovery; `user` accounts never are.
export type AccountOrigin = 'discovered' | 'user';

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

export interface Settings {
  pinned: boolean;
  intervalSeconds: number;
  accounts: Account[];
  dismissedAccountIds: string[];
  providerOrder: ProviderId[];
  preferredModels: Partial<Record<ProviderId, string>>;
  language: Language;
  window?: WindowBounds;
}

export type StatusCode = ProviderErrorCode | 'no_limits_reported' | 'no_accounts';
export type AccountStatus = 'pending' | 'ok' | 'stale' | 'no_limits_reported' | ProviderErrorCode;
export type ProviderStatus = AccountStatus | 'unavailable';

export interface MeasuredAccount extends Account {
  status: AccountStatus;
  windows: QuotaWindow[];
  fetchedAt?: string;
  plan?: string;
  messageCode?: StatusCode;
}

export interface ProviderState {
  id: ProviderId;
  status: ProviderStatus;
  accounts: MeasuredAccount[];
  fetchedAt?: string;
  messageCode?: StatusCode;
}

export interface Snapshot {
  providers: ProviderState[];
  refreshing: boolean;
  settings: Settings;
}
