'use strict';
const path = require('node:path');
const https = require('node:https');
const crypto = require('node:crypto');
const { normalizeWindow, safeText } = require('../core/model.cjs');
const common = require('./common.cjs');

function parseAntigravityDiagnostic(result) {
  if (result?.outcome === 'no-local-language-server') throw new common.ProviderError('app_closed');
  if (result?.outcome !== 'quota-read-success') throw new common.ProviderError('local_service_unavailable');
  const attempt = result.attempts?.find(a => a.method === 'RetrieveUserQuotaSummary' && a.httpStatus === 200 && a.quotaFields?.length) || result.attempts?.find(a => a.httpStatus === 200 && a.quotaFields?.length);
  if (!attempt) throw new common.ProviderError('invalid_response');
  const windows = attempt.quotaFields.map((row, index) => normalizeWindow({
    id: `quota:${safeText(row.bucketId, String(index))}:${index}`,
    label: row.bucketId || row.window || (row.scope === 'model' ? 'Model quota (name unavailable)' : 'Quota window (name unavailable)'),
    remainingPercent: row.remainingFractionPresent && typeof row.remainingFraction === 'number' && Number.isFinite(row.remainingFraction) ? row.remainingFraction * 100 : null,
    resetsAt: row.resetTime, ...(row.group ? { scope: row.group } : {}), active: typeof row.disabled === 'boolean' ? !row.disabled : undefined,
    detail: 'Source: existing Antigravity local service.',
  }));
  return { windows };
}
function checkedCode(value) {
  if (value === undefined || value === null || value === 0 || value === '0' || (typeof value === 'string' && ['ok', 'success'].includes(value.toLowerCase()))) return;
  throw new common.ProviderError(value === 16 || value === 'UNAUTHENTICATED' ? 'auth_rejected' : value === 8 || value === 'RESOURCE_EXHAUSTED' ? 'rate_limited' : 'local_service_unavailable');
}
function rawReset(value) {
  if (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value)) {
    const date = new Date(Number(value) * 1000); return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }
  return value;
}
function fractionPercent(value) { return typeof value === 'number' && Number.isFinite(value) ? value * 100 : null; }
function sourceKey(...values) { return values.find(value => typeof value === 'string' && value.trim())?.trim().normalize('NFC') || ''; }
function stableWindowId(kind, ...parts) { return `${kind}:${crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 24)}`; }
function parseAntigravitySummary(raw) {
  checkedCode(raw?.code);
  const groups = raw?.response?.groups ?? raw?.summary?.groups ?? raw?.groups;
  if (!Array.isArray(groups)) throw new common.ProviderError('invalid_response');
  const windows = [];
  const ids = new Set();
  for (const group of groups) {
    if (!Array.isArray(group?.buckets)) continue;
    const groupKey = sourceKey(group.groupId, group.id, group.displayName, group.name);
    for (const bucket of group.buckets) {
      if (!bucket || typeof bucket !== 'object') continue;
      const bucketKey = sourceKey(bucket.bucketId, bucket.id, bucket.window, bucket.displayName, bucket.name);
      if (!bucketKey) throw new common.ProviderError('invalid_response');
      const id = stableWindowId('quota', groupKey, bucketKey, sourceKey(bucket.window));
      if (ids.has(id)) throw new common.ProviderError('invalid_response');
      ids.add(id);
      const cadence = safeText(bucket.window || bucket.displayName || bucket.name || bucketKey).toLowerCase();
      const label = /^(5h|session|5-hour|five hour|five-hour)$/.test(cadence) ? '5 hours' : cadence === 'weekly' ? 'Weekly' : safeText(bucket.displayName || bucket.name || bucketKey);
      const remaining = bucket.remainingFraction ?? bucket.remaining?.remainingFraction ?? (bucket.remaining?.case === 'remainingFraction' ? bucket.remaining.value : null);
      const scope = safeText(group.displayName || group.name, 'Quota group');
      windows.push(normalizeWindow({ id, label, scope, remainingPercent: fractionPercent(remaining), resetsAt: rawReset(bucket.resetTime), active: typeof bucket.disabled === 'boolean' ? !bucket.disabled : undefined, detail: 'Source: existing Antigravity local service.' }));
    }
  }
  if (!windows.length) throw new common.ProviderError('invalid_response');
  return { windows };
}
function parseAntigravityUserStatus(raw) {
  checkedCode(raw?.code);
  const models = raw?.userStatus?.cascadeModelConfigData?.clientModelConfigs ?? raw?.clientModelConfigs;
  if (!Array.isArray(models)) throw new common.ProviderError('invalid_response');
  const ids = new Set();
  const windows = models.flatMap(model => {
    if (!model?.quotaInfo || typeof model.quotaInfo !== 'object') return [];
    const modelKey = sourceKey(model.modelOrAlias?.model, model.modelId, model.label, model.displayName);
    if (!modelKey) throw new common.ProviderError('invalid_response');
    const label = safeText(model.label || model.displayName, modelKey);
    const id = stableWindowId('model', modelKey);
    if (ids.has(id)) throw new common.ProviderError('invalid_response');
    ids.add(id);
    return [normalizeWindow({ id, label, scope: label, remainingPercent: fractionPercent(model.quotaInfo.remainingFraction), resetsAt: rawReset(model.quotaInfo.resetTime), detail: 'Model quota; period not reported by source.' })];
  });
  if (!windows.length) throw new common.ProviderError('invalid_response');
  return { windows };
}
async function powerShellBinary(env = process.env) {
  if (env.VIBE_POWERSHELL_BINARY) { if (!common.validBinary(env.VIBE_POWERSHELL_BINARY)) throw new common.ProviderError('invalid_binary'); return env.VIBE_POWERSHELL_BINARY; }
  // Windows ships this interpreter. It is sufficient for CIM/TCP discovery;
  // networking stays in Node and needs neither PS7 nor a downloaded runtime.
  const candidate = path.join(env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  if (!common.validBinary(candidate)) throw new common.ProviderError('invalid_binary');
  return candidate;
}
function validateServers(value) {
  if (!Array.isArray(value)) throw new common.ProviderError('local_service_unavailable');
  return value.slice(0, 4).filter(server => Number.isInteger(server?.pid) && server.pid > 0 && typeof server.csrfToken === 'string' && server.csrfToken.length > 0 && server.csrfToken.length <= 512 && !/[\x00-\x20\x7f]/.test(server.csrfToken) && Array.isArray(server.ports)).map(server => ({ pid: server.pid, csrfToken: server.csrfToken, ports: [...new Set(server.ports.filter(p => Number.isInteger(p) && p > 0 && p <= 65535))].slice(0, 4) })).filter(server => server.ports.length);
}
// Process matching and PID-owned listening-port semantics are derived from:
// CodexBar AntigravityStatusProbe.swift processInfos/antigravityProcessKind and
// AntigravityStatusProbe+PortDetection.swift lsofListeningPorts. This Node port
// of discovery has fixture coverage; it has not been executed on a Mac.
function parseMacProcessList(output, currentUid) {
  if (!Number.isInteger(currentUid) || currentUid < 0) return [];
  const servers = [];
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line); if (!match || Number(match[2]) !== currentUid) continue;
    const command = match[3], lower = command.toLowerCase();
    const languageServer = /(?:^|[/\\])language(?:_|-)server(?:[_-][a-z0-9]+)*(?:\.exe)?(?:["\s]|$)/.test(lower);
    const owner = /\/(?:antigravity|antigravity ide|gemini)\.app\//.test(lower) || /\/antigravity\//.test(lower) || (/(?:^|\s)--app_data_dir(?:=|\s)/.test(lower) && lower.includes('antigravity'));
    // This current-app adapter intentionally excludes tokenless CLI processes.
    if (!languageServer || !owner) continue;
    const csrf = /(?:^|\s)--csrf_token(?:=|\s+)(?:"([^"\r\n]+)"|([^\s]+))/.exec(command);
    const csrfToken = csrf?.[1] || csrf?.[2];
    if (csrfToken && !/[\x00-\x20\x7f]/.test(csrfToken)) servers.push({ pid: Number(match[1]), csrfToken });
    if (servers.length >= 4) break;
  }
  return servers;
}
function parseListeningPorts(output, expectedPid) {
  if (!Number.isInteger(expectedPid) || expectedPid <= 0) return [];
  const ports = new Set();
  for (const line of output.split(/\r?\n/)) {
    const owner = /^\S+\s+(\d+)\s+\S+\s+\S+\s+IPv4\s+/.exec(line.trim());
    if (!owner || Number(owner[1]) !== expectedPid) continue;
    // The request target is exactly 127.0.0.1. A LAN address, another 127/8
    // address, or an IPv6-only socket does not prove ownership of that target.
    const listener = /\bTCP\s+(?:127\.0\.0\.1|0\.0\.0\.0|\*):(\d+)\s+\(LISTEN\)\s*$/.exec(line);
    const port = listener ? Number(listener[1]) : 0;
    if (port > 0 && port <= 65535) ports.add(port);
  }
  return [...ports].sort((a, b) => a - b);
}
async function discoverAntigravityServers(options = {}) {
  const run = options.runProcess || common.runProcess, platform = options.platform || process.platform;
  if (platform === 'win32') {
    const script = path.resolve(__dirname, '../launchers/discover-antigravity.ps1').replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');
    let output;
    try { output = JSON.parse((await run(await powerShellBinary(options.env), ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { timeoutMs: 12000, maxBytes: 65536 })).replace(/^\uFEFF/, '')); }
    catch (error) { if (error instanceof common.ProviderError) throw error; throw new common.ProviderError('local_service_unavailable'); }
    if (output?.outcome === 'app_closed') throw new common.ProviderError('app_closed');
    if (output?.outcome !== 'success') throw new common.ProviderError('local_service_unavailable');
    const servers = validateServers(output.servers);
    if (!servers.length) throw new common.ProviderError('local_service_unavailable');
    return servers;
  }
  if (platform !== 'darwin') throw new common.ProviderError('unsupported_platform');
  const currentUid = options.currentUid ?? process.geteuid?.() ?? process.getuid?.();
  if (!Number.isInteger(currentUid) || currentUid < 0) throw new common.ProviderError('local_service_unavailable');
  const entries = parseMacProcessList(await run('/bin/ps', ['-ax', '-o', 'pid=,uid=,command='], { timeoutMs: 4000, maxBytes: 4 * 1024 * 1024 }), currentUid);
  if (!entries.length) throw new common.ProviderError('app_closed');
  const servers = [];
  for (const entry of entries) {
    try {
      const output = await run('/usr/sbin/lsof', ['-nP', '-i4TCP', '-sTCP:LISTEN', '-a', '-p', String(entry.pid)], { timeoutMs: 4000, maxBytes: 65536 });
      servers.push({ ...entry, ports: parseListeningPorts(output, entry.pid) });
    } catch { /* No global port or tokenless fallback. */ }
  }
  const validated = validateServers(servers);
  if (!validated.length) throw new common.ProviderError('local_service_unavailable');
  return validated;
}
function requestLocalJson(server, port, method, options = {}) {
  return new Promise((resolve, reject) => {
    if (!Number.isInteger(server?.pid) || server.pid <= 0 || !server.ports?.includes(port) || !Number.isInteger(port) || port < 1 || port > 65535 || typeof server.csrfToken !== 'string' || !server.csrfToken || /[\x00-\x20\x7f]/.test(server.csrfToken) || !['RetrieveUserQuotaSummary', 'GetUserStatus'].includes(method)) return reject(new common.ProviderError('endpoint_not_allowed'));
    const timeoutMs = Math.max(1, Math.min(options.timeoutMs || 3000, 3000)), maxBytes = Math.min(options.maxBytes || 1024 * 1024, 1024 * 1024);
    let request, activeResponse, settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(deadline);
      if (error) { activeResponse?.destroy?.(); request?.destroy?.(); reject(error); }
      else resolve(value);
    };
    const deadline = setTimeout(() => finish(new common.ProviderError('request_timeout')), timeoutMs);
    const body = JSON.stringify(method === 'RetrieveUserQuotaSummary' ? { forceRefresh: true } : { metadata: { ideName: 'antigravity', extensionName: 'antigravity', locale: 'en', ideVersion: 'unknown' } });
    try {
      request = (options.request || https.request)({ hostname: '127.0.0.1', port, path: `/exa.language_server_pb.LanguageServerService/${method}`, method: 'POST', agent: false, rejectUnauthorized: false, timeout: timeoutMs, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Connect-Protocol-Version': '1', 'X-Codeium-Csrf-Token': server.csrfToken } }, response => {
        activeResponse = response;
        // Handlers must cover rejected responses too: destroying an HTTP error
        // stream can still emit error/aborted after the promise has settled.
        response.on('error', () => finish(new common.ProviderError('transport_error')));
        response.on('aborted', () => finish(new common.ProviderError('transport_error')));
        if (response.statusCode !== 200) {
          const retry = Number(response.headers?.['retry-after']);
          finish(new common.ProviderError(response.statusCode === 429 ? 'rate_limited' : [401, 403].includes(response.statusCode) ? 'auth_rejected' : 'http_rejected', { retryAfterSeconds: retry })); return;
        }
        let bytes = 0, chunks = [];
        response.on('data', chunk => { if (settled) return; bytes += chunk.length; if (bytes > maxBytes) { chunks = []; finish(new common.ProviderError('response_too_large')); } else chunks.push(chunk); });
        response.on('end', () => { if (settled) return; try { finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { finish(new common.ProviderError('invalid_response')); } });
      });
      request.on('error', () => finish(new common.ProviderError('transport_error')));
      request.on('timeout', () => finish(new common.ProviderError('request_timeout')));
      request.end(body);
    } catch { finish(new common.ProviderError('transport_error')); }
  });
}
function createAntigravityProvider(options = {}) {
  return { id: 'antigravity', name: 'Antigravity', discover: async () => [{ id: 'antigravity:current', providerId: 'antigravity', label: 'Mevcut uygulama', primary: true, enabled: true }], async fetch(account) {
    if (account.configDir) throw new common.ProviderError('unsupported_profile');
    const servers = await discoverAntigravityServers(options), deadline = Date.now() + 12000;
    const read = options.requestLocalJson || requestLocalJson;
    let lastError = new common.ProviderError('local_service_unavailable');
    for (const server of servers) {
      for (const port of server.ports) {
        for (const method of ['RetrieveUserQuotaSummary', 'GetUserStatus']) {
          if (Date.now() >= deadline) throw new common.ProviderError('request_timeout');
          try {
            const raw = await read(server, port, method, { timeoutMs: Math.min(3000, deadline - Date.now()) });
            return method === 'RetrieveUserQuotaSummary' ? parseAntigravitySummary(raw) : parseAntigravityUserStatus(raw);
          } catch (error) { if (error.code === 'rate_limited') throw error; lastError = error instanceof common.ProviderError ? error : new common.ProviderError('local_service_unavailable'); }
        }
      }
    }
    throw lastError;
  } };
}
module.exports = { parseAntigravityDiagnostic, parseAntigravitySummary, parseAntigravityUserStatus, createAntigravityProvider, powerShellBinary, discoverAntigravityServers, parseMacProcessList, parseListeningPorts, requestLocalJson };
