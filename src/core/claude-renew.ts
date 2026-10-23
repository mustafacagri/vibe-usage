// Renewing a Claude Code profile's sign-in once its access token has expired.
//
// Claude Code renews its token only while it runs, so a profile left idle for some hours holds an
// expired one: its quota cannot be read, and it cannot take over work when another account runs
// out. The app never uses the refresh token itself: it is Claude Code's own sign-in, and a second
// refresher could invalidate the token a running Claude Code holds. Claude Code renews it, with
// the smallest request it makes: one word from the smallest model, no tools, no MCP servers,
// nothing saved as a session.
import { execFile, type ExecFileOptions } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { claudeOAuthSection, readClaudeCredentials } from '../providers/claude.ts';
import { findCommand } from '../providers/common.ts';
import type { Account } from '../shared/types.ts';
import { applyEnvironment, environmentChanges } from './environment.ts';
import { profileEnvironment } from './launch.ts';
import { claudeAlias } from './model-families.ts';

const RENEW_DIR = 'renew';
const RENEW_TIMEOUT_MS = 90_000;
// Written for Claude Code, so it is deliberately not localized.
const RENEW_PROMPT = 'Reply with the single word ok.';
export const RENEW_ARGS = [
  '-p',
  RENEW_PROMPT,
  '--model',
  claudeAlias('fast'),
  '--tools',
  '',
  '--strict-mcp-config',
  '--no-session-persistence',
  '--max-turns',
  '1'
] as const;

export type RunProcess = (binary: string, args: readonly string[], options: ExecFileOptions) => Promise<void>;

const run: RunProcess = (binary, args, options) =>
  new Promise(resolve => {
    execFile(binary, [...args], options, () => {
      resolve();
    });
  });

// Whether Claude Code can renew the sign-in: it holds a refresh token, and that token has not
// itself expired. Claude Code writes the refresh token's own expiry (refreshTokenExpiresAt, some
// weeks out) on every refresh; once it has passed only signing in again helps, so starting Claude
// Code would cost a launch for nothing. Credentials without it (older files) are taken as renewable.
function canRenew(oauth: Record<string, unknown>, now: number): boolean {
  if (typeof oauth.refreshToken !== 'string' || oauth.refreshToken.length === 0) return false;
  if (oauth.refreshTokenExpiresAt === undefined || oauth.refreshTokenExpiresAt === null) return true;
  const refreshExpiresAt = Number(oauth.refreshTokenExpiresAt);
  return !Number.isFinite(refreshExpiresAt) || refreshExpiresAt > now;
}

// The saved sign-in's expiry, and whether Claude Code can renew it.
async function signIn(
  account: Account,
  read: (account: Account) => Promise<unknown>,
  now: number
): Promise<{ expiresAt: number; renewable: boolean } | null> {
  const credentials = await read(account).catch(() => null);
  const oauth = claudeOAuthSection(credentials);
  if (!oauth) return null;
  const expiresAt = Number(oauth.expiresAt);
  return {
    expiresAt: Number.isFinite(expiresAt) ? expiresAt : 0,
    renewable: canRenew(oauth, now)
  };
}

export interface RenewOptions {
  dataDir: string;
  home?: string;
  clock?: () => number;
  runProcess?: RunProcess;
  readCredentials?: (account: Account) => Promise<unknown>;
}

// True when the profile's sign-in was renewed (its expiry moved on, into the future).
export async function renewClaudeSignIn(
  account: Account,
  { dataDir, home = os.homedir(), clock = Date.now, runProcess = run, readCredentials }: RenewOptions
): Promise<boolean> {
  const read = readCredentials ?? ((target: Account) => readClaudeCredentials(target, { home }));
  const before = await signIn(account, read, clock());
  if (!before?.renewable) return false;
  const cwd = path.join(dataDir, RENEW_DIR);
  await fsp.mkdir(cwd, { recursive: true });
  const command = await findCommand('claude');
  await runProcess(command.binary, [...command.args, ...RENEW_ARGS], {
    cwd,
    env: applyEnvironment(environmentChanges(profileEnvironment(account))),
    timeout: RENEW_TIMEOUT_MS,
    windowsHide: true
  });
  const after = await signIn(account, read, clock());
  return Boolean(after && after.expiresAt > before.expiresAt && after.expiresAt > clock());
}
