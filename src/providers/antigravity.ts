import crypto from 'node:crypto';
import type { ClientRequest, IncomingMessage } from 'node:http';
import https from 'node:https';
import path from 'node:path';
import type { Environment } from '../core/environment.ts';
import { ProviderError } from '../core/errors.ts';
import { isObject, type JsonObject } from '../core/files.ts';
import { hasControlChars, isoFromUnixSeconds, normalizeWindow, safeText } from '../core/model.ts';
import { durationLabel, MAX_LABEL_LENGTH, MINUTES, type PeriodLabel } from '../shared/catalog.ts';
import type { Account, QuotaWindow } from '../shared/types.ts';
import {
  MAX_RESPONSE_BYTES,
  readJsonResponse,
  runProcess as defaultRunProcess,
  settleOnce,
  unpackedPath,
  windowsPowerShell,
  type RunProcess
} from './common.ts';
import type { DiscoveredAccount, ProviderAdapter } from './types.ts';

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
const RPC_METHODS = { quota: 'RetrieveUserQuotaSummary', status: 'GetUserStatus' } as const;
type RpcMethod = (typeof RPC_METHODS)[keyof typeof RPC_METHODS];
const RPC_METHOD_NAMES: ReadonlySet<string> = new Set(Object.values(RPC_METHODS));
const RPC_PATH_PREFIX = '/exa.language_server_pb.LanguageServerService/';
// Connect error codes (gRPC numbering) the language server returns in the body.
const CONNECT_CODES = { UNAUTHENTICATED: 16, RESOURCE_EXHAUSTED: 8 };
const SUCCESS_CODES: readonly unknown[] = [undefined, null, 0, '0', 'ok', 'success'];
const FIVE_HOUR_CADENCE = /^(5h|session|5-hour|five hour|five-hour)$/;
const WEEKLY_CADENCE = 'weekly';
const DISCOVERY_SCRIPT = unpackedPath(path.resolve(import.meta.dirname, '../launchers/discover-antigravity.ps1'));

function checkedCode(value: unknown): void {
  if (SUCCESS_CODES.includes(typeof value === 'string' ? value.toLowerCase() : value)) return;
  if (value === CONNECT_CODES.UNAUTHENTICATED || value === 'UNAUTHENTICATED') throw new ProviderError('auth_rejected');
  if (value === CONNECT_CODES.RESOURCE_EXHAUSTED || value === 'RESOURCE_EXHAUSTED') throw new ProviderError('rate_limited');
  throw new ProviderError('local_service_unavailable');
}

// Reset times arrive as an ISO string or as epoch seconds in a decimal string.
function rawReset(value: unknown): unknown {
  return typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value) ? isoFromUnixSeconds(Number(value)) : value;
}

const fractionPercent = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value * 100 : null);

// The first non-blank string among the values, as a stable identity component.
function sourceKey(...values: unknown[]): string {
  const value = values.find((v): v is string => typeof v === 'string' && v.trim() !== '');
  return value?.trim().normalize('NFC') ?? '';
}

function stableWindowId(kind: string, ...parts: string[]): string {
  return `${kind}:${crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, ID_HASH_LENGTH)}`;
}

const field = (value: unknown, key: string): unknown => (isObject(value) ? value[key] : undefined);

// The language server has reported the signed-in e-mail under several shapes.
function extractEmail(raw: unknown): string | null {
  const email = [
    field(field(raw, 'userStatus'), 'email'),
    field(field(field(raw, 'response'), 'userStatus'), 'email'),
    field(raw, 'userEmail'),
    field(raw, 'email'),
    field(field(raw, 'user'), 'email')
  ].find(value => typeof value === 'string' && value.trim());
  return typeof email === 'string' ? email.toLowerCase().trim() : null;
}

export interface AntigravityReading {
  windows: QuotaWindow[];
  email: string | null;
}

function cadenceLabel(cadence: string, fallbackName: string): PeriodLabel | { label: string } {
  if (FIVE_HOUR_CADENCE.test(cadence)) return durationLabel(MINUTES.FIVE_HOURS);
  if (cadence === WEEKLY_CADENCE) return durationLabel(MINUTES.WEEK);
  return { label: fallbackName };
}

// Bucket remaining fraction, in any of the encodings servers have used.
function bucketRemaining(bucket: JsonObject): unknown {
  const { remaining } = bucket;
  const nested = isObject(remaining)
    ? (remaining.remainingFraction ?? (remaining.case === 'remainingFraction' ? remaining.value : null))
    : null;
  return bucket.remainingFraction ?? nested;
}

// Uniquely identified windows: a repeated identity means the response is not understood.
function addUnique(ids: Set<string>, id: string): string {
  if (ids.has(id)) throw new ProviderError('invalid_response');
  ids.add(id);
  return id;
}

export function parseAntigravitySummary(raw: unknown): AntigravityReading {
  checkedCode(field(raw, 'code'));
  const groups = field(field(raw, 'response'), 'groups') ?? field(field(raw, 'summary'), 'groups') ?? field(raw, 'groups');
  if (!Array.isArray(groups)) throw new ProviderError('invalid_response');
  const windows: QuotaWindow[] = [];
  const ids = new Set<string>();
  for (const group of groups.filter(isObject)) {
    if (!Array.isArray(group.buckets)) continue;
    const groupKey = sourceKey(group.groupId, group.id, group.displayName, group.name);
    for (const bucket of group.buckets.filter(isObject)) {
      const bucketKey = sourceKey(bucket.bucketId, bucket.id, bucket.window, bucket.displayName, bucket.name);
      if (!bucketKey) throw new ProviderError('invalid_response');
      const name = sourceKey(bucket.displayName, bucket.name) || bucketKey;
      const cadence = safeText(sourceKey(bucket.window, bucket.displayName, bucket.name) || bucketKey).toLowerCase();
      windows.push(
        normalizeWindow({
          id: addUnique(ids, stableWindowId('quota', groupKey, bucketKey, sourceKey(bucket.window))),
          ...cadenceLabel(cadence, safeText(name)),
          scope: safeText(sourceKey(group.displayName, group.name)),
          detailKey: 'antigravitySourceNote',
          remainingPercent: fractionPercent(bucketRemaining(bucket)),
          resetsAt: rawReset(bucket.resetTime),
          active: typeof bucket.disabled === 'boolean' ? !bucket.disabled : undefined
        })
      );
    }
  }
  if (!windows.length) throw new ProviderError('invalid_response');
  return { windows, email: extractEmail(raw) };
}

export function parseAntigravityUserStatus(raw: unknown): AntigravityReading {
  checkedCode(field(raw, 'code'));
  const models = field(field(field(raw, 'userStatus'), 'cascadeModelConfigData'), 'clientModelConfigs') ?? field(raw, 'clientModelConfigs');
  if (!Array.isArray(models)) throw new ProviderError('invalid_response');
  const ids = new Set<string>();
  const windows = models.filter(isObject).flatMap(model => {
    const quota = model.quotaInfo;
    if (!isObject(quota)) return [];
    const modelKey = sourceKey(field(model.modelOrAlias, 'model'), model.modelId, model.label, model.displayName);
    if (!modelKey) throw new ProviderError('invalid_response');
    const label = safeText(sourceKey(model.label, model.displayName) || modelKey);
    return [
      normalizeWindow({
        id: addUnique(ids, stableWindowId('model', modelKey)),
        label,
        scope: label,
        detailKey: 'modelQuotaNoPeriod',
        remainingPercent: fractionPercent(quota.remainingFraction),
        resetsAt: rawReset(quota.resetTime)
      })
    ];
  });
  if (!windows.length) throw new ProviderError('invalid_response');
  return { windows, email: extractEmail(raw) };
}

const MAX_TOKEN_LENGTH = 512;
const MAX_LSOF_BYTES = 64 * 1024;
const MAX_PS_BYTES = 4 * 1024 * 1024;
const MAX_TCP_PORT = 65535;

export interface LanguageServer {
  pid: number;
  csrfToken: string;
  ports: number[];
  sourceKind: 'ide' | 'app';
}

const isPositiveInteger = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value > 0;
const isPort = (value: unknown): value is number => isPositiveInteger(value) && value <= MAX_TCP_PORT;
const isPid = isPositiveInteger;
// The CSRF token is sent as a header; it must be a single visible token.
const isSafeToken = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= MAX_TOKEN_LENGTH && !hasControlChars(value) && !value.includes(' ');

function validateServers(value: unknown): LanguageServer[] {
  if (!Array.isArray(value)) throw new ProviderError('local_service_unavailable');
  return value
    .slice(0, MAX_SERVERS)
    .filter(isObject)
    .flatMap(server => {
      const { pid, csrfToken, ports } = server;
      if (!isPid(pid) || !isSafeToken(csrfToken) || !Array.isArray(ports)) return [];
      const owned = [...new Set(ports.filter(isPort))].slice(0, MAX_PORTS_PER_SERVER);
      return owned.length
        ? [{ pid, csrfToken, ports: owned, sourceKind: server.sourceKind === 'ide' ? ('ide' as const) : ('app' as const) }]
        : [];
    });
}

// Process matching and PID-owned listening-port semantics follow CodexBar's
// AntigravityStatusProbe.swift (processInfos/antigravityProcessKind) and
// AntigravityStatusProbe+PortDetection.swift (lsofListeningPorts).
const LANGUAGE_SERVER = /(?:^|[/\\])language(?:_|-)server(?:[_-][a-z0-9]+)*(?:\.exe)?(?:["\s]|$)/;
const ANTIGRAVITY_BUNDLE = /\/(?:antigravity|antigravity ide|gemini)\.app\//;
const APP_DATA_DIR_FLAG = /(?:^|\s)--app_data_dir(?:=|\s)/;
const CSRF_FLAG = /(?:^|\s)--csrf_token(?:=|\s+)(?:"([^"\r\n]+)"|([^\s]+))/;
const PS_LINE = /^\s*(\d+)\s+(\d+)\s+(.+)$/;

type ProcessEntry = Omit<LanguageServer, 'ports'>;

export function parseMacProcessList(output: string, currentUid: unknown): ProcessEntry[] {
  if (typeof currentUid !== 'number' || !Number.isInteger(currentUid) || currentUid < 0) return [];
  const servers: ProcessEntry[] = [];
  for (const line of output.split(/\r?\n/)) {
    const [, pid, uid, command = ''] = PS_LINE.exec(line) ?? [];
    if (Number(uid) !== currentUid) continue;
    const lower = command.toLowerCase();
    const ownedByAntigravity =
      ANTIGRAVITY_BUNDLE.test(lower) || lower.includes('/antigravity/') || (APP_DATA_DIR_FLAG.test(lower) && lower.includes('antigravity'));
    // Only the running app's servers carry a CSRF token; tokenless CLI processes are skipped.
    if (!LANGUAGE_SERVER.test(lower) || !ownedByAntigravity) continue;
    const csrf = CSRF_FLAG.exec(command);
    const csrfToken = csrf?.[1] ?? csrf?.[2];
    const isIde = lower.includes('antigravity ide') || lower.includes('antigravity-ide') || APP_DATA_DIR_FLAG.test(lower);
    if (isSafeToken(csrfToken)) servers.push({ pid: Number(pid), csrfToken, sourceKind: isIde ? 'ide' : 'app' });
    if (servers.length >= MAX_SERVERS) break;
  }
  return servers;
}

const LSOF_OWNER = /^\S+\s+(\d+)\s+\S+\s+\S+\s+IPv4\s+/;
// Requests go to exactly 127.0.0.1. A LAN address, another 127/8 address or an IPv6-only
// socket does not prove ownership of that target.
const LSOF_LISTENER = /\bTCP\s+(?:127\.0\.0\.1|0\.0\.0\.0|\*):(\d+)\s+\(LISTEN\)\s*$/;

export function parseListeningPorts(output: string, expectedPid: unknown): number[] {
  if (!isPid(expectedPid)) return [];
  const ports = new Set<number>();
  for (const line of output.split(/\r?\n/)) {
    const owner = LSOF_OWNER.exec(line.trim());
    if (Number(owner?.[1]) !== expectedPid) continue;
    const port = Number(LSOF_LISTENER.exec(line)?.[1]);
    if (isPort(port)) ports.add(port);
  }
  return [...ports].sort((a, b) => a - b);
}

async function discoverWindowsServers(run: RunProcess, env: Environment): Promise<unknown> {
  let output: unknown;
  try {
    const stdout = await run(
      windowsPowerShell(env),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', DISCOVERY_SCRIPT],
      { timeoutMs: WINDOWS_DISCOVERY_TIMEOUT_MS, maxBytes: MAX_LSOF_BYTES }
    );
    output = JSON.parse(stdout.replace(/^\uFEFF/, ''));
  } catch (error) {
    throw error instanceof ProviderError ? error : new ProviderError('local_service_unavailable', { cause: error });
  }
  const outcome = field(output, 'outcome');
  if (outcome === 'app_closed') throw new ProviderError('app_closed');
  if (outcome !== 'success') throw new ProviderError('local_service_unavailable');
  return field(output, 'servers');
}

async function discoverMacServers(run: RunProcess, currentUid: number | undefined): Promise<unknown> {
  if (currentUid === undefined) throw new ProviderError('local_service_unavailable');
  const processes = await run('/bin/ps', ['-ax', '-o', 'pid=,uid=,command='], {
    timeoutMs: MAC_PROCESS_TIMEOUT_MS,
    maxBytes: MAX_PS_BYTES
  });
  const entries = parseMacProcessList(processes, currentUid);
  if (!entries.length) throw new ProviderError('app_closed');
  // A server whose ports cannot be listed is dropped: there is no fallback to unowned ports.
  const listed = await Promise.all(
    entries.map(entry =>
      run('/usr/sbin/lsof', ['-nP', '-i4TCP', '-sTCP:LISTEN', '-a', '-p', String(entry.pid)], {
        timeoutMs: MAC_PROCESS_TIMEOUT_MS,
        maxBytes: MAX_LSOF_BYTES
      }).then(
        output => ({ ...entry, ports: parseListeningPorts(output, entry.pid) }),
        () => null
      )
    )
  );
  return listed.filter(Boolean);
}

export interface DiscoveryOptions {
  runProcess?: RunProcess;
  platform?: NodeJS.Platform;
  env?: Environment;
  currentUid?: number;
}

export async function discoverAntigravityServers({
  runProcess = defaultRunProcess,
  platform = process.platform,
  env = process.env,
  currentUid = process.geteuid?.()
}: DiscoveryOptions = {}): Promise<LanguageServer[]> {
  let raw: unknown;
  if (platform === 'win32') raw = await discoverWindowsServers(runProcess, env);
  else if (platform === 'darwin') raw = await discoverMacServers(runProcess, currentUid);
  else throw new ProviderError('unsupported_platform');
  const servers = validateServers(raw);
  if (!servers.length) throw new ProviderError('local_service_unavailable');
  return servers;
}

function isAllowedTarget(server: LanguageServer, port: number, method: string): boolean {
  return isPid(server.pid) && isPort(port) && server.ports.includes(port) && isSafeToken(server.csrfToken) && RPC_METHOD_NAMES.has(method);
}

function requestBody(method: RpcMethod): string {
  return JSON.stringify(
    method === RPC_METHODS.quota
      ? { forceRefresh: true }
      : { metadata: { ideName: 'antigravity', extensionName: 'antigravity', locale: 'en', ideVersion: 'unknown' } }
  );
}

type HttpsRequest = (options: https.RequestOptions, callback: (response: IncomingMessage) => void) => ClientRequest;

export interface LocalRequestOptions {
  timeoutMs?: number;
  maxBytes?: number;
  request?: HttpsRequest;
}

export type RequestLocalJson = (server: LanguageServer, port: number, method: RpcMethod, options?: LocalRequestOptions) => Promise<unknown>;

// The local language server listens on 127.0.0.1 with a self-signed certificate; access is
// scoped by the per-process CSRF token and the PID-owned port, not by TLS identity.
export const requestLocalJson: RequestLocalJson = (server, port, method, options = {}) =>
  new Promise((resolve, reject) => {
    if (!isAllowedTarget(server, port, method)) {
      reject(new ProviderError('endpoint_not_allowed'));
      return;
    }
    const timeoutMs = Math.max(1, Math.min(options.timeoutMs ?? LOCAL_REQUEST_TIMEOUT_MS, LOCAL_REQUEST_TIMEOUT_MS));
    const maxBytes = Math.min(options.maxBytes ?? MAX_RESPONSE_BYTES, MAX_RESPONSE_BYTES);
    const body = requestBody(method);
    const settle = settleOnce<unknown>(resolve, reject, timeoutMs);
    try {
      const request = settle.attach(
        (options.request ?? https.request)(
          {
            hostname: '127.0.0.1',
            port,
            path: `${RPC_PATH_PREFIX}${method}`,
            method: 'POST',
            agent: false,
            rejectUnauthorized: false,
            timeout: timeoutMs,
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(body),
              'Connect-Protocol-Version': '1',
              'X-Codeium-Csrf-Token': server.csrfToken
            }
          },
          response => {
            readJsonResponse(settle.attach(response), settle, maxBytes);
          }
        )
      );
      request.on('error', () => {
        settle.fail(new ProviderError('transport_error'));
      });
      request.on('timeout', () => {
        settle.fail(new ProviderError('request_timeout'));
      });
      request.end(body);
    } catch {
      settle.fail(new ProviderError('transport_error'));
    }
  });

export function antigravityAccountId(email: string): string {
  const hash = crypto.createHash('sha256').update(email.toLowerCase().trim()).digest('hex').slice(0, ACCOUNT_HASH_LENGTH);
  return `antigravity:${hash}`;
}

const timeLeft = (deadline: number): number => Math.min(LOCAL_REQUEST_TIMEOUT_MS, Math.max(MIN_REQUEST_TIMEOUT_MS, deadline - Date.now()));
const asProviderError = (error: unknown): ProviderError =>
  error instanceof ProviderError ? error : new ProviderError('local_service_unavailable', { cause: error });

// Rate limiting is account-wide: retrying another port would only extend the cooldown.
function rethrowIfRateLimited(error: unknown): void {
  if (error instanceof ProviderError && error.code === 'rate_limited') throw error;
}

async function fetchServerWindows(
  server: LanguageServer,
  read: RequestLocalJson,
  deadline: number,
  needsEmail: boolean
): Promise<AntigravityReading> {
  let lastError: ProviderError | null = null;
  const request = (port: number, method: RpcMethod): Promise<unknown> => read(server, port, method, { timeoutMs: timeLeft(deadline) });
  for (const port of server.ports) {
    if (Date.now() >= deadline) throw new ProviderError('request_timeout');
    let email: string | null = null;
    let status: unknown = null;
    if (needsEmail) {
      // Identity first: with several servers, windows are only usable once tied to an account.
      try {
        status = await request(port, RPC_METHODS.status);
        email = extractEmail(status);
      } catch (error) {
        rethrowIfRateLimited(error);
        lastError = asProviderError(error);
      }
      if (!email) continue;
    }
    try {
      const reading = parseAntigravitySummary(await request(port, RPC_METHODS.quota));
      return { windows: reading.windows, email: email ?? reading.email };
    } catch (error) {
      rethrowIfRateLimited(error);
      // Older servers lack the quota summary; per-model quota from the status call is the fallback.
      try {
        const reading = parseAntigravityUserStatus(status ?? (await request(port, RPC_METHODS.status)));
        return { windows: reading.windows, email: email ?? reading.email };
      } catch {
        // The fallback failed as well; the original error is the one worth reporting.
      }
      lastError = asProviderError(error);
    }
  }
  throw lastError ?? new ProviderError('local_service_unavailable');
}

// When the app and the IDE both report a window: a later reset wins (it is the newer period);
// within the same period the lower remaining value wins, so quota is never overstated.
function preferIncoming(existing: QuotaWindow, incoming: QuotaWindow): boolean {
  const resetExisting = Date.parse(existing.resetsAt ?? '');
  const resetIncoming = Date.parse(incoming.resetsAt ?? '');
  const bothReset = Number.isFinite(resetIncoming) && Number.isFinite(resetExisting);
  if (bothReset && Math.abs(resetIncoming - resetExisting) > SAME_PERIOD_TOLERANCE_MS) return resetIncoming > resetExisting;
  if (Number.isFinite(resetIncoming) !== Number.isFinite(resetExisting)) return Number.isFinite(resetIncoming);
  if (incoming.remainingPercent === null) return false;
  return existing.remainingPercent === null || incoming.remainingPercent < existing.remainingPercent;
}

function mergeWindows(readings: AntigravityReading[]): QuotaWindow[] {
  const merged = new Map<string, QuotaWindow>();
  for (const window of readings.flatMap(reading => reading.windows)) {
    const existing = merged.get(window.id);
    if (!existing || preferIncoming(existing, window)) merged.set(window.id, window);
  }
  return [...merged.values()];
}

async function resolveServerEmails(servers: LanguageServer[], read: RequestLocalJson): Promise<PromiseSettledResult<string | null>[]> {
  const deadline = Date.now() + DISCOVERY_BUDGET_MS;
  return Promise.allSettled(
    servers.map(async server => {
      let lastError: ProviderError | null = null;
      for (const port of server.ports) {
        try {
          const email = extractEmail(await read(server, port, RPC_METHODS.status, { timeoutMs: timeLeft(deadline) }));
          if (email) return email;
        } catch (error) {
          lastError = asProviderError(error);
        }
      }
      if (lastError) throw lastError;
      return null;
    })
  );
}

const fulfilled = <T>(results: PromiseSettledResult<T>[]): T[] =>
  results.flatMap(result => (result.status === 'fulfilled' ? [result.value] : []));

export interface AntigravityProviderOptions extends DiscoveryOptions {
  discoverAntigravityServers?: (options: DiscoveryOptions) => Promise<LanguageServer[]>;
  requestLocalJson?: RequestLocalJson;
}

export function createAntigravityProvider(options: AntigravityProviderOptions = {}): ProviderAdapter {
  const discoverServers = (): Promise<LanguageServer[]> => (options.discoverAntigravityServers ?? discoverAntigravityServers)(options);
  const read = options.requestLocalJson ?? requestLocalJson;
  return {
    id: 'antigravity',
    async discover(): Promise<DiscoveredAccount[]> {
      const servers = await discoverServers();
      if (!servers.length) throw new ProviderError('app_closed');
      const queries = await resolveServerEmails(servers, read);
      const emails = fulfilled(queries);
      // Fail closed: an unidentified server could belong to any account.
      if (emails.length !== servers.length || emails.some(email => !email)) throw new ProviderError('local_service_unavailable');
      return [...new Set(emails.filter(email => email !== null))].map((email, index) => ({
        id: antigravityAccountId(email),
        providerId: 'antigravity',
        label: email.slice(0, MAX_LABEL_LENGTH),
        email,
        primary: index === 0,
        enabled: true
      }));
    },
    async fetch(account: Account) {
      if (account.configDir) throw new ProviderError('unsupported_profile');
      const servers = await discoverServers();
      if (!servers.length) throw new ProviderError('app_closed');
      const deadline = Date.now() + FETCH_BUDGET_MS;
      const needsEmail = Boolean(account.email) || servers.length > 1;
      const queries = await Promise.allSettled(servers.map(server => fetchServerWindows(server, read, deadline, needsEmail)));
      let readings = fulfilled(queries);
      if (!readings.length) {
        const rejected = queries.find(query => query.status === 'rejected');
        throw rejected?.reason instanceof ProviderError ? rejected.reason : new ProviderError('local_service_unavailable');
      }
      // Several servers can only be merged when every one of them is tied to an account.
      if (servers.length > 1 && (readings.length !== servers.length || readings.some(reading => !reading.email)))
        throw new ProviderError('local_service_unavailable');
      const accountEmail = account.email?.toLowerCase().trim();
      if (accountEmail) {
        readings = readings.filter(reading => reading.email === accountEmail);
        if (!readings.length) throw new ProviderError('auth_missing');
      } else if (new Set(readings.map(reading => reading.email).filter(Boolean)).size > 1) {
        throw new ProviderError('unsupported_profile');
      }
      const windows = mergeWindows(readings);
      if (!windows.length) throw new ProviderError('invalid_response');
      return { windows };
    }
  };
}
