import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { cleanEnvironment } from '../core/environment.ts';
import { ProviderError } from '../core/errors.ts';
import { isObject } from '../core/files.ts';
import { isoFromUnixSeconds, normalizeWindow, safePlan, safeText } from '../core/model.ts';
import type { QuotaWindow } from '../shared/types.ts';
import { durationLabel } from '../shared/catalog.ts';
import {
  APP_VERSION,
  findBinary,
  isExpired,
  jwtClaims,
  MAX_RESPONSE_BYTES,
  readCredentialFile,
  type BinaryLocation,
  type Clock
} from './common.ts';
import type { FetchResult, ParsedQuota, ProviderAdapter } from './types.ts';

const RPC_TIMEOUT_MS = 10000;
const SHUTDOWN_GRACE_MS = 2000;
// The default bucket is the account-wide limit; other buckets are model-specific scopes.
const DEFAULT_BUCKET = 'codex';
const WINDOW_SLOTS = ['primary', 'secondary'] as const;

export function parseCodexRateLimits(response: unknown): ParsedQuota {
  if (!isObject(response) || !(isObject(response.rateLimitsByLimitId) || isObject(response.rateLimits)))
    throw new ProviderError('invalid_response');
  const buckets = isObject(response.rateLimitsByLimitId) ? response.rateLimitsByLimitId : { [DEFAULT_BUCKET]: response.rateLimits };
  const windows: QuotaWindow[] = [];
  for (const [bucketId, value] of Object.entries(buckets)) {
    for (const slot of WINDOW_SLOTS) {
      const raw = isObject(value) ? value[slot] : undefined;
      if (!isObject(raw)) continue;
      windows.push(
        normalizeWindow({
          id: `${bucketId}:${slot}`,
          ...durationLabel(raw.windowDurationMins),
          usedPercent: raw.usedPercent,
          resetsAt: isoFromUnixSeconds(raw.resetsAt),
          ...(bucketId === DEFAULT_BUCKET ? {} : { scope: safeText(bucketId) })
        })
      );
    }
  }
  return windows.length ? { windows } : { windows, status: 'no_limits_reported' };
}

interface RpcServer {
  request(method: string, params?: object): Promise<unknown>;
  notify(method: string): void;
  stop(): Promise<void>;
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: ProviderError): void;
}

// Minimal JSON-RPC client over the Codex app server's stdio transport.
function startAppServer(binary: string, configDir: string): RpcServer {
  const child = spawn(binary, ['app-server', '--listen', 'stdio://'], {
    shell: false,
    windowsHide: true,
    env: cleanEnvironment({ CODEX_HOME: configDir }),
    stdio: ['pipe', 'pipe', 'ignore']
  });
  const pending = new Map<number, Pending>();
  let buffer = '';
  let closed = false;
  let serial = 0;

  function rejectAll(): void {
    closed = true;
    for (const item of pending.values()) item.reject(new ProviderError('server_closed'));
    pending.clear();
  }

  function receive(line: string): void {
    let packet: unknown;
    try {
      packet = JSON.parse(line);
    } catch {
      return;
    }
    if (!isObject(packet) || typeof packet.id !== 'number') return;
    const item = pending.get(packet.id);
    if (!item) return;
    pending.delete(packet.id);
    if (packet.error) item.reject(new ProviderError('rpc_error'));
    else item.resolve(packet.result);
  }

  child.on('error', rejectAll);
  child.on('close', rejectAll);
  // Writing to a server that already exited fails with EPIPE; `close` reports that instead.
  child.stdin.on('error', () => undefined);
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    if (buffer.length > MAX_RESPONSE_BYTES) {
      rejectAll();
      child.kill();
      return;
    }
    for (let newline = buffer.indexOf('\n'); newline !== -1; newline = buffer.indexOf('\n')) {
      receive(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
    }
  });

  const send = (message: object): void => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  };

  return {
    request: (method, params) =>
      new Promise((resolve, reject) => {
        if (closed) {
          reject(new ProviderError('server_closed'));
          return;
        }
        const id = ++serial;
        const timeout = setTimeout(() => {
          pending.delete(id);
          reject(new ProviderError('rpc_timeout'));
        }, RPC_TIMEOUT_MS);
        pending.set(id, {
          resolve: value => {
            clearTimeout(timeout);
            resolve(value);
          },
          reject: error => {
            clearTimeout(timeout);
            reject(error);
          }
        });
        send({ id, method, ...(params ? { params } : {}) });
      }),
    notify: method => {
      send({ method });
    },
    async stop() {
      child.stdin.end();
      child.kill();
      if (child.exitCode === null && child.signalCode === null) {
        await new Promise<void>(resolve => {
          const timer = setTimeout(resolve, SHUTDOWN_GRACE_MS);
          child.once('close', () => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
      rejectAll();
    }
  };
}

async function probeAccount(binary: string, configDir: string): Promise<FetchResult> {
  const server = startAppServer(binary, configDir);
  try {
    await server.request('initialize', {
      clientInfo: { name: 'vibe_usage', title: 'Vibe Usage', version: APP_VERSION },
      capabilities: { experimentalApi: false }
    });
    server.notify('initialized');
    const read = await server.request('account/read', { refreshToken: false });
    const account = isObject(read) ? read.account : undefined;
    if (!isObject(account)) throw new ProviderError('auth_missing');
    const result = parseCodexRateLimits(await server.request('account/rateLimits/read'));
    const plan = safePlan(account.planType);
    return plan ? { ...result, plan } : result;
  } finally {
    await server.stop();
  }
}

// Fails fast on a locally expired token; a missing auth file is left to the app server, which
// reports the signed-out state itself.
async function assertTokenNotExpired(configDir: string, clock?: Clock): Promise<void> {
  const auth = await readCredentialFile(path.join(configDir, 'auth.json')).catch((error: unknown) => {
    if (error instanceof ProviderError && error.code === 'auth_missing') return null;
    throw error;
  });
  const token = isObject(auth?.tokens) ? auth.tokens.access_token : undefined;
  if (typeof token !== 'string') return;
  const { exp } = jwtClaims(token);
  if (typeof exp === 'number' && isExpired(exp * 1000, clock)) throw new ProviderError('auth_expired');
}

export interface CodexProviderOptions extends BinaryLocation {
  clock?: Clock;
}

export function createCodexProvider(options: CodexProviderOptions = {}): ProviderAdapter {
  const home = options.home ?? os.homedir();
  const defaultConfigDir = process.env.CODEX_HOME ?? path.join(home, '.codex');
  return {
    id: 'codex',
    discover: () =>
      Promise.resolve([
        { id: 'codex:default', providerId: 'codex', labelKey: 'defaultAccount', configDir: defaultConfigDir, primary: true, enabled: true }
      ]),
    async fetch(account) {
      const configDir = account.configDir ?? defaultConfigDir;
      await assertTokenNotExpired(configDir, options.clock);
      return probeAccount(await findBinary('codex', options), configDir);
    }
  };
}
