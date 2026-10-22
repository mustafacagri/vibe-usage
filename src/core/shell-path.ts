// A Finder- or Dock-launched app has no shell profile, so its PATH misses where the user installed
// their tools (nvm, pnpm, bun, Homebrew). The folders are read once from the user's own login
// shell, the way a terminal would have them.
import { posix as path } from 'node:path';
import { DURATION_MS } from '../shared/catalog.ts';
import { runProcess as defaultRunProcess, type RunProcess } from '../providers/common.ts';

// The login shell is a Unix one, so its paths are read as Unix paths on every system (the tests run on Windows too).
// Shells whose `-ilc` runs a command after reading the profile and the rc file.
const SHELLS: ReadonlySet<string> = new Set(['zsh', 'bash']);
// What the profile prints on its own (a greeting, a version manager's notice) surrounds the answer.
const MARKER = '__VIBE_USAGE_PATH__';
const SHELL_TIMEOUT_MS = 4 * DURATION_MS.SECOND;

// The folders on the login shell's PATH; none when the shell is not one of those above or does not answer.
export async function loginShellPath(env: NodeJS.ProcessEnv = process.env, runProcess: RunProcess = defaultRunProcess): Promise<string[]> {
  const shell = env.SHELL;
  if (!shell || !path.isAbsolute(shell) || !SHELLS.has(path.basename(shell))) return [];
  const output = await runProcess(shell, ['-ilc', `printf '%s' "${MARKER}\${PATH}${MARKER}"`], { timeoutMs: SHELL_TIMEOUT_MS }).catch(
    () => ''
  );
  const [, value = '', closing] = output.split(MARKER);
  if (closing === undefined) return [];
  return [...new Set(value.split(path.delimiter).filter(directory => path.isAbsolute(directory)))];
}

// `folders` first, then what `current` has beyond them.
export function mergePath(folders: readonly string[], current: string | undefined): string {
  const rest = (current ?? '').split(path.delimiter).filter(Boolean);
  return [...new Set([...folders, ...rest])].join(path.delimiter);
}
