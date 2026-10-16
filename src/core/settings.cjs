'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const {
  PROVIDER_IDS,
  ACCOUNT_ID_PATTERN,
  MODEL_ID_PATTERN,
  MAX_DISMISSED_ACCOUNTS,
  MAX_LABEL_LENGTH,
  isProviderId,
  providerById,
  normalizeProviderOrder
} = require('../catalog.cjs');
const { SUPPORTED_LANGUAGES, DEFAULT_LANGUAGE } = require('../ui/i18n.js');
const { AppError } = require('./errors.cjs');
const { hasControlChars } = require('./model.cjs');

const INTERVAL_SECONDS = { min: 30, max: 900, default: 120 };
const MAX_ACCOUNTS = 40;
const MAX_EMAIL_LENGTH = 256;
const MAX_PATH_LENGTH = 1024;
const WINDOW_BOUNDS = { maxOffset: 100000, minWidth: 280, maxWidth: 3000, minHeight: 300, maxHeight: 3000 };
// Account names the app supplies; the UI translates them. A user-typed name replaces the key.
const ACCOUNT_LABEL_KEYS = ['accountA', 'accountB', 'defaultAccount'];
const ACCOUNT_ORIGINS = ['discovered', 'user'];

const DEFAULT_SETTINGS = Object.freeze({
  pinned: false,
  intervalSeconds: INTERVAL_SECONDS.default,
  accounts: [],
  dismissedAccountIds: [],
  providerOrder: [...PROVIDER_IDS],
  preferredModels: {},
  language: DEFAULT_LANGUAGE
});

// Settings files written by 0.1.x. Each rule rewrites one retired shape into the current one.
const LEGACY_ACCOUNT_LABELS = {
  'Hesap A': 'accountA',
  'Hesap B': 'accountB',
  'Mevcut hesap': 'defaultAccount',
  'Mevcut uygulama': 'defaultAccount'
};
const LEGACY_ANTIGRAVITY_LABEL = /^Antigravity \((.+)\)$/;
function migrateSettings(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const { fallbackOrder, primaryProvider, ...settings } = raw;
  // `fallbackOrder` and `primaryProvider` duplicated `providerOrder` (primary = first entry).
  if (fallbackOrder !== undefined || primaryProvider !== undefined) {
    const base = Array.isArray(fallbackOrder) ? fallbackOrder : settings.providerOrder;
    settings.providerOrder = normalizeProviderOrder([primaryProvider, ...(Array.isArray(base) ? base : [])]);
  }
  // Model preferences for tools that are opened as apps and take no model argument.
  if (settings.preferredModels && typeof settings.preferredModels === 'object') {
    settings.preferredModels = Object.fromEntries(
      Object.entries(settings.preferredModels).filter(([id]) => !isProviderId(id) || providerById(id).acceptsModel)
    );
  }
  if (Array.isArray(settings.accounts)) {
    settings.accounts = settings.accounts.map(account => {
      if (!account || typeof account.label !== 'string') return account;
      if (LEGACY_ACCOUNT_LABELS[account.label]) {
        const { label, ...rest } = account;
        return { ...rest, labelKey: LEGACY_ACCOUNT_LABELS[label] };
      }
      const email = LEGACY_ANTIGRAVITY_LABEL.exec(account.label);
      return account.providerId === 'antigravity' && email ? { ...account, label: email[1] } : account;
    });
  }
  return settings;
}

function assertKeys(value, allowed, error) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !allowed.includes(k)))
    throw new Error(error);
}
function validateConfigDir(value) {
  // Absolute, local (no UNC share) and without parent traversal.
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
function validateAccount(a, ids, primaries) {
  assertKeys(
    a,
    ['id', 'providerId', 'label', 'labelKey', 'configDir', 'primary', 'enabled', 'configDirExplicit', 'origin', 'email'],
    'unknown_account_setting'
  );
  if (typeof a.id !== 'string' || !ACCOUNT_ID_PATTERN.test(a.id) || ids.has(a.id) || !isProviderId(a.providerId))
    throw new Error('invalid_account');
  ids.add(a.id);
  const label = typeof a.label === 'string' ? a.label.slice(0, MAX_LABEL_LENGTH).trim() : '';
  if (label ? hasControlChars(label) : !ACCOUNT_LABEL_KEYS.includes(a.labelKey)) throw new Error('invalid_account_label');
  if (typeof a.primary !== 'boolean' || typeof a.enabled !== 'boolean') throw new Error('invalid_account_flags');
  if (a.configDirExplicit !== undefined && typeof a.configDirExplicit !== 'boolean') throw new Error('invalid_account_flags');
  if (a.origin !== undefined && !ACCOUNT_ORIGINS.includes(a.origin)) throw new Error('invalid_account_flags');
  if (a.email !== undefined && (typeof a.email !== 'string' || a.email.length > MAX_EMAIL_LENGTH || hasControlChars(a.email)))
    throw new Error('invalid_account_flags');
  if (a.primary && primaries.has(a.providerId)) throw new Error('duplicate_primary');
  if (a.primary) primaries.add(a.providerId);
  return {
    id: a.id,
    providerId: a.providerId,
    ...(label ? { label } : { labelKey: a.labelKey }),
    ...(a.configDir !== undefined ? { configDir: validateConfigDir(a.configDir) } : {}),
    ...(a.configDirExplicit !== undefined ? { configDirExplicit: a.configDirExplicit } : {}),
    ...(a.origin !== undefined ? { origin: a.origin } : {}),
    ...(a.email !== undefined ? { email: a.email.toLowerCase().trim() } : {}),
    primary: a.primary,
    enabled: a.enabled
  };
}
function validateWindow(value) {
  assertKeys(value, ['x', 'y', 'width', 'height'], 'invalid_window');
  const { x, y, width, height } = value;
  const b = WINDOW_BOUNDS;
  if (
    ![x, y, width, height].every(Number.isInteger) ||
    Math.abs(x) > b.maxOffset ||
    Math.abs(y) > b.maxOffset ||
    width < b.minWidth ||
    width > b.maxWidth ||
    height < b.minHeight ||
    height > b.maxHeight
  )
    throw new Error('invalid_window');
  return { x, y, width, height };
}
function validateSettings(input) {
  assertKeys(
    input,
    ['pinned', 'intervalSeconds', 'accounts', 'window', 'dismissedAccountIds', 'providerOrder', 'preferredModels', 'language'],
    'unknown_setting'
  );
  if (typeof input.pinned !== 'boolean') throw new Error('invalid_pinned');
  if (
    !Number.isInteger(input.intervalSeconds) ||
    input.intervalSeconds < INTERVAL_SECONDS.min ||
    input.intervalSeconds > INTERVAL_SECONDS.max
  )
    throw new Error('invalid_interval');
  if (!Array.isArray(input.accounts) || input.accounts.length > MAX_ACCOUNTS) throw new Error('invalid_accounts');
  if (input.language !== undefined && !SUPPORTED_LANGUAGES.includes(input.language)) throw new Error('invalid_settings');
  if (
    input.dismissedAccountIds !== undefined &&
    (!Array.isArray(input.dismissedAccountIds) ||
      input.dismissedAccountIds.some(id => typeof id !== 'string' || !ACCOUNT_ID_PATTERN.test(id)))
  )
    throw new Error('invalid_settings');
  if (
    input.providerOrder !== undefined &&
    (!Array.isArray(input.providerOrder) ||
      input.providerOrder.length > PROVIDER_IDS.length ||
      new Set(input.providerOrder).size !== input.providerOrder.length ||
      !input.providerOrder.every(isProviderId))
  )
    throw new Error('invalid_settings');
  if (input.preferredModels !== undefined) {
    if (!input.preferredModels || typeof input.preferredModels !== 'object' || Array.isArray(input.preferredModels))
      throw new Error('invalid_settings');
    for (const [provider, model] of Object.entries(input.preferredModels)) {
      if (!isProviderId(provider) || typeof model !== 'string' || !MODEL_ID_PATTERN.test(model)) throw new Error('invalid_settings');
    }
  }
  const ids = new Set(),
    primaries = new Set();
  return {
    pinned: input.pinned,
    intervalSeconds: input.intervalSeconds,
    accounts: input.accounts.map(account => validateAccount(account, ids, primaries)),
    ...(input.language !== undefined ? { language: input.language } : {}),
    ...(input.dismissedAccountIds !== undefined
      ? { dismissedAccountIds: [...new Set(input.dismissedAccountIds)].slice(-MAX_DISMISSED_ACCOUNTS) }
      : {}),
    ...(input.providerOrder !== undefined ? { providerOrder: input.providerOrder } : {}),
    ...(input.preferredModels !== undefined ? { preferredModels: input.preferredModels } : {}),
    ...(input.window !== undefined ? { window: validateWindow(input.window) } : {})
  };
}
function defaultSettingsPath() {
  if (process.env.NODE_TEST_CONTEXT) {
    throw new Error('test_suite_cannot_use_default_settings_path');
  }
  const root =
    process.platform === 'win32'
      ? process.env.APPDATA || path.join(os.homedir(), 'AppData/Roaming')
      : process.platform === 'darwin'
        ? path.join(os.homedir(), 'Library/Application Support')
        : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(root, 'Vibe Usage', 'settings.json');
}
async function loadSettings(file = defaultSettingsPath()) {
  try {
    return validateSettings(migrateSettings(JSON.parse(await fs.readFile(file, 'utf8'))));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error('invalid_settings_file');
  }
}
async function saveSettings(file, input) {
  const settings = validateSettings(input);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomBytes(8).toString('hex')}.tmp`);
  let handle;
  try {
    handle = await fs.open(temporary, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(settings, null, 2) + '\n', 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporary, file);
  } finally {
    if (handle) await handle.close();
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
  return settings;
}
module.exports = {
  DEFAULT_SETTINGS,
  validateSettings,
  migrateSettings,
  validateConfigDir,
  defaultSettingsPath,
  loadSettings,
  saveSettings
};
