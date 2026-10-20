import { ProviderError } from '../core/errors.ts';
import { isObject, type JsonObject } from '../core/files.ts';
import { hasControlChars } from '../core/model.ts';
import { MAX_RESPONSE_BYTES, runProcess as defaultRunProcess, sha256Prefix, type RunProcess } from './common.ts';
import type { RefreshContext } from './types.ts';

const DEFAULT_SERVICE = 'Claude Code-credentials';
const SELECTOR_MAX_LENGTH = 1024;
const SELECTOR_HASH_LENGTH = 8;
const KEYCHAIN_TIMEOUT_MS = 8000;

export interface KeychainSelector {
  configDir?: string;
  configDirExplicit?: boolean;
  secureStorageConfigDir?: string;
}

// The Keychain item Claude Code uses for a profile. The selector is the raw configured
// directory, not a resolved path: an explicitly configured default directory is a different
// item than the unset default. Verified against quota-axi (src/lib/claude-profile.ts,
// suffixedKeychainService) and anthropics/claude-code#92252, #79223.
export function resolveClaudeKeychainService({
  configDir,
  configDirExplicit = false,
  secureStorageConfigDir
}: KeychainSelector = {}): string {
  const selected = secureStorageConfigDir || (configDirExplicit ? configDir : undefined);
  if (!selected) return DEFAULT_SERVICE;
  if (selected.length > SELECTOR_MAX_LENGTH || hasControlChars(selected)) throw new ProviderError('unsupported_profile');
  const suffix = sha256Prefix(selected.normalize('NFC'), SELECTOR_HASH_LENGTH);
  return `${DEFAULT_SERVICE}-${suffix}`;
}

export interface KeychainOptions extends KeychainSelector, Partial<RefreshContext> {
  platform?: NodeJS.Platform;
  runProcess?: RunProcess;
}

// The parsed credentials document stored for the profile; the caller checks its contents.
// Read only: the item is never refreshed or written.
export async function readClaudeKeychain({
  platform = process.platform,
  runProcess = defaultRunProcess,
  deadline,
  signal,
  ...selector
}: KeychainOptions = {}): Promise<JsonObject> {
  if (platform !== 'darwin') throw new ProviderError('unsupported_platform');
  const service = resolveClaudeKeychainService(selector);
  let credentials: unknown;
  try {
    const output = await runProcess('/usr/bin/security', ['find-generic-password', '-s', service, '-w'], {
      timeoutMs: KEYCHAIN_TIMEOUT_MS,
      maxBytes: MAX_RESPONSE_BYTES,
      ...(deadline === undefined ? {} : { deadline }),
      ...(signal ? { signal } : {})
    });
    credentials = JSON.parse(output);
  } catch (error) {
    throw new ProviderError('keychain_unavailable', { cause: error });
  }
  if (!isObject(credentials)) throw new ProviderError('keychain_unavailable');
  return credentials;
}
