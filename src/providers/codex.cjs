'use strict';
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { normalizeWindow, isoDate, safeText, safePlan } = require('../core/model.cjs');
const { durationLabel } = require('../catalog.cjs');
const common = require('./common.cjs');
const { version } = require('../../package.json');

const RPC_TIMEOUT_MS = 10000;
const SHUTDOWN_GRACE_MS = 2000;
// The default bucket is the account-wide limit; other buckets are model-specific scopes.
const DEFAULT_BUCKET = 'codex';
const WINDOW_SLOTS = ['primary', 'secondary'];

function parseCodexRateLimits(response) {
  if (!response || typeof response !== 'object' || Array.isArray(response)) throw new common.ProviderError('invalid_response');
  if (!response.rateLimitsByLimitId && !response.rateLimits) throw new common.ProviderError('invalid_response');
  const buckets = response.rateLimitsByLimitId || { [DEFAULT_BUCKET]: response.rateLimits };
  const windows = [];
  for (const [bucketId, bucket] of Object.entries(buckets)) {
    for (const slot of WINDOW_SLOTS) {
      const raw = bucket?.[slot];
      if (!raw) continue;
      windows.push(normalizeWindow({
        id: `${bucketId}:${slot}`,
        ...durationLabel(raw.windowDurationMins),
        usedPercent: raw.usedPercent,
        resetsAt: isoDate(raw.resetsAt, true),
        ...(bucketId !== DEFAULT_BUCKET ? { scope: safeText(bucketId) } : {})
      }));
    }
  }
  return windows.length ? { windows } : { windows, status: 'no_limits_reported' };
}

// Minimal JSON-RPC client over the Codex app server's stdio transport.
function startAppServer(binary, configDir) {
  const child = spawn(binary, ['app-server', '--listen', 'stdio://'], {
    shell: false, windowsHide: true, env: common.cleanEnvironment({ CODEX_HOME: configDir }), stdio: ['pipe', 'pipe', 'pipe']
  });
  const pending = new Map();
  let buffer = '', closed = false, serial = 0;

  function rejectAll() {
    closed = true;
    for (const item of pending.values()) item.reject(new common.ProviderError('server_closed'));
    pending.clear();
  }
  child.on('error', rejectAll);
  child.on('close', rejectAll);
  child.stderr.on('data', () => {});
  child.stdin.on('error', () => {});
  child.stdout.on('data', chunk => {
    buffer += chunk.toString();
    if (buffer.length > common.MAX_RESPONSE_BYTES) { rejectAll(); child.kill(); return; }
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      let packet;
      try { packet = JSON.parse(line); } catch { continue; }
      const item = pending.get(packet.id);
      if (!item) continue;
      pending.delete(packet.id);
      if (packet.error) item.reject(new common.ProviderError('rpc_error')); else item.resolve(packet.result);
    }
  });

  function send(message) {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  }
  function request(method, params) {
    return new Promise((resolve, reject) => {
      if (closed) return reject(new common.ProviderError('server_closed'));
      const id = ++serial;
      const timeout = setTimeout(() => { pending.delete(id); reject(new common.ProviderError('rpc_timeout')); }, RPC_TIMEOUT_MS);
      pending.set(id, {
        resolve: value => { clearTimeout(timeout); resolve(value); },
        reject: error => { clearTimeout(timeout); reject(error); }
      });
      send({ id, method, ...(params ? { params } : {}) });
    });
  }
  async function stop() {
    child.stdin.end();
    child.kill();
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise(resolve => {
        const timer = setTimeout(resolve, SHUTDOWN_GRACE_MS);
        child.once('close', () => { clearTimeout(timer); resolve(); });
      });
    }
    rejectAll();
  }
  return { request, notify: method => send({ method }), stop };
}

async function probeAccount(binary, configDir) {
  const server = startAppServer(binary, configDir);
  try {
    await server.request('initialize', { clientInfo: { name: 'vibe_usage', title: 'Vibe Usage', version }, capabilities: { experimentalApi: false } });
    server.notify('initialized');
    const account = await server.request('account/read', { refreshToken: false });
    if (!account?.account) throw new common.ProviderError('auth_missing');
    const result = parseCodexRateLimits(await server.request('account/rateLimits/read'));
    const plan = safePlan(account.account.planType);
    if (plan) result.plan = plan;
    return result;
  } finally {
    await server.stop();
  }
}

// Fails fast on a locally expired token; a missing auth file is left to the app server,
// which reports the signed-out state itself.
async function assertTokenNotExpired(configDir, clock) {
  let auth;
  try { auth = await common.readJson(path.join(configDir, 'auth.json')); }
  catch (error) { if (error.code === 'auth_missing') return; throw error; }
  const token = auth.tokens?.access_token;
  if (typeof token === 'string' && common.isExpired(common.jwtClaims(token).exp * 1000, clock)) throw new common.ProviderError('auth_expired');
}

function createCodexProvider(options = {}) {
  const home = options.home || os.homedir();
  const defaultConfigDir = process.env.CODEX_HOME || path.join(home, '.codex');
  return {
    id: 'codex',
    discover: async () => [{ id: 'codex:default', providerId: 'codex', labelKey: 'defaultAccount', configDir: defaultConfigDir, primary: true, enabled: true }],
    async fetch(account) {
      const configDir = account.configDir || defaultConfigDir;
      await assertTokenNotExpired(configDir, options.clock);
      return probeAccount(await common.findBinary('codex', options), configDir);
    }
  };
}

module.exports = { parseCodexRateLimits, createCodexProvider };
