// Renewing an isolated Antigravity profile's access token once it expires.
//
// Isolated Antigravity profiles keep their login in `<profileDir>/antigravity-cli/antigravity-oauth-token`
// via `agy`'s file-storage fallback (`WSL_INTEROP=1`). Access tokens expire hourly; instead of holding
// any OAuth client secret in Vibe Usage, renewal is delegated to `agy --gemini_dir=<profileDir> models`,
// which lists models (spending no quota) and writes the refreshed token back to that profile's file.
import { execFile, type ExecFileOptions } from 'node:child_process';
import path from 'node:path';
import {
  ANTIGRAVITY_ISOLATION_ENV,
  antigravityTokenPath,
  parseAntigravityTokenDocument,
  type AntigravityTokenDocument
} from '../providers/antigravity.ts';
import { findCommand, readCredentialFile } from '../providers/common.ts';
import type { Account } from '../shared/types.ts';
import { applyEnvironment, environmentChanges } from './environment.ts';
import { validateConfigDir } from './settings.ts';

const RENEW_TIMEOUT_MS = 60_000;

export type RunProcess = (binary: string, args: readonly string[], options: ExecFileOptions) => Promise<void>;

const run: RunProcess = (binary, args, options) =>
  new Promise(resolve => {
    execFile(binary, [...args], options, () => {
      resolve();
    });
  });

async function readProfileToken(
  configDir: string,
  readToken?: (configDir: string) => Promise<unknown>
): Promise<AntigravityTokenDocument | null> {
  const raw = await (readToken ? readToken(configDir) : readCredentialFile(antigravityTokenPath(configDir))).catch(() => null);
  return parseAntigravityTokenDocument(raw);
}

export interface AntigravityRenewOptions {
  clock?: () => number;
  runProcess?: RunProcess;
  readToken?: (configDir: string) => Promise<unknown>;
}

// True when the isolated profile's sign-in was renewed (its access-token expiry moved into the future).
export async function renewAntigravitySignIn(
  account: Account,
  { clock = Date.now, runProcess = run, readToken }: AntigravityRenewOptions = {}
): Promise<boolean> {
  if (!account.configDir) return false;
  const configDir = validateConfigDir(account.configDir);
  const before = await readProfileToken(configDir, readToken);
  if (!before?.refreshToken) return false;
  const command = await findCommand('agy');
  await runProcess(command.binary, [...command.args, `--gemini_dir=${configDir}`, 'models'], {
    cwd: path.resolve(configDir),
    env: applyEnvironment(environmentChanges({ set: { ...ANTIGRAVITY_ISOLATION_ENV } })),
    timeout: RENEW_TIMEOUT_MS,
    windowsHide: true
  });
  const after = await readProfileToken(configDir, readToken);
  const beforeExpiry = before.expiryMs ?? 0;
  return after?.expiryMs !== undefined && after.expiryMs > beforeExpiry && after.expiryMs > clock();
}
