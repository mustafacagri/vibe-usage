// What the diagnostics screen and its copyable report show: whether each tool is present,
// the state of its accounts, how fresh their readings are, and a concrete next step.
// Accounts appear only as ordinals; nothing here carries a label, address, path or token.
import os from 'node:os';
import path from 'node:path';
import { findCommand, TOOL_INSTALLS, windowsAppPath, type DesktopApp } from '../providers/common.ts';
import { APP_NAME, DURATION_MS, PROVIDER_IDS, providerById, type ProviderId } from '../shared/catalog.ts';
import type {
  AccountDiagnostics,
  AccountStatus,
  Diagnostics,
  Fault,
  MeasuredAccount,
  ProviderDiagnostics,
  ProviderStatus,
  Remedy,
  Snapshot,
  StatusCode
} from '../shared/types.ts';

export type { AccountDiagnostics, Diagnostics, ProviderDiagnostics, Remedy } from '../shared/types.ts';
import type { Environment } from './environment.ts';
import { isDirectory, isFile } from './files.ts';

// A reading older than this many refresh intervals is shown as stale.
const STALE_INTERVALS = 3;

// English wording for the report, which is meant to be pasted into a GitHub issue.
export const REMEDY_TEXT: Readonly<Record<Remedy, string>> = {
  remedyInstallTool: 'Install the tool, then refresh.',
  remedyInstallCli: "Install the tool's command-line interface, or check where it is installed.",
  remedyAllowProgram: 'Allow Vibe Usage to start the tool in the antivirus program or security policy, then refresh.',
  remedySignIn: 'Sign in again with the tool, then refresh.',
  remedyOpenApp: 'Open the app, then refresh.',
  remedyUnlockKeychain: 'Unlock the Keychain and allow access when asked, then refresh.',
  remedyWaitRateLimit: 'Wait a few minutes; the provider is limiting requests.',
  remedyCheckNetwork: 'Check the internet connection, proxy or VPN, then refresh.',
  remedyCheckCertificates: "Check the system's certificate trust and any TLS-inspecting proxy, then refresh.",
  remedyNotSupported: 'Reading this account is not supported on this system yet.',
  remedyAddAccount: 'Sign in with the tool or add an account in Settings.',
  remedyWaitForRefresh: 'Wait for the current reading to finish.',
  remedyUpdateTool: 'Update the tool to its latest version, then refresh.',
  remedyRetryLater: 'Refresh again later; if it keeps failing, report an issue with this report.',
  remedyReportIssue: 'This looks like a Vibe Usage bug; report an issue with this report.'
};

type Code = ProviderStatus | StatusCode;

// Every status and message code the app knows. Doubles as the allow-list of what may be
// reported: anything else in a snapshot is treated as unknown.
const REMEDIES: Readonly<Record<Code, Remedy | null>> = {
  pending: 'remedyWaitForRefresh',
  ok: null,
  stale: 'remedyRetryLater',
  no_limits_reported: null,
  unavailable: 'remedyRetryLater',
  no_accounts: 'remedyAddAccount',
  auth_missing: 'remedySignIn',
  auth_expired: 'remedySignIn',
  auth_invalid: 'remedySignIn',
  auth_rejected: 'remedySignIn',
  rate_limited: 'remedyWaitRateLimit',
  transport_error: 'remedyCheckNetwork',
  request_timeout: 'remedyCheckNetwork',
  tls_certificate_error: 'remedyCheckCertificates',
  trust_store_unavailable: 'remedyCheckCertificates',
  response_too_large: 'remedyUpdateTool',
  invalid_response: 'remedyUpdateTool',
  rpc_error: 'remedyUpdateTool',
  http_rejected: 'remedyRetryLater',
  endpoint_not_allowed: 'remedyReportIssue',
  binary_missing: 'remedyInstallCli',
  invalid_binary: 'remedyInstallCli',
  process_failed: 'remedyRetryLater',
  process_blocked: 'remedyAllowProgram',
  process_timeout: 'remedyRetryLater',
  rpc_timeout: 'remedyRetryLater',
  server_closed: 'remedyRetryLater',
  app_closed: 'remedyOpenApp',
  local_service_unavailable: 'remedyOpenApp',
  unsupported_platform: 'remedyNotSupported',
  unsupported_profile: 'remedyNotSupported',
  keychain_unavailable: 'remedyUnlockKeychain',
  provider_failed: 'remedyRetryLater'
};

const isCode = (value: unknown): value is Code => typeof value === 'string' && Object.hasOwn(REMEDIES, value);
const accountStatus = (value: unknown): AccountStatus =>
  isCode(value) && value !== 'unavailable' && value !== 'no_accounts' ? value : 'provider_failed';
const providerStatus = (value: unknown): ProviderStatus => (isCode(value) && value !== 'no_accounts' ? value : 'unavailable');
const messageCode = (value: unknown): StatusCode | null =>
  isCode(value) && value !== 'pending' && value !== 'ok' && value !== 'stale' && value !== 'unavailable' ? value : null;

// A stale reading keeps the failure that made it stale in its message code; that failure is
// what the user can act on.
export const remedyFor = (status: ProviderStatus, code: StatusCode | null): Remedy | null => REMEDIES[code ?? status];

// Whether a tool is present on this device: true, false, or null when it cannot be told.
export interface ToolProbe {
  installed(providerId: ProviderId): Promise<boolean | null>;
}

function freshness(
  fetchedAt: unknown,
  status: ProviderStatus,
  staleAfterMs: number,
  now: number
): { ageMs: number | null; stale: boolean } {
  const time = typeof fetchedAt === 'string' ? Date.parse(fetchedAt) : NaN;
  // A reading stamped in the future (a clock change) counts as just taken.
  const ageMs = Number.isFinite(time) ? Math.max(0, now - time) : null;
  return { ageMs, stale: status === 'stale' || (ageMs !== null && ageMs > staleAfterMs) };
}

// A failing tool usually takes its state from its accounts, whose remedy is more specific.
function providerRemedy(
  installed: boolean | null,
  status: ProviderStatus,
  code: StatusCode | null,
  accounts: readonly AccountDiagnostics[]
): Remedy | null {
  // A tool the probe misses but that still reads fine is present in a form the probe does not know.
  if (installed === false && !accounts.some(a => a.status === 'ok')) return 'remedyInstallTool';
  if (status === 'ok' || code) return remedyFor(status, code);
  return accounts.find(a => a.remedy)?.remedy ?? remedyFor(status, null);
}

async function probeSafely(probe: ToolProbe, id: ProviderId): Promise<boolean | null> {
  try {
    return await probe.installed(id);
  } catch {
    return null;
  }
}

export async function collectDiagnostics(
  snapshot: Snapshot,
  probe: ToolProbe,
  now: number,
  faults: readonly Fault[] = []
): Promise<Diagnostics> {
  const { settings } = snapshot;
  const staleAfterMs = STALE_INTERVALS * settings.intervalSeconds * 1000;
  const installed = await Promise.all(PROVIDER_IDS.map(id => probeSafely(probe, id)));
  const providers = PROVIDER_IDS.map((id, index): ProviderDiagnostics => {
    const state = snapshot.providers.find(provider => provider.id === id);
    const measured = state?.accounts ?? [];
    // Settings list every account, disabled ones too; the service measures only enabled ones.
    const configured = settings.accounts.filter(a => a.providerId === id);
    const accounts: Pick<MeasuredAccount, 'id' | 'enabled' | 'primary' | 'status' | 'messageCode' | 'fetchedAt'>[] = [
      ...configured.map(a => measured.find(m => m.id === a.id) ?? { ...a, status: 'pending' as const }),
      ...measured.filter(m => !configured.some(a => a.id === m.id))
    ];
    const rows = accounts.map((a, i): AccountDiagnostics => {
      const status = accountStatus(a.status);
      const code = messageCode(a.messageCode);
      return {
        ordinal: i + 1,
        enabled: a.enabled,
        primary: a.primary,
        status,
        messageCode: code,
        ...freshness(a.fetchedAt, status, staleAfterMs, now),
        // A disabled account is the user's choice, not a fault.
        remedy: a.enabled ? remedyFor(status, code) : null
      };
    });
    const status = providerStatus(state?.status);
    const code = messageCode(state?.messageCode);
    const isInstalled = installed[index] ?? null;
    return {
      id,
      installed: isInstalled,
      status,
      messageCode: code,
      accountCount: rows.length,
      enabledCount: rows.filter(a => a.enabled).length,
      ...freshness(state?.fetchedAt, status, staleAfterMs, now),
      remedy: providerRemedy(isInstalled, status, code, rows),
      accounts: rows
    };
  });
  return { generatedAt: now, intervalSeconds: settings.intervalSeconds, refreshing: snapshot.refreshing, providers, faults: [...faults] };
}

export interface ToolProbeOptions {
  homeDir?: string;
  platform?: NodeJS.Platform;
  env?: Environment;
}

// Looks tools up the way launches do (TOOL_INSTALLS), but only looks for files: it never starts
// a tool, which could ask to sign in or touch credentials.
export function createToolProbe({
  homeDir = os.homedir(),
  platform = process.platform,
  env = process.env
}: ToolProbeOptions = {}): ToolProbe {
  // null when this platform has no known app location.
  async function hasApp(app: DesktopApp): Promise<boolean | null> {
    if (platform === 'win32') return isFile(windowsAppPath(app, env, homeDir));
    if (platform === 'darwin') {
      const bundles = ['/Applications', path.join(homeDir, 'Applications')].map(dir => path.join(dir, `${app.mac}.app`));
      return (await Promise.all(bundles.map(isDirectory))).some(Boolean);
    }
    return null;
  }
  async function hasBinary(name: string): Promise<boolean> {
    return findCommand(name, { env, home: homeDir, platform }).then(
      () => true,
      () => false
    );
  }
  return {
    async installed(providerId) {
      const { binaries, app } = TOOL_INSTALLS[providerId];
      const found = await Promise.all([...binaries.map(hasBinary), app ? hasApp(app) : false]);
      if (found.includes(true)) return true;
      return found.includes(null) ? null : false;
    }
  };
}

export interface ReportContext {
  appVersion: string;
  platform: string;
  arch: string;
  generatedAt: number;
  // Removed from the report wherever it appears, along with its last segment (the user name).
  homeDir?: string;
}

const yesNo = (value: boolean | null): string => (value === null ? 'unknown' : value ? 'yes' : 'no');
const safeToken = (value: string, pattern: RegExp): string => (pattern.test(value) ? value : 'unknown');
const VERSION_PATTERN = /^[0-9A-Za-z.+-]{1,40}$/;
const SYSTEM_PATTERN = /^[a-z0-9_]{1,20}$/i;

function formatAge(ageMs: number | null): string {
  if (ageMs === null) return 'never';
  const minutes = Math.floor(ageMs / DURATION_MS.MINUTE);
  if (minutes < 1) return 'under 1 min ago';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours} h ${minutes % 60} min ago` : `${Math.floor(hours / 24)} d ago`;
}

const formatStatus = (status: string, code: StatusCode | null): string => (code && code !== status ? `${status} (${code})` : status);
const formatRemedy = (remedy: Remedy | null): string => (remedy ? REMEDY_TEXT[remedy] : 'none');

// Anything with an @, absolute Windows, UNC and POSIX paths, and home-relative paths.
const REDACTIONS: readonly RegExp[] = [/[^\s|`]*@[^\s|`]*/g, /(?:\b[A-Za-z]:[\\/]|\\\\)[^\s|`]*/g, /(?<![\w.-])~?\/[^\s|`]*/g];
const REDACTED = '[redacted]';

// A last pass over the finished report, so a mistake upstream cannot leak identity.
export function redactReport(text: string, homeDir?: string): string {
  let result = text;
  if (homeDir) {
    // win32 parsing accepts both separators, whatever the host.
    const user = path.win32.basename(homeDir);
    const variants = new Set([homeDir, homeDir.replaceAll('\\', '/'), homeDir.replaceAll('/', '\\')]);
    for (const variant of variants) result = result.replace(new RegExp(RegExp.escape(variant), 'gi'), REDACTED);
    // Short names would also match ordinary words in the report.
    if (user.length >= 3) result = result.replace(new RegExp(`\\b${RegExp.escape(user)}\\b`, 'gi'), REDACTED);
  }
  for (const pattern of REDACTIONS) result = result.replace(pattern, REDACTED);
  return result;
}

// Plain Markdown in English, to paste into a GitHub issue: codes, counts, ages and ordinals only.
export function renderDiagnosticsReport(diagnostics: Diagnostics, context: ReportContext): string {
  const lines = [
    `## ${APP_NAME} diagnostics`,
    '',
    `- Version: ${safeToken(context.appVersion, VERSION_PATTERN)}`,
    `- OS: ${safeToken(context.platform, SYSTEM_PATTERN)} ${safeToken(context.arch, SYSTEM_PATTERN)}`,
    `- Generated: ${Number.isFinite(context.generatedAt) ? new Date(context.generatedAt).toISOString() : 'unknown'}`,
    `- Refresh interval: ${diagnostics.intervalSeconds} s`,
    `- Refreshing: ${yesNo(diagnostics.refreshing)}`
  ];
  for (const provider of diagnostics.providers) {
    lines.push(
      '',
      `### ${providerById(provider.id).name}`,
      '',
      `- Installed: ${yesNo(provider.installed)}`,
      `- Status: ${formatStatus(provider.status, provider.messageCode)}`,
      `- Accounts: ${provider.accountCount} configured, ${provider.enabledCount} enabled`,
      `- Last measured: ${formatAge(provider.ageMs)}${provider.stale ? ', stale' : ''}`,
      `- Next step: ${formatRemedy(provider.remedy)}`
    );
    if (!provider.accounts.length) continue;
    lines.push(
      '',
      '| Account | Enabled | Primary | Status | Last measured | Stale | Next step |',
      '| --- | --- | --- | --- | --- | --- | --- |',
      ...provider.accounts
        .map(a =>
          [
            `Account ${a.ordinal}`,
            yesNo(a.enabled),
            yesNo(a.primary),
            formatStatus(a.status, a.messageCode),
            formatAge(a.ageMs),
            yesNo(a.stale),
            formatRemedy(a.remedy)
          ].join(' | ')
        )
        .map(row => `| ${row} |`)
    );
  }
  if (diagnostics.faults.length)
    lines.push(
      '',
      '### Unexpected errors',
      '',
      ...diagnostics.faults.map(fault => `- ${new Date(fault.at).toISOString()} · ${fault.action} · ${fault.error}`)
    );
  return `${redactReport(lines.join('\n'), context.homeDir)}\n`;
}
