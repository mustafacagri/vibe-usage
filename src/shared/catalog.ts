// Single source of truth for identifiers shared by the main process, the CLI and the renderer.
import type { MessageKey } from './i18n/index.ts';

// The product name: window and tray titles, the data folder, launched terminals and briefs.
export const APP_NAME = 'Vibe Usage';
// The product's name in identifiers: its repository, files it saves, and how it names itself to services.
export const APP_SLUG = 'vibe-usage';
// The GitHub repository releases are published to (`owner/name`).
export const APP_REPOSITORY = `mustafacagri/${APP_SLUG}`;

export const PROVIDER_IDS = ['claude', 'codex', 'cursor', 'antigravity', 'copilot'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export interface Provider {
  readonly id: ProviderId;
  readonly name: string;
  readonly glyph: string;
  // Whether the tool can be started with a chosen model. Antigravity opens as a desktop app,
  // which takes no model argument.
  readonly acceptsModel: boolean;
  // Whether the app can start work in the tool, so a handover or a fallback may pick it.
  readonly runsWork: boolean;
}

const PROVIDER_DETAILS: Readonly<Record<ProviderId, Omit<Provider, 'id'>>> = {
  claude: { name: 'Claude', glyph: '◈', acceptsModel: true, runsWork: true },
  codex: { name: 'Codex', glyph: '✺', acceptsModel: true, runsWork: true },
  cursor: { name: 'Cursor', glyph: '✦', acceptsModel: true, runsWork: true },
  antigravity: { name: 'Antigravity', glyph: '▲', acceptsModel: false, runsWork: true },
  // Only its quota is read: it lives inside the editors, so the app starts nothing.
  copilot: { name: 'GitHub Copilot', glyph: '◐', acceptsModel: false, runsWork: false }
};

export const PROVIDERS: readonly Provider[] = PROVIDER_IDS.map(id => ({ id, ...PROVIDER_DETAILS[id] }));
export const WORK_PROVIDER_IDS: readonly ProviderId[] = PROVIDER_IDS.filter(id => PROVIDER_DETAILS[id].runsWork);

// Tools that keep one sign-in per profile folder, the default one in the home directory.
// Further accounts live in sibling folders (`.codex-work`) or in any folder the user adds.
export const PROFILE_DIRS = { claude: '.claude', codex: '.codex' } as const satisfies Partial<Record<ProviderId, string>>;
export type ProfileProviderId = keyof typeof PROFILE_DIRS;
export const isProfileProvider = (id: ProviderId): id is ProfileProviderId => Object.hasOwn(PROFILE_DIRS, id);
export const PROFILE_PROVIDER_IDS: readonly ProfileProviderId[] = PROVIDER_IDS.filter(isProfileProvider);
// The variable that points each of those tools at a profile folder other than the default one.
export const PROFILE_ENV = { claude: 'CLAUDE_CONFIG_DIR', codex: 'CODEX_HOME' } as const satisfies Record<ProfileProviderId, string>;

export const AUTO = 'auto';
export type Auto = typeof AUTO;

export const ACCOUNT_ID_PATTERN = /^[a-zA-Z0-9:@._+-]{1,120}$/;
// An account's id: its tool, and a key that tells it from the tool's other accounts.
export const accountId = (providerId: ProviderId, key: string): string => `${providerId}:${key}`;
// The key of the account a tool uses when nothing selects another.
export const DEFAULT_ACCOUNT_KEY = 'default';
export const MAX_DISMISSED_ACCOUNTS = 100;
export const MAX_LABEL_LENGTH = 80;
// A model id as CLIs accept it (`opus`, `gpt-5.6-terra`, `sonnet[1m]`). It must start
// alphanumeric so that it can never be read as a command-line flag.
export const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:/[\]-]{0,99}$/;
// Claude Code's `--permission-mode` and `--effort` values.
export const CLAUDE_PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions'] as const;
export type ClaudePermissionMode = (typeof CLAUDE_PERMISSION_MODES)[number];
export const CLAUDE_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ClaudeEffortLevel = (typeof CLAUDE_EFFORT_LEVELS)[number];

// Whether `value` is one of `values`: the guard for every list of literals below.
export const isOneOf = <T>(values: readonly T[], value: unknown): value is T => values.some(entry => entry === value);

// Each list is the one owner of its values; the type of the same name in types.ts derives from it.
// Account names the app supplies; the UI translates them.
export const ACCOUNT_LABEL_KEYS = ['accountA', 'accountB', 'defaultAccount', 'newAccount'] as const satisfies readonly MessageKey[];
export const ACCOUNT_ORIGINS = ['discovered', 'user', 'pending'] as const;
export const AUTO_CONTINUE = ['off', 'accounts', 'tools'] as const;
// What a project's own choice is when it leaves the matter to the app-wide setting.
export const INHERIT = 'inherit';
// How the app takes a step it may take by itself: never, after asking, or on its own.
export const AUTOMATION_MODES = ['off', 'ask', 'auto'] as const;
// What a status page says of a component that is not working, from the mildest to the worst;
// planned maintenance is none of them.
export const SERVICE_STATUSES = ['degraded_performance', 'partial_outage', 'major_outage'] as const;
export const SUGGESTION_KINDS = ['low', 'return', 'reopen'] as const;
export const TRANSITION_STATUSES = ['offered', 'dispatching', 'dispatched', 'failed', 'interrupted', 'dismissed'] as const;

// A limit at or below this share is shown as low and, when the user opted in, notified.
export const LOW_QUOTA_PERCENT = 20;
// The values each numeric setting may take, and the ones the window offers; a saved value
// outside the offered ones (from an imported file) is offered too.
export const LOW_QUOTA_RANGE = { min: 1, max: 99, choices: [5, 10, 15, 20, 25, 30, 40, 50] } as const;
export const REFRESH_INTERVAL_SECONDS = { min: 30, max: 900, default: 120, choices: [60, 120, 300, 600] } as const;

export const MINUTES = { HOUR: 60, DAY: 1440, FIVE_HOURS: 300, WEEK: 10080 } as const;
// The same units in milliseconds, for times and ages.
export const DURATION_MS = { SECOND: 1000, MINUTE: 60_000, HOUR: 3_600_000, DAY: 86_400_000, WEEK: 604_800_000 } as const;

// What Claude Code sets for the processes it starts. A Claude Code that inherits them takes itself
// for a child session of another one and saves nothing: no transcript, no entry in the profile's
// session list. The app may itself run under Claude Code (started from one of its terminals), so
// they are never passed on.
export const CLAUDE_SESSION_ENV_KEYS: readonly string[] = [
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
  'AI_AGENT',
  'TRACEPARENT'
];

// Environment variables that would make a launched CLI or a quota probe use credentials,
// endpoints or profiles other than the account the user selected.
export const CREDENTIAL_ENV_KEYS: readonly string[] = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_PROFILE',
  'ANTHROPIC_VERTEX_PROJECT_ID',
  'ANTHROPIC_BEDROCK_BASE_URL',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_SECURESTORAGE_CONFIG_DIR',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  PROFILE_ENV.codex,
  'CODEX_API_KEY',
  'CODEX_ACCESS_TOKEN',
  'ACCESS_TOKEN',
  'CURSOR_API_KEY'
];

export function providerById(id: ProviderId): Provider {
  return { id, ...PROVIDER_DETAILS[id] };
}

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && Object.hasOwn(PROVIDER_DETAILS, value);
}

// A complete, duplicate-free order of `ids` (the tools work moves between unless told otherwise):
// known entries first, then any tool left out.
export function normalizeProviderOrder(order: unknown, ids: readonly ProviderId[] = WORK_PROVIDER_IDS): ProviderId[] {
  const known = Array.isArray(order) ? order.filter(id => isOneOf(ids, id)) : [];
  return [...new Set([...known, ...ids])];
}

// The order the window and the tray list tools in: the user's own, else the fallback order.
export const displayOrder = (settings: { homeOrder?: unknown; providerOrder: unknown }): ProviderId[] =>
  normalizeProviderOrder(settings.homeOrder ?? settings.providerOrder, PROVIDER_IDS);

// The tools the window and the tray show, in display order.
export const visibleProviders = (settings: {
  homeOrder?: unknown;
  providerOrder: unknown;
  hiddenProviders?: readonly ProviderId[];
}): ProviderId[] => displayOrder(settings).filter(id => !settings.hiddenProviders?.includes(id));

export interface PeriodLabel {
  labelKey: MessageKey;
  labelParams?: { n: number };
  durationMinutes?: number;
}

// Semantic label for a quota window length; wording lives in i18n.
export function durationLabel(minutes: unknown): PeriodLabel {
  if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes <= 0) return { labelKey: 'labelNoPeriodReported' };
  if (minutes === MINUTES.WEEK) return { labelKey: 'labelWeekly', durationMinutes: minutes };
  if (minutes >= 2 * MINUTES.DAY && minutes % MINUTES.DAY === 0)
    return { labelKey: 'labelNDays', labelParams: { n: minutes / MINUTES.DAY }, durationMinutes: minutes };
  if (minutes % MINUTES.HOUR === 0)
    return { labelKey: 'labelNHours', labelParams: { n: minutes / MINUTES.HOUR }, durationMinutes: minutes };
  return { labelKey: 'labelNMins', labelParams: { n: minutes }, durationMinutes: minutes };
}
