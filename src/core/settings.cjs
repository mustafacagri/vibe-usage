'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const PROVIDERS = ['codex', 'claude', 'cursor', 'antigravity'];
const DEFAULT_SETTINGS = Object.freeze({ pinned: false, intervalSeconds: 120, accounts: [] });
function assertKeys(value, allowed, error) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !allowed.includes(k))) throw new Error(error);
}
function validateConfigDir(value) {
  if (typeof value !== 'string' || value.length > 1024 || /[\x00-\x1f]/.test(value) || /^[/\\]{2}/.test(value) || value.split(/[\\/]/).includes('..') || !path.isAbsolute(value)) throw new Error('invalid_config_path');
  return path.normalize(value);
}
function validateSettings(input) {
  assertKeys(input, ['pinned', 'intervalSeconds', 'accounts', 'window'], 'unknown_setting');
  if (typeof input.pinned !== 'boolean') throw new Error('invalid_pinned');
  if (!Number.isInteger(input.intervalSeconds) || input.intervalSeconds < 30 || input.intervalSeconds > 900) throw new Error('invalid_interval');
  if (!Array.isArray(input.accounts) || input.accounts.length > 40) throw new Error('invalid_accounts');
  const ids = new Set(), primaries = new Set();
  const accounts = input.accounts.map(a => {
    assertKeys(a, ['id', 'providerId', 'label', 'configDir', 'primary', 'enabled'], 'unknown_account_setting');
    if (typeof a.id !== 'string' || !/^[a-zA-Z0-9:_-]{1,100}$/.test(a.id) || ids.has(a.id) || !PROVIDERS.includes(a.providerId)) throw new Error('invalid_account');
    ids.add(a.id);
    if (typeof a.label !== 'string' || !a.label.trim() || a.label.length > 80 || /[\x00-\x1f\x7f]/.test(a.label)) throw new Error('invalid_account_label');
    if (typeof a.primary !== 'boolean' || typeof a.enabled !== 'boolean') throw new Error('invalid_account_flags');
    if (a.primary && primaries.has(a.providerId)) throw new Error('duplicate_primary');
    if (a.primary) primaries.add(a.providerId);
    return { id: a.id, providerId: a.providerId, label: a.label.trim(), ...(a.configDir !== undefined ? { configDir: validateConfigDir(a.configDir) } : {}), primary: a.primary, enabled: a.enabled };
  });
  const result = { pinned: input.pinned, intervalSeconds: input.intervalSeconds, accounts };
  if (input.window !== undefined) {
    assertKeys(input.window, ['x', 'y', 'width', 'height'], 'invalid_window');
    const { x, y, width, height } = input.window;
    if (![x, y, width, height].every(Number.isInteger) || Math.abs(x) > 100000 || Math.abs(y) > 100000 || width < 280 || width > 3000 || height < 300 || height > 3000) throw new Error('invalid_window');
    result.window = { x, y, width, height };
  }
  return result;
}
function defaultSettingsPath() {
  const root = process.platform === 'win32' ? (process.env.APPDATA || path.join(os.homedir(), 'AppData/Roaming')) : process.platform === 'darwin' ? path.join(os.homedir(), 'Library/Application Support') : (process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'));
  return path.join(root, 'Vibe Usage', 'settings.json');
}
async function loadSettings(file = defaultSettingsPath()) {
  try { return validateSettings(JSON.parse(await fs.readFile(file, 'utf8'))); }
  catch (error) { if (error.code === 'ENOENT') return null; throw new Error('invalid_settings_file'); }
}
async function saveSettings(file, input) {
  const settings = validateSettings(input);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomBytes(8).toString('hex')}.tmp`);
  let handle;
  try {
    handle = await fs.open(temporary, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(settings, null, 2) + '\n', 'utf8'); await handle.sync(); await handle.close(); handle = null;
    await fs.rename(temporary, file);
  } finally { if (handle) await handle.close(); await fs.rm(temporary, { force: true }).catch(() => {}); }
  return settings;
}
module.exports = { DEFAULT_SETTINGS, PROVIDERS, validateSettings, validateConfigDir, defaultSettingsPath, loadSettings, saveSettings };
