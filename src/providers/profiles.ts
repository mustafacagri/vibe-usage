// Profile folders of the tools that keep one sign-in per folder (see PROFILE_DIRS): finding
// them in the home directory, and the id and name of the account each one holds.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { AppError, systemErrorCode } from '../core/errors.ts';
import { accountId, PROFILE_DIRS, type ProfileProviderId } from '../shared/catalog.ts';
import type { Account } from '../shared/types.ts';
import { sha256Prefix } from './common.ts';

const ID_HASH_LENGTH = 12;
// Numbered folders the app creates for new accounts: `.codex-2`, `.codex-3`, …
const FIRST_NEW_PROFILE = 2;
const MAX_NEW_PROFILE = 99;
const PROFILE_NAME = /^[a-zA-Z0-9_-]+$/;
// Sibling folders that are copies rather than profiles (`.claude-backup`, `.codex-old`).
const COPY_NAME = /(?:^|[-_])(backup|backups|history|old|archive|copy|bak)(?:[-_]|$)/i;

export const shortHash = (value: string): string => sha256Prefix(value, ID_HASH_LENGTH);

export const defaultProfileDir = (providerId: ProfileProviderId, home: string): string => path.join(home, PROFILE_DIRS[providerId]);

// Where a tool keeps its settings and transcripts: the default profile folder and every folder
// an enabled account of the tool uses, each once.
export function accountProfileDirs(providerId: ProfileProviderId, home: string, accounts: readonly Account[]): string[] {
  const used = accounts.filter(a => a.providerId === providerId && a.enabled).flatMap(a => (a.configDir ? [a.configDir] : []));
  return [...new Set([defaultProfileDir(providerId, home), ...used].map(dir => path.resolve(dir)))];
}

export const profileAccountId = (providerId: ProfileProviderId, configDir: string): string =>
  accountId(providerId, shortHash(path.resolve(configDir)));

// `.codex-work` is named `work`; any other folder keeps its own name.
export function profileLabel(providerId: ProfileProviderId, configDir: string): string {
  const name = path.basename(configDir);
  const prefix = `${PROFILE_DIRS[providerId]}-`;
  const label = name === PROFILE_DIRS[providerId] ? '' : name.startsWith(prefix) ? name.slice(prefix.length) : name;
  return label || path.resolve(configDir);
}

// The default profile folder and its `-<name>` siblings that exist in `home`.
export async function profileFolders(providerId: ProfileProviderId, home: string): Promise<string[]> {
  const base = PROFILE_DIRS[providerId];
  const entries = await fsp.readdir(home, { withFileTypes: true }).catch((error: unknown) => {
    if (systemErrorCode(error) === 'ENOENT') return [];
    throw error;
  });
  return entries
    .filter(entry => {
      if (!entry.isDirectory()) return false;
      if (entry.name === base) return true;
      const suffix = entry.name.startsWith(`${base}-`) ? entry.name.slice(base.length + 1) : '';
      return PROFILE_NAME.test(suffix) && !COPY_NAME.test(suffix);
    })
    .map(entry => path.join(home, entry.name));
}

// The first numbered profile folder in `home` a new account can have: a new one, private to the
// user, or an existing one that `isFree` (no account uses it and it holds no sign-in, as one a
// sign-in given up on leaves behind).
export async function createProfileFolder(
  providerId: ProfileProviderId,
  home: string,
  isFree: (dir: string) => Promise<boolean>
): Promise<string> {
  for (let n = FIRST_NEW_PROFILE; n <= MAX_NEW_PROFILE; n++) {
    const dir = path.join(home, `${PROFILE_DIRS[providerId]}-${n}`);
    try {
      await fsp.mkdir(dir, { mode: 0o700 });
      return dir;
    } catch (error) {
      if (systemErrorCode(error) !== 'EEXIST') throw error;
      if ((await fsp.lstat(dir)).isDirectory() && (await isFree(dir))) return dir;
    }
  }
  throw new AppError('invalid_path');
}

// A sign-in file counts only as a regular file: a symbolic link could point anywhere.
export async function isRegularFile(file: string): Promise<boolean> {
  const stat = await fsp.lstat(file).catch((error: unknown) => {
    if (systemErrorCode(error) === 'ENOENT') return null;
    throw error;
  });
  return stat?.isFile() ?? false;
}
