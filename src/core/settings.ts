import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  ACCOUNT_ID_PATTERN,
  isProviderId,
  MAX_DISMISSED_ACCOUNTS,
  MAX_LABEL_LENGTH,
  MODEL_ID_PATTERN,
  normalizeProviderOrder,
  PROVIDER_IDS,
  providerById,
  type ProviderId
} from '../shared/catalog.ts';
import { DEFAULT_LANGUAGE, isLanguage } from '../shared/i18n/index.ts';
import type { Account, AccountLabelKey, AccountOrigin, Settings, WindowBounds } from '../shared/types.ts';
import { AppError, InvalidSettingsError } from './errors.ts';
import { asArray, isObject, type JsonObject } from './files.ts';
import { hasControlChars } from './model.ts';

const APP_DIR = 'Vibe Usage';
const SETTINGS_FILE = 'settings.json';
const INTERVAL_SECONDS = { min: 30, max: 900, default: 120 };
const MAX_ACCOUNTS = 40;
const MAX_EMAIL_LENGTH = 256;
const MAX_PATH_LENGTH = 1024;
const WINDOW_BOUNDS = { maxOffset: 100000, minWidth: 280, maxWidth: 3000, minHeight: 300, maxHeight: 3000 };
// Account names the app supplies; the UI translates them. A user-typed name replaces the key.
const ACCOUNT_LABEL_KEYS: readonly unknown[] = ['accountA', 'accountB', 'defaultAccount'] satisfies AccountLabelKey[];
const ACCOUNT_ORIGINS: readonly unknown[] = ['discovered', 'user'] satisfies AccountOrigin[];
const isAccountLabelKey = (value: unknown): value is AccountLabelKey => ACCOUNT_LABEL_KEYS.includes(value);
const isAccountOrigin = (value: unknown): value is AccountOrigin => ACCOUNT_ORIGINS.includes(value);
const SETTINGS_KEYS = [
  'pinned',
  'intervalSeconds',
  'accounts',
  'window',
  'dismissedAccountIds',
  'providerOrder',
  'preferredModels',
  'language'
];
const ACCOUNT_KEYS = ['id', 'providerId', 'label', 'labelKey', 'configDir', 'primary', 'enabled', 'configDirExplicit', 'origin', 'email'];
const WINDOW_KEYS = ['x', 'y', 'width', 'height'];

export function defaultSettings(): Settings {
  return {
    pinned: false,
    intervalSeconds: INTERVAL_SECONDS.default,
    accounts: [],
    dismissedAccountIds: [],
    providerOrder: [...PROVIDER_IDS],
    preferredModels: {},
    language: DEFAULT_LANGUAGE
  };
}

// Settings files written by 0.1.x. Each rule rewrites one retired shape into the current one.
const LEGACY_ACCOUNT_LABELS: Readonly<Record<string, AccountLabelKey>> = {
  'Hesap A': 'accountA',
  'Hesap B': 'accountB',
  'Mevcut hesap': 'defaultAccount',
  'Mevcut uygulama': 'defaultAccount'
};
const LEGACY_ANTIGRAVITY_LABEL = /^Antigravity \((.+)\)$/;

function migrateAccount(account: unknown): unknown {
  if (!isObject(account) || typeof account.label !== 'string') return account;
  const labelKey = LEGACY_ACCOUNT_LABELS[account.label];
  if (labelKey) {
    const { label: _legacy, ...rest } = account;
    return { ...rest, labelKey };
  }
  const email = LEGACY_ANTIGRAVITY_LABEL.exec(account.label)?.[1];
  return account.providerId === 'antigravity' && email ? { ...account, label: email } : account;
}

export function migrateSettings(raw: unknown): unknown {
  if (!isObject(raw)) return raw;
  const { fallbackOrder, primaryProvider, ...settings } = raw;
  // `fallbackOrder` and `primaryProvider` duplicated `providerOrder` (primary = first entry).
  if (fallbackOrder !== undefined || primaryProvider !== undefined) {
    const base = Array.isArray(fallbackOrder) ? fallbackOrder : settings.providerOrder;
    settings.providerOrder = normalizeProviderOrder([primaryProvider, ...asArray(base)]);
  }
  // Model preferences for tools that are opened as apps and take no model argument.
  if (isObject(settings.preferredModels)) {
    settings.preferredModels = Object.fromEntries(
      Object.entries(settings.preferredModels).filter(([id]) => !isProviderId(id) || providerById(id).acceptsModel)
    );
  }
  if (Array.isArray(settings.accounts)) settings.accounts = settings.accounts.map(migrateAccount);
  return settings;
}

function assertShape(value: unknown, allowed: readonly string[], reason: string): asserts value is JsonObject {
  if (!isObject(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new InvalidSettingsError(reason);
}

function check(condition: boolean, reason: string): asserts condition {
  if (!condition) throw new InvalidSettingsError(reason);
}

// An absolute, local (no UNC share) directory path without parent traversal.
export function validateConfigDir(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length > MAX_PATH_LENGTH ||
    hasControlChars(value) ||
    /^[/\\]{2}/.test(value) ||
    value.split(/[\\/]/).includes('..') ||
    !path.isAbsolute(value)
  )
    throw new AppError('invalid_path');
  return path.normalize(value);
}

const isOptionalBoolean = (value: unknown): value is boolean | undefined => value === undefined || typeof value === 'boolean';

function validateAccount(input: unknown, ids: Set<string>, primaries: Set<ProviderId>): Account {
  assertShape(input, ACCOUNT_KEYS, 'unknown_account_setting');
  const { id, providerId, labelKey, configDir, configDirExplicit, origin, email, primary, enabled } = input;
  check(typeof id === 'string' && ACCOUNT_ID_PATTERN.test(id) && !ids.has(id) && isProviderId(providerId), 'invalid_account');
  ids.add(id);
  const label = typeof input.label === 'string' ? input.label.slice(0, MAX_LABEL_LENGTH).trim() : '';
  const naming = label ? { label } : isAccountLabelKey(labelKey) ? { labelKey } : null;
  check(naming !== null && !hasControlChars(label), 'invalid_account_label');
  check(typeof primary === 'boolean' && typeof enabled === 'boolean' && isOptionalBoolean(configDirExplicit), 'invalid_account_flags');
  check(origin === undefined || isAccountOrigin(origin), 'invalid_account_flags');
  check(
    email === undefined || (typeof email === 'string' && email.length <= MAX_EMAIL_LENGTH && !hasControlChars(email)),
    'invalid_account_flags'
  );
  check(!(primary && primaries.has(providerId)), 'duplicate_primary');
  if (primary) primaries.add(providerId);
  return {
    id,
    providerId,
    ...naming,
    ...(configDir === undefined ? {} : { configDir: validateConfigDir(configDir) }),
    ...(configDirExplicit === undefined ? {} : { configDirExplicit }),
    ...(origin === undefined ? {} : { origin }),
    ...(email === undefined ? {} : { email: email.toLowerCase().trim() }),
    primary,
    enabled
  };
}

function validateWindow(value: unknown): WindowBounds {
  assertShape(value, WINDOW_KEYS, 'invalid_window');
  const { x, y, width, height } = value;
  const b = WINDOW_BOUNDS;
  const isInteger = (n: unknown): n is number => Number.isInteger(n);
  check(
    isInteger(x) &&
      isInteger(y) &&
      isInteger(width) &&
      isInteger(height) &&
      Math.abs(x) <= b.maxOffset &&
      Math.abs(y) <= b.maxOffset &&
      width >= b.minWidth &&
      width <= b.maxWidth &&
      height >= b.minHeight &&
      height <= b.maxHeight,
    'invalid_window'
  );
  return { x, y, width, height };
}

function validateProviderOrder(value: unknown): ProviderId[] {
  check(
    Array.isArray(value) && value.length <= PROVIDER_IDS.length && new Set(value).size === value.length && value.every(isProviderId),
    'invalid_provider_order'
  );
  return value;
}

function validatePreferredModels(value: unknown): Settings['preferredModels'] {
  assertShape(value, PROVIDER_IDS, 'invalid_preferred_models');
  const models: Settings['preferredModels'] = {};
  for (const [providerId, model] of Object.entries(value)) {
    check(isProviderId(providerId) && typeof model === 'string' && MODEL_ID_PATTERN.test(model), 'invalid_preferred_models');
    models[providerId] = model;
  }
  return models;
}

function validateDismissed(value: unknown): string[] {
  const isAccountId = (id: unknown): id is string => typeof id === 'string' && ACCOUNT_ID_PATTERN.test(id);
  check(Array.isArray(value) && value.every(isAccountId), 'invalid_dismissed_accounts');
  return [...new Set(value)].slice(-MAX_DISMISSED_ACCOUNTS);
}

// Complete settings from a stored or patched document; absent optional fields get defaults.
export function validateSettings(input: unknown): Settings {
  assertShape(input, SETTINGS_KEYS, 'unknown_setting');
  const { pinned, intervalSeconds, accounts, language } = input;
  check(typeof pinned === 'boolean', 'invalid_pinned');
  check(
    typeof intervalSeconds === 'number' &&
      Number.isInteger(intervalSeconds) &&
      intervalSeconds >= INTERVAL_SECONDS.min &&
      intervalSeconds <= INTERVAL_SECONDS.max,
    'invalid_interval'
  );
  check(Array.isArray(accounts) && accounts.length <= MAX_ACCOUNTS, 'invalid_accounts');
  check(language === undefined || isLanguage(language), 'invalid_language');
  const ids = new Set<string>();
  const primaries = new Set<ProviderId>();
  const defaults = defaultSettings();
  return {
    pinned,
    intervalSeconds,
    accounts: accounts.map(account => validateAccount(account, ids, primaries)),
    dismissedAccountIds:
      input.dismissedAccountIds === undefined ? defaults.dismissedAccountIds : validateDismissed(input.dismissedAccountIds),
    providerOrder: input.providerOrder === undefined ? defaults.providerOrder : validateProviderOrder(input.providerOrder),
    preferredModels: input.preferredModels === undefined ? defaults.preferredModels : validatePreferredModels(input.preferredModels),
    language: language ?? defaults.language,
    ...(input.window === undefined ? {} : { window: validateWindow(input.window) })
  };
}

// Where the app keeps its data: VIBE_DATA_DIR, else the platform's per-user app data folder
// (the same folder Electron's `userData` resolves to).
export function appDataDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (env.VIBE_DATA_DIR) return path.resolve(env.VIBE_DATA_DIR);
  const root =
    platform === 'win32'
      ? (env.APPDATA ?? path.join(os.homedir(), 'AppData/Roaming'))
      : platform === 'darwin'
        ? path.join(os.homedir(), 'Library/Application Support')
        : (env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'));
  return path.join(root, APP_DIR);
}

export const settingsPath = (dataDir: string): string => path.join(dataDir, SETTINGS_FILE);

const isMissingFile = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'ENOENT';

// The stored settings, or null when none were saved yet.
export async function loadSettings(file: string): Promise<Settings | null> {
  let text: string;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    throw new InvalidSettingsError('malformed_file');
  }
  return validateSettings(migrateSettings(document));
}

// Validates and writes atomically: a crash mid-write never leaves a truncated file.
export async function saveSettings(file: string, input: unknown): Promise<Settings> {
  const settings = validateSettings(input);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomBytes(8).toString('hex')}.tmp`);
  try {
    const handle = await fsp.open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(settings, null, 2)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fsp.rename(temporary, file);
  } finally {
    await fsp.rm(temporary, { force: true });
  }
  return settings;
}
