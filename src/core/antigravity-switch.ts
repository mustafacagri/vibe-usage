// Manual Antigravity active-account switching and OS-keyring backup/restore.
//
// Antigravity keeps one active sign-in per machine in the OS credential store
// (`gemini:antigravity` in Windows Credential Manager; service `gemini`, account
// `antigravity` in macOS Keychain). Switching copies a signed-in isolated profile's
// credential into that slot AFTER backing up the previous value to a separate OS
// credential-store entry (`vibe-usage:antigravity-backup`), then restarts the local
// `agy --hub` process. Node.js never reads, logs or prints raw token bytes: the
// platform helper script performs the file-to-keyring and backup transfers directly.
import path from 'node:path';
import { antigravityTokenPath } from '../providers/antigravity.ts';
import { runProcess as defaultRunProcess, unpackedPath, windowsPowerShell, type RunProcess } from '../providers/common.ts';
import { isRegularFile } from '../providers/profiles.ts';
import type { Account } from '../shared/types.ts';
import type { Environment } from './environment.ts';
import { AppError } from './errors.ts';
import { isObject, parseJson } from './files.ts';
import { validateConfigDir } from './settings.ts';

const SWITCH_TIMEOUT_MS = 15_000;
const WINDOWS_SCRIPT = unpackedPath(path.resolve(import.meta.dirname, '../launchers/antigravity-credential.ps1'));
const MAC_SCRIPT = unpackedPath(path.resolve(import.meta.dirname, '../launchers/antigravity-credential.sh'));
const ZSH = '/bin/zsh';

export const ANTIGRAVITY_KEYRING = {
  target: 'gemini:antigravity',
  backupTarget: 'vibe-usage:antigravity-backup',
  macService: 'gemini',
  macAccount: 'antigravity',
  macBackupService: 'vibe-usage',
  macBackupAccount: 'antigravity-backup'
} as const;

export interface AntigravitySwitchOptions {
  platform?: NodeJS.Platform;
  env?: Environment;
  runProcess?: RunProcess;
  isFile?: (file: string) => Promise<boolean>;
}

export interface AntigravitySwitchResult {
  hubRestarted: boolean;
  backedUp?: boolean;
}

type HelperAction = 'status' | 'switch' | 'restore';

interface HelperResponse {
  ok: boolean;
  hasBackup?: boolean;
  backedUp?: boolean;
  hubRestarted?: boolean;
  error?: string;
}

function parseHelperOutput(output: string): HelperResponse {
  const line = output
    .split(/\r?\n/)
    .map(part => part.trim())
    .filter(Boolean)
    .at(-1);
  if (!line) throw new AppError('antigravity_switch_failed');
  let parsed: unknown;
  try {
    parsed = parseJson(line);
  } catch {
    throw new AppError('antigravity_switch_failed');
  }
  if (!isObject(parsed) || typeof parsed.ok !== 'boolean') throw new AppError('antigravity_switch_failed');
  return {
    ok: parsed.ok,
    ...(typeof parsed.hasBackup === 'boolean' ? { hasBackup: parsed.hasBackup } : {}),
    ...(typeof parsed.backedUp === 'boolean' ? { backedUp: parsed.backedUp } : {}),
    ...(typeof parsed.hubRestarted === 'boolean' ? { hubRestarted: parsed.hubRestarted } : {}),
    ...(typeof parsed.error === 'string' ? { error: parsed.error } : {})
  };
}

async function runHelper(
  action: HelperAction,
  tokenFile: string | undefined,
  { platform = process.platform, env = process.env, runProcess = defaultRunProcess }: AntigravitySwitchOptions
): Promise<HelperResponse> {
  if (platform === 'win32') {
    const args = [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      WINDOWS_SCRIPT,
      '-Action',
      action,
      ...(tokenFile ? ['-TokenFile', tokenFile] : [])
    ];
    const output = await runProcess(windowsPowerShell(env), args, { timeoutMs: SWITCH_TIMEOUT_MS });
    return parseHelperOutput(output);
  }
  if (platform === 'darwin') {
    const args = [MAC_SCRIPT, action, ...(tokenFile ? [tokenFile] : [])];
    const output = await runProcess(ZSH, args, { timeoutMs: SWITCH_TIMEOUT_MS });
    return parseHelperOutput(output);
  }
  throw new AppError('unsupported_platform');
}

function mapHelperError(code: string | undefined): AppError {
  if (code === 'no_backup') return new AppError('antigravity_no_backup');
  if (code === 'token_missing') return new AppError('auth_missing');
  if (code === 'invalid_token') return new AppError('auth_invalid');
  return new AppError('antigravity_switch_failed');
}

// Whether a previous Antigravity login backup exists in the OS credential store.
export async function hasAntigravityBackup(options: AntigravitySwitchOptions = {}): Promise<boolean> {
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32' && platform !== 'darwin') return false;
  try {
    const response = await runHelper('status', undefined, options);
    return response.ok && response.hasBackup === true;
  } catch {
    return false;
  }
}

// Replaces the active OS-keyring Antigravity login with `account`'s isolated profile token,
// backing up the previous entry first and restarting `agy --hub`.
export async function switchAntigravityAccount(account: Account, options: AntigravitySwitchOptions = {}): Promise<AntigravitySwitchResult> {
  if (account.providerId !== 'antigravity' || !account.configDir) throw new AppError('account_not_found');
  const configDir = validateConfigDir(account.configDir);
  const tokenFile = antigravityTokenPath(configDir);
  const checkFile = options.isFile ?? isRegularFile;
  if (!(await checkFile(tokenFile))) throw new AppError('auth_missing');
  let response: HelperResponse;
  try {
    response = await runHelper('switch', tokenFile, options);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('antigravity_switch_failed');
  }
  if (!response.ok) throw mapHelperError(response.error);
  return {
    hubRestarted: response.hubRestarted === true,
    ...(response.backedUp !== undefined ? { backedUp: response.backedUp } : {})
  };
}

// Restores the backed-up OS-keyring Antigravity login and restarts `agy --hub`.
export async function restoreAntigravityBackup(options: AntigravitySwitchOptions = {}): Promise<AntigravitySwitchResult> {
  let response: HelperResponse;
  try {
    response = await runHelper('restore', undefined, options);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('antigravity_switch_failed');
  }
  if (!response.ok) throw mapHelperError(response.error);
  return { hubRestarted: response.hubRestarted === true };
}
