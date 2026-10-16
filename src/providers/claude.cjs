'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { normalizeWindow, safeText } = require('../core/model.cjs');
const common = require('./common.cjs');

function parseClaudeUsage(usage) {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) throw new common.ProviderError('invalid_response');
  const windows = [];
  const labels = { five_hour: '5 saat', seven_day: 'Haftalık', seven_day_opus: 'Opus · haftalık', seven_day_sonnet: 'Sonnet · haftalık' };
  for (const key of Object.keys(labels)) {
    if (!['five_hour', 'seven_day'].includes(key) && !usage[key]) continue;
    windows.push(normalizeWindow({ id: key, label: labels[key], usedPercent: usage[key]?.utilization, resetsAt: usage[key]?.resets_at, ...(key === 'seven_day_opus' ? { scope: 'Opus' } : key === 'seven_day_sonnet' ? { scope: 'Sonnet' } : {}) }));
  }
  for (const record of (Array.isArray(usage.limits) ? usage.limits : [])) {
    if (!record || typeof record !== 'object') continue;
    const kind = safeText(record.kind, 'unknown');
    const model = record.scope?.model;
    const scope = safeText(model?.display_name || model?.id || (typeof record.scope === 'string' ? record.scope : ''), '');
    const canonical = !scope && kind === 'session' ? 'five_hour' : !scope && kind === 'weekly_all' ? 'seven_day' : null;
    const period = kind.startsWith('weekly') ? 'haftalık' : kind === 'session' ? '5 saat' : kind.replace(/_/g, ' ');
    const identity = String(record.id || model?.id || scope || record.window || record.period || 'general');
    const stableId = crypto.createHash('sha256').update(identity).digest('hex').slice(0,12);
    const window = normalizeWindow({ id: canonical || `limit:${kind}:${stableId}`, label: scope ? `${scope} · ${period}` : period, usedPercent: record.percent, resetsAt: record.resets_at, ...(scope ? { scope } : {}), active: record.is_active, detail: '' });
    if (canonical) {
      const current = windows.find(w => w.id === canonical);
      if (current.usedPercent === null && window.usedPercent !== null) Object.assign(current, window, { label: labels[canonical] });
      else if (typeof record.is_active === 'boolean') current.active = record.is_active;
    } else windows.push(window);
  }
  return { windows };
}
function profileAccount(configDir, defaultDir) {
  const isDefault = path.resolve(configDir) === path.resolve(defaultDir);
  const secondary = path.basename(configDir) === '.claude-secondary';
  const suffix = isDefault ? 'default' : secondary ? 'secondary' : crypto.createHash('sha256').update(path.resolve(configDir)).digest('hex').slice(0, 12);
  return { id: `claude:${suffix}`, providerId: 'claude', label: isDefault ? 'Hesap A' : secondary ? 'Hesap B' : path.basename(configDir).replace(/^\.claude-?/, '') || 'Claude hesabı', configDir, primary: isDefault, enabled: true };
}
async function discoverClaudeAccounts({ home = os.homedir(), platform = process.platform } = {}) {
  const defaultDir = path.join(home, '.claude');
  const entries = await fs.readdir(home, { withFileTypes: true }).catch(() => []);
  const roots = entries.filter(e => e.isDirectory() && /^\.claude(?:-[a-zA-Z0-9_-]+)?$/.test(e.name) && !/(?:^|[-_])(backup|backups|history|old|archive|copy|bak)(?:[-_]|$)/i.test(e.name)).map(e => path.join(home, e.name));
  const accounts = [];
  for (const root of roots) {
    try {
      const file = path.join(root, '.credentials.json');
      if (platform === 'darwin') {
        const configured = await fs.stat(path.join(root,'settings.json')).then(s=>s.isFile()).catch(()=>false);
        if (configured) { accounts.push(profileAccount(root,defaultDir)); continue; }
      }
      if (!(await fs.lstat(file)).isFile()) continue;
      const auth = await common.readJson(file);
      if (typeof auth.claudeAiOauth?.accessToken === 'string' && auth.claudeAiOauth.accessToken.trim()) accounts.push(profileAccount(root, defaultDir));
    } catch { /* No history, backups, or raw credential values are exposed. */ }
  }
  // Only the default service name has been verified in primary source. A custom
  // Mac profile is never silently assigned the default profile's Keychain entry.
  if (platform === 'darwin' && !accounts.some(a => a.id === 'claude:default')) accounts.unshift(profileAccount(defaultDir, defaultDir));
  accounts.sort((a, b) => (a.id === 'claude:default' ? -1 : b.id === 'claude:default' ? 1 : a.id === 'claude:secondary' ? -1 : b.id === 'claude:secondary' ? 1 : a.label.localeCompare(b.label)));
  if (!accounts.length) accounts.push(profileAccount(defaultDir, defaultDir));
  if (!accounts.some(a => a.primary)) accounts[0].primary = true;
  return accounts;
}
async function readClaudeCredentials(account, options = {}) {
  const platform = options.platform || process.platform, home = options.home || os.homedir();
  const configDir = account.configDir || path.join(home, '.claude');
  // Source: CodexBar ClaudeOAuth/ClaudeOAuthCredentials.swift, service constant
  // `Claude Code-credentials`. Read only; neither refresh nor Keychain write.
  if (platform === 'darwin') {
    try { return await require('./claude-keychain.cjs').readClaudeKeychain({configDir,configDirExplicit:account.id!=='claude:default',platform,runProcess:options.runProcess}); } catch { /* Documented file fallback below. */ }
  }
  try { return await common.readJson(path.join(configDir, '.credentials.json')); }
  catch (error) { if (platform === 'darwin' && error.code === 'auth_missing') throw new common.ProviderError(path.resolve(configDir) === path.resolve(home, '.claude') ? 'keychain_unavailable' : 'unsupported_profile'); throw error; }
}
function createClaudeProvider(options = {}) {
  return { id: 'claude', name: 'Claude', discover: () => discoverClaudeAccounts(options), async fetch(account) {
    const credentials = await readClaudeCredentials(account, options);
    const oauth = credentials.claudeAiOauth;
    if (typeof oauth?.accessToken !== 'string' || !oauth.accessToken.trim()) throw new common.ProviderError('auth_missing');
    if (typeof oauth.expiresAt === 'number' && oauth.expiresAt <= common.now(options.clock) + 60000) throw new common.ProviderError('auth_expired');
    const usage = await (options.getJson || common.getJson)('https://api.anthropic.com/api/oauth/usage', { headers: { Authorization: `Bearer ${oauth.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': 'vibe-usage/0.1', Accept: 'application/json' } });
    const result = parseClaudeUsage(usage);
    if (typeof oauth.subscriptionType === 'string' && /^[a-zA-Z][a-zA-Z0-9_ -]{0,40}$/.test(oauth.subscriptionType)) result.plan = oauth.subscriptionType;
    return result;
  } };
}
module.exports = { parseClaudeUsage, discoverClaudeAccounts, readClaudeCredentials, createClaudeProvider };
