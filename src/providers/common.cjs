'use strict';
const https = require('node:https');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { getQuotaAgent } = require('./tls-trust.cjs');
const { CREDENTIAL_ENV_KEYS } = require('../catalog.cjs');
const { version } = require('../../package.json');

const USER_AGENT = `vibe-usage/${version}`;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_HTTP_TIMEOUT_MS = 15000;
const DEFAULT_PROCESS_TIMEOUT_MS = 20000;
// Treat tokens this close to expiry as expired: a request started now would fail mid-flight.
const TOKEN_EXPIRY_SKEW_MS = 60 * 1000;
const RETRY_AFTER_BOUNDS_SECONDS = { min: 60, max: 900 };

// The only remote endpoints the app may call. Everything else is rejected before a request.
const QUOTA_ENDPOINTS = Object.freeze({
  claude: 'https://api.anthropic.com/api/oauth/usage',
  cursor: 'https://cursor.com/api/usage-summary'
});
const ALLOWED_ENDPOINTS = new Set(Object.values(QUOTA_ENDPOINTS));

const ERROR_CODES = new Set([
  'auth_missing', 'auth_expired', 'auth_invalid', 'auth_rejected', 'rate_limited', 'transport_error', 'request_timeout',
  'response_too_large', 'invalid_response', 'http_rejected', 'endpoint_not_allowed', 'binary_missing', 'invalid_binary',
  'process_failed', 'process_timeout', 'rpc_error', 'rpc_timeout', 'server_closed', 'app_closed', 'local_service_unavailable',
  'unsupported_platform', 'unsupported_profile', 'keychain_unavailable', 'provider_failed', 'tls_certificate_error',
  'trust_store_unavailable'
]);
const CERTIFICATE_ERRORS = new Set([
  'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'CERT_UNTRUSTED', 'CERT_REJECTED',
  'CERT_SIGNATURE_FAILURE', 'ERR_TLS_CERT_ALTNAME_INVALID'
]);

class ProviderError extends Error {
  constructor(code, options = {}) {
    super(ERROR_CODES.has(code) ? code : 'provider_failed');
    this.name = 'ProviderError';
    this.code = this.message;
    if (options.retryAfterSeconds !== undefined) {
      const seconds = Number(options.retryAfterSeconds) || RETRY_AFTER_BOUNDS_SECONDS.min;
      this.retryAfterSeconds = Math.max(RETRY_AFTER_BOUNDS_SECONDS.min, Math.min(RETRY_AFTER_BOUNDS_SECONDS.max, seconds));
    }
  }
}
function safeError(error) { return error instanceof ProviderError ? error.code : 'provider_failed'; }
function now(clock = Date.now) { const result = clock(); return result instanceof Date ? result.getTime() : Number(result); }

function isExpired(epochMs, clock) {
  return Number.isFinite(epochMs) && epochMs <= now(clock) + TOKEN_EXPIRY_SKEW_MS;
}

// Reads JWT claims without verifying the signature: only the expiry and subject are used,
// to fail fast locally; the provider still authenticates the token.
function jwtClaims(token) {
  const parts = typeof token === 'string' ? token.split('.') : [];
  if (parts.length !== 3) throw new ProviderError('auth_invalid');
  try { return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); }
  catch { throw new ProviderError('auth_invalid'); }
}

async function readJson(file) {
  try {
    const stat = await fs.stat(file);
    if (stat.size > MAX_RESPONSE_BYTES) throw new ProviderError('invalid_response');
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError(error.code === 'ENOENT' ? 'auth_missing' : 'auth_invalid');
  }
}

function retryAfterSeconds(header) {
  const seconds = Number(header);
  return Number.isFinite(seconds) ? seconds : Math.ceil((Date.parse(header) - Date.now()) / 1000);
}

function httpStatusError(response) {
  const status = response.statusCode;
  const code = status === 429 ? 'rate_limited' : status === 401 || status === 403 ? 'auth_rejected' : 'http_rejected';
  return new ProviderError(code, { retryAfterSeconds: retryAfterSeconds(response.headers?.['retry-after']) });
}

// Settles `finish` exactly once with the parsed JSON body, or a ProviderError. Handlers stay
// attached after settling: a destroyed stream can still emit error/aborted later.
function readJsonResponse(response, finish, maxBytes = MAX_RESPONSE_BYTES) {
  response.on('error', () => finish(new ProviderError('transport_error')));
  response.on('aborted', () => finish(new ProviderError('transport_error')));
  // A rejected response is destroyed by `finish`; its body is never read.
  if (response.statusCode !== 200) {
    finish(httpStatusError(response));
    return;
  }
  let bytes = 0, chunks = [];
  response.on('data', chunk => {
    bytes += chunk.length;
    if (bytes > maxBytes) { chunks = []; finish(new ProviderError('response_too_large')); } else chunks.push(chunk);
  });
  response.on('end', () => {
    try { finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { finish(new ProviderError('invalid_response')); }
  });
}

// One-shot settle helper shared by the HTTP clients: clears the deadline and, on failure,
// tears down every attached stream. Attach request and response as soon as they exist.
function settleOnce(resolve, reject, timeoutMs) {
  let settled = false;
  const streams = [];
  const deadline = setTimeout(() => finish(new ProviderError('request_timeout')), timeoutMs);
  function finish(error, value) {
    if (settled) return;
    settled = true;
    clearTimeout(deadline);
    if (error) { for (const stream of streams) stream?.destroy?.(); reject(error); } else resolve(value);
  }
  const attach = stream => { streams.push(stream); return stream; };
  return { finish, attach };
}

function getJson(endpoint, { headers = {}, timeoutMs = DEFAULT_HTTP_TIMEOUT_MS, requestImpl = https.get } = {}) {
  return new Promise((resolve, reject) => {
    if (!ALLOWED_ENDPOINTS.has(endpoint)) return reject(new ProviderError('endpoint_not_allowed'));
    const { finish, attach } = settleOnce(resolve, reject, timeoutMs);
    try {
      const request = attach(requestImpl(new URL(endpoint), { headers, timeout: timeoutMs, agent: getQuotaAgent(), rejectUnauthorized: true }, response => {
        readJsonResponse(attach(response), finish);
      }));
      request.on('timeout', () => finish(new ProviderError('request_timeout')));
      request.on('error', error => finish(new ProviderError(CERTIFICATE_ERRORS.has(error.code) ? 'tls_certificate_error' : 'transport_error')));
    } catch (error) {
      finish(new ProviderError(error.message === 'trust_store_unavailable' ? 'trust_store_unavailable' : 'transport_error'));
    }
  });
}

// Files inside app.asar cannot be executed; electron-builder unpacks them next to it.
function unpackedPath(file) {
  return file.replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');
}

// Windows ships this interpreter; it is all the launch and discovery scripts need.
function windowsPowerShell(env = process.env) {
  const candidate = env.VIBE_POWERSHELL_BINARY || path.win32.join(env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  if (!validBinary(candidate, 'win32')) throw new ProviderError('invalid_binary');
  return candidate;
}

function validBinary(file, platform = process.platform) {
  if (typeof file !== 'string' || !file || /[\x00-\x1f]/.test(file) || /\.(cmd|bat|ps1)$/i.test(file)) return false;
  return (platform === 'win32' ? path.win32 : path.posix).isAbsolute(file);
}

// Per-user install locations that GUI-launched apps miss: Finder/Explorer do not load the
// shell profile that would put them on PATH.
function knownInstallLocations(name, { env, home, platform }) {
  const filename = platform === 'win32' ? `${name}.exe` : name;
  const locations = [];
  if (name === 'codex' && platform === 'win32') locations.push(path.join(env.LOCALAPPDATA || path.join(home, 'AppData/Local'), 'Programs/OpenAI/Codex/bin/codex.exe'));
  if (['claude', 'cursor-agent', 'agent'].includes(name)) locations.push(path.join(home, '.local/bin', filename));
  return locations;
}

async function macPathHelperDirectories() {
  const files = ['/etc/paths', ...await fs.readdir('/etc/paths.d').then(entries => entries.map(entry => path.join('/etc/paths.d', entry))).catch(() => [])];
  const directories = [];
  for (const file of files) {
    try { directories.push(...(await fs.readFile(file, 'utf8')).split(/\r?\n/).filter(p => p.startsWith('/'))); } catch {}
  }
  return directories;
}

async function findBinary(name, { env = process.env, home = os.homedir(), platform = process.platform } = {}) {
  const override = env[`VIBE_${name.toUpperCase().replace(/-/g, '_')}_BINARY`];
  if (override) {
    if (!validBinary(override, platform)) throw new ProviderError('invalid_binary');
    if (await fs.stat(override).then(s => s.isFile()).catch(() => false)) return override;
    throw new ProviderError('binary_missing');
  }
  const filename = platform === 'win32' ? `${name}.exe` : name;
  const directories = (env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
  if (platform === 'darwin') directories.push(...await macPathHelperDirectories());
  const candidates = [...knownInstallLocations(name, { env, home, platform }), ...directories.map(directory => path.join(directory, filename))];
  for (const candidate of candidates) {
    if (validBinary(candidate, platform) && await fs.stat(candidate).then(s => s.isFile()).catch(() => false)) return candidate;
  }
  throw new ProviderError('binary_missing');
}

// Copy of `source` without credential overrides (matched case-insensitively on Windows,
// where environment names are case-insensitive), plus `config`.
function cleanEnvironment(config = {}, platform = process.platform, source = process.env) {
  const blocked = new Set(CREDENTIAL_ENV_KEYS.map(k => platform === 'win32' ? k.toLowerCase() : k));
  const environment = Object.fromEntries(Object.entries(source).filter(([key]) => !blocked.has(platform === 'win32' ? key.toLowerCase() : key)));
  return { ...environment, ...config };
}

function runProcess(binary, args, { env, platform = process.platform, timeoutMs = DEFAULT_PROCESS_TIMEOUT_MS, maxBytes = MAX_RESPONSE_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    if (!validBinary(binary, platform) || !Array.isArray(args) || args.some(a => typeof a !== 'string' || a.includes('\0'))) return reject(new ProviderError('invalid_binary'));
    const child = spawn(binary, args, { env: env || cleanEnvironment({}, platform), shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', bytes = 0, failure = null;
    const timer = setTimeout(() => { failure = new ProviderError('process_timeout'); child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > maxBytes) { output = ''; failure = new ProviderError('response_too_large'); child.kill('SIGKILL'); } else output += chunk.toString();
    });
    child.stderr.on('data', () => {});
    child.on('error', () => { clearTimeout(timer); reject(new ProviderError('process_failed')); });
    child.on('close', code => {
      clearTimeout(timer);
      if (failure) reject(failure); else if (code !== 0) reject(new ProviderError('process_failed')); else resolve(output);
    });
  });
}

module.exports = {
  USER_AGENT, MAX_RESPONSE_BYTES, QUOTA_ENDPOINTS, ProviderError, safeError, now, isExpired, jwtClaims, readJson,
  readJsonResponse, settleOnce, getJson, unpackedPath, windowsPowerShell, findBinary, cleanEnvironment, runProcess
};
