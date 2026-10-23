// The contract between the renderer and the main process. Each method is invoked on the
// channel `vibe:<name>`; results travel in an envelope so that error codes survive the hop.
import type { Auto, ProfileProviderId, ProviderId } from './catalog.ts';
import type { AccountTokens, Diagnostics, ErrorPayload, PassedOver, QuietHours, Settings, Snapshot, TransitionRecord } from './types.ts';

export const IPC_PREFIX = 'vibe:';
export const SNAPSHOT_EVENT = `${IPC_PREFIX}update` as const;

export type LaunchMode = 'terminal' | 'app';
// A settings change; null turns the quiet hours off.
export type SettingsPatch = Partial<Omit<Settings, 'quietHours'>> & { quietHours?: QuietHours | null };
export type ModelCatalog = Record<ProviderId, string[]>;

// Opaque identity of a discovered physical session and the version the user reviewed.
// These are matched against trusted discovery; neither value is a renderer-supplied path.
export interface SessionSourceRef {
  id: string;
  version: string;
  accountId?: string;
}

export interface SessionSummary {
  id: string;
  providerId: ProviderId;
  source: SessionSourceRef;
  // Empty when the session has no usable title; the UI words it.
  title: string;
  updatedAt: number;
  sizeBytes: number;
  turnCount: number;
  model: string;
}

export interface SmartLaunchPreview {
  providerId: ProviderId;
  verified: boolean;
  isFallback: boolean;
  headroomPercent: number | null;
  model: string | null;
  // The tools ahead of it in the order and why each was passed over; every tool when unverified.
  passedOver: PassedOver[];
}

export interface HandoverRequest {
  projectDir: string;
  fromProvider: ProviderId | Auto;
  toProvider: ProviderId | Auto;
  sessionId: string;
  // The provider of a session picked under "auto"; a session is never read as another tool's.
  sessionProvider?: ProviderId;
  targetModel?: string;
  sourceAccountId?: string | undefined;
  // Null pins a preview that found no session; undefined keeps automatic CLI discovery.
  sessionSource?: SessionSourceRef | null;
}

// What a handover would do, shown before anything is written or started. Under an automatic
// session choice it names the session it resolved: executing with that id and provider reads
// that session or fails, it never switches to a newer one.
export interface HandoverPreview {
  from: ProviderId | null;
  to: ProviderId;
  model: string | null;
  // Null when the project has no session to hand over.
  sessionId: string | null;
  sessionProvider: ProviderId | null;
  sessionSource?: SessionSourceRef;
  // The exact brief execution writes (its generation time aside).
  brief: string;
}

export interface HandoverResult {
  from: ProviderId | null;
  to: ProviderId;
  model: string | null;
  mode: LaunchMode;
}

// Whether the app opens at login. The operating system holds the setting; `supported` is false
// where the app cannot register itself (an unpackaged development build).
export interface LoginItem {
  supported: boolean;
  enabled: boolean;
}

// Quota readings of one window of one account over the last week: [time in ms, used percent].
export interface HistorySeries {
  accountId: string;
  windowId: string;
  samples: (readonly [number, number])[];
}

export interface ContinueOutcome {
  status: 'continued';
  to: ProviderId;
  accountId: string | null;
  // The session itself continues (rather than a new one from a handover brief).
  resumed: boolean;
  mode: LaunchMode;
}

export interface Canceled {
  status: 'canceled';
}

export interface VibeMethods {
  snapshot(): Snapshot;
  refresh(providerId?: ProviderId): Snapshot;
  saveSettings(patch: SettingsPatch): Snapshot;
  pin(): Snapshot;
  loginItem(): LoginItem;
  setLoginItem(enabled: boolean): LoginItem;
  hide(): void;
  dismissAccount(accountId: string): Snapshot;
  // Settings as a file to keep or carry to another computer; reset returns to the defaults.
  exportSettings(): Canceled | { status: 'saved' };
  importSettings(): Canceled | { status: 'imported' };
  resetSettings(): Snapshot;
  dismissSettingsNotice(): Snapshot;
  diagnostics(): Diagnostics;
  // The diagnostics as an English report without names, addresses or paths, to paste or save.
  copyDiagnostics(): void;
  exportDiagnostics(): Canceled | { status: 'saved' };
  restoreDismissedAccounts(): Snapshot;
  // Signs in the given account's profile, or the tool's default profile.
  signIn(providerId: ProviderId, accountId?: string): void;
  // Adds an account in a new profile folder and opens the tool's sign-in for it.
  addAccount(providerId: ProfileProviderId): Snapshot;
  launchClaude(accountId: string): Canceled | { status: 'launched' };
  getModels(): ModelCatalog;
  previewSmartLaunch(): SmartLaunchPreview;
  smartLaunch(): Canceled | ({ status: 'launched'; verified: boolean } & Omit<HandoverResult, 'from'>);
  listSessions(options: { providerId: ProviderId | Auto; projectDir: string }): SessionSummary[];
  selectDirectory(options: { defaultPath?: string }): string | null;
  defaultProjectDir(): string;
  // The brief and the target a handover would use; nothing is written or started.
  previewHandover(request: HandoverRequest): HandoverPreview;
  executeHandover(request: HandoverRequest): HandoverResult;
  // Acts on a suggestion from the snapshot: the work continues where it suggests.
  continueWork(suggestionId: string): Canceled | ContinueOutcome;
  dismissSuggestion(suggestionId: string): Snapshot;
  history(): HistorySeries[];
  // What each account's tool used, from its own logs; the first call may take a while.
  tokenUsage(): AccountTokens[];
  transitions(): TransitionRecord[];
  retryTransition(id: string): Canceled | ContinueOutcome;
  // Opens the page of the newer release the snapshot reports.
  openUpdate(): void;
  // Downloads the newer release, then restarts into it; only where the copy can update itself.
  downloadUpdate(): void;
  installUpdate(): void;
  // In the compact view, the window takes the height of its content.
  fitHeight(height: number): void;
}

export type Channel = keyof VibeMethods;
export type Envelope<T> = { ok: true; value: T } | { ok: false; error: ErrorPayload };

type AsyncMethods = { [K in Channel]: (...args: Parameters<VibeMethods[K]>) => Promise<ReturnType<VibeMethods[K]>> };

// The systems Node reports as `process.platform`. Shared code has no Node types; the preload
// assigns process.platform to it, which checks the two lists agree.
export type Platform = 'aix' | 'android' | 'cygwin' | 'darwin' | 'freebsd' | 'haiku' | 'linux' | 'netbsd' | 'openbsd' | 'sunos' | 'win32';

export interface VibeApi extends AsyncMethods {
  readonly platform: Platform;
  onSnapshot(callback: (snapshot: Snapshot) => void): () => void;
}
