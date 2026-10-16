'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { EventEmitter } = require('node:events');

test('raw Antigravity summary preserves direct/nested/oneof and unknown fractions without identity', () => {
  const { parseAntigravitySummary } = require('../src/providers/antigravity.cjs');
  const result = parseAntigravitySummary({ response: { groups: [{ displayName: 'Claude and GPT models', buckets: [
    { bucketId: 'claude-weekly', window: 'weekly', remainingFraction: 1, resetTime: '2026-10-23T09:50:40Z' },
    { bucketId: 'claude-session', window: '5h', remaining: { remainingFraction: 0.25 }, resetTime: null },
    { bucketId: 'unknown', remaining: { case: 'remainingFraction', value: 0 }, disabled: true },
    { bucketId: 'missing', remaining: { case: 'unknown', value: 1 } },
  ] }] }, userStatus: { email: 'private-fixture@example.invalid' } });
  assert.deepEqual(result.windows.map(w => w.remainingPercent), [100, 25, 0, null]);
  assert.equal(result.windows[1].label, '5 hours');
  assert.equal(result.windows[2].active, false);
  assert.equal(result.windows[3].resetsAt, null);
  assert.equal(JSON.stringify(result).includes('private-fixture'), false);
  assert.throws(() => parseAntigravitySummary({ code: 16, response: { groups: [] } }), /auth_rejected/);
});

test('model quota fallback emits only actual model windows', () => {
  const { parseAntigravityUserStatus } = require('../src/providers/antigravity.cjs');
  const value = parseAntigravityUserStatus({ userStatus: { email: 'private', cascadeModelConfigData: { clientModelConfigs: [
    { label: 'Claude', modelOrAlias: { model: 'claude-model' }, quotaInfo: { remainingFraction: 0.2, resetTime: '2026-10-16T14:50:40Z' } },
    { label: 'Unmeasured', quotaInfo: { resetTime: null } }, { label: 'No quota' },
  ] } } });
  assert.equal(value.windows.length, 2);
  assert.equal(value.windows[0].remainingPercent, 20);
  assert.equal(value.windows[1].remainingPercent, null);
  assert.equal(JSON.stringify(value).includes('Gemini'), false);
});

test('Antigravity group/bucket IDs survive reordering without misattributing retained quota', () => {
  const { parseAntigravitySummary } = require('../src/providers/antigravity.cjs');
  const a = { id: 'claude-gpt', displayName: 'Claude and GPT models', buckets: [{ bucketId: 'session', window: '5h', remainingFraction: 0.2 }, { bucketId: 'weekly', window: 'weekly', remainingFraction: 0.8 }] };
  const b = { displayName: 'Gemini Models', buckets: [{ bucketId: 'session', window: '5h', remainingFraction: 0.9 }] };
  const first = parseAntigravitySummary({ groups: [a, b] }).windows;
  const second = parseAntigravitySummary({ groups: [b, { ...a, buckets: [...a.buckets].reverse() }] }).windows;
  const byId = windows => Object.fromEntries(windows.map(w => [w.id, { scope: w.scope, label: w.label, remaining: w.remainingPercent }]));
  assert.deepEqual(byId(first), byId(second));
  assert.equal(new Set(first.map(w => w.id)).size, 3);
});

test('Antigravity model IDs survive order changes and use source identity over label', () => {
  const { parseAntigravityUserStatus } = require('../src/providers/antigravity.cjs');
  const models = [{ label: 'Claude', modelOrAlias: { model: 'claude-source' }, quotaInfo: { remainingFraction: 0.4 } }, { label: 'Gemini', modelOrAlias: { model: 'gemini-source' }, quotaInfo: { remainingFraction: 0.8 } }];
  const first = parseAntigravityUserStatus({ clientModelConfigs: models }).windows;
  const second = parseAntigravityUserStatus({ clientModelConfigs: [...models].reverse().map(m => ({ ...m, label: `${m.label} updated` })) }).windows;
  assert.deepEqual(first.map(w => w.id).sort(), second.map(w => w.id).sort());
});

test('Antigravity source success codes accept case-insensitive ok and success', () => {
  const { parseAntigravitySummary } = require('../src/providers/antigravity.cjs');
  for (const code of [0, '0', 'ok', 'OK', 'success', 'SUCCESS']) {
    const result = parseAntigravitySummary({ code, groups: [{ displayName: 'Actual group', buckets: [{ bucketId: 'actual', remainingFraction: 0.5 }] }] });
    assert.equal(result.windows[0].remainingPercent, 50);
  }
});

test('Windows discovery invokes built-in Windows PowerShell with only static script argv', async () => {
  const { discoverAntigravityServers } = require('../src/providers/antigravity.cjs');
  const calls = [];
  const servers = await discoverAntigravityServers({ platform: 'win32', env: { SystemRoot: 'C:\\Windows' }, runProcess: async (binary, args, options) => {
    calls.push({ binary, args, options });
    return JSON.stringify({ outcome: 'success', servers: [{ pid: 42, csrfToken: 'fixture-csrf', ports: [3333] }] });
  } });
  assert.match(calls[0].binary, /WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/);
  assert.equal(calls[0].args.includes('-LaunchApp'), false);
  assert.equal(calls[0].args.includes('-Command'), false);
  assert.match(calls[0].args.at(-1), /discover-antigravity\.ps1$/);
  assert.equal(servers[0].pid, 42);
  assert.equal(servers[0].csrfToken, 'fixture-csrf');
});

test('Windows discovery script is read-only and limits output to internal server descriptors', async () => {
  const source = await fs.readFile(path.join(__dirname, '../src/launchers/discover-antigravity.ps1'), 'utf8');
  assert.match(source, /Get-CimInstance/); assert.match(source, /Get-NetTCPConnection/);
  assert.match(source, /-OwningProcess/); assert.match(source, /ExecutablePath/);
  assert.match(source, /WindowsIdentity\]::GetCurrent\(\)/); assert.match(source, /-MethodName GetOwnerSid/);
  assert.doesNotMatch(source, /Start-Process|Stop-Process|Invoke-Expression|Set-Content|Write-Host|HttpClient|Invoke-WebRequest/i);
});

test('Windows discovery rejects a foreign-user fixture before reading its ports', { skip: process.platform !== 'win32' }, async () => {
  const { runProcess } = require('../src/providers/common.cjs');
  const { powerShellBinary } = require('../src/providers/antigravity.cjs');
  const scriptPath = path.resolve(__dirname, '../src/launchers/discover-antigravity.ps1').replace(/'/g, "''");
  const harness = [
    "$global:fixtureSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
    '$global:portsRead = @()',
    "$global:fixtureExe = Join-Path $env:LOCALAPPDATA 'Programs\\Antigravity\\resources\\bin\\language_server.exe'",
    "function Get-CimInstance { param($ClassName, $Filter) $rows = @( [pscustomobject]@{ ProcessId=100; ExecutablePath=$global:fixtureExe; CreationDate='fixture'; CommandLine='server --csrf_token=fixture-foreign' }, [pscustomobject]@{ ProcessId=200; ExecutablePath=$global:fixtureExe; CreationDate='fixture'; CommandLine='server --csrf_token=fixture-current' }); if ($Filter -match 'ProcessId = (\\d+)') { $rows | Where-Object { $_.ProcessId -eq [int]$Matches[1] } } else { $rows } }",
    "function Invoke-CimMethod { param($InputObject, $MethodName) [pscustomobject]@{ ReturnValue=0; Sid=$(if ($InputObject.ProcessId -eq 200) { $global:fixtureSid } else { 'S-1-0-0' }) } }",
    'function Get-NetTCPConnection { param($State, $OwningProcess, $ErrorAction) $global:portsRead += $OwningProcess; if ($OwningProcess -eq 100) { [pscustomobject]@{ LocalAddress="127.0.0.1"; LocalPort=9999 } } else { [pscustomobject]@{ LocalAddress="127.0.0.1"; LocalPort=3333 }; [pscustomobject]@{ LocalAddress="192.168.1.10"; LocalPort=4444 }; [pscustomobject]@{ LocalAddress="127.0.0.2"; LocalPort=5555 }; [pscustomobject]@{ LocalAddress="::1"; LocalPort=6666 }; [pscustomobject]@{ LocalAddress="::"; LocalPort=7777 }; [pscustomobject]@{ LocalAddress="0.0.0.0"; LocalPort=8888 } } }',
    `. '${scriptPath}'`,
    '[pscustomobject]@{ portsRead=@($global:portsRead) } | ConvertTo-Json -Compress',
  ].join('\n');
  const [output, reads] = (await runProcess(await powerShellBinary(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', harness], { timeoutMs: 8000 })).trim().split(/\r?\n/).map(line => JSON.parse(line));
  assert.deepEqual(output.servers.map(s => s.pid), [200]); assert.deepEqual(reads.portsRead, [200]);
  assert.deepEqual(output.servers[0].ports, [3333, 8888]);
});

test('macOS source-derived process discovery rejects unrelated servers and binds lsof to PID', async () => {
  const { discoverAntigravityServers } = require('../src/providers/antigravity.cjs');
  const calls = [];
  const servers = await discoverAntigravityServers({ platform: 'darwin', currentUid: 501, runProcess: async (binary, args) => {
    calls.push({ binary, args });
    if (binary === '/bin/ps') return [
      '11 501 /Applications/Other.app/Contents/bin/language_server --csrf_token=wrong',
      '21 502 /Applications/Antigravity.app/Contents/Resources/bin/language_server_macos_arm --csrf_token=foreign-user',
      '22 501 /Applications/Antigravity.app/Contents/Resources/bin/language_server_macos_arm --csrf_token=fixture-csrf',
      '23 501 /Applications/Antigravity IDE.app/Contents/Resources/extensions/antigravity/bin/language_server_macos --app_data_dir antigravity-ide',
    ].join('\n');
    if (binary === '/usr/sbin/lsof') { assert.equal(args.at(-1), '22'); assert.equal(args.includes('-i4TCP'), true); return 'COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\nlanguage 22 owner 8u IPv4 0t0 TCP 127.0.0.1:4444 (LISTEN)\nlanguage 22 owner 9u IPv6 0t0 TCP [::1]:5555 (LISTEN)\nlanguage 22 owner 10u IPv4 0t0 TCP 192.168.1.10:6666 (LISTEN)\nlanguage 22 owner 11u IPv4 0t0 TCP 127.0.0.2:7777 (LISTEN)'; }
    throw new Error('unexpected_process');
  } });
  assert.equal(servers.length, 1); assert.deepEqual(servers[0].ports, [4444]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].args.includes('pid=,uid=,command='), true);
});

test('macOS listening-port parser binds exact IPv4 loopback or wildcard and excludes foreign PID', () => {
  const { parseListeningPorts } = require('../src/providers/antigravity.cjs');
  const output = [
    'COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME',
    'language 22 owner 8u IPv4 0t0 TCP 127.0.0.1:3333 (LISTEN)',
    'language 22 owner 9u IPv4 0t0 TCP *:4444 (LISTEN)',
    'language 22 owner 10u IPv4 0t0 TCP 0.0.0.0:5555 (LISTEN)',
    'language 22 owner 11u IPv4 0t0 TCP 192.168.1.10:6666 (LISTEN)',
    'language 22 owner 12u IPv4 0t0 TCP 127.0.0.2:7777 (LISTEN)',
    'language 22 owner 13u IPv6 0t0 TCP [::1]:8888 (LISTEN)',
    'language 22 owner 14u IPv6 0t0 TCP *:8889 (LISTEN)',
    'language 21 foreign 8u IPv4 0t0 TCP 127.0.0.1:9999 (LISTEN)',
  ].join('\n');
  assert.deepEqual(parseListeningPorts(output, 22), [3333, 4444, 5555]);
  assert.deepEqual(parseListeningPorts(output, undefined), []);
});

test('macOS process parser fails closed for missing/foreign UID even with a valid app path', () => {
  const { parseMacProcessList } = require('../src/providers/antigravity.cjs');
  const command = '/Applications/Antigravity.app/Contents/bin/language_server --csrf_token=fixture';
  assert.deepEqual(parseMacProcessList(`22 502 ${command}`, 501), []);
  assert.deepEqual(parseMacProcessList(`22 ${command}`, 501), []);
  assert.deepEqual(parseMacProcessList(`22 501 ${command}`, undefined), []);
  assert.equal(parseMacProcessList(`22 501 ${command}`, 501).length, 1);
});

test('closed app is unavailable without any quota requests', async () => {
  const { createAntigravityProvider } = require('../src/providers/antigravity.cjs');
  const provider = createAntigravityProvider({ platform: 'win32', env: { SystemRoot: 'C:\\Windows' }, runProcess: async () => JSON.stringify({ outcome: 'app_closed', servers: [] }), requestLocalJson: async () => { throw new Error('must_not_call'); } });
  await assert.rejects(provider.fetch({}), /app_closed/);
});

test('provider reads summary from only discovered ports and returns no internal descriptor', async () => {
  const { createAntigravityProvider } = require('../src/providers/antigravity.cjs');
  let calls = 0;
  const provider = createAntigravityProvider({ platform: 'win32', env: { SystemRoot: 'C:\\Windows' }, runProcess: async () => JSON.stringify({ outcome: 'success', servers: [{ pid: 42, csrfToken: 'fixture-secret', ports: [3333] }] }), requestLocalJson: async (server, port, method) => {
    calls++; assert.equal(port, 3333); assert.equal(server.pid, 42); assert.equal(method, 'RetrieveUserQuotaSummary');
    return { groups: [{ displayName: 'Claude and GPT models', buckets: [{ bucketId: 'weekly', remainingFraction: 0.5 }] }] };
  } });
  const result = await provider.fetch({});
  assert.equal(calls, 1); assert.equal(result.windows[0].remainingPercent, 50);
  assert.equal(JSON.stringify(result).includes('fixture-secret'), false);
  assert.equal(JSON.stringify(result).includes('3333'), false);
});

test('loopback request fixes host/path/TLS scope and rejects unowned ports and redirects', async () => {
  const { requestLocalJson } = require('../src/providers/antigravity.cjs');
  const server = { pid: 42, csrfToken: 'fixture-csrf', ports: [3333] };
  let called = false;
  await assert.rejects(requestLocalJson(server, 3334, 'RetrieveUserQuotaSummary', { request: () => { called = true; } }), /endpoint_not_allowed/);
  assert.equal(called, false);
  const request = (options, onResponse) => {
    assert.equal(options.hostname, '127.0.0.1'); assert.equal(options.rejectUnauthorized, false); assert.equal(options.method, 'POST');
    assert.equal(options.path, '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary');
    assert.equal(options.headers['X-Codeium-Csrf-Token'], 'fixture-csrf');
    const req = new EventEmitter(); req.destroy = () => {}; req.end = body => {
      assert.deepEqual(JSON.parse(body), { forceRefresh: true });
      const response = new EventEmitter(); response.statusCode = 302; response.headers = { location: 'https://evil.example' }; response.resume = () => {};
      onResponse(response);
    }; return req;
  };
  await assert.rejects(requestLocalJson(server, 3333, 'RetrieveUserQuotaSummary', { request }), /http_rejected/);
});

test('loopback response byte limit rejects oversized bodies', async () => {
  const { requestLocalJson } = require('../src/providers/antigravity.cjs');
  const request = (options, onResponse) => {
    const req = new EventEmitter(); req.destroy = () => {}; req.end = () => {
      const response = new EventEmitter(); response.statusCode = 200; response.headers = {}; response.destroy = () => {};
      onResponse(response); response.emit('data', Buffer.alloc(20));
    }; return req;
  };
  await assert.rejects(requestLocalJson({ pid: 42, csrfToken: 'fixture', ports: [3333] }, 3333, 'RetrieveUserQuotaSummary', { request, maxBytes: 10 }), /response_too_large/);
});

test('rejected loopback responses destroy both streams and handle late error/abort events', async () => {
  const { requestLocalJson } = require('../src/providers/antigravity.cjs');
  let response, requestDestroyed = 0, responseDestroyed = 0, resumed = false;
  const request = (options, onResponse) => {
    const req = new EventEmitter(); req.destroy = () => { requestDestroyed++; }; req.end = () => {
      response = new EventEmitter(); response.statusCode = 503; response.headers = {};
      response.resume = () => { resumed = true; }; response.destroy = () => { responseDestroyed++; };
      onResponse(response);
    }; return req;
  };
  await assert.rejects(requestLocalJson({ pid: 42, csrfToken: 'fixture', ports: [3333] }, 3333, 'GetUserStatus', { request, timeoutMs: 5 }), /http_rejected/);
  assert.equal(requestDestroyed, 1); assert.equal(responseDestroyed, 1); assert.equal(resumed, false);
  assert.doesNotThrow(() => response.emit('error', new Error('synthetic-reset')));
  assert.doesNotThrow(() => response.emit('aborted'));
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(requestDestroyed, 1); assert.equal(responseDestroyed, 1);
});

test('loopback request has an absolute deadline and rate-limit retry remains bounded', async () => {
  const { requestLocalJson } = require('../src/providers/antigravity.cjs');
  let destroyed = false;
  const stalled = () => { const req = new EventEmitter(); req.end = () => {}; req.destroy = () => { destroyed = true; }; return req; };
  const server = { pid: 42, csrfToken: 'fixture', ports: [3333] };
  await assert.rejects(requestLocalJson(server, 3333, 'GetUserStatus', { request: stalled, timeoutMs: 5 }), /request_timeout/);
  assert.equal(destroyed, true);
  const throttled = (options, onResponse) => {
    const req = new EventEmitter(); req.destroy = () => {}; req.end = () => {
      const response = new EventEmitter(); response.statusCode = 429; response.headers = { 'retry-after': '100000' }; response.resume = () => {}; onResponse(response);
    }; return req;
  };
  await assert.rejects(requestLocalJson(server, 3333, 'GetUserStatus', { request: throttled }), error => error.code === 'rate_limited' && error.retryAfterSeconds === 900);
});

test('Claude exact Keychain selector keeps unset default distinct from explicit default and custom', () => {
  const { resolveClaudeKeychainService } = require('../src/providers/claude-keychain.cjs');
  assert.equal(resolveClaudeKeychainService(), 'Claude Code-credentials');
  assert.equal(resolveClaudeKeychainService({ configDir: '/Users/example/.claude', configDirExplicit: false }), 'Claude Code-credentials');
  assert.equal(resolveClaudeKeychainService({ configDir: '/Users/example/.claude', configDirExplicit: true }), 'Claude Code-credentials-402b469b');
  assert.equal(resolveClaudeKeychainService({ configDir: '/Users/example/.claude-secondary', configDirExplicit: true }), 'Claude Code-credentials-ffea7840');
});

test('Claude Keychain selector respects raw NFC selector without path resolution or sibling fallback', () => {
  const { resolveClaudeKeychainService } = require('../src/providers/claude-keychain.cjs');
  const composed = resolveClaudeKeychainService({ configDir: '/Users/examplé/.claude', configDirExplicit: true });
  assert.equal(composed, resolveClaudeKeychainService({ configDir: '/Users/example\u0301/.claude', configDirExplicit: true }));
  assert.notEqual(resolveClaudeKeychainService({ configDir: '~/.claude', configDirExplicit: true }), resolveClaudeKeychainService({ configDir: '/Users/example/.claude', configDirExplicit: true }));
  assert.equal(resolveClaudeKeychainService({ configDir: '/other', configDirExplicit: true, secureStorageConfigDir: '/Users/example/.claude-secondary' }), 'Claude Code-credentials-ffea7840');
  assert.throws(() => resolveClaudeKeychainService({ configDir: '/bad\npath', configDirExplicit: true }), /unsupported_profile/);
});

test('Claude Keychain read uses one exact service, bounded argv and sanitized failures', async () => {
  const { readClaudeKeychain } = require('../src/providers/claude-keychain.cjs');
  let calls = 0;
  const value = await readClaudeKeychain({ platform: 'darwin', configDir: '/Users/example/.claude-secondary', configDirExplicit: true, runProcess: async (binary, args, options) => {
    calls++; assert.equal(binary, '/usr/bin/security'); assert.deepEqual(args, ['find-generic-password', '-s', 'Claude Code-credentials-ffea7840', '-w']);
    assert.equal(options.timeoutMs, 8000); assert.equal(options.maxBytes, 1048576);
    return JSON.stringify({ claudeAiOauth: { accessToken: 'fixture-value' } });
  } });
  assert.equal(calls, 1); assert.equal(value.claudeAiOauth.accessToken, 'fixture-value');
  await assert.rejects(readClaudeKeychain({ platform: 'darwin', runProcess: async () => { throw new Error('private-response'); } }), error => error.message === 'keychain_unavailable');
});
