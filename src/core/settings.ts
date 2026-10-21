import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  ACCOUNT_ID_PATTERN,
  ACCOUNT_LABEL_KEYS,
  ACCOUNT_ORIGINS,
  APP_NAME,
  AUTO_CONTINUE,
  AUTOMATION_MODES,
  INHERIT,
  isOneOf,
  isProviderId,
  LOW_QUOTA_PERCENT,
  LOW_QUOTA_RANGE,
  MAX_DISMISSED_ACCOUNTS,
  MAX_LABEL_LENGTH,
  MODEL_ID_PATTERN,
  PROVIDER_IDS,
  WORK_PROVIDER_IDS,
  providerById,
  REFRESH_INTERVAL_SECONDS,
  type ProviderId
} from '../shared/catalog.ts';
import { DEFAULT_LANGUAGE, isLanguage } from '../shared/i18n/index.ts';
import type { Account, ProjectPreference, QuietHours, Settings, SettingsNotice, WindowBounds } from '../shared/types.ts';
import { AppError, InvalidSettingsError, systemErrorCode } from './errors.ts';
import { isObject, parseJson, pathKey, samePath, writeFileAtomic, type JsonObject } from './files.ts';
import { hasControlChars, normalizeEmail } from './model.ts';
import { withSettingsLock } from './settings-lock.ts';

const SETTINGS_SCHEMA_VERSION = 1;
const SETTINGS_FILE = 'settings.json';
// The last document that validated before it was replaced.
const BACKUP_SUFFIX = '.bak';
// An unreadable document is kept beside the new one under this suffix and a timestamp.
const DAMAGED_SUFFIX = '.damaged-';
const MAX_PROJECT_PREFERENCES = 100;
const TIME_OF_DAY = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const MAX_ACCOUNTS = 40;
const MAX_EMAIL_LENGTH = 256;
const MAX_PATH_LENGTH = 1024;
const WINDOW_BOUNDS = { maxOffset: 100000, minWidth: 280, maxWidth: 3000, minHeight: 300, maxHeight: 3000 };
const SETTINGS_KEYS = [
  'schemaVersion',
  'pinned',
  'intervalSeconds',
  'accounts',
  'window',
  'dismissedAccountIds',
  'providerOrder',
  'homeOrder',
  'hiddenProviders',
  'preferredModels',
  'language',
  'notifications',
  'compareAccounts',
  'autoContinue',
  'returnToPrimary',
  'reopenAfterRestart',
  'compact',
  'checkUpdates',
  'checkServiceStatus',
  'projectPreferences',
  'lowQuotaPercent',
  'quietHours'
];
const PREFERENCE_KEYS = ['projectDir', 'tool', 'model', 'accountId', 'autoContinue'];
const QUIET_HOURS_KEYS = ['start', 'end'];
const ACCOUNT_KEYS = [
  'id',
  'providerId',
  'label',
  'labelKey',
  'configDir',
  'primary',
  'enabled',
  'configDirExplicit',
  'origin',
  'signInUntil',
  'email'
];
const WINDOW_KEYS = ['x', 'y', 'width', 'height'];

export function defaultSettings(): Settings {
  return {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    pinned: false,
    intervalSeconds: REFRESH_INTERVAL_SECONDS.default,
    accounts: [],
    dismissedAccountIds: [],
    providerOrder: [...WORK_PROVIDER_IDS],
    hiddenProviders: [],
    preferredModels: {},
    language: DEFAULT_LANGUAGE,
    notifications: false,
    compareAccounts: false,
    autoContinue: 'off',
    returnToPrimary: 'ask',
    reopenAfterRestart: 'ask',
    compact: false,
    checkUpdates: true,
    checkServiceStatus: true,
    projectPreferences: [],
    lowQuotaPercent: LOW_QUOTA_PERCENT
  };
}

function assertShape(value: unknown, allowed: readonly string[], reason: string): asserts value is JsonObject {
  if (!isObject(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new InvalidSettingsError(reason);
}

function check(condition: boolean, reason: string): asserts condition {
  if (!condition) throw new InvalidSettingsError(reason);
}

// An absolute, local (no UNC share) directory path without parent traversal. On Windows it
// names its drive: `\Repo` would depend on the current one.
export function validateConfigDir(value: unknown, platform: NodeJS.Platform = process.platform): string {
  if (
    typeof value !== 'string' ||
    value.length > MAX_PATH_LENGTH ||
    hasControlChars(value) ||
    /^[/\\]{2}/.test(value) ||
    value.split(/[\\/]/).includes('..') ||
    !path.isAbsolute(value) ||
    (platform === 'win32' && !/^[A-Za-z]:[\\/]/.test(value))
  )
    throw new AppError('invalid_path');
  return path.normalize(value);
}

const isOptionalBoolean = (value: unknown): value is boolean | undefined => value === undefined || typeof value === 'boolean';

function validateAccount(input: unknown, ids: Set<string>, primaries: Set<ProviderId>): Account {
  assertShape(input, ACCOUNT_KEYS, 'unknown_account_setting');
  const { id, providerId, labelKey, configDir, configDirExplicit, origin, signInUntil, email, primary, enabled } = input;
  check(typeof id === 'string' && ACCOUNT_ID_PATTERN.test(id) && !ids.has(id) && isProviderId(providerId), 'invalid_account');
  ids.add(id);
  const label = typeof input.label === 'string' ? input.label.slice(0, MAX_LABEL_LENGTH).trim() : '';
  // A typed name is shown instead of the app's key, which stays: clearing the name brings it
  // back. Without either, the account is shown by its sign-in.
  check(labelKey === undefined || isOneOf(ACCOUNT_LABEL_KEYS, labelKey), 'invalid_account_label');
  check(!hasControlChars(label), 'invalid_account_label');
  check(typeof primary === 'boolean' && typeof enabled === 'boolean' && isOptionalBoolean(configDirExplicit), 'invalid_account_flags');
  check(origin === undefined || isOneOf(ACCOUNT_ORIGINS, origin), 'invalid_account_flags');
  check(signInUntil === undefined || (typeof signInUntil === 'number' && Number.isFinite(signInUntil)), 'invalid_account_flags');
  check(
    email === undefined || (typeof email === 'string' && email.length <= MAX_EMAIL_LENGTH && !hasControlChars(email)),
    'invalid_account_flags'
  );
  check(!(primary && primaries.has(providerId)), 'duplicate_primary');
  if (primary) primaries.add(providerId);
  return {
    id,
    providerId,
    ...(label ? { label } : {}),
    ...(isOneOf(ACCOUNT_LABEL_KEYS, labelKey) ? { labelKey } : {}),
    ...(configDir === undefined ? {} : { configDir: validateConfigDir(configDir) }),
    ...(configDirExplicit === undefined ? {} : { configDirExplicit }),
    ...(origin === undefined ? {} : { origin }),
    // Only a pending account waits for a sign-in; without a time, its sign-in is closed.
    ...(origin === 'pending' && typeof signInUntil === 'number' ? { signInUntil } : {}),
    ...(email === undefined ? {} : { email: normalizeEmail(email) }),
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

// A duplicate-free list of tools from `ids`.
function validateToolList(
  value: unknown,
  ids: readonly ProviderId[],
  code: 'invalid_provider_order' | 'invalid_hidden_providers'
): ProviderId[] {
  check(
    Array.isArray(value) &&
      value.length <= ids.length &&
      new Set(value).size === value.length &&
      value.every((id): id is ProviderId => isOneOf(ids, id)),
    code
  );
  return value;
}

function validateHiddenProviders(value: unknown): ProviderId[] {
  const hidden = validateToolList(value, PROVIDER_IDS, 'invalid_hidden_providers');
  // The window needs a tool to show that is there without a sign-in to read: one that runs work.
  check(
    WORK_PROVIDER_IDS.some(id => !hidden.includes(id)),
    'invalid_hidden_providers'
  );
  return hidden;
}

function validatePreferredModels(value: unknown): Settings['preferredModels'] {
  assertShape(value, PROVIDER_IDS, 'invalid_preferred_models');
  const models: Settings['preferredModels'] = {};
  for (const [providerId, model] of Object.entries(value)) {
    // Tools opened as apps take no model argument.
    check(
      isProviderId(providerId) && providerById(providerId).acceptsModel && typeof model === 'string' && MODEL_ID_PATTERN.test(model),
      'invalid_preferred_models'
    );
    models[providerId] = model;
  }
  return models;
}

function validateDismissed(value: unknown): string[] {
  const isAccountId = (id: unknown): id is string => typeof id === 'string' && ACCOUNT_ID_PATTERN.test(id);
  check(Array.isArray(value) && value.every(isAccountId), 'invalid_dismissed_accounts');
  return [...new Set(value)].slice(-MAX_DISMISSED_ACCOUNTS);
}

// Folders compare the way the file systems name them by default: case-insensitively on Windows
// and macOS, as session folders are matched.

export const projectPreference = (settings: Pick<Settings, 'projectPreferences'>, projectDir: string): ProjectPreference | null =>
  settings.projectPreferences.find(p => samePath(p.projectDir, projectDir)) ?? null;

// A preferred account may since have been removed: it is checked where it is used, so that
// removing an account never makes the settings invalid.
function validateProjectPreference(input: unknown, seen: Set<string>): ProjectPreference {
  assertShape(input, PREFERENCE_KEYS, 'invalid_project_preference');
  const { tool, model, accountId, autoContinue } = input;
  const projectDir = validateConfigDir(input.projectDir);
  check(!seen.has(pathKey(projectDir)), 'duplicate_project_preference');
  seen.add(pathKey(projectDir));
  check(tool === undefined || isOneOf(WORK_PROVIDER_IDS, tool), 'invalid_project_preference');
  check(
    model === undefined ||
      (tool !== undefined && providerById(tool).acceptsModel && typeof model === 'string' && MODEL_ID_PATTERN.test(model)),
    'invalid_project_preference'
  );
  check(accountId === undefined || (typeof accountId === 'string' && ACCOUNT_ID_PATTERN.test(accountId)), 'invalid_project_preference');
  check(autoContinue === undefined || autoContinue === INHERIT || isOneOf(AUTO_CONTINUE, autoContinue), 'invalid_project_preference');
  return {
    projectDir,
    ...(tool === undefined ? {} : { tool }),
    ...(model === undefined ? {} : { model }),
    ...(accountId === undefined ? {} : { accountId }),
    autoContinue: autoContinue ?? INHERIT
  };
}

function validateProjectPreferences(value: unknown): ProjectPreference[] {
  check(Array.isArray(value) && value.length <= MAX_PROJECT_PREFERENCES, 'invalid_project_preference');
  const seen = new Set<string>();
  return value.map(entry => validateProjectPreference(entry, seen));
}

// Equal times would be an empty or a whole-day span; neither is a useful setting.
function validateQuietHours(value: unknown): QuietHours {
  assertShape(value, QUIET_HOURS_KEYS, 'invalid_quiet_hours');
  const { start, end } = value;
  check(typeof start === 'string' && typeof end === 'string' && TIME_OF_DAY.test(start) && TIME_OF_DAY.test(end), 'invalid_quiet_hours');
  check(start !== end, 'invalid_quiet_hours');
  return { start, end };
}

const minutesOfDay = (time: string): number => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));

// Whether `date` (local time) falls in the quiet hours; the start is included, the end is not.
export function inQuietHours(quietHours: QuietHours | undefined, date: Date): boolean {
  if (!quietHours) return false;
  const now = date.getHours() * 60 + date.getMinutes();
  const start = minutesOfDay(quietHours.start);
  const end = minutesOfDay(quietHours.end);
  return start < end ? now >= start && now < end : now >= start || now < end;
}

const isFutureDocument = (document: unknown): boolean =>
  isObject(document) && typeof document.schemaVersion === 'number' && document.schemaVersion > SETTINGS_SCHEMA_VERSION;

// Complete settings from a stored or patched document; absent optional fields get defaults.
// A document without a version predates versioning and reads as version 1 unchanged.
// Settings an earlier version wrote that no longer exist: a file that has them is read without
// them (and saved without them next time), rather than refused as unknown.
const RETIRED_SETTINGS = ['globalShortcut'];

export function validateSettings(document: unknown): Settings {
  const input = isObject(document)
    ? Object.fromEntries(Object.entries(document).filter(([key]) => !RETIRED_SETTINGS.includes(key)))
    : document;
  assertShape(input, SETTINGS_KEYS, 'unknown_setting');
  check(!isFutureDocument(input), 'unsupported_schema');
  check(input.schemaVersion === undefined || input.schemaVersion === SETTINGS_SCHEMA_VERSION, 'invalid_schema_version');
  const {
    pinned,
    intervalSeconds,
    accounts,
    language,
    notifications,
    compareAccounts,
    autoContinue,
    returnToPrimary,
    reopenAfterRestart,
    compact,
    checkUpdates,
    checkServiceStatus
  } = input;
  check(typeof pinned === 'boolean', 'invalid_pinned');
  check(isOptionalBoolean(notifications), 'invalid_notifications');
  check(isOptionalBoolean(compareAccounts), 'invalid_compare_accounts');
  check(autoContinue === undefined || isOneOf(AUTO_CONTINUE, autoContinue), 'invalid_auto_continue');
  check(returnToPrimary === undefined || isOneOf(AUTOMATION_MODES, returnToPrimary), 'invalid_settings');
  check(reopenAfterRestart === undefined || isOneOf(AUTOMATION_MODES, reopenAfterRestart), 'invalid_settings');
  check(isOptionalBoolean(compact) && isOptionalBoolean(checkUpdates) && isOptionalBoolean(checkServiceStatus), 'invalid_settings');
  check(
    typeof intervalSeconds === 'number' &&
      Number.isInteger(intervalSeconds) &&
      intervalSeconds >= REFRESH_INTERVAL_SECONDS.min &&
      intervalSeconds <= REFRESH_INTERVAL_SECONDS.max,
    'invalid_interval'
  );
  check(Array.isArray(accounts) && accounts.length <= MAX_ACCOUNTS, 'invalid_accounts');
  check(language === undefined || isLanguage(language), 'invalid_language');
  const { lowQuotaPercent } = input;
  check(
    lowQuotaPercent === undefined ||
      (Number.isInteger(lowQuotaPercent) &&
        typeof lowQuotaPercent === 'number' &&
        lowQuotaPercent >= LOW_QUOTA_RANGE.min &&
        lowQuotaPercent <= LOW_QUOTA_RANGE.max),
    'invalid_low_quota_percent'
  );
  const ids = new Set<string>();
  const primaries = new Set<ProviderId>();
  const defaults = defaultSettings();
  return {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    pinned,
    intervalSeconds,
    accounts: accounts.map(account => validateAccount(account, ids, primaries)),
    dismissedAccountIds:
      input.dismissedAccountIds === undefined ? defaults.dismissedAccountIds : validateDismissed(input.dismissedAccountIds),
    providerOrder:
      input.providerOrder === undefined
        ? defaults.providerOrder
        : validateToolList(input.providerOrder, WORK_PROVIDER_IDS, 'invalid_provider_order'),
    hiddenProviders: input.hiddenProviders === undefined ? defaults.hiddenProviders : validateHiddenProviders(input.hiddenProviders),
    preferredModels: input.preferredModels === undefined ? defaults.preferredModels : validatePreferredModels(input.preferredModels),
    language: language ?? defaults.language,
    notifications: notifications ?? defaults.notifications,
    compareAccounts: compareAccounts ?? defaults.compareAccounts,
    autoContinue: autoContinue ?? defaults.autoContinue,
    returnToPrimary: returnToPrimary ?? defaults.returnToPrimary,
    reopenAfterRestart: reopenAfterRestart ?? defaults.reopenAfterRestart,
    compact: compact ?? defaults.compact,
    checkUpdates: checkUpdates ?? defaults.checkUpdates,
    checkServiceStatus: checkServiceStatus ?? defaults.checkServiceStatus,
    projectPreferences:
      input.projectPreferences === undefined ? defaults.projectPreferences : validateProjectPreferences(input.projectPreferences),
    lowQuotaPercent: lowQuotaPercent ?? defaults.lowQuotaPercent,
    // null clears the quiet hours: an absent field would keep the current ones in a patch.
    ...(input.quietHours === undefined || input.quietHours === null ? {} : { quietHours: validateQuietHours(input.quietHours) }),
    ...(input.homeOrder === undefined ? {} : { homeOrder: validateToolList(input.homeOrder, PROVIDER_IDS, 'invalid_provider_order') }),
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
  return path.join(root, APP_NAME);
}

export const settingsPath = (dataDir: string): string => path.join(dataDir, SETTINGS_FILE);

export const backupPath = (file: string): string => `${file}${BACKUP_SUFFIX}`;

async function readText(file: string): Promise<string | null> {
  try {
    return await fsp.readFile(file, 'utf8');
  } catch (error) {
    if (systemErrorCode(error) === 'ENOENT') return null;
    throw error;
  }
}

// A file that is there but cannot be read (no permission, a folder in its place) counts as
// damaged; only a missing one is absent.
const UNREADABLE = Symbol('unreadable');
const readStored = (file: string): Promise<string | null | typeof UNREADABLE> => readText(file).catch(() => UNREADABLE);

function parseSettings(text: string): Settings {
  let document: unknown;
  try {
    document = parseJson(text);
  } catch {
    throw new InvalidSettingsError('malformed_file');
  }
  return validateSettings(document);
}

// The stored settings, or null when none were saved yet.
export async function loadSettings(file: string): Promise<Settings | null> {
  const text = await readText(file);
  return text === null ? null : parseSettings(text);
}

export interface LoadedSettings {
  settings: Settings;
  notice?: SettingsNotice;
  // Content revision, including the recovery copy. It is metadata, never a user setting.
  revision: string;
}

// The settings to start with. A damaged or unreadable file falls back to the backup, else to
// defaults; a newer version's file (or backup) to defaults, locked. Nothing is written here:
// the evidence stays as it is.
export async function loadSettingsWithRecovery(file: string): Promise<LoadedSettings> {
  const text = await readStored(file);
  const backup = await readStored(backupPath(file));
  const revision = crypto
    .createHash('sha256')
    .update(JSON.stringify([text, backup].map(value => (value === UNREADABLE ? { unreadable: true } : value))))
    .digest('hex');
  if (text === null) return { settings: defaultSettings(), revision };
  if (text !== UNREADABLE) {
    if (isFutureDocument(attemptParse(text))) return { settings: defaultSettings(), notice: 'future', revision };
    const settings = attemptValidate(text);
    if (settings) return { settings, revision };
  }
  if (typeof backup === 'string' && isFutureDocument(attemptParse(backup)))
    return { settings: defaultSettings(), notice: 'future', revision };
  const restored = typeof backup === 'string' ? attemptValidate(backup) : null;
  return restored
    ? { settings: restored, notice: 'recovered', revision }
    : { settings: defaultSettings(), notice: 'unrecoverable', revision };
}

export interface SettingsTransaction extends LoadedSettings {
  save(input: unknown): Promise<LoadedSettings>;
}

// Every writer reloads under the same OS lock. Callers apply a narrow change to these
// current settings, never replace them with a snapshot held by another process.
export function transactSettings<T>(file: string, task: (transaction: SettingsTransaction) => Promise<T>): Promise<T> {
  return withSettingsLock(file, async () => {
    const loaded = await loadSettingsWithRecovery(file);
    let revision = loaded.revision;
    return task({
      ...loaded,
      async save(input) {
        // Detect an older app/editor which did not participate in the locking protocol.
        if ((await loadSettingsWithRecovery(file)).revision !== revision) throw new AppError('settings_locked');
        await writeSettings(file, input);
        const written = await loadSettingsWithRecovery(file);
        revision = written.revision;
        return written;
      }
    });
  });
}

function attemptParse(text: string): unknown {
  try {
    return parseJson(text);
  } catch {
    return null;
  }
}

function attemptValidate(text: string): Settings | null {
  try {
    return parseSettings(text);
  } catch {
    return null;
  }
}

// Validates and writes atomically: a crash mid-write never leaves a truncated file. The
// document it replaces becomes the backup when it was valid, or is kept aside when it was
// not; a newer version's document is never replaced.
async function writeSettings(file: string, input: unknown): Promise<Settings> {
  const settings = validateSettings(input);
  const previous = await readStored(file);
  if (typeof previous === 'string' && isFutureDocument(attemptParse(previous))) throw new AppError('settings_locked');
  let damaged: string | undefined;
  if (typeof previous === 'string' && attemptValidate(previous)) await keepBackup(file, previous);
  else if (previous !== null) {
    damaged = `${file}${DAMAGED_SUFFIX}${new Date().toISOString().replace(/[:.]/g, '-')}`;
    await fsp.rename(file, damaged);
  }
  try {
    await writeFileAtomic(file, `${JSON.stringify(settings, null, 2)}\n`);
  } catch (error) {
    // A failed explicit repair must not turn a damaged document into a missing one on the
    // next load. Its original bytes (or directory) still exist even if restoration fails.
    if (damaged) await fsp.rename(damaged, file).catch(() => undefined);
    throw error;
  }
  return settings;
}

export function saveSettings(file: string, input: unknown): Promise<Settings> {
  // A complete replacement is explicit (import/reset or callers of this low-level API).
  // Service edits use transactSettings and merge their patch into its current document.
  return transactSettings(file, async transaction => (await transaction.save(input)).settings);
}

// A newer version's backup is its last good document: it is kept rather than replaced.
async function keepBackup(file: string, previous: string): Promise<void> {
  const backup = await readStored(backupPath(file));
  if (typeof backup === 'string' && isFutureDocument(attemptParse(backup))) return;
  await writeFileAtomic(backupPath(file), previous);
}
