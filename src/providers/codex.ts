import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import { cleanEnvironment, type Environment } from '../core/environment.ts';
import { ProviderError } from '../core/errors.ts';
import { attemptSync, isObject } from '../core/files.ts';
import { isoFromUnixSeconds, normalizeWindow, safeEmail, safePlan, safeText } from '../core/model.ts';
import type { QuotaWindow } from '../shared/types.ts';
import { accountId, APP_NAME, APP_SLUG, DEFAULT_ACCOUNT_KEY, durationLabel, PROFILE_ENV } from '../shared/catalog.ts';
import {
  APP_VERSION,
  findCommand,
  isExpired,
  jwtClaims,
  MAX_RESPONSE_BYTES,
  processStartError,
  readCredentialFile,
  remainingTimeout,
  type BinaryLocation,
  type Clock,
  type ToolCommand
} from './common.ts';
import { defaultProfileDir, isRegularFile, profileAccountId, profileFolders, profileLabel } from './profiles.ts';
import {
  type Discovery,
  type DiscoveredAccount,
  type FetchResult,
  type ParsedQuota,
  type ProviderAdapter,
  type RefreshContext
} from './types.ts';

export const DEFAULT_ACCOUNT_ID = accountId('codex', DEFAULT_ACCOUNT_KEY);
const AUTH_FILE = 'auth.json';
// Where a Codex home keeps its session rollouts, by date.
export const CODEX_SESSIONS_DIR = 'sessions';
const RPC_TIMEOUT_MS = 10000;
const SHUTDOWN_GRACE_MS = 2000;
// The app server's requests in a read, one after the other (see probeAccount).
const PROBE_REQUESTS = 3;
// The default bucket is the account-wide limit; other buckets are model-specific scopes.
const DEFAULT_BUCKET = 'codex';
const WINDOW_SLOTS = ['primary', 'secondary'] as const;

export function parseCodexRateLimits(response: unknown): ParsedQuota {
  if (!isObject(response) || !(isObject(response.rateLimitsByLimitId) || isObject(response.rateLimits)))
    throw new ProviderError('invalid_response');
  const buckets = isObject(response.rateLimitsByLimitId) ? response.rateLimitsByLimitId : { [DEFAULT_BUCKET]: response.rateLimits };
  const windows: QuotaWindow[] = [];
  for (const [bucketId, value] of Object.entries(buckets)) {
    if (value !== null && !isObject(value)) throw new ProviderError('invalid_response');
    for (const slot of WINDOW_SLOTS) {
      const raw = isObject(value) ? value[slot] : undefined;
      if (raw !== undefined && raw !== null && !isObject(raw)) throw new ProviderError('invalid_response');
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
  return windows.length ? { windows, completeness: 'complete' } : { windows, status: 'no_limits_reported', completeness: 'complete' };
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
type ServerProcess = Pick<ChildProcess, 'on' | 'once' | 'kill' | 'exitCode' | 'signalCode'> & { stdin: Writable; stdout: Readable };
export type SpawnAppServer = (binary: string, args: readonly string[], options: SpawnOptions) => ServerProcess;
const spawnAppServer: SpawnAppServer = (binary, args, options) => spawn(binary, args, { ...options, stdio: ['pipe', 'pipe', 'ignore'] });

function startAppServer(command: ToolCommand, configDir: string, spawnProcess: SpawnAppServer, context?: RefreshContext): RpcServer {
  remainingTimeout(RPC_TIMEOUT_MS, context);
  let child: ServerProcess;
  try {
    child = spawnProcess(command.binary, [...command.args, 'app-server', '--listen', 'stdio://'], {
      shell: false,
      windowsHide: true,
      env: cleanEnvironment({ [PROFILE_ENV.codex]: configDir }),
      stdio: ['pipe', 'pipe', 'ignore']
    });
  } catch (error) {
    throw processStartError(error, 'server_closed');
  }
  const pending = new Map<number, Pending>();
  let buffer = '';
  let closed = false;
  let serial = 0;

  function rejectAll(error = new ProviderError('server_closed')): void {
    closed = true;
    for (const item of pending.values()) item.reject(error);
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

  child.on('error', error => {
    rejectAll(processStartError(error, 'server_closed'));
  });
  child.on('close', () => {
    rejectAll();
  });
  const abort = (): void => {
    rejectAll(new ProviderError('request_timeout'));
    child.kill('SIGKILL');
  };
  context?.signal.addEventListener('abort', abort, { once: true });
  if (context?.signal.aborted) abort();
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
        const timeout = setTimeout(
          () => {
            pending.delete(id);
            reject(new ProviderError('rpc_timeout'));
          },
          remainingTimeout(RPC_TIMEOUT_MS, context)
        );
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
      remainingTimeout(RPC_TIMEOUT_MS, context);
      send({ method });
    },
    async stop() {
      child.stdin.end();
      child.kill();
      if (child.exitCode === null && child.signalCode === null) {
        await new Promise<void>(resolve => {
          const timer = setTimeout(() => {
            child.kill('SIGKILL');
            resolve();
          }, SHUTDOWN_GRACE_MS);
          child.once('close', () => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
      context?.signal.removeEventListener('abort', abort);
      rejectAll();
    }
  };
}

async function probeAccount(
  command: ToolCommand,
  configDir: string,
  spawnProcess: SpawnAppServer,
  context?: RefreshContext
): Promise<FetchResult> {
  const server = startAppServer(command, configDir, spawnProcess, context);
  try {
    await server.request('initialize', {
      // The app server takes a client name as an identifier with underscores.
      clientInfo: { name: APP_SLUG.replaceAll('-', '_'), title: APP_NAME, version: APP_VERSION },
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

// The signed-in e-mail from the local auth file, failing fast on a locally expired token. A
// missing auth file is left to the app server, which reports the signed-out state itself.
async function readLocalSignIn(configDir: string, clock?: Clock, context?: RefreshContext): Promise<string | undefined> {
  const auth = await readCredentialFile(path.join(configDir, AUTH_FILE), context).catch((error: unknown) => {
    if (error instanceof ProviderError && error.code === 'auth_missing') return null;
    throw error;
  });
  const tokens = isObject(auth?.tokens) ? auth.tokens : {};
  if (typeof tokens.access_token === 'string') {
    const { exp } = jwtClaims(tokens.access_token);
    if (typeof exp === 'number' && isExpired(exp * 1000, clock)) throw new ProviderError('auth_expired');
  }
  return safeEmail(attemptSync(() => jwtClaims(tokens.id_token).email));
}

// The folder plain `codex` uses: CODEX_HOME when set, else `~/.codex`.
const codexDefaultDir = (home: string, env: Environment = process.env): string =>
  env[PROFILE_ENV.codex] ?? defaultProfileDir('codex', home);

// The account a Codex home folder holds; Codex keeps one sign-in per folder.
export function codexProfile(configDir: string, home: string, env: Environment = process.env): DiscoveredAccount {
  const resolved = path.resolve(configDir);
  const isDefault = resolved === path.resolve(codexDefaultDir(home, env));
  return {
    id: isDefault ? DEFAULT_ACCOUNT_ID : profileAccountId('codex', resolved),
    providerId: 'codex',
    ...(isDefault ? { labelKey: 'defaultAccount' as const } : { label: profileLabel('codex', resolved) }),
    configDir: resolved,
    primary: isDefault,
    enabled: true
  };
}

// Whether a Codex home folder holds a sign-in.
export const isSignedInCodexHome = (root: string): Promise<boolean> => isRegularFile(path.join(root, AUTH_FILE));

// The default folder always counts: its app server reports a signed-out state itself. Other
// profile folders count once they hold a sign-in.
// A profile folder that cannot be inspected is unknown, not absent, and does not hide the others.
async function discoverCodexAccounts(home: string, env: Environment): Promise<Discovery> {
  const defaultDir = path.resolve(codexDefaultDir(home, env));
  const others: DiscoveredAccount[] = [];
  let complete = true;
  for (const root of await profileFolders('codex', home)) {
    try {
      if (path.resolve(root) !== defaultDir && (await isSignedInCodexHome(root))) others.push(codexProfile(root, home, env));
    } catch {
      complete = false;
    }
  }
  return {
    kind: complete ? 'complete' : 'unknown',
    accounts: [codexProfile(defaultDir, home, env), ...others.sort((a, b) => a.id.localeCompare(b.id))]
  };
}

export interface CodexProviderOptions extends BinaryLocation {
  clock?: Clock;
  spawnProcess?: SpawnAppServer;
}

export function createCodexProvider(options: CodexProviderOptions = {}): ProviderAdapter {
  const home = options.home ?? os.homedir();
  const env = options.env ?? process.env;
  const defaultConfigDir = codexDefaultDir(home, env);
  return {
    id: 'codex',
    fetchTimeoutMs: PROBE_REQUESTS * RPC_TIMEOUT_MS + SHUTDOWN_GRACE_MS,
    discover: () => discoverCodexAccounts(home, env).catch((): Discovery => ({ kind: 'unknown', accounts: [] })),
    async fetch(account, context) {
      const configDir = account.configDir ?? defaultConfigDir;
      const signedInAs = await readLocalSignIn(configDir, options.clock, context);
      const result = await probeAccount(await findCommand('codex', options), configDir, options.spawnProcess ?? spawnAppServer, context);
      return signedInAs ? { ...result, signedInAs } : result;
    }
  };
}
