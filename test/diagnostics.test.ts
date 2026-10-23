import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {
  collectDiagnostics,
  createToolProbe,
  redactReport,
  remedyFor,
  renderDiagnosticsReport,
  REMEDY_TEXT,
  type Diagnostics,
  type Remedy,
  type ToolProbe
} from '../src/core/diagnostics.ts';
import { defaultSettings } from '../src/core/settings.ts';
import { PROVIDER_IDS, type ProviderId } from '../src/shared/catalog.ts';
import type { Account, AccountStatus, MeasuredAccount, ProviderState, Snapshot, StatusCode } from '../src/shared/types.ts';
import { account, measuredAccount, quotaWindow, tempDir } from './helpers/fixtures.ts';

const NOW = Date.parse('2026-10-18T12:00:00.000Z');
const MINUTE = 60_000;
const ago = (ms: number): string => new Date(NOW - ms).toISOString();

const probe = (installed: Partial<Record<ProviderId, boolean | null>> = {}): ToolProbe => ({
  installed: id => Promise.resolve(id in installed ? (installed[id] ?? null) : true)
});

function snapshot(providers: Partial<ProviderState>[], accounts: Account[] = [], intervalSeconds = 300): Snapshot {
  return {
    providers: providers.map(p => ({ id: 'claude', status: 'ok', accounts: [], ...p })),
    refreshing: false,
    settings: { ...defaultSettings(), intervalSeconds, accounts }
  };
}

// One enabled, measured Claude account with the given state.
async function single(fields: Partial<MeasuredAccount>): Promise<Diagnostics> {
  const measured = measuredAccount(fields);
  return collectDiagnostics(snapshot([{ status: measured.status, accounts: [measured] }], [account()]), probe(), NOW);
}

test('each status maps to a concrete next step, preferring the failure behind a stale reading', () => {
  const cases: [AccountStatus, StatusCode | null, Remedy | null][] = [
    ['ok', null, null],
    ['no_limits_reported', 'no_limits_reported', null],
    ['pending', null, 'remedyWaitForRefresh'],
    ['auth_missing', 'auth_missing', 'remedySignIn'],
    ['auth_expired', null, 'remedySignIn'],
    ['auth_invalid', null, 'remedySignIn'],
    ['auth_rejected', null, 'remedySignIn'],
    ['binary_missing', null, 'remedyInstallCli'],
    ['invalid_binary', null, 'remedyInstallCli'],
    ['app_closed', null, 'remedyOpenApp'],
    ['local_service_unavailable', null, 'remedyOpenApp'],
    ['keychain_unavailable', null, 'remedyUnlockKeychain'],
    ['rate_limited', null, 'remedyWaitRateLimit'],
    ['transport_error', null, 'remedyCheckNetwork'],
    ['request_timeout', null, 'remedyCheckNetwork'],
    ['tls_certificate_error', null, 'remedyCheckCertificates'],
    ['trust_store_unavailable', null, 'remedyCheckCertificates'],
    ['unsupported_platform', null, 'remedyNotSupported'],
    ['unsupported_profile', null, 'remedyNotSupported'],
    ['invalid_response', null, 'remedyUpdateTool'],
    ['endpoint_not_allowed', null, 'remedyReportIssue'],
    ['provider_failed', null, 'remedyRetryLater'],
    ['stale', 'auth_expired', 'remedySignIn'],
    ['stale', 'rate_limited', 'remedyWaitRateLimit'],
    ['stale', null, 'remedyRetryLater']
  ];
  for (const [status, code, remedy] of cases) assert.equal(remedyFor(status, code), remedy, `${status} ${code ?? ''}`);
  assert.equal(remedyFor('unavailable', 'no_accounts'), 'remedyAddAccount');
  for (const text of Object.values(REMEDY_TEXT)) assert.ok(text.length > 10);
});

test('every tool is listed in catalog order with its accounts as ordinals', async () => {
  const accounts = [
    account({ id: 'codex:b', providerId: 'codex', label: 'Work', primary: false }),
    account({ id: 'codex:a', providerId: 'codex', label: 'Home' }),
    account({ id: 'codex:off', providerId: 'codex', enabled: false, primary: false }),
    account({ id: 'claude:a' })
  ];
  const measured = (id: string, status: AccountStatus, fields: Partial<MeasuredAccount> = {}) =>
    measuredAccount({ ...accounts.find(a => a.id === id), status, ...fields });
  const diagnostics = await collectDiagnostics(
    snapshot(
      [
        { id: 'antigravity', status: 'unavailable', messageCode: 'no_accounts' },
        {
          id: 'codex',
          status: 'stale',
          accounts: [measured('codex:a', 'ok', { fetchedAt: ago(MINUTE) }), measured('codex:b', 'stale', { messageCode: 'auth_expired' })]
        },
        { id: 'claude', status: 'pending', accounts: [measured('claude:a', 'pending')] }
      ],
      accounts
    ),
    probe({ cursor: false, antigravity: null }),
    NOW
  );
  assert.deepEqual(
    diagnostics.providers.map(p => p.id),
    [...PROVIDER_IDS]
  );
  const [claude, codex, cursor, antigravity] = diagnostics.providers;
  assert.ok(claude && codex && cursor && antigravity);
  assert.equal(claude.remedy, 'remedyWaitForRefresh');
  assert.deepEqual(
    codex.accounts.map(a => [a.ordinal, a.enabled, a.primary, a.status, a.messageCode, a.remedy]),
    [
      [1, true, false, 'stale', 'auth_expired', 'remedySignIn'],
      [2, true, true, 'ok', null, null],
      [3, false, false, 'pending', null, null]
    ],
    'settings order; a disabled account is listed without a remedy'
  );
  assert.deepEqual([codex.accountCount, codex.enabledCount], [3, 2]);
  assert.equal(codex.remedy, 'remedySignIn', 'a stale tool takes the remedy of its failing account');
  assert.equal(codex.installed, true);
  assert.deepEqual([cursor.installed, cursor.status, cursor.remedy, cursor.accountCount], [false, 'unavailable', 'remedyInstallTool', 0]);
  assert.deepEqual([antigravity.installed, antigravity.messageCode, antigravity.remedy], [null, 'no_accounts', 'remedyAddAccount']);
  assert.deepEqual(Object.keys(codex.accounts[0] ?? {}).sort(), [
    'ageMs',
    'enabled',
    'messageCode',
    'ordinal',
    'primary',
    'remedy',
    'stale',
    'status'
  ]);
});

test('a tool not found is still fine while it reads; a failing probe means unknown', async () => {
  const measured = measuredAccount({ fetchedAt: ago(0) });
  const found = await collectDiagnostics(snapshot([{ accounts: [measured] }], [account()]), probe({ claude: false }), NOW);
  assert.deepEqual([found.providers[0]?.installed, found.providers[0]?.remedy], [false, null]);
  const failing: ToolProbe = { installed: () => Promise.reject(new Error('boom')) };
  const unknown = await collectDiagnostics(snapshot([]), failing, NOW);
  assert.ok(unknown.providers.every(p => p.installed === null && p.status === 'unavailable' && p.accounts.length === 0));
});

test('freshness is the age of the last reading; stale after three refresh intervals or when marked stale', async () => {
  const at = async (fields: Partial<MeasuredAccount>) => (await single(fields)).providers[0]?.accounts[0];
  assert.deepEqual(await at({ fetchedAt: ago(5 * MINUTE) }), {
    ordinal: 1,
    enabled: true,
    primary: true,
    status: 'ok',
    messageCode: null,
    ageMs: 5 * MINUTE,
    stale: false,
    remedy: null
  });
  assert.equal((await at({ fetchedAt: ago(15 * MINUTE) }))?.stale, false, 'exactly three intervals is still fresh');
  assert.equal((await at({ fetchedAt: ago(15 * MINUTE + 1) }))?.stale, true);
  assert.deepEqual(await at({ status: 'stale', messageCode: 'transport_error', fetchedAt: ago(MINUTE) }).then(a => [a?.stale, a?.remedy]), [
    true,
    'remedyCheckNetwork'
  ]);
  assert.deepEqual(await at({ status: 'pending' }).then(a => [a?.ageMs, a?.stale]), [null, false]);
  assert.equal((await at({ fetchedAt: new Date(NOW + MINUTE).toISOString() }))?.ageMs, 0, 'a future stamp counts as just taken');
  assert.equal((await at({ fetchedAt: 'not a date' }))?.ageMs, null);

  const provider = await collectDiagnostics(snapshot([{ fetchedAt: ago(60 * MINUTE) }], [], 600), probe(), NOW);
  assert.deepEqual([provider.providers[0]?.ageMs, provider.providers[0]?.stale, provider.intervalSeconds], [60 * MINUTE, true, 600]);
});

test('unknown status and message codes in a snapshot are never passed through', async () => {
  const forged = measuredAccount({
    status: 'leaked@example.com' as AccountStatus,
    messageCode: 'C:\\Users\\jane\\.claude' as StatusCode
  });
  const diagnostics = await collectDiagnostics(
    snapshot([{ status: '/home/jane' as AccountStatus, messageCode: 'raw upstream error' as StatusCode, accounts: [forged] }], [account()]),
    probe(),
    NOW
  );
  const claude = diagnostics.providers[0];
  assert.deepEqual([claude?.status, claude?.messageCode], ['unavailable', null]);
  assert.deepEqual([claude?.accounts[0]?.status, claude?.accounts[0]?.messageCode], ['provider_failed', null]);
});

test('the report holds codes, counts and ages, never identity, paths or upstream text', async () => {
  const home = process.platform === 'win32' ? 'C:\\Users\\jdoe-secret' : '/home/jdoe-secret';
  const accounts = [
    account({
      id: 'claude:jane@example.com',
      label: 'jane.doe@example.com',
      email: 'jane.doe@example.com',
      configDir: path.join(home, '.claude-work')
    }),
    account({ id: 'codex:x', providerId: 'codex', label: '/Users/jdoe-secret/project', configDir: 'D:\\work\\codex', primary: false })
  ];
  const measured = (index: number, fields: Partial<MeasuredAccount>): MeasuredAccount => ({
    ...measuredAccount({ ...accounts[index] }),
    plan: 'Max for jane.doe@example.com',
    signedInAs: 'jane.doe@example.com',
    windows: [quotaWindow({ id: 'w', label: 'C:\\Users\\jdoe-secret\\secret-window', scope: 'secret-scope' })],
    ...fields
  });
  const diagnostics = await collectDiagnostics(
    snapshot(
      [
        { id: 'claude', status: 'ok', fetchedAt: ago(3 * MINUTE), accounts: [measured(0, { fetchedAt: ago(3 * MINUTE) })] },
        {
          id: 'codex',
          status: 'stale',
          accounts: [
            measured(1, {
              status: 'stale',
              messageCode: 'Bearer sk-secret-token at /home/jdoe-secret/.codex' as StatusCode,
              fetchedAt: ago(3 * 60 * MINUTE)
            })
          ]
        }
      ],
      accounts
    ),
    probe({ antigravity: false }),
    NOW
  );
  const report = renderDiagnosticsReport(diagnostics, {
    appVersion: '1.4.0',
    platform: 'win32',
    arch: 'x64',
    generatedAt: NOW,
    homeDir: home
  });
  for (const secret of [
    '@',
    'jane',
    'jdoe',
    'example',
    'secret',
    'Users',
    'home',
    '.claude',
    '.codex',
    'work',
    'Max',
    'Bearer',
    'project',
    'C:',
    'D:',
    '\\'
  ])
    assert.ok(!report.includes(secret), `the report leaks ${secret}:\n${report}`);
  assert.match(report, /^## Vibe Usage diagnostics$/m);
  assert.match(report, /- Version: 1\.4\.0/);
  assert.match(report, /- OS: win32 x64/);
  assert.match(report, /- Generated: 2026-10-18T12:00:00\.000Z/);
  assert.match(report, /\| Account 1 \| yes \| yes \| ok \| 3 min ago \| no \| none \|/);
  assert.match(report, /\| Account 1 \| yes \| no \| stale \| 3 h 0 min ago \| yes \| Refresh again later/);
  assert.match(
    report,
    /### Antigravity\n\n- Installed: no\n- Status: unavailable\n- Accounts: 0 configured, 0 enabled\n- Last measured: never/
  );
  assert.match(report, /- Next step: Install the tool, then refresh\./);
});

test('the report formats ages and statuses and rejects malformed context values', () => {
  const diagnostics: Diagnostics = {
    generatedAt: NOW,
    intervalSeconds: 300,
    refreshing: true,
    faults: [{ at: NOW, action: 'signIn', error: 'Error EPERM spawn' }],
    providers: [
      {
        id: 'cursor',
        installed: null,
        status: 'auth_expired',
        messageCode: 'auth_expired',
        accountCount: 2,
        enabledCount: 2,
        ageMs: 30_000,
        stale: false,
        remedy: 'remedySignIn',
        accounts: [
          {
            ordinal: 1,
            enabled: true,
            primary: true,
            status: 'stale',
            messageCode: 'rate_limited',
            ageMs: 3 * 24 * 60 * MINUTE,
            stale: true,
            remedy: 'remedyWaitRateLimit'
          },
          {
            ordinal: 2,
            enabled: true,
            primary: false,
            status: 'pending',
            messageCode: null,
            ageMs: null,
            stale: false,
            remedy: 'remedyWaitForRefresh'
          }
        ]
      }
    ]
  };
  const report = renderDiagnosticsReport(diagnostics, {
    appVersion: '1.0.0 /Users/x',
    platform: 'darwin',
    arch: 'arm64',
    generatedAt: Number.NaN
  });
  assert.match(report, /- Version: unknown/);
  assert.match(report, /- Generated: unknown/);
  assert.match(report, /- Refreshing: yes/);
  assert.match(report, /- Installed: unknown\n- Status: auth_expired\n/);
  assert.match(report, /- Last measured: under 1 min ago\n/);
  assert.match(report, /\| Account 1 \| yes \| yes \| stale \(rate_limited\) \| 3 d ago \| yes \| Wait a few minutes/);
  assert.match(report, /\| Account 2 \| yes \| no \| pending \| never \| no \| Wait for the current reading to finish\. \|/);
  assert.match(
    report,
    /### Unexpected errors\n\n- \d{4}-\d\d-\d\dT[\d:.]+Z · signIn · Error EPERM spawn\n/,
    'what failed, never its message'
  );
});

test('the scrub pass removes addresses, absolute paths and the home folder anywhere', () => {
  assert.equal(redactReport('mail a.b+c@x.co now'), 'mail [redacted] now');
  assert.equal(redactReport('at C:\\Users\\me\\x and D:/y and \\\\server\\share'), 'at [redacted] and [redacted] and [redacted]');
  assert.equal(redactReport('at /Users/me/x and ~/y but 1/2'), 'at [redacted] and [redacted] but 1/2');
  assert.equal(redactReport('home is c:/users/mehmet, user Mehmet', 'C:\\Users\\Mehmet'), 'home is [redacted], user [redacted]');
  assert.equal(redactReport('ok ok', '/home/ok/'), 'ok ok', 'short user names are kept: they match ordinary words');
});

test('the real probe finds CLIs the way launches do and desktop apps in their install folders', async t => {
  const home = await tempDir(t, 'vibe-diag-home-');
  const bin = await tempDir(t, 'vibe-diag-bin-');
  const executable = (name: string): string => (process.platform === 'win32' ? `${name}.exe` : name);
  await fs.writeFile(path.join(bin, executable('codex')), '');
  const localAppData = path.join(home, 'AppData', 'Local');
  // Overrides to missing files keep the host's own installs out of the answer.
  const env = {
    PATH: bin,
    LOCALAPPDATA: localAppData,
    VIBE_CLAUDE_BINARY: path.join(bin, executable('claude'))
  };
  const host = createToolProbe({ homeDir: home, platform: process.platform, env });
  assert.equal(await host.installed('codex'), true, 'on PATH');
  assert.equal(await host.installed('claude'), false);

  const windows = createToolProbe({ homeDir: home, platform: 'win32', env: { PATH: '', LOCALAPPDATA: localAppData } });
  assert.equal(await windows.installed('antigravity'), false);
  await fs.mkdir(path.join(localAppData, 'Programs', 'Antigravity'), { recursive: true });
  await fs.writeFile(path.join(localAppData, 'Programs', 'Antigravity', 'Antigravity.exe'), '');
  assert.equal(await windows.installed('antigravity'), true);
  const fallback = createToolProbe({ homeDir: home, platform: 'win32', env: { PATH: '' } });
  assert.equal(await fallback.installed('antigravity'), true, 'without LOCALAPPDATA, the default under the home folder');

  const mac = createToolProbe({ homeDir: home, platform: 'darwin', env: { PATH: '' } });
  await fs.mkdir(path.join(home, 'Applications', 'Antigravity.app'), { recursive: true });
  assert.equal(await mac.installed('antigravity'), true, '~/Applications counts as well as /Applications');

  const linux = createToolProbe({ homeDir: home, platform: 'linux', env: { PATH: '' } });
  assert.equal(await linux.installed('antigravity'), null, 'no known app location: unknown');
  assert.ok([true, false, null].includes(await createToolProbe().installed('antigravity')), 'defaults to this device');
});
