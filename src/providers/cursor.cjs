'use strict';
const path = require('node:path');
const os = require('node:os');
const { normalizeWindow, safeText } = require('../core/model.cjs');
const common = require('./common.cjs');

function parseCursorUsage(summary) {
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) throw new common.ProviderError('invalid_response');
  const plan = summary.individualUsage?.plan, windows = [];
  const resetsAt = summary.billingCycleEnd;
  if (plan) {
    for (const [key, label] of [['auto', 'Auto kapsamı'], ['api', 'API kapsamı'], ['total', 'Toplam kullanım']]) windows.push(normalizeWindow({ id: `plan:${key}`, label, usedPercent: plan[`${key}PercentUsed`], resetsAt, detail: key==='api'?'Bu sınır hesabın bütün modellerde bittiği anlamına gelmez.':'' }));
    const names={used:'Kullanılan',limit:'Limit',remaining:'Kalan'};
    const amounts = ['used', 'limit', 'remaining'].filter(k => typeof plan[k] === 'number' && Number.isFinite(plan[k])).map(k => `${names[k]}: ${plan[k]} cents`);
    if (typeof plan.breakdown?.bonus === 'number') amounts.push(`Bonus kaydı: ${plan.breakdown.bonus} cents`);
    windows.push(normalizeWindow({ id: 'plan:spend', label: 'Dahil kullanım · tutar', resetsAt, valueText:typeof plan.remaining==='number'?`${plan.remaining} cent kalan`:'Tutar bildirilmedi', detail: amounts.join('; ') || 'Tutar bildirilmedi.' }));
  }
  for (const [group, usage] of [['individual', summary.individualUsage], ['team', summary.teamUsage]]) {
    for (const key of ['onDemand', 'overall', 'pooled']) {
      const pool = usage?.[key]; if (!pool) continue;
      const names={used:'Kullanılan',limit:'Limit',remaining:'Kalan'};
      const detail = ['used', 'limit', 'remaining'].filter(k => typeof pool[k] === 'number' && Number.isFinite(pool[k])).map(k => `${names[k]}: ${pool[k]} cents`).join('; ');
      windows.push(normalizeWindow({ id: `${group}:${key}`, label: `${group === 'team' ? 'Takım · ' : ''}${key === 'onDemand' ? 'Ek ücretli kullanım' : key}`, resetsAt, valueText:pool.enabled===false?'Kapalı':typeof pool.remaining==='number'?`${pool.remaining} cent kalan`:'Tutar bildirilmedi', detail: detail || 'Tutar bildirilmedi.' }));
    }
  }
  return { ...(typeof summary.membershipType === 'string' && /^[a-zA-Z][a-zA-Z0-9_ -]{0,40}$/.test(summary.membershipType) ? { plan: safeText(summary.membershipType) } : {}), windows };
}
function createCursorProvider(options = {}) {
  const home = options.home || os.homedir(), platform = options.platform || process.platform, env = options.env || process.env;
  return { id: 'cursor', name: 'Cursor', discover: async () => [{ id: 'cursor:default', providerId: 'cursor', label: 'Mevcut hesap', primary: true, enabled: true }], async fetch(account) {
    if (account.configDir) throw new common.ProviderError('unsupported_profile');
    let token;
    if (platform === 'win32') token = (await common.readJson(path.join(env.APPDATA || path.join(home, 'AppData/Roaming'), 'Cursor/auth.json'))).accessToken;
    else if (platform === 'darwin') {
      // Source: CodexBar CursorAppAuth.swift, resolveDefaultDBPath/loadSession.
      // sqlite3 -readonly never mutates Cursor's database or copies its auth.
      const db = path.join(home, 'Library/Application Support/Cursor/User/globalStorage/state.vscdb');
      try { token = (await (options.runProcess || common.runProcess)('/usr/bin/sqlite3', ['-readonly', db, "SELECT value FROM ItemTable WHERE key = 'cursorAuth/accessToken' LIMIT 1;"], { timeoutMs: 5000 })).trim(); }
      catch { throw new common.ProviderError('auth_missing'); }
    } else throw new common.ProviderError('unsupported_platform');
    if (typeof token !== 'string' || !token.trim()) throw new common.ProviderError('auth_missing');
    let claims;
    try { if (token.split('.').length !== 3) throw new Error(); claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')); } catch { throw new common.ProviderError('auth_invalid'); }
    const user = typeof claims.sub === 'string' ? claims.sub.split('|').at(-1) : '';
    if (!/^[A-Za-z0-9._-]+$/.test(user) || !Number.isFinite(claims.exp)) throw new common.ProviderError('auth_invalid');
    if (claims.exp * 1000 <= common.now(options.clock) + 60000) throw new common.ProviderError('auth_expired');
    return parseCursorUsage(await (options.getJson || common.getJson)('https://cursor.com/api/usage-summary', { headers: { Accept: 'application/json', Cookie: `WorkosCursorSessionToken=${user}%3A%3A${token}` }, timeoutMs: 20000 }));
  } };
}
module.exports = { parseCursorUsage, createCursorProvider };
