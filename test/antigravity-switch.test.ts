import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {
  ANTIGRAVITY_KEYRING,
  hasAntigravityBackup,
  restoreAntigravityBackup,
  switchAntigravityAccount
} from '../src/core/antigravity-switch.ts';
import { antigravityTokenPath } from '../src/providers/antigravity.ts';
import type { RunProcess } from '../src/providers/common.ts';
import { account, tempDir } from './helpers/fixtures.ts';

const PS1_SCRIPT = path.join(import.meta.dirname, '../src/launchers/antigravity-credential.ps1');
const SH_SCRIPT = path.join(import.meta.dirname, '../src/launchers/antigravity-credential.sh');

test('Windows Antigravity switch passes only the token file path to the helper and maps outcomes cleanly', async t => {
  const dir = await tempDir(t, 'vibe-agy-switch-win-');
  const configDir = path.join(dir, '.antigravity-2');
  const tokenFile = antigravityTokenPath(configDir);
  await fs.mkdir(path.dirname(tokenFile), { recursive: true });
  const secretToken = 'synthetic-secret-token-must-not-appear-in-argv-or-errors';
  await fs.writeFile(tokenFile, JSON.stringify({ token: { access_token: secretToken, refresh_token: 'synthetic-refresh' } }));
  const target = account({ id: 'antigravity:profile-2', providerId: 'antigravity', configDir });

  const calls: { binary: string; args: readonly string[] }[] = [];
  const runProcess: RunProcess = (binary, args) => {
    calls.push({ binary, args });
    assert.equal(args.join(' ').includes(secretToken), false, 'token bytes never travel in argv');
    if (args.includes('status')) return Promise.resolve(JSON.stringify({ ok: true, hasBackup: true }));
    if (args.includes('switch')) return Promise.resolve(JSON.stringify({ ok: true, backedUp: true, hubRestarted: true }));
    if (args.includes('restore')) return Promise.resolve(JSON.stringify({ ok: true, hubRestarted: true }));
    return Promise.reject(new Error('unexpected'));
  };

  const options = { platform: 'win32' as const, env: { SystemRoot: 'C:\\Windows' }, runProcess };
  assert.equal(await hasAntigravityBackup(options), true);
  assert.deepEqual(await switchAntigravityAccount(target, options), { backedUp: true, hubRestarted: true });
  assert.deepEqual(await restoreAntigravityBackup(options), { hubRestarted: true });
  assert.equal(calls.length, 3);
  assert.match(calls[1]?.binary ?? '', /powershell\.exe$/i);
  assert.ok(calls[1]?.args.includes('-TokenFile'));
  assert.ok(calls[1]?.args.includes(tokenFile));
});

test('macOS Antigravity switch invokes the zsh helper and Linux fails closed', async t => {
  const dir = await tempDir(t, 'vibe-agy-switch-mac-');
  const configDir = path.join(dir, '.antigravity-2');
  const tokenFile = antigravityTokenPath(configDir);
  await fs.mkdir(path.dirname(tokenFile), { recursive: true });
  await fs.writeFile(tokenFile, JSON.stringify({ token: { access_token: 'fixture' } }));
  const target = account({ id: 'antigravity:profile-2', providerId: 'antigravity', configDir });

  const calls: { binary: string; args: readonly string[] }[] = [];
  const runProcess: RunProcess = (binary, args) => {
    calls.push({ binary, args });
    if (args[1] === 'status') return Promise.resolve(JSON.stringify({ ok: true, hasBackup: false }));
    if (args[1] === 'switch') return Promise.resolve(JSON.stringify({ ok: true, backedUp: false, hubRestarted: false }));
    return Promise.resolve(JSON.stringify({ ok: false, error: 'no_backup' }));
  };

  assert.equal(await hasAntigravityBackup({ platform: 'darwin', runProcess }), false);
  assert.deepEqual(await switchAntigravityAccount(target, { platform: 'darwin', runProcess }), { backedUp: false, hubRestarted: false });
  await assert.rejects(restoreAntigravityBackup({ platform: 'darwin', runProcess }), /antigravity_no_backup/);
  const [firstCall] = calls;
  assert.ok(firstCall);
  assert.equal(firstCall.binary, '/bin/zsh');
  assert.match(firstCall.args[0] ?? '', /antigravity-credential\.sh$/);

  assert.equal(await hasAntigravityBackup({ platform: 'linux', runProcess }), false);
  await assert.rejects(switchAntigravityAccount(target, { platform: 'linux', runProcess }), /unsupported_platform/);
  await assert.rejects(restoreAntigravityBackup({ platform: 'linux', runProcess }), /unsupported_platform/);
});

test('Antigravity switch validates account, token presence and helper error codes without leaking details', async t => {
  const dir = await tempDir(t, 'vibe-agy-switch-err-');
  const configDir = path.join(dir, '.antigravity-2');
  const target = account({ id: 'antigravity:profile-2', providerId: 'antigravity', configDir });

  await assert.rejects(switchAntigravityAccount(account({ id: 'claude:a', providerId: 'claude', configDir })), /account_not_found/);
  await assert.rejects(switchAntigravityAccount(account({ id: 'antigravity:local', providerId: 'antigravity' })), /account_not_found/);
  await assert.rejects(switchAntigravityAccount(target, { platform: 'darwin' }), /auth_missing/);

  const tokenFile = antigravityTokenPath(configDir);
  await fs.mkdir(path.dirname(tokenFile), { recursive: true });
  await fs.writeFile(tokenFile, '{}');

  const failing =
    (output: string | Error): RunProcess =>
    () =>
      output instanceof Error ? Promise.reject(output) : Promise.resolve(output);

  await assert.rejects(
    switchAntigravityAccount(target, { platform: 'darwin', runProcess: failing('{"ok":false,"error":"token_missing"}') }),
    /auth_missing/
  );
  await assert.rejects(
    switchAntigravityAccount(target, { platform: 'darwin', runProcess: failing('{"ok":false,"error":"invalid_token"}') }),
    /auth_invalid/
  );
  await assert.rejects(
    switchAntigravityAccount(target, { platform: 'darwin', runProcess: failing('{"ok":false,"error":"backup_failed"}') }),
    /antigravity_switch_failed/
  );
  await assert.rejects(switchAntigravityAccount(target, { platform: 'darwin', runProcess: failing('') }), /antigravity_switch_failed/);
  await assert.rejects(
    switchAntigravityAccount(target, { platform: 'darwin', runProcess: failing('{not json') }),
    /antigravity_switch_failed/
  );
  await assert.rejects(
    switchAntigravityAccount(target, { platform: 'darwin', runProcess: failing('{"ok":"yes"}') }),
    /antigravity_switch_failed/
  );
  await assert.rejects(
    switchAntigravityAccount(target, { platform: 'darwin', runProcess: failing(new Error('raw-secret-stderr')) }),
    (error: unknown) => error instanceof Error && error.message === 'antigravity_switch_failed'
  );
  await assert.rejects(
    restoreAntigravityBackup({ platform: 'darwin', runProcess: failing(new Error('raw-secret-stderr')) }),
    (error: unknown) => error instanceof Error && error.message === 'antigravity_switch_failed'
  );
  assert.equal(await hasAntigravityBackup({ platform: 'darwin', runProcess: failing(new Error('boom')) }), false);
});

test('Antigravity credential helper scripts back up before replacing, check owner SID and never print tokens', async () => {
  const ps1 = await fs.readFile(PS1_SCRIPT, 'utf8');
  assert.ok(ps1.includes(ANTIGRAVITY_KEYRING.target));
  assert.ok(ps1.includes(ANTIGRAVITY_KEYRING.backupTarget));
  for (const required of [/CredReadW/, /CredWriteW/, /CredFree/, /GetOwnerSid/, /Array\]::Clear/, /2560/]) assert.match(ps1, required);
  assert.doesNotMatch(ps1, /Write-Host|Invoke-Expression/i);

  const sh = await fs.readFile(SH_SCRIPT, 'utf8');
  assert.ok(sh.includes(ANTIGRAVITY_KEYRING.macService));
  assert.ok(sh.includes(ANTIGRAVITY_KEYRING.macBackupService));
  assert.match(sh, /add-generic-password -U -s/);
  assert.match(sh, /go-keyring-base64:/);
});
