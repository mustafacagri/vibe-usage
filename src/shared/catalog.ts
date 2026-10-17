// Single source of truth for identifiers shared by the main process, the CLI and the renderer.
import type { MessageKey } from './i18n/index.ts';

export const PROVIDER_IDS = ['claude', 'codex', 'cursor', 'antigravity'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export interface Provider {
  readonly id: ProviderId;
  readonly name: string;
  readonly glyph: string;
  // Whether the tool can be started with a chosen model. Antigravity opens as a desktop app,
  // which takes no model argument.
  readonly acceptsModel: boolean;
}

const PROVIDER_DETAILS: Readonly<Record<ProviderId, Omit<Provider, 'id'>>> = {
  claude: { name: 'Claude', glyph: '◈', acceptsModel: true },
  codex: { name: 'Codex', glyph: '✺', acceptsModel: true },
  cursor: { name: 'Cursor', glyph: '✦', acceptsModel: true },
  antigravity: { name: 'Antigravity', glyph: '▲', acceptsModel: false }
};

export const PROVIDERS: readonly Provider[] = PROVIDER_IDS.map(id => ({ id, ...PROVIDER_DETAILS[id] }));

export const AUTO = 'auto';
export type Auto = typeof AUTO;

export const ACCOUNT_ID_PATTERN = /^[a-zA-Z0-9:@._+-]{1,120}$/;
export const MAX_DISMISSED_ACCOUNTS = 100;
export const MAX_LABEL_LENGTH = 80;
// A model id as CLIs accept it (`opus`, `gpt-5.6-terra`, `sonnet[1m]`). It must start
// alphanumeric so that it can never be read as a command-line flag.
export const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:/[\]-]{0,99}$/;

export const MINUTES = { HOUR: 60, DAY: 1440, FIVE_HOURS: 300, WEEK: 10080 } as const;

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
  'CODEX_HOME',
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

// A complete, duplicate-free order: known entries first, then any provider left out.
export function normalizeProviderOrder(order: unknown): ProviderId[] {
  const known = Array.isArray(order) ? order.filter(isProviderId) : [];
  return [...new Set([...known, ...PROVIDER_IDS])];
}

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
