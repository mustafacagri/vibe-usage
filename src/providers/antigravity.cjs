'use strict';
const path = require('node:path');
const https = require('node:https');
const crypto = require('node:crypto');
const { normalizeWindow, safeText } = require('../core/model.cjs');
const { MINUTES, MAX_LABEL_LENGTH, durationLabel } = require('../catalog.cjs');
const common = require('./common.cjs');

const MAX_SERVERS = 4;
const MAX_PORTS_PER_SERVER = 4;
const LOCAL_REQUEST_TIMEOUT_MS = 3000;
const MIN_REQUEST_TIMEOUT_MS = 100;
const DISCOVERY_BUDGET_MS = 6000;
const FETCH_BUDGET_MS = 12000;
const WINDOWS_DISCOVERY_TIMEOUT_MS = 12000;
const MAC_PROCESS_TIMEOUT_MS = 4000;
const ID_HASH_LENGTH = 24;
const ACCOUNT_HASH_LENGTH = 16;
// Two readings whose resets differ by less than this describe the same quota period.
const SAME_PERIOD_TOLERANCE_MS = 60 * 1000;
const RPC_METHODS = { quota: 'RetrieveUserQuotaSummary', status: 'GetUserStatus' };
const RPC_PATH_PREFIX = '/exa.language_server_pb.LanguageServerService/';
// Connect error codes (gRPC numbering) the language server returns in the body.
const CONNECT_CODES = { UNAUTHENTICATED: 16, RESOURCE_EXHAUSTED: 8 };
const FIVE_HOUR_CADENCE = /^(5h|session|5-hour|five hour|five-hour)$/;
const WEEKLY_CADENCE = 'weekly';

function checkedCode(value) {
  if (value === undefined || value === null || value === 0 || value === '0' || (typeof value === 'string' && ['ok', 'success'].includes(value.toLowerCase()))) return;
  const code = value === CONNECT_CODES.UNAUTHENTICATED || value === 'UNAUTHENTICATED' ? 'auth_rejected'
    : value === CONNECT_CODES.RESOURCE_EXHAUSTED || value === 'RESOURCE_EXHAUSTED' ? 'rate_limited' : 'local_service_unavailable';
  throw new common.ProviderError(code);
}
function rawReset(value) {
  if (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value)) {
    const date = new Date(Number(value) * 1000); return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }
  return value;
}
function fractionPercent(value) { return typeof value === 'number' && Number.isFinite(value) ? value * 100 : null; }
function sourceKey(...values) { return values.find(value => typeof value === 'string' && value.trim())?.trim().normalize('NFC') || ''; }
function stableWindowId(kind, ...parts) { return `${kind}:${crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, ID_HASH_LENGTH)}`; }
// The language server has reported the signed-in e-mail under several shapes.
function extractEmail(raw) {
  const email = raw?.userStatus?.email || raw?.response?.userStatus?.email || raw?.userEmail || raw?.email || raw?.user?.email;
  return typeof email === 'string' && email.trim() ? email.toLowerCase().trim() : null;
}
function withEmail(windows, raw) {
  const result = { windows };
  const email = extractEmail(raw);
  if (email) Object.defineProperty(result, 'email', { value: email, enumerable: false, writable: true });
  return result;
}
function cadenceLabel(cadence, fallbackName) {
  if (FIVE_HOUR_CADENCE.test(cadence)) return durationLabel(MINUTES.FIVE_HOURS);
  if (cadence === WEEKLY_CADENCE) return durationLabel(MINUTES.WEEK);
  return { label: fallbackName };
}
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
      const remaining = bucket.remainingFraction ?? bucket.remaining?.remainingFraction ?? (bucket.remaining?.case === 'remainingFraction' ? bucket.remaining.value : null);
      windows.push(normalizeWindow({
        id, ...cadenceLabel(cadence, safeText(bucket.displayName || bucket.name || bucketKey)),
        scope: safeText(group.displayName || group.name), detailKey: 'antigravitySourceNote',
        remainingPercent: fractionPercent(remaining), resetsAt: rawReset(bucket.resetTime),
        active: typeof bucket.disabled === 'boolean' ? !bucket.disabled : undefined
      }));
    }
  }
  if (!windows.length) throw new common.ProviderError('invalid_response');
  return withEmail(windows, raw);
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
    return [normalizeWindow({ id, label, scope: label, detailKey: 'modelQuotaNoPeriod', remainingPercent: fractionPercent(model.quotaInfo.remainingFraction), resetsAt: rawReset(model.quotaInfo.resetTime) })];
  });
  if (!windows.length) throw new common.ProviderError('invalid_response');
  return withEmail(windows, raw);
}
function validateServers(value) {
  if (!Array.isArray(value)) throw new common.ProviderError('local_service_unavailable');
  return value.slice(0, MAX_SERVERS).filter(server => Number.isInteger(server?.pid) && server.pid > 0 && typeof server.csrfToken === 'string' && server.csrfToken.length > 0 && server.csrfToken.length <= 512 && !/[\x00-\x20\x7f]/.test(server.csrfToken) && Array.isArray(server.ports)).map(server => ({ pid: server.pid, csrfToken: server.csrfToken, ports: [...new Set(server.ports.filter(p => Number.isInteger(p) && p > 0 && p <= 65535))].slice(0, MAX_PORTS_PER_SERVER), sourceKind: server.sourceKind === 'ide' ? 'ide' : 'app' })).filter(server => server.ports.length);
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
    const isIde = lower.includes('antigravity ide') || lower.includes('antigravity-ide') || lower.includes('--app_data_dir');
    if (csrfToken && !/[\x00-\x20\x7f]/.test(csrfToken)) servers.push({ pid: Number(match[1]), csrfToken, sourceKind: isIde ? 'ide' : 'app' });
    if (servers.length >= MAX_SERVERS) break;
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
    const script = common.unpackedPath(path.resolve(__dirname, '../launchers/discover-antigravity.ps1'));
    let output;
    try { output = JSON.parse((await run(common.windowsPowerShell(options.env), ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { timeoutMs: WINDOWS_DISCOVERY_TIMEOUT_MS, maxBytes: 65536 })).replace(/^\uFEFF/, '')); }
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
  const entries = parseMacProcessList(await run('/bin/ps', ['-ax', '-o', 'pid=,uid=,command='], { timeoutMs: MAC_PROCESS_TIMEOUT_MS, maxBytes: 4 * 1024 * 1024 }), currentUid);
  if (!entries.length) throw new common.ProviderError('app_closed');
  const servers = [];
  for (const entry of entries) {
    try {
      const output = await run('/usr/sbin/lsof', ['-nP', '-i4TCP', '-sTCP:LISTEN', '-a', '-p', String(entry.pid)], { timeoutMs: MAC_PROCESS_TIMEOUT_MS, maxBytes: 65536 });
      servers.push({ ...entry, ports: parseListeningPorts(output, entry.pid) });
    } catch { /* No global port or tokenless fallback. */ }
  }
  const validated = validateServers(servers);
  if (!validated.length) throw new common.ProviderError('local_service_unavailable');
  return validated;
}
function isAllowedTarget(server, port, method) {
  return Number.isInteger(server?.pid) && server.pid > 0 && Number.isInteger(port) && port >= 1 && port <= 65535 && server.ports?.includes(port)
    && typeof server.csrfToken === 'string' && server.csrfToken && !/[\x00-\x20\x7f]/.test(server.csrfToken) && Object.values(RPC_METHODS).includes(method);
}
function requestBody(method) {
  return JSON.stringify(method === RPC_METHODS.quota
    ? { forceRefresh: true }
    : { metadata: { ideName: 'antigravity', extensionName: 'antigravity', locale: 'en', ideVersion: 'unknown' } });
}
// The local language server listens on 127.0.0.1 with a self-signed certificate; access is
// scoped by the per-process CSRF token and the PID-owned port, not by TLS identity.
function requestLocalJson(server, port, method, options = {}) {
  return new Promise((resolve, reject) => {
    if (!isAllowedTarget(server, port, method)) return reject(new common.ProviderError('endpoint_not_allowed'));
    const timeoutMs = Math.max(1, Math.min(options.timeoutMs || LOCAL_REQUEST_TIMEOUT_MS, LOCAL_REQUEST_TIMEOUT_MS));
    const maxBytes = Math.min(options.maxBytes || common.MAX_RESPONSE_BYTES, common.MAX_RESPONSE_BYTES);
    const body = requestBody(method);
    const { finish, attach } = common.settleOnce(resolve, reject, timeoutMs);
    try {
      const request = attach((options.request || https.request)({
        hostname: '127.0.0.1', port, path: `${RPC_PATH_PREFIX}${method}`, method: 'POST', agent: false, rejectUnauthorized: false, timeout: timeoutMs,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Connect-Protocol-Version': '1', 'X-Codeium-Csrf-Token': server.csrfToken }
      }, response => common.readJsonResponse(attach(response), finish, maxBytes)));
      request.on('error', () => finish(new common.ProviderError('transport_error')));
      request.on('timeout', () => finish(new common.ProviderError('request_timeout')));
      request.end(body);
    } catch {
      finish(new common.ProviderError('transport_error'));
    }
  });
}
function antigravityAccountId(email) {
  const hash = crypto.createHash('sha256').update((email || '').toLowerCase().trim()).digest('hex').slice(0, ACCOUNT_HASH_LENGTH);
  return `antigravity:${hash}`;
}

function timeLeft(deadline, cap) {
  return Math.min(cap, Math.max(MIN_REQUEST_TIMEOUT_MS, deadline - Date.now()));
}

// Rate limiting is account-wide: retrying another port would only extend the cooldown.
function rethrowIfRateLimited(error) {
  if (error?.code === 'rate_limited') throw error;
}

async function fetchServerWindows(server, read, deadline, needsEmail = false) {
  let lastError = null;
  const tag = parsed => ({ ...parsed, email: parsed.email, pid: server.pid });
  for (const port of server.ports) {
    if (Date.now() >= deadline) throw new common.ProviderError('request_timeout');
    let email = null, statusRaw = null;
    if (needsEmail) {
      // Identity first: with several servers, windows are only usable once tied to an account.
      try {
        statusRaw = await read(server, port, RPC_METHODS.status, { timeoutMs: timeLeft(deadline, LOCAL_REQUEST_TIMEOUT_MS) });
        email = extractEmail(statusRaw);
      } catch (error) {
        rethrowIfRateLimited(error);
        lastError = error instanceof common.ProviderError ? error : new common.ProviderError('local_service_unavailable');
      }
      if (!email) continue;
    }
    try {
      const parsed = parseAntigravitySummary(await read(server, port, RPC_METHODS.quota, { timeoutMs: timeLeft(deadline, LOCAL_REQUEST_TIMEOUT_MS) }));
      return { ...tag(parsed), email: email || parsed.email || null };
    } catch (error) {
      rethrowIfRateLimited(error);
      // Older servers lack the quota summary; per-model quota from the status call is the fallback.
      try {
        const raw = statusRaw || await read(server, port, RPC_METHODS.status, { timeoutMs: timeLeft(deadline, LOCAL_REQUEST_TIMEOUT_MS) });
        const parsed = parseAntigravityUserStatus(raw);
        return { ...tag(parsed), email: email || parsed.email || null };
      } catch {}
      lastError = error instanceof common.ProviderError ? error : new common.ProviderError('local_service_unavailable');
    }
  }
  throw lastError || new common.ProviderError('local_service_unavailable');
}

// When the app and the IDE both report a window: a later reset wins (it is the newer period);
// within the same period the lower remaining value wins, so quota is never overstated.
function preferIncoming(existing, incoming) {
  const resetExisting = Date.parse(existing.resetsAt), resetIncoming = Date.parse(incoming.resetsAt);
  if (Number.isFinite(resetIncoming) && Number.isFinite(resetExisting) && Math.abs(resetIncoming - resetExisting) > SAME_PERIOD_TOLERANCE_MS) {
    return resetIncoming > resetExisting;
  }
  if (Number.isFinite(resetIncoming) !== Number.isFinite(resetExisting)) return Number.isFinite(resetIncoming);
  if (!Number.isFinite(incoming.remainingPercent)) return false;
  return !Number.isFinite(existing.remainingPercent) || incoming.remainingPercent < existing.remainingPercent;
}

function mergeWindows(results) {
  const merged = new Map();
  for (const window of results.flatMap(result => result.windows || [])) {
    const existing = merged.get(window.id);
    if (!existing || preferIncoming(existing, window)) merged.set(window.id, window);
  }
  return [...merged.values()];
}

async function resolveServerEmails(servers, read) {
  const deadline = Date.now() + DISCOVERY_BUDGET_MS;
  return Promise.allSettled(servers.map(async server => {
    let lastError = null;
    for (const port of server.ports) {
      try {
        const email = extractEmail(await read(server, port, RPC_METHODS.status, { timeoutMs: timeLeft(deadline, LOCAL_REQUEST_TIMEOUT_MS) }));
        if (email) return email;
      } catch (error) {
        lastError = error;
      }
    }
    if (lastError) throw lastError;
    return null;
  }));
}

function createAntigravityProvider(options = {}) {
  const discoverServers = () => (options.discoverAntigravityServers || discoverAntigravityServers)(options);
  const read = options.requestLocalJson || requestLocalJson;
  return {
    id: 'antigravity',
    async discover() {
      const servers = await discoverServers();
      if (!servers.length) throw new common.ProviderError('app_closed');
      const queries = await resolveServerEmails(servers, read);
      // Fail closed: an unidentified server could belong to any account.
      if (queries.some(q => q.status === 'rejected' || !q.value)) throw new common.ProviderError('local_service_unavailable');
      const emails = [...new Set(queries.map(q => q.value))];
      return emails.map((email, index) => ({ id: antigravityAccountId(email), providerId: 'antigravity', label: email.slice(0, MAX_LABEL_LENGTH), email, primary: index === 0, enabled: true }));
    },
    async fetch(account) {
      if (account.configDir) throw new common.ProviderError('unsupported_profile');
      const servers = await discoverServers();
      if (!servers.length) throw new common.ProviderError('app_closed');
      const deadline = Date.now() + FETCH_BUDGET_MS;
      const needsEmail = Boolean(account.email) || servers.length > 1;
      const queries = await Promise.allSettled(servers.map(server => fetchServerWindows(server, read, deadline, needsEmail)));
      let successful = queries.filter(q => q.status === 'fulfilled').map(q => q.value);
      if (!successful.length) {
        const rejected = queries.find(q => q.status === 'rejected');
        throw rejected?.reason instanceof common.ProviderError ? rejected.reason : new common.ProviderError('local_service_unavailable');
      }
      // Several servers can only be merged when every one of them is tied to an account.
      if (servers.length > 1 && (queries.some(q => q.status === 'rejected') || successful.some(s => !s.email))) {
        throw new common.ProviderError('local_service_unavailable');
      }
      const accountEmail = account.email ? account.email.toLowerCase().trim() : null;
      if (accountEmail) {
        successful = successful.filter(s => s.email === accountEmail);
        if (!successful.length) throw new common.ProviderError('auth_missing');
      } else if (new Set(successful.map(s => s.email).filter(Boolean)).size > 1) {
        throw new common.ProviderError('unsupported_profile');
      }
      const windows = mergeWindows(successful);
      if (!windows.length) throw new common.ProviderError('invalid_response');
      return { windows };
    }
  };
}
module.exports = { antigravityAccountId, parseAntigravitySummary, parseAntigravityUserStatus, createAntigravityProvider, discoverAntigravityServers, parseMacProcessList, parseListeningPorts, requestLocalJson };
