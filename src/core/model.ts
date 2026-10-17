// Sanitizing values reported by providers into the quota window contract (see shared/types).
import type { MessageKey } from '../shared/i18n/index.ts';
import type { Amounts, QuotaWindow } from '../shared/types.ts';
import { isObject } from './files.ts';

export const percent = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : null;

const toIso = (date: Date): string | null => (Number.isFinite(date.getTime()) ? date.toISOString() : null);

// An ISO timestamp from a date string or a Date; null for anything else.
export function isoDate(value: unknown): string | null {
  return (typeof value === 'string' && value !== '') || value instanceof Date ? toIso(new Date(value)) : null;
}

export function isoFromUnixSeconds(value: unknown): string | null {
  return typeof value === 'number' && Number.isFinite(value) ? toIso(new Date(value * 1000)) : null;
}

// Control characters never belong in a name, path, id or token the app shows or passes on.
// eslint-disable-next-line no-control-regex -- matching control characters is the purpose
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;
// `search` and `replace` ignore lastIndex, so the shared global pattern carries no state.
export const hasControlChars = (value: string): boolean => value.search(CONTROL_CHARS) !== -1;
const stripControlChars = (value: string): string => value.replace(CONTROL_CHARS, '');

const TEXT_MAX_LENGTH = 160;

export function safeText(value: unknown, fallback = '', max = TEXT_MAX_LENGTH): string {
  return typeof value === 'string' ? stripControlChars(value).slice(0, max) : fallback;
}

// Plan names come from the provider and are shown as a badge; anything unusual is dropped.
const PLAN_NAME = /^[a-zA-Z][a-zA-Z0-9_ -]{0,40}$/;
export function safePlan(value: unknown): string | undefined {
  return typeof value === 'string' && PLAN_NAME.test(value) ? value : undefined;
}

// What a provider parser hands over: our own keys and labels, plus raw source values that
// are validated here.
export interface WindowInput {
  id: string;
  usedPercent?: unknown;
  remainingPercent?: unknown;
  resetsAt?: unknown;
  label?: string;
  labelKey?: MessageKey;
  labelParams?: { n: number };
  detailKey?: MessageKey;
  valueKey?: MessageKey | undefined;
  durationMinutes?: number;
  scope?: string;
  active?: unknown;
  group?: string;
  section?: 'details';
  amounts?: unknown;
}

const AMOUNT_FIELDS = ['used', 'limit', 'remaining', 'bonus'] as const satisfies readonly (keyof Amounts)[];

function safeAmounts(input: unknown): Amounts | undefined {
  if (!isObject(input)) return undefined;
  const amounts: Amounts = {};
  for (const field of AMOUNT_FIELDS) {
    const value = input[field];
    if (typeof value === 'number' && Number.isFinite(value)) amounts[field] = value;
  }
  return Object.keys(amounts).length ? amounts : undefined;
}

// A window with only contract fields. Unknown numbers and resets stay unknown; a used or a
// remaining percentage implies the other.
export function normalizeWindow(input: WindowInput): QuotaWindow {
  let usedPercent = percent(input.usedPercent);
  let remainingPercent = percent(input.remainingPercent);
  if (usedPercent === null && remainingPercent !== null) usedPercent = 100 - remainingPercent;
  if (remainingPercent === null && usedPercent !== null) remainingPercent = 100 - usedPercent;
  const window: QuotaWindow = { id: safeText(input.id, 'unknown'), usedPercent, remainingPercent, resetsAt: isoDate(input.resetsAt) };
  if (input.label) window.label = safeText(input.label);
  if (input.labelKey) window.labelKey = input.labelKey;
  if (input.labelParams) window.labelParams = input.labelParams;
  if (input.detailKey) window.detailKey = input.detailKey;
  if (input.valueKey) window.valueKey = input.valueKey;
  if (input.durationMinutes !== undefined && Number.isFinite(input.durationMinutes)) window.durationMinutes = input.durationMinutes;
  if (input.scope) window.scope = safeText(input.scope);
  if (typeof input.active === 'boolean') window.active = input.active;
  if (input.group === 'team') window.group = 'team';
  if (input.section === 'details') window.section = 'details';
  const amounts = safeAmounts(input.amounts);
  if (amounts) window.amounts = amounts;
  return window;
}
