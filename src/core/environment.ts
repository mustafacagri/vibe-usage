// Environments for processes the app starts. Credential overrides are always removed so that
// a tool uses the account the user picked, never one injected by the parent environment.
import { CREDENTIAL_ENV_KEYS } from '../shared/catalog.ts';
import { AppError } from './errors.ts';

export type Environment = Readonly<Record<string, string | undefined>>;

export interface EnvironmentRequest {
  set?: Readonly<Record<string, string>>;
  unset?: readonly string[];
}

export interface EnvironmentChanges {
  set: Readonly<Record<string, string>>;
  unset: readonly string[];
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function environmentChanges({ set = {}, unset = [] }: EnvironmentRequest = {}): EnvironmentChanges {
  if ([...Object.keys(set), ...unset].some(name => !ENV_NAME.test(name))) throw new AppError('invalid_argument');
  return { set, unset: [...new Set([...CREDENTIAL_ENV_KEYS, ...unset])].filter(name => !Object.hasOwn(set, name)) };
}

// A copy of `source` with the changes applied (names are case-insensitive on Windows).
export function applyEnvironment(
  changes: EnvironmentChanges,
  source: Environment = process.env,
  platform: NodeJS.Platform = process.platform
): Record<string, string> {
  const normalize = platform === 'win32' ? (name: string) => name.toLowerCase() : (name: string) => name;
  const removed = new Set([...changes.unset, ...Object.keys(changes.set)].map(normalize));
  const kept = Object.entries(source).filter(
    (entry): entry is [string, string] => entry[1] !== undefined && !removed.has(normalize(entry[0]))
  );
  return { ...Object.fromEntries(kept), ...changes.set };
}

// `source` without credential overrides, plus `set`.
export function cleanEnvironment(
  set: Readonly<Record<string, string>> = {},
  platform: NodeJS.Platform = process.platform,
  source: Environment = process.env
): Record<string, string> {
  return applyEnvironment(environmentChanges({ set }), source, platform);
}
