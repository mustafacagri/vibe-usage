'use strict';
const https = require('node:https');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { getQuotaAgent } = require('./tls-trust.cjs');

const ERROR_CODES = new Set(['auth_missing', 'auth_expired', 'auth_invalid', 'auth_rejected', 'rate_limited', 'transport_error', 'request_timeout', 'response_too_large', 'invalid_response', 'http_rejected', 'endpoint_not_allowed', 'binary_missing', 'invalid_binary', 'process_failed', 'process_timeout', 'rpc_error', 'rpc_timeout', 'server_closed', 'app_closed', 'local_service_unavailable', 'unsupported_platform', 'unsupported_profile', 'keychain_unavailable', 'provider_failed']);
ERROR_CODES.add('tls_certificate_error');
ERROR_CODES.add('trust_store_unavailable');
const CERTIFICATE_ERRORS = new Set(['SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'CERT_UNTRUSTED', 'CERT_REJECTED', 'CERT_SIGNATURE_FAILURE', 'ERR_TLS_CERT_ALTNAME_INVALID']);
class ProviderError extends Error {
  constructor(code, options = {}) { super(ERROR_CODES.has(code) ? code : 'provider_failed'); this.code = this.message; if (options.retryAfterSeconds !== undefined) this.retryAfterSeconds = Math.max(60, Math.min(900, Number(options.retryAfterSeconds) || 60)); }
}
function safeError(error) { return error instanceof ProviderError ? error.code : 'provider_failed'; }
function now(clock = Date.now) { const result = clock(); return result instanceof Date ? result.getTime() : Number(result); }
async function readJson(file) {
  try { const stat = await fs.stat(file); if (stat.size > 1024 * 1024) throw new ProviderError('invalid_response'); return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error instanceof ProviderError) throw error; throw new ProviderError(error.code === 'ENOENT' ? 'auth_missing' : 'auth_invalid'); }
}
function getJson(endpoint, { headers = {}, timeoutMs = 15000, requestImpl = https.get } = {}) {
  return new Promise((resolve, reject) => {
    let url; try { url = new URL(endpoint); } catch { return reject(new ProviderError('endpoint_not_allowed')); }
    const allowed = (url.hostname === 'api.anthropic.com' && url.pathname === '/api/oauth/usage') || (url.hostname === 'cursor.com' && url.pathname === '/api/usage-summary');
    if (!allowed || url.protocol !== 'https:' || url.port || url.username || url.password || url.search || url.hash) return reject(new ProviderError('endpoint_not_allowed'));
    let request, received, settled=false;
    const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(deadline);if(error){received?.destroy();request?.destroy();reject(error);}else resolve(value);};
    const deadline=setTimeout(()=>finish(new ProviderError('request_timeout')),timeoutMs);
    try { request = requestImpl(url, { headers, timeout: timeoutMs, agent: getQuotaAgent(), rejectUnauthorized: true }, response => {
      received=response;
      response.on('error', () => finish(new ProviderError('transport_error')));
      response.on('aborted', () => finish(new ProviderError('transport_error')));
      if (response.statusCode !== 200) {
        response.resume();
        const retryHeader = response.headers['retry-after'];
        let retryAfterSeconds = Number(retryHeader);
        if (!Number.isFinite(retryAfterSeconds)) retryAfterSeconds = Math.ceil((Date.parse(retryHeader) - Date.now()) / 1000);
        finish(new ProviderError(response.statusCode === 429 ? 'rate_limited' : [401, 403].includes(response.statusCode) ? 'auth_rejected' : 'http_rejected', { retryAfterSeconds })); return;
      }
      let bytes = 0, chunks = [];
      response.on('data', chunk => { bytes += chunk.length; if (bytes > 1024 * 1024) { chunks = []; finish(new ProviderError('response_too_large')); } else chunks.push(chunk); });
      response.on('end', () => { try { finish(null,JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { finish(new ProviderError('invalid_response')); } });
    });
    request.on('timeout', () => finish(new ProviderError('request_timeout')));
    request.on('error', error => finish(new ProviderError(CERTIFICATE_ERRORS.has(error.code) ? 'tls_certificate_error' : 'transport_error')));
    } catch (error) { finish(new ProviderError(error.message === 'trust_store_unavailable' ? 'trust_store_unavailable' : 'transport_error')); }
  });
}
function validBinary(file) { return typeof file === 'string' && path.isAbsolute(file) && !/[\x00-\x1f]/.test(file) && !/\.(cmd|bat|ps1)$/i.test(file); }
async function findBinary(name, { env = process.env, home = os.homedir(), platform = process.platform } = {}) {
  const override = env[`VIBE_${name.toUpperCase()}_BINARY`];
  if (override) { if (!validBinary(override)) throw new ProviderError('invalid_binary'); try { if ((await fs.stat(override)).isFile()) return override; } catch {} throw new ProviderError('binary_missing'); }
  // Verified Windows desktop installation; PATH lookup also supports npm/Homebrew
  // installs on macOS. Finder doesn't inherit shell startup files, so consult
  // macOS path_helper's /etc/paths and paths.d, rather than executing a shell.
  const filename = platform === 'win32' ? `${name}.exe` : name;
  let directories = (env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
  if (platform === 'darwin') {
    for (const file of ['/etc/paths', ...await fs.readdir('/etc/paths.d').then(entries => entries.map(entry => path.join('/etc/paths.d', entry))).catch(() => [])]) {
      try { directories.push(...(await fs.readFile(file, 'utf8')).split(/\r?\n/).filter(p => p.startsWith('/'))); } catch {}
    }
  }
  let candidates = directories.map(directory => path.join(directory, filename));
  if (name === 'codex' && platform === 'win32') candidates.unshift(path.join(env.LOCALAPPDATA || path.join(home, 'AppData/Local'), 'Programs/OpenAI/Codex/bin/codex.exe'));
  if (name === 'claude') candidates.unshift(path.join(home, '.local/bin', filename));
  for (const candidate of candidates) { if (!validBinary(candidate)) continue; try { if ((await fs.stat(candidate)).isFile()) return candidate; } catch {} }
  throw new ProviderError('binary_missing');
}
function cleanEnvironment(config = {}) {
  const environment = { ...process.env, ...config };
  for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'ACCESS_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CURSOR_API_KEY']) delete environment[key];
  return environment;
}
function runProcess(binary, args, { env, timeoutMs = 20000, maxBytes = 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    if (!validBinary(binary) || !Array.isArray(args) || args.some(a => typeof a !== 'string' || a.includes('\0'))) return reject(new ProviderError('invalid_binary'));
    const child = spawn(binary, args, { env: env || cleanEnvironment(), shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', bytes = 0, failure = null;
    const timer = setTimeout(() => { failure = new ProviderError('process_timeout'); child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > maxBytes) { output = ''; failure = new ProviderError('response_too_large'); child.kill('SIGKILL'); } else output += chunk.toString(); });
    child.stderr.on('data', () => {});
    child.on('error', () => { clearTimeout(timer); reject(new ProviderError('process_failed')); });
    child.on('close', code => { clearTimeout(timer); if (failure) reject(failure); else if (code !== 0) reject(new ProviderError('process_failed')); else resolve(output); });
  });
}
module.exports = { ProviderError, safeError, now, readJson, getJson, validBinary, findBinary, cleanEnvironment, runProcess };
