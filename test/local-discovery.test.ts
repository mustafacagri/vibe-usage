import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import type { ClientRequest, IncomingMessage } from 'node:http';
import type https from 'node:https';
import path from 'node:path';
import test from 'node:test';
import { ProviderError } from '../src/core/errors.ts';
import {
  createAntigravityProvider,
  discoverAntigravityServers,
  parseAntigravitySummary,
  parseAntigravityUserStatus,
  parseListeningPorts,
  parseMacProcessList,
  requestLocalJson,
  type LanguageServer,
  type LocalRequestOptions
} from '../src/providers/antigravity.ts';
import { readClaudeKeychain, resolveClaudeKeychainService } from '../src/providers/claude-keychain.ts';
import { runProcess, windowsPowerShell, type RunOptions, type RunProcess } from '../src/providers/common.ts';
import { account, windowsOf } from './helpers/fixtures.ts';

const DISCOVERY_SCRIPT = path.join(import.meta.dirname, '../src/launchers/discover-antigravity.ps1');
const antigravityAccount = account({ id: 'antigravity:current', providerId: 'antigravity' });
const languageServer = (csrfToken = 'fixture'): LanguageServer => ({ pid: 42, csrfToken, ports: [3333], sourceKind: 'app' });

interface FakeResponse extends EventEmitter {
  statusCode: number;
  headers: Record<string, string>;
  destroy(): void;
  resume(): void;
}

function fakeResponse(
  statusCode: number,
  headers: Record<string, string> = {},
  hooks: Partial<Pick<FakeResponse, 'destroy' | 'resume'>> = {}
): FakeResponse {
  return Object.assign(new EventEmitter(), { statusCode, headers, destroy: () => undefined, resume: () => undefined, ...hooks });
}

// An https.request stand-in: `end` receives the request body and the response callback.
function fakeRequest(
  end: (body: string, respond: (response: FakeResponse) => void, options: https.RequestOptions) => void,
  destroy: () => void = () => undefined
): NonNullable<LocalRequestOptions['request']> {
  return (options, onResponse) => {
    const request = Object.assign(new EventEmitter(), {
      destroy,
      end: (body: string) => {
        end(
          body,
          response => {
            onResponse(response as unknown as IncomingMessage);
          },
          options
        );
      }
    });
    return request as unknown as ClientRequest;
  };
}

test('raw Antigravity summary preserves direct/nested/oneof and unknown fractions', () => {
  const result = parseAntigravitySummary({
    response: {
      groups: [
        {
          displayName: 'Claude and GPT models',
          buckets: [
            { bucketId: 'claude-weekly', window: 'weekly', remainingFraction: 1, resetTime: '2026-10-23T09:50:40Z' },
            { bucketId: 'claude-session', window: '5h', remaining: { remainingFraction: 0.25 }, resetTime: null },
            { bucketId: 'unknown', remaining: { case: 'remainingFraction', value: 0 }, disabled: true },
            { bucketId: 'missing', remaining: { case: 'unknown', value: 1 } }
          ]
        }
      ]
    },
    userStatus: { email: 'private-fixture@example.invalid' }
  });
  const [, session, disabled, missing] = result.windows;
  assert.deepEqual(
    result.windows.map(w => w.remainingPercent),
    [100, 25, 0, null]
  );
  assert.deepEqual([session?.labelKey, session?.labelParams], ['labelNHours', { n: 5 }]);
  assert.equal(disabled?.active, false);
  assert.equal(missing?.resetsAt, null);
  assert.equal(result.email, 'private-fixture@example.invalid', 'identity is reported beside the windows');
  assert.equal(JSON.stringify(result.windows).includes('private-fixture'), false, 'and never inside them');
  assert.throws(() => parseAntigravitySummary({ code: 16, response: { groups: [] } }), /auth_rejected/);
});

test('model quota fallback emits only actual model windows', () => {
  const value = parseAntigravityUserStatus({
    userStatus: {
      email: 'private',
      cascadeModelConfigData: {
        clientModelConfigs: [
          {
            label: 'Claude',
            modelOrAlias: { model: 'claude-model' },
            quotaInfo: { remainingFraction: 0.2, resetTime: '2026-10-16T14:50:40Z' }
          },
          { label: 'Unmeasured', quotaInfo: { resetTime: null } },
          { label: 'No quota' }
        ]
      }
    }
  });
  assert.deepEqual(
    value.windows.map(w => w.remainingPercent),
    [20, null]
  );
  assert.equal(JSON.stringify(value).includes('Gemini'), false);
});

test('Antigravity group/bucket IDs survive reordering without misattributing retained quota', () => {
  const claude = {
    id: 'claude-gpt',
    displayName: 'Claude and GPT models',
    buckets: [
      { bucketId: 'session', window: '5h', remainingFraction: 0.2 },
      { bucketId: 'weekly', window: 'weekly', remainingFraction: 0.8 }
    ]
  };
  const gemini = { displayName: 'Gemini Models', buckets: [{ bucketId: 'session', window: '5h', remainingFraction: 0.9 }] };
  const first = parseAntigravitySummary({ groups: [claude, gemini] }).windows;
  const second = parseAntigravitySummary({ groups: [gemini, { ...claude, buckets: [...claude.buckets].reverse() }] }).windows;
  const byId = (windows: typeof first) =>
    Object.fromEntries(windows.map(w => [w.id, { scope: w.scope, label: w.label, remaining: w.remainingPercent }]));
  assert.deepEqual(byId(first), byId(second));
  assert.equal(new Set(first.map(w => w.id)).size, 3);
});

test('Antigravity model IDs survive order changes and use source identity over label', () => {
  const models = [
    { label: 'Claude', modelOrAlias: { model: 'claude-source' }, quotaInfo: { remainingFraction: 0.4 } },
    { label: 'Gemini', modelOrAlias: { model: 'gemini-source' }, quotaInfo: { remainingFraction: 0.8 } }
  ];
  const ids = (configs: typeof models): string[] =>
    parseAntigravityUserStatus({ clientModelConfigs: configs })
      .windows.map(w => w.id)
      .sort();
  assert.deepEqual(ids(models), ids([...models].reverse().map(m => ({ ...m, label: `${m.label} updated` }))));
});

test('Antigravity source success codes accept case-insensitive ok and success', () => {
  for (const code of [0, '0', 'ok', 'OK', 'success', 'SUCCESS']) {
    const result = parseAntigravitySummary({
      code,
      groups: [{ displayName: 'Actual group', buckets: [{ bucketId: 'actual', remainingFraction: 0.5 }] }]
    });
    assert.equal(result.windows[0]?.remainingPercent, 50);
  }
});

test('Windows discovery invokes built-in Windows PowerShell with only static script argv', async () => {
  const calls: { binary: string; args: readonly string[] }[] = [];
  const servers = await discoverAntigravityServers({
    platform: 'win32',
    env: { SystemRoot: 'C:\\Windows' },
    runProcess: (binary, args) => {
      calls.push({ binary, args });
      return Promise.resolve(JSON.stringify({ outcome: 'success', servers: [{ pid: 42, csrfToken: 'fixture-csrf', ports: [3333] }] }));
    }
  });
  const [call] = calls;
  assert.ok(call);
  assert.match(call.binary, /WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/);
  assert.equal(call.args.includes('-LaunchApp'), false);
  assert.equal(call.args.includes('-Command'), false);
  assert.match(call.args.at(-1) ?? '', /discover-antigravity\.ps1$/);
  assert.deepEqual(servers, [{ pid: 42, csrfToken: 'fixture-csrf', ports: [3333], sourceKind: 'app' }]);
});

test('Windows discovery script is read-only and limits output to internal server descriptors', async () => {
  const source = await fs.readFile(DISCOVERY_SCRIPT, 'utf8');
  for (const required of [
    /Get-CimInstance/,
    /Get-NetTCPConnection/,
    /-OwningProcess/,
    /ExecutablePath/,
    /WindowsIdentity\]::GetCurrent\(\)/,
    /-MethodName GetOwnerSid/
  ])
    assert.match(source, required);
  assert.doesNotMatch(source, /Start-Process|Stop-Process|Invoke-Expression|Set-Content|Write-Host|HttpClient|Invoke-WebRequest/i);
});

test('Windows discovery rejects a foreign-user fixture before reading its ports', { skip: process.platform !== 'win32' }, async () => {
  const scriptPath = DISCOVERY_SCRIPT.replaceAll("'", "''");
  const harness = [
    '$global:fixtureSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
    '$global:portsRead = @()',
    "$global:fixtureExe = Join-Path $env:LOCALAPPDATA 'Programs\\Antigravity\\resources\\bin\\language_server.exe'",
    "function Get-CimInstance { param($ClassName, $Filter) $rows = @( [pscustomobject]@{ ProcessId=100; ExecutablePath=$global:fixtureExe; CreationDate='fixture'; CommandLine='server --csrf_token=fixture-foreign' }, [pscustomobject]@{ ProcessId=200; ExecutablePath=$global:fixtureExe; CreationDate='fixture'; CommandLine='server --csrf_token=fixture-current' }); if ($Filter -match 'ProcessId = (\\d+)') { $rows | Where-Object { $_.ProcessId -eq [int]$Matches[1] } } else { $rows } }",
    "function Invoke-CimMethod { param($InputObject, $MethodName) [pscustomobject]@{ ReturnValue=0; Sid=$(if ($InputObject.ProcessId -eq 200) { $global:fixtureSid } else { 'S-1-0-0' }) } }",
    'function Get-NetTCPConnection { param($State, $OwningProcess, $ErrorAction) $global:portsRead += $OwningProcess; if ($OwningProcess -eq 100) { [pscustomobject]@{ LocalAddress="127.0.0.1"; LocalPort=9999 } } else { [pscustomobject]@{ LocalAddress="127.0.0.1"; LocalPort=3333 }; [pscustomobject]@{ LocalAddress="192.168.1.10"; LocalPort=4444 }; [pscustomobject]@{ LocalAddress="127.0.0.2"; LocalPort=5555 }; [pscustomobject]@{ LocalAddress="::1"; LocalPort=6666 }; [pscustomobject]@{ LocalAddress="::"; LocalPort=7777 }; [pscustomobject]@{ LocalAddress="0.0.0.0"; LocalPort=8888 } } }',
    `. '${scriptPath}'`,
    '[pscustomobject]@{ portsRead=@($global:portsRead) } | ConvertTo-Json -Compress'
  ].join('\n');
  const output = await runProcess(windowsPowerShell(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', harness], {
    timeoutMs: 8000
  });
  const [discovery, reads] = output
    .trim()
    .split(/\r?\n/)
    .map(line => JSON.parse(line) as { servers?: { pid: number; ports: number[] }[]; portsRead?: number[] });
  assert.deepEqual(
    discovery?.servers?.map(s => s.pid),
    [200]
  );
  assert.deepEqual(reads?.portsRead, [200]);
  assert.deepEqual(discovery.servers[0]?.ports, [3333, 8888]);
});

test('macOS process discovery rejects unrelated servers and binds lsof to the PID', async () => {
  const calls: { binary: string; args: readonly string[] }[] = [];
  const servers = await discoverAntigravityServers({
    platform: 'darwin',
    currentUid: 501,
    runProcess: (binary, args) => {
      calls.push({ binary, args });
      if (binary === '/bin/ps')
        return Promise.resolve(
          [
            '11 501 /Applications/Other.app/Contents/bin/language_server --csrf_token=wrong',
            '21 502 /Applications/Antigravity.app/Contents/Resources/bin/language_server_macos_arm --csrf_token=foreign-user',
            '22 501 /Applications/Antigravity.app/Contents/Resources/bin/language_server_macos_arm --csrf_token=fixture-csrf',
            '23 501 /Applications/Antigravity IDE.app/Contents/Resources/extensions/antigravity/bin/language_server_macos --app_data_dir antigravity-ide'
          ].join('\n')
        );
      if (binary === '/usr/sbin/lsof') {
        assert.equal(args.at(-1), '22');
        assert.equal(args.includes('-i4TCP'), true);
        return Promise.resolve(
          'COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\nlanguage 22 owner 8u IPv4 0t0 TCP 127.0.0.1:4444 (LISTEN)\nlanguage 22 owner 9u IPv6 0t0 TCP [::1]:5555 (LISTEN)\nlanguage 22 owner 10u IPv4 0t0 TCP 192.168.1.10:6666 (LISTEN)\nlanguage 22 owner 11u IPv4 0t0 TCP 127.0.0.2:7777 (LISTEN)'
        );
      }
      return Promise.reject(new Error('unexpected_process'));
    }
  });
  assert.deepEqual(
    servers.map(s => s.ports),
    [[4444]]
  );
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.args.includes('pid=,uid=,command='), true);
});

test('macOS listening-port parser binds exact IPv4 loopback or wildcard and excludes foreign PID', () => {
  const output = [
    'COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME',
    'language 22 owner 8u IPv4 0t0 TCP 127.0.0.1:3333 (LISTEN)',
    'language 22 owner 9u IPv4 0t0 TCP *:4444 (LISTEN)',
    'language 22 owner 10u IPv4 0t0 TCP 0.0.0.0:5555 (LISTEN)',
    'language 22 owner 11u IPv4 0t0 TCP 192.168.1.10:6666 (LISTEN)',
    'language 22 owner 12u IPv4 0t0 TCP 127.0.0.2:7777 (LISTEN)',
    'language 22 owner 13u IPv6 0t0 TCP [::1]:8888 (LISTEN)',
    'language 22 owner 14u IPv6 0t0 TCP *:8889 (LISTEN)',
    'language 21 foreign 8u IPv4 0t0 TCP 127.0.0.1:9999 (LISTEN)'
  ].join('\n');
  assert.deepEqual(parseListeningPorts(output, 22), [3333, 4444, 5555]);
  assert.deepEqual(parseListeningPorts(output, undefined), []);
});

test('macOS process parser fails closed for a missing or foreign UID even with a valid app path', () => {
  const command = '/Applications/Antigravity.app/Contents/bin/language_server --csrf_token=fixture';
  assert.deepEqual(parseMacProcessList(`22 502 ${command}`, 501), []);
  assert.deepEqual(parseMacProcessList(`22 ${command}`, 501), []);
  assert.deepEqual(parseMacProcessList(`22 501 ${command}`, undefined), []);
  assert.equal(parseMacProcessList(`22 501 ${command}`, 501).length, 1);
});

test('a closed app is unavailable without any quota requests', async () => {
  const provider = createAntigravityProvider({
    platform: 'win32',
    env: { SystemRoot: 'C:\\Windows' },
    runProcess: () => Promise.resolve(JSON.stringify({ outcome: 'app_closed', servers: [] })),
    requestLocalJson: () => Promise.reject(new Error('must_not_call'))
  });
  await assert.rejects(provider.fetch(antigravityAccount), /app_closed/);
});

test('the provider reads the summary from discovered ports only and returns no internal descriptor', async () => {
  let calls = 0;
  const provider = createAntigravityProvider({
    platform: 'win32',
    env: { SystemRoot: 'C:\\Windows' },
    runProcess: () =>
      Promise.resolve(JSON.stringify({ outcome: 'success', servers: [{ pid: 42, csrfToken: 'fixture-secret', ports: [3333] }] })),
    requestLocalJson: (server, port, method) => {
      calls++;
      assert.deepEqual([server.pid, port, method], [42, 3333, 'RetrieveUserQuotaSummary']);
      return Promise.resolve({
        groups: [{ displayName: 'Claude and GPT models', buckets: [{ bucketId: 'weekly', remainingFraction: 0.5 }] }]
      });
    }
  });
  const result = await provider.fetch(antigravityAccount);
  assert.equal(calls, 1);
  assert.equal(windowsOf(result)[0]?.remainingPercent, 50);
  assert.equal(JSON.stringify(result).includes('fixture-secret'), false);
  assert.equal(JSON.stringify(result).includes('3333'), false);
});

test('a loopback request fixes host, path and TLS scope and rejects unowned ports and redirects', async () => {
  const server = languageServer('fixture-csrf');
  let called = false;
  const unused = fakeRequest(() => {
    called = true;
  });
  await assert.rejects(requestLocalJson(server, 3334, 'RetrieveUserQuotaSummary', { request: unused }), /endpoint_not_allowed/);
  assert.equal(called, false);
  const redirect = fakeRequest((body, respond, options) => {
    assert.equal(options.hostname, '127.0.0.1');
    assert.equal(options.rejectUnauthorized, false);
    assert.equal(options.method, 'POST');
    assert.equal(options.path, '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary');
    assert.equal((options.headers as Record<string, string>)['X-Codeium-Csrf-Token'], 'fixture-csrf');
    assert.deepEqual(JSON.parse(body), { forceRefresh: true });
    respond(fakeResponse(302, { location: 'https://evil.example' }));
  });
  await assert.rejects(requestLocalJson(server, 3333, 'RetrieveUserQuotaSummary', { request: redirect }), /http_rejected/);
});

test('the loopback response byte limit rejects oversized bodies', async () => {
  const request = fakeRequest((_body, respond) => {
    const response = fakeResponse(200);
    respond(response);
    response.emit('data', Buffer.alloc(20));
  });
  await assert.rejects(
    requestLocalJson(languageServer(), 3333, 'RetrieveUserQuotaSummary', { request, maxBytes: 10 }),
    /response_too_large/
  );
});

test('rejected loopback responses destroy both streams and survive late error/abort events', async () => {
  let response: FakeResponse | undefined;
  let requestDestroyed = 0;
  let responseDestroyed = 0;
  let resumed = false;
  const request = fakeRequest(
    (_body, respond) => {
      response = fakeResponse(
        503,
        {},
        {
          resume: () => {
            resumed = true;
          },
          destroy: () => {
            responseDestroyed++;
          }
        }
      );
      respond(response);
    },
    () => {
      requestDestroyed++;
    }
  );
  await assert.rejects(requestLocalJson(languageServer(), 3333, 'GetUserStatus', { request, timeoutMs: 5 }), /http_rejected/);
  assert.deepEqual([requestDestroyed, responseDestroyed, resumed], [1, 1, false]);
  assert.doesNotThrow(() => response?.emit('error', new Error('synthetic-reset')));
  assert.doesNotThrow(() => response?.emit('aborted'));
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual([requestDestroyed, responseDestroyed], [1, 1]);
});

test('a loopback request has an absolute deadline and the rate-limit retry stays bounded', async () => {
  let destroyed = false;
  const stalled = fakeRequest(
    () => undefined,
    () => {
      destroyed = true;
    }
  );
  await assert.rejects(requestLocalJson(languageServer(), 3333, 'GetUserStatus', { request: stalled, timeoutMs: 5 }), /request_timeout/);
  assert.equal(destroyed, true);
  const throttled = fakeRequest((_body, respond) => {
    respond(fakeResponse(429, { 'retry-after': '100000' }));
  });
  await assert.rejects(
    requestLocalJson(languageServer(), 3333, 'GetUserStatus', { request: throttled }),
    (error: unknown) => error instanceof ProviderError && error.code === 'rate_limited' && error.retryAfterSeconds === 900
  );
});

test('the Claude Keychain selector keeps an unset default distinct from an explicit default and custom dirs', () => {
  assert.equal(resolveClaudeKeychainService(), 'Claude Code-credentials');
  assert.equal(resolveClaudeKeychainService({ configDir: '/Users/example/.claude', configDirExplicit: false }), 'Claude Code-credentials');
  assert.equal(
    resolveClaudeKeychainService({ configDir: '/Users/example/.claude', configDirExplicit: true }),
    'Claude Code-credentials-402b469b'
  );
  assert.equal(
    resolveClaudeKeychainService({ configDir: '/Users/example/.claude-secondary', configDirExplicit: true }),
    'Claude Code-credentials-ffea7840'
  );
});

test('the Claude Keychain selector is the raw NFC selector, without path resolution or sibling fallback', () => {
  const explicit = (configDir: string) => resolveClaudeKeychainService({ configDir, configDirExplicit: true });
  assert.equal(explicit('/Users/examplé/.claude'), explicit('/Users/example\u0301/.claude'));
  assert.notEqual(explicit('~/.claude'), explicit('/Users/example/.claude'));
  assert.equal(
    resolveClaudeKeychainService({
      configDir: '/other',
      configDirExplicit: true,
      secureStorageConfigDir: '/Users/example/.claude-secondary'
    }),
    'Claude Code-credentials-ffea7840'
  );
  assert.throws(() => explicit('/bad\npath'), /unsupported_profile/);
});

test('a Claude Keychain read uses one exact service, bounded argv and sanitized failures', async () => {
  let calls = 0;
  const runProcess: RunProcess = (binary, args, options?: RunOptions) => {
    calls++;
    assert.equal(binary, '/usr/bin/security');
    assert.deepEqual(args, ['find-generic-password', '-s', 'Claude Code-credentials-ffea7840', '-w']);
    assert.deepEqual([options?.timeoutMs, options?.maxBytes], [8000, 1048576]);
    return Promise.resolve(JSON.stringify({ claudeAiOauth: { accessToken: 'fixture-value' } }));
  };
  const value = await readClaudeKeychain({
    platform: 'darwin',
    configDir: '/Users/example/.claude-secondary',
    configDirExplicit: true,
    runProcess
  });
  assert.equal(calls, 1);
  assert.deepEqual(value, { claudeAiOauth: { accessToken: 'fixture-value' } });
  await assert.rejects(
    readClaudeKeychain({ platform: 'darwin', runProcess: () => Promise.reject(new Error('private-response')) }),
    (error: unknown) => error instanceof ProviderError && error.message === 'keychain_unavailable'
  );
});
