// Transport shared by the providers: HTTPS to the allow-listed quota endpoints, local
// processes, and locating the tools' binaries.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import type { ClientRequest, IncomingMessage } from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { cleanEnvironment, type Environment } from '../core/environment.ts';
import { ProviderError, systemErrorCode } from '../core/errors.ts';
import { isFile, isObject, type JsonObject } from '../core/files.ts';
import { hasControlChars } from '../core/model.ts';
import { APP_SLUG, DURATION_MS, type ProviderId } from '../shared/catalog.ts';
import { getQuotaAgent } from './tls-trust.ts';
import type { RefreshContext } from './types.ts';

export type Clock = () => number;

export function remainingTimeout(timeoutMs: number, context?: Partial<RefreshContext>): number {
  const remaining = context?.deadline === undefined ? timeoutMs : Math.min(timeoutMs, context.deadline - Date.now());
  if (context?.signal?.aborted || remaining <= 0) throw new ProviderError('request_timeout');
  return remaining;
}

const packageJson: unknown = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
export const APP_VERSION = isObject(packageJson) && typeof packageJson.version === 'string' ? packageJson.version : '0.0.0';
export const USER_AGENT = `${APP_SLUG}/${APP_VERSION}`;
export const MAX_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_HTTP_TIMEOUT_MS = 15000;
const DEFAULT_PROCESS_TIMEOUT_MS = 20000;
// Treat tokens this close to expiry as expired: a request started now would fail mid-flight.
const TOKEN_EXPIRY_SKEW_MS = DURATION_MS.MINUTE;

// The only remote endpoints the app may call. Everything else is rejected before a request.
export const QUOTA_ENDPOINTS = {
  claude: 'https://api.anthropic.com/api/oauth/usage',
  cursor: 'https://cursor.com/api/usage-summary',
  copilot: 'https://api.github.com/copilot_internal/user'
} as const;
const ALLOWED_ENDPOINTS: ReadonlySet<string> = new Set(Object.values(QUOTA_ENDPOINTS));

const CERTIFICATE_ERRORS = new Set([
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'CERT_UNTRUSTED',
  'CERT_REJECTED',
  'CERT_SIGNATURE_FAILURE',
  'ERR_TLS_CERT_ALTNAME_INVALID'
]);

// The first `length` hex digits of the value's SHA-256: a stable, short id that reveals nothing.
export const sha256Prefix = (value: string, length: number): string =>
  crypto.createHash('sha256').update(value).digest('hex').slice(0, length);

export function isExpired(epochMs: unknown, clock: Clock = Date.now): boolean {
  return typeof epochMs === 'number' && Number.isFinite(epochMs) && epochMs <= clock() + TOKEN_EXPIRY_SKEW_MS;
}

// Reads JWT claims without verifying the signature: only the expiry and subject are used, to
// fail fast locally; the provider still authenticates the token.
export function jwtClaims(token: unknown): JsonObject {
  const payload = typeof token === 'string' ? token.split('.') : [];
  if (payload.length !== 3) throw new ProviderError('auth_invalid');
  try {
    const claims: unknown = JSON.parse(Buffer.from(payload[1] ?? '', 'base64url').toString('utf8'));
    if (isObject(claims)) return claims;
  } catch {
    // reported below
  }
  throw new ProviderError('auth_invalid');
}

// A credentials document written by a provider's own tool.
export async function readCredentialFile(file: string, context?: RefreshContext): Promise<JsonObject> {
  let document: unknown;
  try {
    remainingTimeout(DEFAULT_PROCESS_TIMEOUT_MS, context);
    const stat = await fsp.stat(file);
    if (stat.size > MAX_RESPONSE_BYTES) throw new ProviderError('invalid_response');
    document = JSON.parse(await fsp.readFile(file, { encoding: 'utf8', ...(context ? { signal: context.signal } : {}) }));
    remainingTimeout(DEFAULT_PROCESS_TIMEOUT_MS, context);
  } catch (error) {
    if (context?.signal.aborted) throw new ProviderError('request_timeout');
    if (error instanceof ProviderError) throw error;
    throw new ProviderError(systemErrorCode(error) === 'ENOENT' ? 'auth_missing' : 'auth_invalid', { cause: error });
  }
  if (!isObject(document)) throw new ProviderError('auth_invalid');
  return document;
}

function retryAfterSeconds(header: string | string[] | undefined): number | undefined {
  if (typeof header !== 'string') return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) ? seconds : Math.ceil((Date.parse(header) - Date.now()) / 1000);
}

function httpStatusError(response: IncomingMessage): ProviderError {
  const status = response.statusCode;
  const code = status === 429 ? 'rate_limited' : status === 401 || status === 403 ? 'auth_rejected' : 'http_rejected';
  const retryAfter = retryAfterSeconds(response.headers['retry-after']);
  return new ProviderError(code, retryAfter === undefined ? {} : { retryAfterSeconds: retryAfter });
}

interface Destroyable {
  destroy(): void;
}

export interface Settle<T> {
  succeed(value: T): void;
  fail(error: ProviderError): void;
  // Registers a stream to tear down on failure; attach request and response as soon as they exist.
  attach<S extends Destroyable>(stream: S): S;
}

// One-shot settlement shared by the HTTP clients: the first outcome wins, the deadline is
// cleared, and a failure destroys every attached stream.
export function settleOnce<T>(
  resolve: (value: T) => void,
  reject: (error: ProviderError) => void,
  timeoutMs: number,
  signal?: AbortSignal
): Settle<T> {
  let settled = false;
  const streams: Destroyable[] = [];
  const deadline = setTimeout(() => {
    fail(new ProviderError('request_timeout'));
  }, timeoutMs);
  const settle = (): boolean => {
    if (settled) return false;
    settled = true;
    clearTimeout(deadline);
    signal?.removeEventListener('abort', abort);
    return true;
  };
  function fail(error: ProviderError): void {
    if (!settle()) return;
    for (const stream of streams) stream.destroy();
    reject(error);
  }
  const abort = (): void => {
    fail(new ProviderError('request_timeout'));
  };
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  return {
    succeed: value => {
      if (settle()) resolve(value);
    },
    fail,
    attach: stream => {
      if (settled) stream.destroy();
      else streams.push(stream);
      return stream;
    }
  };
}

// Settles with the parsed JSON body. Handlers stay attached after settling: a destroyed
// stream can still emit error or aborted later.
export function readJsonResponse(response: IncomingMessage, settle: Settle<unknown>, maxBytes = MAX_RESPONSE_BYTES): void {
  response.on('error', () => {
    settle.fail(new ProviderError('transport_error'));
  });
  response.on('aborted', () => {
    settle.fail(new ProviderError('transport_error'));
  });
  // A rejected response is destroyed on failure; its body is never read.
  if (response.statusCode !== 200) {
    settle.fail(httpStatusError(response));
    return;
  }
  let bytes = 0;
  let chunks: Buffer[] = [];
  response.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > maxBytes) {
      chunks = [];
      settle.fail(new ProviderError('response_too_large'));
    } else chunks.push(chunk);
  });
  response.on('end', () => {
    try {
      settle.succeed(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    } catch {
      settle.fail(new ProviderError('invalid_response'));
    }
  });
}

export type QuotaEndpoint = (typeof QUOTA_ENDPOINTS)[keyof typeof QUOTA_ENDPOINTS];
type HttpsGet = (url: URL, options: https.RequestOptions, callback: (response: IncomingMessage) => void) => ClientRequest;

export interface GetJsonOptions extends Partial<RefreshContext> {
  headers?: Readonly<Record<string, string>>;
  timeoutMs?: number;
  requestImpl?: HttpsGet;
}

export type GetJson = (endpoint: QuotaEndpoint, options?: GetJsonOptions) => Promise<unknown>;

export const getJson: GetJson = (
  endpoint,
  { headers = {}, timeoutMs = DEFAULT_HTTP_TIMEOUT_MS, requestImpl = https.get, ...context } = {}
) =>
  new Promise((resolve, reject) => {
    if (!ALLOWED_ENDPOINTS.has(endpoint)) {
      reject(new ProviderError('endpoint_not_allowed'));
      return;
    }
    try {
      timeoutMs = remainingTimeout(timeoutMs, context);
    } catch (error) {
      reject(error instanceof Error ? error : new ProviderError('request_timeout'));
      return;
    }
    const settle = settleOnce<unknown>(resolve, reject, timeoutMs, context.signal);
    try {
      const request = settle.attach(
        requestImpl(new URL(endpoint), { headers, timeout: timeoutMs, agent: getQuotaAgent(), rejectUnauthorized: true }, response => {
          readJsonResponse(settle.attach(response), settle);
        })
      );
      request.on('timeout', () => {
        settle.fail(new ProviderError('request_timeout'));
      });
      request.on('error', error => {
        settle.fail(
          new ProviderError(CERTIFICATE_ERRORS.has(String(systemErrorCode(error))) ? 'tls_certificate_error' : 'transport_error')
        );
      });
    } catch (error) {
      settle.fail(error instanceof ProviderError ? error : new ProviderError('transport_error', { cause: error }));
    }
  });

// Files inside app.asar cannot be executed; electron-builder unpacks them next to it.
export function unpackedPath(file: string): string {
  return file.replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');
}

function isValidBinary(file: unknown, platform: NodeJS.Platform = process.platform): file is string {
  if (typeof file !== 'string' || !file || hasControlChars(file) || /\.(cmd|bat|ps1)$/i.test(file)) return false;
  return (platform === 'win32' ? path.win32 : path.posix).isAbsolute(file);
}

// Windows ships this interpreter; it is all the launch and discovery scripts need.
export function windowsPowerShell(env: Environment = process.env): string {
  const candidate =
    env.VIBE_POWERSHELL_BINARY ?? path.win32.join(env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  if (!isValidBinary(candidate, 'win32')) throw new ProviderError('invalid_binary');
  return candidate;
}

export interface BinaryLocation {
  env?: Environment;
  home?: string;
  platform?: NodeJS.Platform;
}

export interface DesktopApp {
  // The macOS bundle name.
  mac: string;
  // The path of the per-user Windows install, under the local app data's Programs folder.
  windows: readonly string[];
}

// The GitHub CLI, which holds the sign-in Copilot's quota is read with.
export const GITHUB_CLI = 'gh';

// How each tool is installed: its command-line binaries in lookup order, and its desktop app.
// Launches and diagnostics both look tools up here.
export const TOOL_INSTALLS: Readonly<Record<ProviderId, { binaries: readonly string[]; app?: DesktopApp }>> = {
  claude: { binaries: ['claude'] },
  codex: { binaries: ['codex'] },
  // The Cursor Agent CLI; older installs only have the `agent` name.
  cursor: { binaries: ['cursor-agent', 'agent'], app: { mac: 'Cursor', windows: ['cursor', 'Cursor.exe'] } },
  antigravity: { binaries: [], app: { mac: 'Antigravity', windows: ['Antigravity', 'Antigravity.exe'] } },
  // Copilot has no program of its own here: the GitHub CLI holds the sign-in its quota is read with.
  copilot: { binaries: [GITHUB_CLI] }
};

const localAppData = (env: Environment, home: string): string => env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local');

// Where a desktop app's per-user Windows installer puts its executable.
export const windowsAppPath = (app: DesktopApp, env: Environment, home: string): string =>
  path.join(localAppData(env, home), 'Programs', ...app.windows);

// Per-user install locations that GUI-launched apps miss: Finder/Explorer do not load the
// shell profile that would put them on PATH.
const HOME_BIN_TOOLS: ReadonlySet<string> = new Set([
  ...TOOL_INSTALLS.claude.binaries,
  ...TOOL_INSTALLS.codex.binaries,
  ...TOOL_INSTALLS.cursor.binaries
]);
function knownInstallLocations(name: string, env: Environment, home: string, platform: NodeJS.Platform): string[] {
  const filename = platform === 'win32' ? `${name}.exe` : name;
  const locations: string[] = [];
  if (name === 'codex' && platform === 'win32') locations.push(path.join(localAppData(env, home), 'Programs/OpenAI/Codex/bin/codex.exe'));
  if (HOME_BIN_TOOLS.has(name)) locations.push(path.join(home, '.local/bin', filename));
  return locations;
}

// Apple Silicon Homebrew's folder: only the shell profile (`brew shellenv`) puts it on PATH, so
// Finder- and Dock-launched apps miss it. Intel Homebrew's `/usr/local/bin` is in `/etc/paths`.
const HOMEBREW_BIN = '/opt/homebrew/bin';

// The directories macOS path_helper adds to PATH (missing files simply add nothing), and Homebrew's.
async function macPathHelperDirectories(): Promise<string[]> {
  const extra = await fsp.readdir('/etc/paths.d').catch(() => []);
  const files = ['/etc/paths', ...extra.map(entry => path.join('/etc/paths.d', entry))];
  const contents = await Promise.all(files.map(file => fsp.readFile(file, 'utf8').catch(() => '')));
  return [...contents.flatMap(text => text.split(/\r?\n/).filter(line => line.startsWith('/'))), HOMEBREW_BIN];
}

// `VIBE_<NAME>_BINARY` overrides the search; otherwise known install locations, then PATH.
export async function findBinary(
  name: string,
  { env = process.env, home = os.homedir(), platform = process.platform }: BinaryLocation = {}
): Promise<string> {
  const override = env[`VIBE_${name.toUpperCase().replaceAll('-', '_')}_BINARY`];
  if (override) {
    if (!isValidBinary(override, platform)) throw new ProviderError('invalid_binary');
    if (await isFile(override)) return override;
    throw new ProviderError('binary_missing');
  }
  const filename = platform === 'win32' ? `${name}.exe` : name;
  const directories = (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean);
  if (platform === 'darwin') directories.push(...(await macPathHelperDirectories()));
  const candidates = [...knownInstallLocations(name, env, home, platform), ...directories.map(directory => path.join(directory, filename))];
  for (const candidate of candidates) {
    if (isValidBinary(candidate, platform) && (await isFile(candidate))) return candidate;
  }
  throw new ProviderError('binary_missing');
}

export interface RunOptions extends Partial<RefreshContext> {
  env?: Record<string, string>;
  platform?: NodeJS.Platform;
  timeoutMs?: number;
  maxBytes?: number;
}

export type RunProcess = (binary: string, args: readonly string[], options?: RunOptions) => Promise<string>;

// Runs a binary without a shell and resolves with its stdout. The environment has no
// credential overrides unless `env` is given.
export const runProcess: RunProcess = (
  binary,
  args,
  { env, platform = process.platform, timeoutMs = DEFAULT_PROCESS_TIMEOUT_MS, maxBytes = MAX_RESPONSE_BYTES, ...context } = {}
) =>
  new Promise((resolve, reject) => {
    if (!isValidBinary(binary, platform) || args.some(arg => arg.includes('\0'))) {
      reject(new ProviderError('invalid_binary'));
      return;
    }
    try {
      timeoutMs = remainingTimeout(timeoutMs, context);
    } catch (error) {
      reject(error instanceof Error ? error : new ProviderError('request_timeout'));
      return;
    }
    const child = spawn(binary, args, {
      env: env ?? cleanEnvironment({}, platform),
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    let output = '';
    let bytes = 0;
    let failure: ProviderError | null = null;
    const abort = (): void => {
      failure = new ProviderError('request_timeout');
      child.kill('SIGKILL');
    };
    context.signal?.addEventListener('abort', abort, { once: true });
    if (context.signal?.aborted) abort();
    const timer = setTimeout(() => {
      failure = new ProviderError('process_timeout');
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        output = '';
        failure = new ProviderError('response_too_large');
        child.kill('SIGKILL');
      } else output += chunk.toString();
    });
    child.on('error', () => {
      clearTimeout(timer);
      context.signal?.removeEventListener('abort', abort);
      reject(new ProviderError('process_failed'));
    });
    child.on('close', code => {
      clearTimeout(timer);
      context.signal?.removeEventListener('abort', abort);
      if (failure) reject(failure);
      else if (code !== 0) reject(new ProviderError('process_failed'));
      else resolve(output);
    });
  });
