// The contract between the renderer and the main process. Each method is invoked on the
// channel `vibe:<name>`; results travel in an envelope so that error codes survive the hop.
import type { Auto, ProviderId } from './catalog.ts';
import type { ErrorPayload, Settings, Snapshot } from './types.ts';

export const IPC_PREFIX = 'vibe:';
export const SNAPSHOT_EVENT = `${IPC_PREFIX}update` as const;

export type LaunchMode = 'terminal' | 'app';
export type ModelCatalog = Record<ProviderId, string[]>;

export interface SessionSummary {
  id: string;
  providerId: ProviderId;
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
}

export interface HandoverRequest {
  projectDir: string;
  fromProvider: ProviderId | Auto;
  toProvider: ProviderId | Auto;
  sessionId: string;
  // The provider of a session picked under "auto"; a session is never read as another tool's.
  sessionProvider?: ProviderId;
  targetModel?: string;
}

export interface HandoverResult {
  from: ProviderId | null;
  to: ProviderId;
  model: string | null;
  mode: LaunchMode;
}

export interface Canceled {
  status: 'canceled';
}

export interface VibeMethods {
  snapshot(): Snapshot;
  refresh(providerId?: ProviderId): Snapshot;
  saveSettings(patch: Partial<Settings>): Snapshot;
  pin(): Snapshot;
  hide(): void;
  dismissAccount(accountId: string): Snapshot;
  restoreDismissedAccounts(): Snapshot;
  signIn(providerId: ProviderId): void;
  addClaudeProfile(): Canceled | { status: 'missing_credentials' | 'exists' | 'added' };
  launchClaude(accountId: string): Canceled | { status: 'launched' };
  getModels(): ModelCatalog;
  previewSmartLaunch(): SmartLaunchPreview;
  smartLaunch(options: { targetModel?: string }): Canceled | ({ status: 'launched'; verified: boolean } & Omit<HandoverResult, 'from'>);
  listSessions(options: { providerId: ProviderId | Auto; projectDir: string }): SessionSummary[];
  selectDirectory(options: { defaultPath?: string }): string | null;
  defaultProjectDir(): string;
  executeHandover(request: HandoverRequest): HandoverResult;
}

export type Channel = keyof VibeMethods;
export type Envelope<T> = { ok: true; value: T } | { ok: false; error: ErrorPayload };

type AsyncMethods = { [K in Channel]: (...args: Parameters<VibeMethods[K]>) => Promise<ReturnType<VibeMethods[K]>> };

export interface VibeApi extends AsyncMethods {
  readonly platform: string;
  onSnapshot(callback: (snapshot: Snapshot) => void): () => void;
}
