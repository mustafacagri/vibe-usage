import assert from 'node:assert/strict';
import test from 'node:test';
import { ProviderError } from '../src/core/errors.ts';
import type { RunProcess } from '../src/providers/common.ts';
import { loginShellPath, mergePath } from '../src/core/shell-path.ts';

const answering =
  (text: string, ran: string[][] = []): RunProcess =>
  (binary, args) => {
    ran.push([binary, ...args]);
    return Promise.resolve(text);
  };
const MARKER = '__VIBE_USAGE_PATH__';

test('the login shell is asked for its PATH, and what its profile prints around the answer is ignored', async () => {
  const ran: string[][] = [];
  const folders = await loginShellPath(
    { SHELL: '/bin/zsh' },
    answering(`Welcome back\n${MARKER}/Users/me/.nvm/bin:/opt/homebrew/bin:/opt/homebrew/bin:relative:/usr/bin${MARKER}\nbye`, ran)
  );
  assert.deepEqual(folders, ['/Users/me/.nvm/bin', '/opt/homebrew/bin', '/usr/bin']);
  const [call] = ran;
  assert.ok(call);
  assert.equal(call[0], '/bin/zsh');
  assert.equal(call[1], '-ilc');
  // Braces: the marker's letters would otherwise read as part of the variable's name.
  assert.equal(call[2], `printf '%s' "${MARKER}\${PATH}${MARKER}"`);
});

test('no folders come from an unknown shell, a missing one, a failure or an answer without its markers', async () => {
  const answer = answering(`${MARKER}/usr/bin${MARKER}`);
  assert.deepEqual(await loginShellPath({}, answer), []);
  assert.deepEqual(await loginShellPath({ SHELL: 'zsh' }, answer), []);
  assert.deepEqual(await loginShellPath({ SHELL: '/usr/local/bin/fish' }, answer), []);
  assert.deepEqual(await loginShellPath({ SHELL: '/bin/bash' }, () => Promise.reject(new ProviderError('process_timeout'))), []);
  assert.deepEqual(await loginShellPath({ SHELL: '/bin/bash' }, answering('/usr/bin')), []);
  assert.deepEqual(await loginShellPath({ SHELL: '/bin/bash' }, answering(`${MARKER}/usr/bin`)), []);
});

test('the shell folders come first and the PATH the app had keeps the rest', () => {
  assert.equal(mergePath(['/a', '/b'], '/b:/c::/d'), '/a:/b:/c:/d');
  assert.equal(mergePath(['/a'], undefined), '/a');
});
