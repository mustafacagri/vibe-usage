'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

// Shared fixtures for session/handover tests. They mirror the on-disk formats the
// providers really write (verified against local installs), at minimal size.
function writeAntigravityDb(file, projectDir, modelName) {
  const { DatabaseSync } = require('node:sqlite');
  const { pathToFileURL } = require('node:url');
  const uri = Buffer.from(pathToFileURL(path.resolve(projectDir)).href);
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE trajectory_metadata_blob (id TEXT DEFAULT "main", data BLOB, PRIMARY KEY (id)); CREATE TABLE gen_metadata (idx INTEGER, data BLOB, size INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (idx));');
  db.prepare('INSERT INTO trajectory_metadata_blob (id, data) VALUES (?, ?)').run('main', Buffer.concat([Buffer.from([0x0a, uri.length]), uri, Buffer.from([0x12, 0x02, 0x08, 0x01])]));
  if (modelName) {
    const name = Buffer.from(modelName);
    db.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)').run(0, Buffer.concat([Buffer.from([0x0a, 0x01, 0x41, 0xaa, 0x01, name.length]), name]));
  }
  db.close();
}

function codexRollout({ id, cwd, source = 'vscode', model = 'gpt-6-luna', user = [], assistant = [] }) {
  const lines = [{ type: 'session_meta', payload: { session_id: id, id, cwd, source, base_instructions: { text: 'x'.repeat(200) } } }, { type: 'turn_context', payload: { cwd, model } }];
  lines.push({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `# AGENTS.md instructions for ${cwd}\n\n<INSTRUCTIONS>x</INSTRUCTIONS>` }] } });
  lines.push({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>\n  <cwd>x</cwd>\n</environment_context>' }] } });
  user.forEach((u, i) => {
    lines.push({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: u }] } });
    if (assistant[i]) lines.push({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: assistant[i] }] } });
  });
  return lines.map(l => JSON.stringify({ timestamp: '2026-10-16T10:00:00.000Z', ...l })).join('\n') + '\n';
}

function writeCursorChat(chatsRoot, { id, cwd, name, user = [], assistant = [] }) {
  const { DatabaseSync } = require('node:sqlite');
  const fsSync = require('node:fs');
  const dir = path.join(chatsRoot, 'a1b2c3', id);
  fsSync.mkdirSync(dir, { recursive: true });
  fsSync.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ schemaVersion: 1, hasConversation: true, updatedAtMs: Date.now(), cwd }));
  const db = new DatabaseSync(path.join(dir, 'store.db'));
  db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB);');
  db.prepare("INSERT INTO meta VALUES ('0', ?)").run(Buffer.from(JSON.stringify({ agentId: id, name })).toString('hex'));
  const put = (k, v) => db.prepare('INSERT INTO blobs VALUES (?, ?)').run(k, Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)));
  put('sys', { role: 'system', content: 'You are an AI coding assistant' });
  put('info', { role: 'user', content: `<user_info>\nWorkspace Path: ${cwd}\n</user_info>` });
  put('tree', '\x0a\x20internal-node');
  user.forEach((u, i) => {
    put(`u${i}`, { role: 'user', content: [{ type: 'text', text: `<user_query>\n${u}\n</user_query>` }] });
    if (assistant[i]) put(`a${i}`, { role: 'assistant', content: [{ type: 'reasoning', text: '' }, { type: 'text', text: assistant[i] }] });
  });
  db.close();
}

function fakeSpawn(calls) {
  return (cmd, args) => {
    calls.push([cmd, ...args]);
    return { once(event, cb) { if (event === 'spawn') setImmediate(cb); }, unref() {} };
  };
}

// Kusur 1: Windows Environment Variables Case-Insensitivity & Project Settings Env Warning
test('Kusur 1: cleanEnvironment and launchEnvironment strip case-insensitive blocked keys on win32', () => {
  const { cleanEnvironment } = require('../src/providers/common.cjs');
  const { launchEnvironment } = require('../src/core/launcher.cjs');

  const dirtySource = {
    anthropic_api_key: 'secret-lower',
    Anthropic_Base_Url: 'https://leak.example',
    CLAUDE_CONFIG_DIR: 'C:\\Users\\old\\.claude',
    claude_config_dir: 'C:\\Users\\old\\.claude-lower',
    cursor_api_key: 'cursor-lower',
    SAFE_VAR: 'keep-me'
  };

  // Test win32 platform stripping
  const cleanedEnv = cleanEnvironment({}, 'win32', dirtySource);
  assert.equal(cleanedEnv.anthropic_api_key, undefined);
  assert.equal(cleanedEnv.Anthropic_Base_Url, undefined);
  assert.equal(cleanedEnv.cursor_api_key, undefined);
  assert.equal(cleanedEnv.SAFE_VAR, 'keep-me');
  assert.equal(cleanEnvironment({ CODEX_HOME: '/x' }).CODEX_HOME, '/x');

  const launchedDefault = launchEnvironment({ id: 'claude:default', configDir: 'C:\\Users\\test\\.claude' }, dirtySource, 'win32');
  assert.equal(launchedDefault.anthropic_api_key, undefined);
  assert.equal(launchedDefault.Anthropic_Base_Url, undefined);
  assert.equal(launchedDefault.CLAUDE_CONFIG_DIR, undefined);
  assert.equal(launchedDefault.claude_config_dir, undefined);
  assert.equal(launchedDefault.SAFE_VAR, 'keep-me');

  const launchedSecondary = launchEnvironment({ id: 'claude:secondary', configDir: 'C:\\Users\\test\\.claude-secondary' }, dirtySource, 'win32');
  assert.equal(launchedSecondary.CLAUDE_CONFIG_DIR, 'C:\\Users\\test\\.claude-secondary');
  assert.equal(launchedSecondary.claude_config_dir, undefined);
});

test('Kusur 1: launchWarnings warns if project-level settings.json has env overrides', () => {
  const { launchWarnings } = require('../src/core/launcher.cjs');
  const snapshot = {
    providers: [{ id: 'claude', accounts: [{ id: 'claude:default', status: 'ok', fetchedAt: new Date().toISOString(), windows: [{ id: 'five_hour', remainingPercent: 50 }, { id: 'seven_day', remainingPercent: 50 }] }] }],
    settings: { accounts: [{ id: 'claude:default', providerId: 'claude', primary: true, enabled: true }] }
  };

  const cleanWarnings = launchWarnings(snapshot, { id: 'claude:default' }, { projectSettings: {} });
  assert.equal(cleanWarnings.some(w => w.includes('.claude/settings.json')), false);

  const dirtyWarnings = launchWarnings(snapshot, { id: 'claude:default' }, { projectSettings: { env: { ANTHROPIC_API_KEY: 'override' } } });
  assert.equal(dirtyWarnings.some(w => w.includes('.claude/settings.json')), true);
});

// Kusur 2: Antigravity Multi-Server Discovery (App vs IDE) and Gemini Window Preservation
test('Kusur 2: Antigravity fetch combines App and IDE servers, preserving Gemini windows without double-counting', async () => {
  const { createAntigravityProvider } = require('../src/providers/antigravity.cjs');

  const appServer = { pid: 101, csrfToken: 'app-token', ports: [3101], sourceKind: 'app' };
  const ideServer = { pid: 202, csrfToken: 'ide-token', ports: [3202], sourceKind: 'ide' };

  const provider = createAntigravityProvider({
    platform: 'darwin',
    runProcess: async (binary) => {
      if (binary === '/bin/ps') {
        return [
          '101 501 /Applications/Antigravity.app/Contents/Resources/bin/language_server --csrf_token=app-token',
          '202 501 /Applications/Antigravity IDE.app/Contents/Resources/extensions/antigravity/bin/language_server_macos --app_data_dir antigravity-ide --csrf_token=ide-token'
        ].join('\n');
      }
      if (binary === '/usr/sbin/lsof') {
        return 'COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\nlanguage 101 owner 8u IPv4 0t0 TCP 127.0.0.1:3101 (LISTEN)\nlanguage 202 owner 8u IPv4 0t0 TCP 127.0.0.1:3202 (LISTEN)';
      }
      throw new Error('unexpected_process');
    },
    requestLocalJson: async (server, port, method) => {
      if (method === 'GetUserStatus') {
        return { userStatus: { email: 'dev@company.com' } };
      }
      if (server.pid === 101) {
        // App only reports Claude and GPT models
        return {
          groups: [
            { id: 'claude-gpt', displayName: 'Claude and GPT models', buckets: [{ bucketId: 'session', window: '5h', remainingFraction: 1.0 }, { bucketId: 'weekly', window: 'weekly', remainingFraction: 1.0 }] }
          ]
        };
      }
      if (server.pid === 202) {
        // IDE reports both Claude and GPT models AND Gemini Models
        return {
          groups: [
            { id: 'claude-gpt', displayName: 'Claude and GPT models', buckets: [{ bucketId: 'session', window: '5h', remainingFraction: 0.9 }, { bucketId: 'weekly', window: 'weekly', remainingFraction: 0.95 }] },
            { id: 'gemini', displayName: 'Gemini Models', buckets: [{ bucketId: 'session', window: '5h', remainingFraction: 0.86 }, { bucketId: 'weekly', window: 'weekly', remainingFraction: 0.93 }] }
          ]
        };
      }
      throw new Error('unknown_server');
    }
  });

  const result = await provider.fetch({ id: 'antigravity:current' });

  // Both Gemini windows must be captured!
  assert.equal(result.windows.some(w => w.scope.includes('Gemini') && w.label === '5 hours'), true);
  assert.equal(result.windows.some(w => w.scope.includes('Gemini') && w.label === 'Weekly'), true);

  // Claude and GPT models must NOT be duplicated (only 1 session, 1 weekly for claude-gpt)
  const claudeSessionWindows = result.windows.filter(w => w.scope.includes('Claude and GPT') && w.label === '5 hours');
  assert.equal(claudeSessionWindows.length, 1);
  // Conservative remaining percentage chosen (0.90 vs 1.0 -> 90%)
  assert.equal(claudeSessionWindows[0].remainingPercent, 90);

  // Total distinct windows: 2 for claude-gpt + 2 for gemini = 4
  assert.equal(result.windows.length, 4);
});

// Kusur 3: Refresh Scope Race Condition
test('Kusur 3: Concurrent refresh(claude) and refresh() never skips remaining providers', async t => {
  const { createService } = require('../src/core/service.cjs');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-race-scope-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  let codexFetched = false;
  let claudeFetched = false;

  const claudeProvider = {
    id: 'claude',
    name: 'Claude',
    discover: async () => [{ id: 'claude:default', providerId: 'claude', label: 'Claude A', primary: true, enabled: true }],
    fetch: async () => {
      await new Promise(r => setTimeout(r, 20));
      claudeFetched = true;
      return { windows: [{ id: 'five_hour', remainingPercent: 80 }] };
    }
  };

  const codexProvider = {
    id: 'codex',
    name: 'Codex',
    discover: async () => [{ id: 'codex:default', providerId: 'codex', label: 'Codex A', primary: true, enabled: true }],
    fetch: async () => {
      codexFetched = true;
      return { windows: [{ id: 'primary', remainingPercent: 70 }] };
    }
  };

  const svc = await createService({
    settingsPath: path.join(dir, 'settings.json'),
    providers: [claudeProvider, codexProvider]
  });

  // Start narrow refresh('claude')
  const p1 = svc.refresh('claude');
  // Immediately call full refresh() concurrently
  const p2 = svc.refresh();

  await Promise.all([p1, p2]);

  // Codex MUST NOT have been skipped!
  assert.equal(claudeFetched, true);
  assert.equal(codexFetched, true);
  const snap = svc.snapshot();
  assert.equal(snap.providers.find(p => p.id === 'codex').accounts[0].status, 'ok');
  assert.equal(snap.providers.find(p => p.id === 'claude').accounts[0].status, 'ok');
});

// Kusur 4: Discovery Lifecycle and Reconciliation
test('Kusur 4: reconcileDiscovery adds newly discovered profiles and removes after 3 consecutive misses', async t => {
  const { createService } = require('../src/core/service.cjs');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-lifecycle-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  let discovered = [
    { id: 'claude:default', providerId: 'claude', label: 'A', primary: true, enabled: true },
    { id: 'claude:secondary', providerId: 'claude', label: 'B', primary: false, enabled: true }
  ];

  const provider = {
    id: 'claude',
    name: 'Claude',
    discover: async () => discovered,
    fetch: async () => ({ windows: [{ id: '5h', remainingPercent: 90 }] })
  };

  const svc = await createService({
    settingsPath: path.join(dir, 'settings.json'),
    providers: [provider]
  });

  assert.equal(svc.snapshot().settings.accounts.length, 2);

  // Simulate secondary profile deletion from disk
  discovered = [{ id: 'claude:default', providerId: 'claude', label: 'A', primary: true, enabled: true }];

  // Miss 1
  await svc.reconcileDiscovery();
  assert.equal(svc.snapshot().settings.accounts.length, 2); // Tombstone: still retained

  // Miss 2
  await svc.reconcileDiscovery();
  assert.equal(svc.snapshot().settings.accounts.length, 2); // Tombstone: still retained

  // Miss 3: Now removed
  await svc.reconcileDiscovery();
  assert.equal(svc.snapshot().settings.accounts.length, 1);
  assert.equal(svc.snapshot().settings.accounts[0].id, 'claude:default');
});

// Kusur 5: Empty/Invalid Response vs no_limits_reported
test('Kusur 5: empty raw responses throw invalid_response while valid limit-free schemas produce no_limits_reported', () => {
  const { parseCursorUsage } = require('../src/providers/cursor.cjs');
  const { parseCodexRateLimits } = require('../src/providers/codex.cjs');

  // Empty object without schema fields fails closed with invalid_response
  assert.throws(() => parseCursorUsage({}), /invalid_response/);
  assert.throws(() => parseCodexRateLimits(null), /invalid_response/);
  assert.throws(() => parseCodexRateLimits({}), /invalid_response/);

  // Valid schema with empty limits returns no_limits_reported
  const cursorNoLimits = parseCursorUsage({ membershipType: 'enterprise', individualUsage: {} });
  assert.equal(cursorNoLimits.status, 'no_limits_reported');
  assert.equal(cursorNoLimits.windows.length, 0);

  const codexNoLimits = parseCodexRateLimits({ rateLimitsByLimitId: {} });
  assert.equal(codexNoLimits.status, 'no_limits_reported');
  assert.equal(codexNoLimits.windows.length, 0);
});

// Kusur 6: macOS Claude Keychain Selector
test('Kusur 6: configDirExplicit is preserved and resolves distinct keychain services', async () => {
  const { readClaudeKeychain } = require('../src/providers/claude-keychain.cjs');
  const calls = [];

  const runProcess = async (bin, args) => {
    calls.push(args[2]); // service argument
    return JSON.stringify({ claudeAiOauth: { accessToken: 'fixture' } });
  };

  // Unset default config resolves to un-suffixed service
  await readClaudeKeychain({
    platform: 'darwin',
    configDir: '/Users/example/.claude',
    configDirExplicit: false,
    runProcess
  });
  assert.equal(calls.at(-1), 'Claude Code-credentials');

  // Explicit default config resolves to suffixed service
  await readClaudeKeychain({
    platform: 'darwin',
    configDir: '/Users/example/.claude',
    configDirExplicit: true,
    runProcess
  });
  assert.equal(calls.at(-1), 'Claude Code-credentials-402b469b');
});

// Helper for deterministic async racing tests without setTimeout
function createDeferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// Claude Round 2 Blocking Finding B1: Provider-scoped generation
test('Claude B1: Provider-scoped generation prevents concurrent refreshes from discarding results', async t => {
  const { createService } = require('../src/core/service.cjs');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-b1-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const defClaude = createDeferred();
  const defCodex = createDeferred();

  const claudeProvider = {
    id: 'claude',
    name: 'Claude',
    discover: async () => [{ id: 'claude:default', providerId: 'claude', label: 'Claude', primary: true, enabled: true }],
    fetch: () => defClaude.promise
  };

  const codexProvider = {
    id: 'codex',
    name: 'Codex',
    discover: async () => [{ id: 'codex:default', providerId: 'codex', label: 'Codex', primary: true, enabled: true }],
    fetch: () => defCodex.promise
  };

  const svc = await createService({
    settingsPath: path.join(dir, 'settings.json'),
    providers: [claudeProvider, codexProvider]
  });

  // Start Claude refresh first (in-flight)
  const pClaude = svc.refresh('claude');

  // Start Codex refresh while Claude is in-flight (bumps global or codex gen)
  const pCodex = svc.refresh('codex');

  // Resolve Claude first
  defClaude.resolve({ windows: [{ id: 'five_hour', remainingPercent: 88 }] });
  await pClaude;

  // Claude result MUST NOT have been discarded by Codex starting!
  const snap1 = svc.snapshot();
  const claudeAcc = snap1.providers.find(p => p.id === 'claude').accounts[0];
  assert.equal(claudeAcc.status, 'ok');
  assert.equal(claudeAcc.windows[0].remainingPercent, 88);

  // Resolve Codex
  defCodex.resolve({ windows: [{ id: 'primary', remainingPercent: 72 }] });
  await pCodex;

  const snap2 = svc.snapshot();
  const codexAcc = snap2.providers.find(p => p.id === 'codex').accounts[0];
  assert.equal(codexAcc.status, 'ok');
  assert.equal(codexAcc.windows[0].remainingPercent, 72);
});

// Claude Round 2 Blocking Finding B4: Zombie account resurrection prevention
test('Claude B4: Settings changes during in-flight fetch prevent zombie account resurrection', async t => {
  const { createService } = require('../src/core/service.cjs');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-b4-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const defA = createDeferred();
  const defB = createDeferred();

  const provider = {
    id: 'claude',
    name: 'Claude',
    discover: async () => [
      { id: 'claude:a', providerId: 'claude', label: 'Account A', configDir: '/dir/a', primary: true, enabled: true },
      { id: 'claude:b', providerId: 'claude', label: 'Account B', configDir: '/dir/b', primary: false, enabled: true }
    ],
    fetch: async (acc) => {
      if (acc.id === 'claude:a') return defA.promise;
      if (acc.id === 'claude:b') return defB.promise;
      throw new Error('unknown_account');
    }
  };

  const svc = await createService({
    settingsPath: path.join(dir, 'settings.json'),
    providers: [provider]
  });

  assert.equal(svc.snapshot().settings.accounts.length, 2);

  // Start refresh for claude (both A and B are in-flight)
  const pRefresh = svc.refresh('claude');

  // User deletes Account B during in-flight fetch
  await svc.updateSettings({
    accounts: [{ id: 'claude:a', providerId: 'claude', label: 'Account A', configDir: '/dir/a', primary: true, enabled: true }]
  });

  // Verify settings has only A
  assert.equal(svc.snapshot().settings.accounts.length, 1);

  // Now resolve both fetches
  defA.resolve({ windows: [{ id: 'five_hour', remainingPercent: 95 }] });
  defB.resolve({ windows: [{ id: 'five_hour', remainingPercent: 10 }] });
  await pRefresh;

  // Account B MUST NOT be resurrected in settings or provider accounts!
  const finalSnap = svc.snapshot();
  assert.equal(finalSnap.settings.accounts.length, 1);
  assert.equal(finalSnap.settings.accounts[0].id, 'claude:a');
  const providerAccounts = finalSnap.providers.find(p => p.id === 'claude').accounts;
  assert.equal(providerAccounts.length, 1);
  assert.equal(providerAccounts[0].id, 'claude:a');
  assert.equal(providerAccounts[0].status, 'ok');
});

// Claude Round 2 Blocking Finding B5: Discovery reconciliation error safety and user customization
test('Claude B5: reconcileDiscovery does not increment misses on error and preserves user customizations', async t => {
  const { createService } = require('../src/core/service.cjs');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-b5-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  let failDiscovery = false;
  let discovered = [
    { id: 'claude:a', providerId: 'claude', label: 'Discovered A', primary: true, enabled: true },
    { id: 'claude:b', providerId: 'claude', label: 'Discovered B', primary: false, enabled: true }
  ];

  const provider = {
    id: 'claude',
    name: 'Claude',
    discover: async () => {
      if (failDiscovery) throw new Error('EACCES: keychain locked');
      return discovered;
    },
    fetch: async () => ({ windows: [{ id: 'five_hour', remainingPercent: 90 }] })
  };

  const svc = await createService({
    settingsPath: path.join(dir, 'settings.json'),
    providers: [provider]
  });

  assert.equal(svc.snapshot().settings.accounts.length, 2);

  // User customizes label of Account B -> origin becomes 'user'
  await svc.updateSettings({
    accounts: [
      { id: 'claude:a', providerId: 'claude', label: 'Discovered A', primary: true, enabled: true },
      { id: 'claude:b', providerId: 'claude', label: 'Custom User Label B', primary: false, enabled: true }
    ]
  });

  const customizedAcc = svc.snapshot().settings.accounts.find(a => a.id === 'claude:b');
  assert.equal(customizedAcc.origin, 'user');

  // Simulate 5 transient discovery failures (e.g. keychain locked for 5 minutes)
  failDiscovery = true;
  for (let i = 0; i < 5; i++) {
    await svc.reconcileDiscovery();
  }
  // No accounts should have been deleted because discovery errored!
  assert.equal(svc.snapshot().settings.accounts.length, 2);

  // Now discovery succeeds, but neither account is reported by discover()
  failDiscovery = false;
  discovered = [];

  // Run 3 clean discovery cycles
  await svc.reconcileDiscovery(); // miss 1
  assert.equal(svc.snapshot().settings.accounts.length, 2);
  await svc.reconcileDiscovery(); // miss 2
  assert.equal(svc.snapshot().settings.accounts.length, 2);
  await svc.reconcileDiscovery(); // miss 3

  // Account A (origin: 'discovered') is removed after 3 misses
  // Account B (origin: 'user') is PROTECTED and retained!
  const finalAccounts = svc.snapshot().settings.accounts;
  assert.equal(finalAccounts.length, 1);
  assert.equal(finalAccounts[0].id, 'claude:b');
  assert.equal(finalAccounts[0].label, 'Custom User Label B');
});

// Claude Round 2 Blocking Finding B6: Antigravity multi-server email grouping and atomic window merging
test('Claude B6: Antigravity multi-server separates accounts by email and merges windows atomically with reset precedence', async () => {
  const { createAntigravityProvider } = require('../src/providers/antigravity.cjs');

  const serverWork = { pid: 1001, csrfToken: 'tok1', ports: [4001], sourceKind: 'app' };
  const serverPersonal = { pid: 1002, csrfToken: 'tok2', ports: [4002], sourceKind: 'app' };

  // 1. Multi-account discovery test with distinct emails
  const multiProvider = createAntigravityProvider({
    platform: 'darwin',
    discoverAntigravityServers: async () => [serverWork, serverPersonal],
    requestLocalJson: async (server) => {
      if (server.pid === 1001) {
        return {
          userStatus: { email: 'work@corp.com' },
          groups: [{ id: 'cg', displayName: 'Claude and GPT', buckets: [{ bucketId: 'session', window: '5h', remainingFraction: 0.85 }] }]
        };
      }
      return {
        userStatus: { email: 'personal@gmail.com' },
        groups: [{ id: 'cg', displayName: 'Claude and GPT', buckets: [{ bucketId: 'session', window: '5h', remainingFraction: 0.15 }] }]
      };
    }
  });

  const discovered = await multiProvider.discover();
  assert.equal(discovered.length, 2);
  assert.equal(discovered[0].email, 'work@corp.com');
  assert.equal(discovered[1].email, 'personal@gmail.com');

  // Fetch for work account only gets work server quota
  const workQuota = await multiProvider.fetch({ id: 'antigravity:work@corp.com', email: 'work@corp.com' });
  assert.equal(workQuota.windows[0].remainingPercent, 85);

  // 2. Atomic window merging test: server A has fresher resetTime (future period), server B has stale 5% cache
  const serverFresh = { pid: 2001, csrfToken: 'fresh', ports: [5001], sourceKind: 'ide' };
  const serverStale = { pid: 2002, csrfToken: 'stale', ports: [5002], sourceKind: 'app' };

  const mergeProvider = createAntigravityProvider({
    platform: 'darwin',
    discoverAntigravityServers: async () => [serverFresh, serverStale],
    requestLocalJson: async (server) => {
      if (server.pid === 2001) {
        // Fresh reset window: next week, 95% remaining
        return {
          userStatus: { email: 'same@user.com' },
          groups: [{
            id: 'cg',
            displayName: 'Claude and GPT',
            buckets: [{
              bucketId: 'session',
              window: '5h',
              remainingFraction: 0.95,
              resetTime: '2026-10-23T18:00:00Z'
            }]
          }]
        };
      }
      // Stale cache prior to reset: last week, 5% remaining
      return {
        userStatus: { email: 'same@user.com' },
        groups: [{
          id: 'cg',
          displayName: 'Claude and GPT',
          buckets: [{
            bucketId: 'session',
            window: '5h',
            remainingFraction: 0.05,
            resetTime: '2026-10-16T18:00:00Z'
          }]
        }]
      };
    }
  });

  const merged = await mergeProvider.fetch({ id: 'antigravity:current' });
  assert.equal(merged.windows.length, 1);
  // Must choose the fresher resetTime (2026-10-23) atomically with its 95% quota, NOT the stale 5%!
  assert.equal(merged.windows[0].remainingPercent, 95);
  assert.equal(merged.windows[0].resetsAt, new Date('2026-10-23T18:00:00Z').toISOString());
});

// Claude Round 2 Blocking Finding B7: Cloud credentials blocked, configDirExplicit unsetting, settings warnings
test('Claude B7: cleanEnvironment blocks cloud/codex variables and launchWarnings checks setting files and helpers', () => {
  const { cleanEnvironment } = require('../src/providers/common.cjs');
  const { launchEnvironment, launchWarnings } = require('../src/core/launcher.cjs');

  const dirty = {
    AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE',
    aws_secret_access_key: 'secret',
    CLAUDE_CODE_USE_BEDROCK: '1',
    claude_code_use_vertex: '1',
    ANTHROPIC_VERTEX_PROJECT_ID: 'my-project',
    CODEX_HOME: '/opt/codex',
    openai_base_url: 'https://proxy.example',
    CLAUDE_CONFIG_DIR: '/custom/claude',
    claude_config_dir: '/custom/claude-lower',
    KEEP_VAR: 'safe'
  };

  // win32 cleanEnvironment deletes all case-insensitively from inherited source
  const cleanedWin = cleanEnvironment({}, 'win32', dirty);
  assert.equal(cleanedWin.AWS_ACCESS_KEY_ID, undefined);
  assert.equal(cleanedWin.aws_secret_access_key, undefined);
  assert.equal(cleanedWin.CLAUDE_CODE_USE_BEDROCK, undefined);
  assert.equal(cleanedWin.claude_code_use_vertex, undefined);
  assert.equal(cleanedWin.ANTHROPIC_VERTEX_PROJECT_ID, undefined);
  assert.equal(cleanedWin.CODEX_HOME, undefined);
  assert.equal(cleanedWin.openai_base_url, undefined);
  assert.equal(cleanedWin.KEEP_VAR, 'safe');
  assert.equal(cleanEnvironment({ CODEX_HOME: '/explicit/codex' }, 'win32', dirty).CODEX_HOME, '/explicit/codex');

  // launchEnvironment unsets CLAUDE_CONFIG_DIR when configDirExplicit is false or default
  const launchedExplicitFalse = launchEnvironment({ id: 'claude:custom', configDir: '/some/dir', configDirExplicit: false }, dirty, 'darwin');
  assert.equal(launchedExplicitFalse.CLAUDE_CONFIG_DIR, undefined);

  // launchWarnings warns on localSettings and apiKeyHelper
  const snapshot = {
    providers: [{ id: 'claude', accounts: [{ id: 'claude:default', status: 'ok', fetchedAt: new Date().toISOString(), windows: [{ id: 'five_hour', remainingPercent: 50 }, { id: 'seven_day', remainingPercent: 50 }] }] }],
    settings: { accounts: [{ id: 'claude:default', providerId: 'claude', primary: true, enabled: true }] }
  };

  const warnLocal = launchWarnings(snapshot, { id: 'claude:default' }, {
    localSettings: { env: { AWS_ACCESS_KEY_ID: 'key' } }
  });
  assert.equal(warnLocal.some(w => w.includes('.claude/settings.local.json')), true);

  const warnHelper = launchWarnings(snapshot, { id: 'claude:default' }, {
    projectSettings: { apiKeyHelper: '/bin/get-key.sh' }
  });
  assert.equal(warnHelper.some(w => w.includes('apiKeyHelper')), true);
});

// Claude Round 2 Finding: Read-Only Verification (Zero FS Writes During Quota Check)
test('Claude Round 2 Guarantee: Quota monitoring performs zero filesystem writes or token modifications', async t => {
  const { createClaudeProvider } = require('../src/providers/claude.cjs');
  let writeCount = 0;

  // Intercept write calls
  const originalWriteFile = fs.writeFile;
  const originalAppendFile = fs.appendFile;
  fs.writeFile = async (...args) => { writeCount++; return originalWriteFile.apply(fs, args); };
  fs.appendFile = async (...args) => { writeCount++; return originalAppendFile.apply(fs, args); };
  t.after(() => {
    fs.writeFile = originalWriteFile;
    fs.appendFile = originalAppendFile;
  });

  const provider = createClaudeProvider({
    platform: 'darwin',
    readCredentials: async () => ({ claudeAiOauth: { accessToken: 'mock-token', expiresAt: Date.now() + 3600000 } }),
    getJson: async () => ({ five_hour: { remaining_fraction: 0.9 } })
  });

  const result = await provider.fetch({ id: 'claude:default', configDir: '/tmp/.claude' });
  assert.equal(result.windows.length, 2);
  assert.equal(writeCount, 0, 'Quota fetch must NEVER write to filesystem or credentials store!');
});

// Claude Round 3 Blocking Finding R1: Closed app discovery failure never deletes accounts
test('Claude R1: Antigravity app closed error re-thrown during discover, preventing account deletion across 3+ cycles', async t => {
  const { createService } = require('../src/core/service.cjs');
  const { ProviderError } = require('../src/providers/common.cjs');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-r1-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  let appRunning = true;
  const antigravityProvider = {
    id: 'antigravity',
    name: 'Antigravity',
    discover: async () => {
      if (!appRunning) throw new ProviderError('app_closed');
      return [{ id: 'antigravity:work@corp.com', providerId: 'antigravity', label: 'Antigravity (work@corp.com)', email: 'work@corp.com', primary: true, enabled: true }];
    },
    fetch: async () => ({ windows: [{ id: '5h', remainingPercent: 90 }] })
  };

  const svc = await createService({
    settingsPath: path.join(dir, 'settings.json'),
    providers: [antigravityProvider]
  });

  assert.equal(svc.snapshot().settings.accounts.length, 1);
  assert.equal(svc.snapshot().settings.accounts[0].id, 'antigravity:work@corp.com');

  // App is now closed for 5 consecutive discovery cycles
  appRunning = false;
  for (let i = 0; i < 5; i++) {
    await svc.reconcileDiscovery();
  }

  // Account MUST NOT have been deleted after 5 cycles with app closed!
  const finalAccounts = svc.snapshot().settings.accounts;
  assert.equal(finalAccounts.length, 1);
  assert.equal(finalAccounts[0].id, 'antigravity:work@corp.com');
});

// Claude Round 3 Blocking Finding R2: Account count transition 1 -> 2 prevents quota mixing
test('Claude R2: Transition from 1 to 2 accounts prevents cross-account quota pollution', async () => {
  const { createAntigravityProvider, antigravityAccountId } = require('../src/providers/antigravity.cjs');

  const serverWork = { pid: 101, csrfToken: 'tok1', ports: [6101], sourceKind: 'ide' };
  const serverPersonal = { pid: 102, csrfToken: 'tok2', ports: [6102], sourceKind: 'app' };

  // 1. Initial state: only 1 server (work@corp.com) running
  const provider = createAntigravityProvider({
    platform: 'darwin',
    discoverAntigravityServers: async () => [serverWork, serverPersonal],
    requestLocalJson: async (server) => {
      if (server.pid === 101) {
        return {
          userStatus: { email: 'work@corp.com' },
          groups: [{ id: 'cg', displayName: 'Claude and GPT', buckets: [{ bucketId: 'session', window: '5h', remainingFraction: 0.90 }] }]
        };
      }
      return {
        userStatus: { email: 'personal@gmail.com' },
        groups: [{ id: 'cg', displayName: 'Claude and GPT', buckets: [{ bucketId: 'session', window: '5h', remainingFraction: 0.10 }] }]
      };
    }
  });

  // Discovery returns stable IDs with email
  const accounts = await provider.discover();
  assert.equal(accounts.length, 2);
  assert.equal(accounts[0].id, antigravityAccountId('work@corp.com'));
  assert.equal(accounts[1].id, antigravityAccountId('personal@gmail.com'));

  // Fetch for work account returns strictly work quota (90%), never polluted by personal (10%)
  const workQuota = await provider.fetch({ id: antigravityAccountId('work@corp.com'), email: 'work@corp.com' });
  assert.equal(workQuota.windows[0].remainingPercent, 90);

  // Ambiguity protection: fetching a legacy account without email refuses to merge multiple accounts
  await assert.rejects(
    () => provider.fetch({ id: 'antigravity:current' }),
    /unsupported_profile/
  );
});

// Claude Round 3 Blocking Finding R3: Serialized reconcileDiscovery and dismissedAccountIds
test('Claude R3: Discovery and updateSettings are serialized via pendingSave and dismissed accounts are not resurrected', async t => {
  const { createService } = require('../src/core/service.cjs');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-r3-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  let discovered = [
    { id: 'claude:a', providerId: 'claude', label: 'Discovered A', primary: true, enabled: true },
    { id: 'claude:b', providerId: 'claude', label: 'Discovered B', primary: false, enabled: true }
  ];

  const provider = {
    id: 'claude',
    name: 'Claude',
    discover: async () => discovered,
    fetch: async () => ({ windows: [{ id: '5h', remainingPercent: 90 }] })
  };

  const svc = await createService({
    settingsPath: path.join(dir, 'settings.json'),
    providers: [provider]
  });

  assert.equal(svc.snapshot().settings.accounts.length, 2);

  // User deletes Account B via dismissAccount concurrently with reconcileDiscovery
  const p1 = svc.dismissAccount('claude:b');
  const p2 = svc.reconcileDiscovery();

  await Promise.all([p1, p2]);

  // Account B must be in dismissedAccountIds and NOT resurrected in settings.accounts!
  const snap = svc.snapshot();
  assert.equal(snap.settings.accounts.length, 1);
  assert.equal(snap.settings.accounts[0].id, 'claude:a');
  assert.equal(snap.settings.dismissedAccountIds.includes('claude:b'), true);

  // Run another discovery cycle where discover() still sees Account B on disk
  await svc.reconcileDiscovery();
  const snapAfter = svc.snapshot();
  assert.equal(snapAfter.settings.accounts.length, 1);
  assert.equal(snapAfter.settings.accounts[0].id, 'claude:a');
});

// Claude Round 3 Blocking Finding R4: User preferences (origin, enabled, order) persist across cold restarts
test('Claude R4: origin: user and enabled: false persist across restart and are never auto-deleted', async t => {
  const { createService } = require('../src/core/service.cjs');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-r4-'));
  const settingsPath = path.join(dir, 'settings.json');
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  let discovered = [
    { id: 'claude:a', providerId: 'claude', label: 'Discovered A', primary: true, enabled: true },
    { id: 'claude:b', providerId: 'claude', label: 'Discovered B', primary: false, enabled: true }
  ];

  const provider = {
    id: 'claude',
    name: 'Claude',
    discover: async () => discovered,
    fetch: async () => ({ windows: [{ id: '5h', remainingPercent: 90 }] })
  };

  const svc1 = await createService({ settingsPath, providers: [provider] });

  // User customizes: disables account B and changes label
  await svc1.updateSettings({
    accounts: [
      { id: 'claude:a', providerId: 'claude', label: 'Discovered A', primary: true, enabled: true },
      { id: 'claude:b', providerId: 'claude', label: 'My Disabled Account B', primary: false, enabled: false }
    ]
  });

  const snap1 = svc1.snapshot();
  const accB1 = snap1.settings.accounts.find(a => a.id === 'claude:b');
  assert.equal(accB1.origin, 'user');
  assert.equal(accB1.enabled, false);

  // Cold restart: create brand new service loading from the same settingsPath
  discovered = []; // No accounts discovered on disk
  const svc2 = await createService({ settingsPath, providers: [provider] });

  const snap2 = svc2.snapshot();
  const accB2 = snap2.settings.accounts.find(a => a.id === 'claude:b');
  assert.equal(accB2.origin, 'user');
  assert.equal(accB2.enabled, false);
  assert.equal(accB2.label, 'My Disabled Account B');

  // Run 3 clean misses of discovery where discover() returns empty
  await svc2.reconcileDiscovery(); // miss 1
  await svc2.reconcileDiscovery(); // miss 2
  await svc2.reconcileDiscovery(); // miss 3

  // Account A (discovered) was deleted after 3 misses
  // Account B (user + disabled) is 100% retained!
  const finalAccounts = svc2.snapshot().settings.accounts;
  assert.equal(finalAccounts.length, 1);
  assert.equal(finalAccounts[0].id, 'claude:b');
  assert.equal(finalAccounts[0].enabled, false);
});

// Claude Round 4 Verification: R2 legacy migration from antigravity:current to antigravity:${hash}
test('Claude R2: legacy antigravity:current seamlessly migrates to antigravity:${hash} while preserving user customizations', async t => {
  const { createService } = require('../src/core/service.cjs');
  const { antigravityAccountId } = require('../src/providers/antigravity.cjs');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-r2-migration-'));
  const settingsPath = path.join(dir, 'settings.json');
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  // Existing settings file with legacy antigravity:current customized by user
  const initialSettings = {
    pinned: false,
    intervalSeconds: 60,
    accounts: [
      {
        id: 'antigravity:current',
        providerId: 'antigravity',
        label: 'My Work Antigravity',
        origin: 'user',
        primary: true,
        enabled: true
      }
    ],
    dismissedAccountIds: []
  };
  await fs.writeFile(settingsPath, JSON.stringify(initialSettings, null, 2), 'utf-8');

  const targetId = antigravityAccountId('dev@company.com');
  const provider = {
    id: 'antigravity',
    name: 'Antigravity',
    discover: async () => [
      {
        id: targetId,
        providerId: 'antigravity',
        email: 'dev@company.com',
        label: 'dev@company.com',
        primary: false,
        enabled: true
      }
    ],
    fetch: async () => ({ windows: [{ id: 'gemini-session', remainingPercent: 85 }] })
  };

  const svc = await createService({ settingsPath, providers: [provider] });

  const snap1 = svc.snapshot();
  assert.equal(snap1.settings.accounts.length, 1);
  const migrated = snap1.settings.accounts[0];
  assert.equal(migrated.id, targetId);
  assert.equal(migrated.email, 'dev@company.com');
  assert.equal(migrated.label, 'My Work Antigravity'); // User custom label preserved!
  assert.equal(migrated.origin, 'user'); // User origin preserved!
  assert.equal(migrated.primary, true); // User primary preserved!
  assert.equal(migrated.enabled, true);

  // Subsequent reconciliation keeps migrated account stable
  await svc.reconcileDiscovery();
  const snap2 = svc.snapshot();
  assert.equal(snap2.settings.accounts.length, 1);
  assert.equal(snap2.settings.accounts[0].id, targetId);
  assert.equal(snap2.settings.accounts[0].label, 'My Work Antigravity');
});

// Claude Round 4 Blocking Finding E1: Dismissed accounts persist across cold restarts
test('Claude E1: Dismissed accounts persist across cold restarts and are never auto-re-added by discovery', async t => {
  const { createService } = require('../src/core/service.cjs');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-e1-'));
  const settingsPath = path.join(dir, 'settings.json');
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  let discovered = [
    { id: 'claude:acc1', providerId: 'claude', label: 'Claude Account 1', primary: true, enabled: true },
    { id: 'claude:acc2', providerId: 'claude', label: 'Claude Account 2', primary: false, enabled: true }
  ];

  const provider = {
    id: 'claude',
    name: 'Claude',
    discover: async () => discovered,
    fetch: async () => ({ windows: [{ id: '5h', remainingPercent: 90 }] })
  };

  // 1. Initial service start discovers 2 accounts
  const svc1 = await createService({ settingsPath, providers: [provider] });
  assert.equal(svc1.snapshot().settings.accounts.length, 2);

  // User dismisses Account 2
  await svc1.dismissAccount('claude:acc2');
  assert.equal(svc1.snapshot().settings.accounts.length, 1);
  assert.equal(svc1.snapshot().settings.accounts[0].id, 'claude:acc1');

  // 2. Cold restart: instantiate brand-new service loading from the exact same settingsPath
  // Even though discover() still returns Account 2 on disk:
  const svc2 = await createService({ settingsPath, providers: [provider] });
  const snapAfterRestart = svc2.snapshot();
  assert.equal(snapAfterRestart.settings.accounts.length, 1);
  assert.equal(snapAfterRestart.settings.accounts[0].id, 'claude:acc1');
  assert.equal(snapAfterRestart.settings.dismissedAccountIds.includes('claude:acc2'), true);

  // Run 3 consecutive reconciliation cycles
  await svc2.reconcileDiscovery();
  await svc2.reconcileDiscovery();
  await svc2.reconcileDiscovery();

  const finalSnap = svc2.snapshot();
  assert.equal(finalSnap.settings.accounts.length, 1);
  assert.equal(finalSnap.settings.accounts[0].id, 'claude:acc1');
});

// Claude Round 4 Blocking Finding E2: Email with '+' character and long email bounds validation
test('Claude E2: Email with + character (user+tag@gmail.com) and long email validate cleanly without crash', async t => {
  const { createService } = require('../src/core/service.cjs');
  const { createAntigravityProvider, antigravityAccountId } = require('../src/providers/antigravity.cjs');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-e2-'));
  const settingsPath = path.join(dir, 'settings.json');
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const plusEmail = 'user+tag@domain.com';
  const longEmail = 'extremely.long.corporate.work.user.email.address.that.exceeds.sixty.seven.characters@very.long.subdomain.enterprise.company.com';

  const server1 = { pid: 701, csrfToken: 'tok1', ports: [7101], sourceKind: 'ide' };
  const server2 = { pid: 702, csrfToken: 'tok2', ports: [7102], sourceKind: 'app' };

  const provider = createAntigravityProvider({
    platform: 'darwin',
    discoverAntigravityServers: async () => [server1, server2],
    requestLocalJson: async (server, port, method) => {
      if (server.pid === 701) {
        return { userStatus: { email: plusEmail }, groups: [{ id: 'cg', displayName: 'Claude and GPT', buckets: [{ bucketId: 'session', window: '5h', remainingFraction: 0.90 }] }] };
      }
      return { userStatus: { email: longEmail }, groups: [{ id: 'cg', displayName: 'Claude and GPT', buckets: [{ bucketId: 'session', window: '5h', remainingFraction: 0.80 }] }] };
    }
  });

  // Verify discover() returns sanitized 28-char IDs matching regex and labels clamped to <= 80 chars
  const discovered = await provider.discover();
  assert.equal(discovered.length, 2);
  for (const acc of discovered) {
    assert.match(acc.id, /^antigravity:[0-9a-f]{16}$/);
    assert.ok(acc.label.length <= 80);
  }
  assert.equal(discovered[0].id, antigravityAccountId(plusEmail));
  assert.equal(discovered[1].id, antigravityAccountId(longEmail));

  // Service initializes cleanly with these accounts and validates settings without crash
  const svc = await createService({ settingsPath, providers: [provider] });
  const accounts = svc.snapshot().settings.accounts;
  assert.equal(accounts.length, 2);
  assert.equal(accounts[0].id, antigravityAccountId(plusEmail));
  assert.equal(accounts[0].email, plusEmail.toLowerCase());
  assert.equal(accounts[1].id, antigravityAccountId(longEmail));
  assert.equal(accounts[1].email, longEmail.toLowerCase());
});

// Claude Round 4 Blocking Finding E3: Identity-free RetrieveUserQuotaSummary relies on GetUserStatus pid->email mapping
test('Claude E3: Quota summary without identity relies on pid->email mapping via GetUserStatus', async () => {
  const { createAntigravityProvider, antigravityAccountId } = require('../src/providers/antigravity.cjs');

  const serverWork = { pid: 801, csrfToken: 'tok1', ports: [8101], sourceKind: 'ide' };
  const serverPersonal = { pid: 802, csrfToken: 'tok2', ports: [8102], sourceKind: 'app' };

  const provider = createAntigravityProvider({
    platform: 'darwin',
    discoverAntigravityServers: async () => [serverWork, serverPersonal],
    requestLocalJson: async (server, port, method) => {
      // GetUserStatus reports identity
      if (method === 'GetUserStatus') {
        if (server.pid === 801) return { code: 'ok', userStatus: { email: 'work@corp.com' } };
        if (server.pid === 802) return { code: 'ok', userStatus: { email: 'personal@gmail.com' } };
      }
      // RetrieveUserQuotaSummary has NO email field whatsoever ("summary without identity")
      if (method === 'RetrieveUserQuotaSummary') {
        if (server.pid === 801) {
          return { code: 'ok', groups: [{ id: 'cg', displayName: 'Claude and GPT', buckets: [{ bucketId: 'session', window: '5h', remainingFraction: 0.92 }] }] };
        }
        if (server.pid === 802) {
          return { code: 'ok', groups: [{ id: 'cg', displayName: 'Claude and GPT', buckets: [{ bucketId: 'session', window: '5h', remainingFraction: 0.22 }] }] };
        }
      }
      throw new Error('unexpected_method');
    }
  });

  const targetWorkId = antigravityAccountId('work@corp.com');
  const workQuota = await provider.fetch({ id: targetWorkId, email: 'work@corp.com' });
  assert.equal(workQuota.windows[0].remainingPercent, 92);

  const targetPersonalId = antigravityAccountId('personal@gmail.com');
  const personalQuota = await provider.fetch({ id: targetPersonalId, email: 'personal@gmail.com' });
  assert.equal(personalQuota.windows[0].remainingPercent, 22);

  // An account with nonexistent email correctly throws auth_missing
  await assert.rejects(
    () => provider.fetch({ id: antigravityAccountId('other@unknown.com'), email: 'other@unknown.com' }),
    /auth_missing/
  );
});

// Claude Round 4 Blocking Finding E4: Running servers with unreadable identity do not delete existing accounts
test('Claude E4: Running servers with unreadable identity do not delete existing accounts across 5 cycles', async t => {
  const { createService } = require('../src/core/service.cjs');
  const { antigravityAccountId } = require('../src/providers/antigravity.cjs');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-e4-'));
  const settingsPath = path.join(dir, 'settings.json');
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const targetId = antigravityAccountId('dev@company.com');
  // Initial settings with dev@company.com configured
  const initialSettings = {
    pinned: false,
    intervalSeconds: 60,
    accounts: [
      {
        id: targetId,
        providerId: 'antigravity',
        label: 'Antigravity (dev@company.com)',
        email: 'dev@company.com',
        origin: 'discovered',
        primary: true,
        enabled: true
      }
    ],
    dismissedAccountIds: []
  };
  await fs.writeFile(settingsPath, JSON.stringify(initialSettings, null, 2), 'utf-8');

  // Server is running (pid 901) but GetUserStatus fails (rate limited or server startup)
  let statusFails = true;
  const provider = {
    id: 'antigravity',
    name: 'Antigravity',
    discover: async () => {
      if (statusFails) {
        // E4: discoverAntigravityServers found servers, but identity read failed -> throws local_service_unavailable
        const { ProviderError } = require('../src/providers/common.cjs');
        throw new ProviderError('local_service_unavailable');
      }
      return [{ id: targetId, providerId: 'antigravity', email: 'dev@company.com', label: 'Antigravity (dev@company.com)', primary: true, enabled: true }];
    },
    fetch: async () => ({ windows: [{ id: '5h', remainingPercent: 90 }] })
  };

  const svc = await createService({ settingsPath, providers: [provider] });

  // Run 5 consecutive discovery reconciliation cycles while identity reading is failing
  for (let i = 0; i < 5; i++) {
    await svc.reconcileDiscovery();
  }

  // dev@company.com account MUST NOT have been deleted, and no zombie antigravity:current was added!
  const snap = svc.snapshot();
  assert.equal(snap.settings.accounts.length, 1);
  assert.equal(snap.settings.accounts[0].id, targetId);
  assert.equal(snap.settings.accounts[0].email, 'dev@company.com');
});

// Claude Round 4 Finding Y1: updateSettings does not infer deletion; dismissAccount is explicit
test('Claude Y1: updateSettings does not infer deletion and dismissAccount is explicit', async t => {
  const { createService } = require('../src/core/service.cjs');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-y1-'));
  const settingsPath = path.join(dir, 'settings.json');
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  let discovered = [
    { id: 'claude:a', providerId: 'claude', label: 'Claude A', primary: true, enabled: true },
    { id: 'claude:b', providerId: 'claude', label: 'Claude B', primary: false, enabled: true }
  ];

  const provider = {
    id: 'claude',
    name: 'Claude',
    discover: async () => discovered,
    fetch: async () => ({ windows: [{ id: '5h', remainingPercent: 90 }] })
  };

  const svc = await createService({ settingsPath, providers: [provider] });
  assert.equal(svc.snapshot().settings.accounts.length, 2);

  // UI saves settings from an older snapshot that only has Account A (e.g. user editing label)
  await svc.updateSettings({
    accounts: [{ id: 'claude:a', providerId: 'claude', label: 'Claude A Custom Label', primary: true, enabled: true }]
  });

  // Account B was NOT put into dismissedAccountIds!
  assert.equal(svc.snapshot().settings.dismissedAccountIds.includes('claude:b'), false);

  // Background discovery reconciles and safely re-attaches Account B
  await svc.reconcileDiscovery();
  const snap = svc.snapshot();
  assert.equal(snap.settings.accounts.length, 2);
  assert.equal(snap.settings.accounts.some(a => a.id === 'claude:b'), true);

  // Only explicit dismissAccount permanently dismisses Account B
  await svc.dismissAccount('claude:b');
  assert.equal(svc.snapshot().settings.dismissedAccountIds.includes('claude:b'), true);
  await svc.reconcileDiscovery();
  assert.equal(svc.snapshot().settings.accounts.length, 1);
  assert.equal(svc.snapshot().settings.accounts[0].id, 'claude:a');
});

// Claude Round 4 Finding Y2: loadClaudeSettingsFiles reads real disk files and triggers launchWarnings
test('Claude Y2: loadClaudeSettingsFiles reads real disk files and triggers launchWarnings', async t => {
  const { loadClaudeSettingsFiles, launchWarnings } = require('../src/core/launcher.cjs');
  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-y2-proj-'));
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-y2-cfg-'));
  t.after(async () => {
    await fs.rm(projectDir, { recursive: true, force: true });
    await fs.rm(configDir, { recursive: true, force: true });
  });

  // Create real .claude/settings.json in projectDir with AWS override
  await fs.mkdir(path.join(projectDir, '.claude'), { recursive: true });
  await fs.writeFile(
    path.join(projectDir, '.claude', 'settings.json'),
    JSON.stringify({ env: { AWS_ACCESS_KEY_ID: 'real-override' } }),
    'utf-8'
  );

  // Create real settings.json in configDir with apiKeyHelper
  await fs.writeFile(
    path.join(configDir, 'settings.json'),
    JSON.stringify({ apiKeyHelper: '/usr/local/bin/token-helper' }),
    'utf-8'
  );

  const files = await loadClaudeSettingsFiles(projectDir, configDir);
  assert.equal(files.projectSettings.env.AWS_ACCESS_KEY_ID, 'real-override');
  assert.equal(files.userSettings.apiKeyHelper, '/usr/local/bin/token-helper');

  const snapshot = {
    providers: [{ id: 'claude', accounts: [{ id: 'claude:default', status: 'ok', fetchedAt: new Date().toISOString(), windows: [{ id: 'five_hour', remainingPercent: 50 }, { id: 'seven_day', remainingPercent: 50 }] }] }],
    settings: { accounts: [{ id: 'claude:default', providerId: 'claude', primary: true, enabled: true }] }
  };

  const warnings = launchWarnings(snapshot, { id: 'claude:default' }, files);
  assert.ok(warnings.some(w => w.includes('.claude/settings.json')));
  assert.ok(warnings.some(w => w.includes('apiKeyHelper')));
});

// Claude Round 4 Finding Y3: macOS launcher script contains unset ANTHROPIC_BEDROCK_BASE_URL
test('Claude Y3: macOS launcher script contains unset ANTHROPIC_BEDROCK_BASE_URL', async t => {
  const launcherSrc = await fs.readFile(path.join(__dirname, '../src/core/launcher.cjs'), 'utf-8');
  assert.ok(launcherSrc.includes('unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_PROFILE CLAUDE_SECURESTORAGE_CONFIG_DIR CLAUDE_CODE_USE_BEDROCK CLAUDE_CODE_USE_VERTEX CLAUDE_CODE_USE_FOUNDRY ANTHROPIC_VERTEX_PROJECT_ID ANTHROPIC_BEDROCK_BASE_URL AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN'));
});

// Claude Round 5 Finding F1: Antigravity discover() fails closed on partial query failure
test('Claude F1: discover() fails closed when any running server fails GetUserStatus or returns no email', async () => {
  const { createAntigravityProvider } = require('../src/providers/antigravity.cjs');
  const server1 = { pid: 101, csrfToken: 'tok1', ports: [3101], sourceKind: 'app' };
  const server2 = { pid: 202, csrfToken: 'tok2', ports: [3202], sourceKind: 'ide' };

  const provider = createAntigravityProvider({
    platform: 'darwin',
    discoverAntigravityServers: async () => [server1, server2],
    requestLocalJson: async (server, port, method) => {
      if (server.pid === 101) return { userStatus: { email: 'user1@company.com' } };
      // Server 2 fails transport or returns no email
      throw new Error('connection_refused');
    }
  });

  await assert.rejects(
    async () => await provider.discover(),
    { code: 'local_service_unavailable' }
  );
});

// Claude Round 5 Finding F1: Antigravity accounts are exempt from miss-based deletion in reconcileDiscovery
test('Claude F1: reconcileDiscovery preserves Antigravity accounts when process is closed', async t => {
  const { createService } = require('../src/core/service.cjs');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-f1-antigravity-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const settingsPath = path.join(dir, 'settings.json');
  // Seed settings with an Antigravity account and a Claude account (both discovered)
  const initialSettings = {
    pinned: false,
    intervalSeconds: 120,
    accounts: [
      { id: 'antigravity:1234567890abcdef', providerId: 'antigravity', label: 'Antigravity IDE', primary: true, enabled: true, origin: 'discovered' },
      { id: 'claude:profile1', providerId: 'claude', configDir: path.join(dir, 'nonexistent'), label: 'Claude Old', primary: false, enabled: true, origin: 'discovered' }
    ]
  };
  await fs.writeFile(settingsPath, JSON.stringify(initialSettings), 'utf-8');

  // Claude discovers empty list (clean miss), Antigravity discovers empty list
  const service = await createService({
    settingsPath,
    providers: [
      { id: 'antigravity', name: 'Antigravity', discover: async () => [], fetch: async () => ({ windows: [] }) },
      { id: 'claude', name: 'Claude', discover: async () => [], fetch: async () => ({ windows: [] }) }
    ]
  });

  // Run 3 reconcileDiscovery cycles so Claude accumulates 3 consecutive clean misses
  await service.reconcileDiscovery();
  await service.reconcileDiscovery();
  await service.reconcileDiscovery();
  const accountsAfter = service.snapshot().settings.accounts;

  // Claude account should have been removed after 3rd clean miss
  assert.equal(accountsAfter.some(a => a.id === 'claude:profile1'), false);
  // Antigravity account must be PRESERVED because processes being closed is normal lifetime
  assert.equal(accountsAfter.some(a => a.id === 'antigravity:1234567890abcdef'), true);
});

// Claude Round 5 Finding F2: Multi-server fetch refuses to merge if any server has unresolvable email
test('Claude F2: fetch refuses to merge when multiple servers run and any server lacks verified identity', async () => {
  const { createAntigravityProvider } = require('../src/providers/antigravity.cjs');
  const server1 = { pid: 101, csrfToken: 'tok1', ports: [3101], sourceKind: 'app' };
  const server2 = { pid: 202, csrfToken: 'tok2', ports: [3202], sourceKind: 'ide' };

  const provider = createAntigravityProvider({
    platform: 'darwin',
    discoverAntigravityServers: async () => [server1, server2],
    requestLocalJson: async (server, port, method) => {
      if (server.pid === 101) {
        if (method === 'GetUserStatus') return { userStatus: { email: 'dev@company.com' } };
        return { groups: [{ id: 'claude-gpt', displayName: 'Claude and GPT', buckets: [{ bucketId: 'session', window: '5h', remainingFraction: 1.0 }] }] };
      }
      if (server.pid === 202) {
        // IDE responds with quota but GetUserStatus has no email
        if (method === 'GetUserStatus') return { userStatus: { email: null } };
        return { groups: [{ id: 'gemini', displayName: 'Gemini', buckets: [{ bucketId: 'weekly', window: 'weekly', remainingFraction: 0.9 }] }] };
      }
    }
  });

  // Multiple servers running, but one cannot resolve identity -> fail closed
  await assert.rejects(
    async () => await provider.fetch({ id: 'antigravity:current' }),
    { code: 'local_service_unavailable' }
  );
});

// Claude Round 5 Finding F2: fetchServerWindows continues port loop if first port lacks email
test('Claude F2: fetchServerWindows checks subsequent ports if first port has no email', async () => {
  const { createAntigravityProvider } = require('../src/providers/antigravity.cjs');
  // Server with two ports: port 3101 has no email, port 3102 has email
  const server = { pid: 101, csrfToken: 'tok1', ports: [3101, 3102], sourceKind: 'app' };

  const provider = createAntigravityProvider({
    platform: 'darwin',
    discoverAntigravityServers: async () => [server],
    requestLocalJson: async (s, port, method) => {
      if (port === 3101) {
        if (method === 'GetUserStatus') return { userStatus: { email: null } };
        return { groups: [] };
      }
      if (port === 3102) {
        if (method === 'GetUserStatus') return { userStatus: { email: 'dev@test.com' } };
        return { groups: [{ id: 'claude-gpt', displayName: 'Claude and GPT', buckets: [{ bucketId: 'session', window: '5h', remainingFraction: 0.8 }] }] };
      }
    }
  });

  const result = await provider.fetch({ id: 'antigravity:current', email: 'dev@test.com' });
  assert.equal(result.windows.length, 1);
  assert.equal(result.windows[0].remainingPercent, 80);
});

// Claude Round 5 Finding F3: dismissAccount validation and UI dismissal lifecycle
test('Claude F3: dismissAccount validates id format, bounds dismissedAccountIds, and supports un-dismissing', async t => {
  const { createService } = require('../src/core/service.cjs');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-f3-dismiss-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const settingsPath = path.join(dir, 'settings.json');
  const service = await createService({
    settingsPath,
    providers: [
      { id: 'claude', name: 'Claude', discover: async () => [{ id: 'claude:valid1', providerId: 'claude', label: 'Valid 1', primary: true, enabled: true }], fetch: async () => ({ windows: [] }) }
    ]
  });
  await service.reconcileDiscovery();

  // Test invalid account ID rejection in service
  await assert.rejects(
    async () => await service.dismissAccount('invalid account with spaces!'),
    /invalid_account/
  );

  // Verify account was discovered with origin: 'discovered'
  const beforeDismiss = service.snapshot().settings.accounts;
  assert.equal(beforeDismiss.find(a => a.id === 'claude:valid1')?.origin, 'discovered');

  // Dismiss valid account
  await service.dismissAccount('claude:valid1');
  let snapshot = service.snapshot();
  assert.ok(snapshot.settings.dismissedAccountIds.includes('claude:valid1'));
  assert.equal(snapshot.settings.accounts.some(a => a.id === 'claude:valid1'), false);

  // Dismissed accounts bounded to 100 entries
  const hundredIds = Array.from({ length: 110 }, (_, i) => `claude:id_${i}`);
  await service.updateSettings({ dismissedAccountIds: hundredIds });
  snapshot = service.snapshot();
  assert.equal(snapshot.settings.dismissedAccountIds.length, 100);

  // Un-dismiss testing: simulate add-profile re-adding a dismissed account
  const currentDismissed = service.snapshot().settings.dismissedAccountIds;
  const nextDismissed = currentDismissed.filter(id => id !== 'claude:valid1');
  await service.updateSettings({
    dismissedAccountIds: nextDismissed,
    accounts: [...service.snapshot().settings.accounts, { id: 'claude:valid1', providerId: 'claude', label: 'Valid 1 Restored', primary: true, enabled: true }]
  });
  snapshot = service.snapshot();
  assert.equal(snapshot.settings.dismissedAccountIds.includes('claude:valid1'), false);
  assert.equal(snapshot.settings.accounts.some(a => a.id === 'claude:valid1'), true);

  // Test updateSettings preserves account origin when untouched
  // Re-add an account via discovery
  const discService = await createService({
    settingsPath: path.join(dir, 'settings2.json'),
    providers: [
      { id: 'claude', name: 'Claude', discover: async () => [{ id: 'claude:disc1', providerId: 'claude', label: 'D1', primary: true, enabled: true }], fetch: async () => ({ windows: [{ id: '5h', remainingPercent: 50 }] }) }
    ]
  });
  await discService.reconcileDiscovery();
  assert.equal(discService.snapshot().settings.accounts[0].origin, 'discovered');

  // Update settings without modifying label, primary, or position
  await discService.updateSettings({
    accounts: [{ id: 'claude:disc1', providerId: 'claude', label: 'D1', primary: true, enabled: true }]
  });
  assert.equal(discService.snapshot().settings.accounts[0].origin, 'discovered');
});

// Claude Round 6 Finding E1: cleanEnvironment preserves explicit CODEX_HOME and overrides
test('Claude E1: cleanEnvironment preserves explicit CODEX_HOME and overrides', () => {
  const { cleanEnvironment } = require('../src/providers/common.cjs');
  const res = cleanEnvironment({ CODEX_HOME: '/explicit/path' }, 'win32', { CODEX_HOME: '/inherited/path' });
  assert.equal(res.CODEX_HOME, '/explicit/path');
  assert.equal(cleanEnvironment({ CODEX_HOME: '/x' }).CODEX_HOME, '/x');
});

// Claude Round 6 Finding E2: defaultSettingsPath throws when NODE_TEST_CONTEXT is defined
test('Claude E2: defaultSettingsPath throws inside test runner to prevent overwriting user settings', () => {
  const { defaultSettingsPath } = require('../src/core/settings.cjs');
  assert.throws(
    () => defaultSettingsPath(),
    /test_suite_cannot_use_default_settings_path/
  );
});

// Claude Round 7 Ö1 / E4: resolveClaudeProfile pure function tests default, secondary, custom profiles and un-dismissing
test('Claude R7-Ö1: resolveClaudeProfile correctly resolves default, secondary, and custom directory profiles', () => {
  const { resolveClaudeProfile } = require('../src/core/launcher.cjs');
  const home = '/fake/home/user';

  // 1. Default directory resolves to claude:default with configDirExplicit: false and label: 'Hesap A'
  const def = resolveClaudeProfile(path.join(home, '.claude'), home);
  assert.equal(def.id, 'claude:default');
  assert.equal(def.isDefault, true);
  assert.equal(def.configDirExplicit, false);
  assert.equal(def.label, 'Hesap A');

  // 2. Secondary directory resolves to claude:secondary with configDirExplicit: true and label: 'Hesap B'
  const sec = resolveClaudeProfile(path.join(home, '.claude-secondary'), home);
  assert.equal(sec.id, 'claude:secondary');
  assert.equal(sec.isDefault, false);
  assert.equal(sec.configDirExplicit, true);
  assert.equal(sec.label, 'Hesap B');

  // 3. Custom directory resolves to claude:<sha256> with configDirExplicit: true and label: basename
  const custom = resolveClaudeProfile(path.join(home, 'my-claude-profile'), home);
  assert.ok(custom.id.startsWith('claude:'));
  assert.notEqual(custom.id, 'claude:default');
  assert.equal(custom.isDefault, false);
  assert.equal(custom.configDirExplicit, true);
  assert.equal(custom.label, 'my-claude-profile');

  // 4. Root path with empty basename resolves with fallback label
  const rootProfile = resolveClaudeProfile('/', home);
  assert.equal(rootProfile.label, 'Claude hesabı');
});

// Claude Round 7 Ö3: dismissAccount promotes the next enabled account to primary if primary account is dismissed
test('Claude R7-Ö3: dismissAccount promotes next available account to primary when primary is dismissed', async t => {
  const { createService } = require('../src/core/service.cjs');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-r7-o3-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const settingsPath = path.join(dir, 'settings.json');
  const initialSettings = {
    pinned: false,
    intervalSeconds: 120,
    accounts: [
      { id: 'claude:1', providerId: 'claude', label: 'Primary Claude', primary: true, enabled: true, origin: 'discovered' },
      { id: 'claude:2', providerId: 'claude', label: 'Backup Claude', primary: false, enabled: true, origin: 'discovered' }
    ]
  };
  await fs.writeFile(settingsPath, JSON.stringify(initialSettings), 'utf-8');

  const service = await createService({
    settingsPath,
    providers: [
      { id: 'claude', name: 'Claude', discover: async () => [], fetch: async () => ({ windows: [{ id: '5h', remainingPercent: 50 }] }) }
    ]
  });

  // Dismiss primary account claude:1
  await service.dismissAccount('claude:1');
  const accountsAfter = service.snapshot().settings.accounts;
  assert.equal(accountsAfter.length, 1);
  assert.equal(accountsAfter[0].id, 'claude:2');
  // claude:2 must have been promoted to primary: true!
  assert.equal(accountsAfter[0].primary, true);
});

// Claude Round 7 Ö2: empty dismissedAccountIds restores all dismissed accounts across providers
test('Claude R7-Ö2: clearing dismissedAccountIds restores dismissed accounts on discovery', async t => {
  const { createService } = require('../src/core/service.cjs');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-r7-o2-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const settingsPath = path.join(dir, 'settings.json');
  const initialSettings = {
    pinned: false,
    intervalSeconds: 120,
    accounts: [],
    dismissedAccountIds: ['antigravity:test_account']
  };
  await fs.writeFile(settingsPath, JSON.stringify(initialSettings), 'utf-8');

  const provider = {
    id: 'antigravity',
    name: 'Antigravity',
    discover: async () => [{ id: 'antigravity:test_account', providerId: 'antigravity', label: 'Antigravity Dev', primary: true, enabled: true }],
    fetch: async () => ({ windows: [] })
  };

  const service = await createService({ settingsPath, providers: [provider] });
  await service.reconcileDiscovery();
  // While dismissed, account is NOT in settings.accounts
  assert.equal(service.snapshot().settings.accounts.length, 0);

  // User clicks "Kaldırılan hesapları geri al" -> saveSettings({ dismissedAccountIds: [] })
  await service.updateSettings({ dismissedAccountIds: [] });
  await service.reconcileDiscovery();

  // Account is now restored!
  const restored = service.snapshot().settings.accounts;
  assert.equal(restored.length, 1);
  assert.equal(restored[0].id, 'antigravity:test_account');
});

// Claude Round 8 Ö2: restoreDismissedAccounts immediately restores accounts without waiting 60s periodic window
test('Claude R8-Ö2: restoreDismissedAccounts immediately restores accounts without waiting 60s periodic window', async t => {
  const { createService } = require('../src/core/service.cjs');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-r8-o2-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const settingsPath = path.join(dir, 'settings.json');
  const initialSettings = {
    pinned: false,
    intervalSeconds: 120,
    accounts: [
      { id: 'antigravity:test_account', providerId: 'antigravity', label: 'Antigravity Dev', primary: true, enabled: true, origin: 'discovered' }
    ],
    dismissedAccountIds: []
  };
  await fs.writeFile(settingsPath, JSON.stringify(initialSettings), 'utf-8');

  let clockTime = 100000;
  const clock = () => clockTime;

  const provider = {
    id: 'antigravity',
    name: 'Antigravity',
    discover: async () => [{ id: 'antigravity:test_account', providerId: 'antigravity', label: 'Antigravity Dev', primary: true, enabled: true }],
    fetch: async () => ({ windows: [{ id: '5h', remainingPercent: 80 }] })
  };

  const service = await createService({ settingsPath, clock, providers: [provider] });

  // Dismiss account
  await service.dismissAccount('antigravity:test_account');
  assert.equal(service.snapshot().settings.accounts.length, 0);
  assert.deepEqual(service.snapshot().settings.dismissedAccountIds, ['antigravity:test_account']);

  // Advance time by only 10s (< 60s periodic discovery interval) and call refresh()
  clockTime += 10000;
  await service.refresh();
  // Within 60s, normal refresh does not trigger discovery reconciliation, so accounts remains 0
  assert.equal(service.snapshot().settings.accounts.length, 0);

  // Now invoke restoreDismissedAccounts directly (as triggered by IPC vibe:restore-dismissed-accounts)
  await service.restoreDismissedAccounts();

  // Account is immediately restored into settings.accounts without waiting for 60s!
  const restored = service.snapshot().settings.accounts;
  assert.equal(restored.length, 1);
  assert.equal(restored[0].id, 'antigravity:test_account');
  assert.deepEqual(service.snapshot().settings.dismissedAccountIds, []);
});

// Claude Round 6 Finding E5: slice(-100) preserves the newest dismissed account when list is full
test('Claude E5: dismissAccount uses slice(-100) to keep newest dismissed account when list reaches 100', async t => {
  const { createService } = require('../src/core/service.cjs');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-e5-dismiss-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const settingsPath = path.join(dir, 'settings.json');
  const initialDismissed = Array.from({ length: 100 }, (_, i) => `claude:old_${i}`);
  const initialSettings = {
    pinned: false,
    intervalSeconds: 120,
    accounts: [
      { id: 'claude:target', providerId: 'claude', label: 'Target', primary: true, enabled: true, origin: 'discovered' }
    ],
    dismissedAccountIds: initialDismissed
  };
  await fs.writeFile(settingsPath, JSON.stringify(initialSettings), 'utf-8');

  const service = await createService({
    settingsPath,
    providers: [
      { id: 'claude', name: 'Claude', discover: async () => [], fetch: async () => ({ windows: [] }) }
    ]
  });

  // Dismiss 101st account
  await service.dismissAccount('claude:target');
  const snap = service.snapshot();
  assert.equal(snap.settings.dismissedAccountIds.length, 100);
  // With slice(-100), newest account claude:target MUST be preserved, and oldest claude:old_0 dropped!
  assert.equal(snap.settings.dismissedAccountIds.includes('claude:target'), true);
  assert.equal(snap.settings.dismissedAccountIds.includes('claude:old_0'), false);
  assert.equal(snap.settings.dismissedAccountIds[99], 'claude:target');
});

// Claude Round 6 Madde 5: Empty windows without explicit status throws invalid_response
test('Claude Madde 5: empty windows without explicit status is treated as invalid_response, not no_limits_reported', async t => {
  const { createService } = require('../src/core/service.cjs');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-m5-empty-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const settingsPath = path.join(dir, 'settings.json');
  const service = await createService({
    settingsPath,
    providers: [
      {
        id: 'claude',
        name: 'Claude',
        discover: async () => [{ id: 'claude:acc1', providerId: 'claude', label: 'Acc 1', primary: true, enabled: true }],
        // Returns empty windows without status: 'no_limits_reported'
        fetch: async () => ({ windows: [] })
      }
    ]
  });

  await service.refresh();
  const acc = service.snapshot().providers.find(p => p.id === 'claude')?.accounts[0];
  // Must NOT be falsely labeled as no_limits_reported!
  assert.notEqual(acc.status, 'no_limits_reported');
  assert.equal(acc.status, 'invalid_response');
});

test('Smart Launch & Handover: buildHandoverPrompt parses session transcript with initialGoal, last messages, and files', async t => {
  const { buildHandoverPrompt } = require('../src/core/launcher.cjs');
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-claude-home-'));
  const tempProject = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-test-proj-'));
  t.after(async () => {
    await fs.rm(tempHome, { recursive: true, force: true });
    await fs.rm(tempProject, { recursive: true, force: true });
  });

  const slug = path.resolve(tempProject).replace(/[/\\:]/g, '-');
  const projDir = path.join(tempHome, '.claude', 'projects', slug);
  await fs.mkdir(projDir, { recursive: true });

  const sessionData = [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'Projeyi Next.js yerine Vanilla JS yapalım.' } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'Anladım, index.html ve src/ui/app.js oluşturuyorum.' } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Write', input: { file_path: 'src/ui/app.js' } }] } }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] }, toolUseResult: { filePath: 'src/ui/app.js' } }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'Lütfen kota tablosunu 2 sütunlu yap.' } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'Quota grid 2 sütun olarak düzenlendi.' } })
  ].join('\n');

  await fs.writeFile(path.join(projDir, 'session-abc.jsonl'), sessionData, 'utf8');

  const handover = await buildHandoverPrompt(tempProject, tempHome);
  assert.equal(handover.hasSession, true);
  assert.equal(handover.sessionId, 'session-abc');
  assert.equal(handover.turnCount, 2);
  assert.equal(handover.initialGoal, 'Projeyi Next.js yerine Vanilla JS yapalım.');
  assert.equal(handover.lastUserMsg, 'Lütfen kota tablosunu 2 sütunlu yap.');
  assert.equal(handover.lastAssistantMsg, 'Quota grid 2 sütun olarak düzenlendi.');
  assert.ok(handover.recentFiles.includes('src/ui/app.js'));
});

test('Smart Launch: smartSelectProvider chooses Claude if quota > 0, Codex if Claude 0, Cursor if neither', () => {
  const { smartSelectProvider } = require('../src/core/launcher.cjs');

  const snapshotWithClaude = {
    settings: {
      accounts: [
        { id: 'claude:acc1', providerId: 'claude', primary: true, enabled: true },
        { id: 'codex:acc1', providerId: 'codex', enabled: true }
      ]
    },
    providers: [
      {
        id: 'claude',
        status: 'ok',
        accounts: [
          { id: 'claude:acc1', status: 'ok', windows: [{ id: 'five_hour', remainingPercent: 45 }] }
        ]
      },
      { id: 'codex', status: 'ok' }
    ]
  };

  const choice1 = smartSelectProvider(snapshotWithClaude);
  assert.equal(choice1.providerId, 'claude');
  assert.equal(choice1.isFallback, false);
  assert.equal(choice1.remaining, 45);

  const snapshotClaudeDepleted = {
    settings: {
      accounts: [
        { id: 'claude:acc1', providerId: 'claude', primary: true, enabled: true },
        { id: 'codex:acc1', providerId: 'codex', enabled: true }
      ]
    },
    providers: [
      {
        id: 'claude',
        status: 'ok',
        accounts: [
          { id: 'claude:acc1', status: 'ok', windows: [{ id: 'five_hour', remainingPercent: 0 }] }
        ]
      },
      { id: 'codex', status: 'ok' }
    ]
  };

  const choice2 = smartSelectProvider(snapshotClaudeDepleted);
  assert.equal(choice2.providerId, 'codex');
  assert.equal(choice2.isFallback, true);

  const snapshotBothDepleted = {
    settings: {
      accounts: [
        { id: 'claude:acc1', providerId: 'claude', primary: true, enabled: true }
      ]
    },
    providers: [
      {
        id: 'claude',
        status: 'ok',
        accounts: [
          { id: 'claude:acc1', status: 'ok', windows: [{ id: 'five_hour', remainingPercent: 0 }] }
        ]
      },
      { id: 'codex', status: 'auth_missing' },
      { id: 'cursor', status: 'ok' }
    ]
  };

  const choice3 = smartSelectProvider(snapshotBothDepleted);
  assert.equal(choice3.providerId, 'cursor');
  assert.equal(choice3.isFallback, true);
});

test('Handover Security: sanitizeText strips system-reminders without deleting prompt and redacts secrets', async t => {
  const { buildHandoverPrompt } = require('../src/core/launcher.cjs');
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-secret-home-'));
  const tempProject = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-secret-proj-'));
  t.after(async () => {
    await fs.rm(tempHome, { recursive: true, force: true });
    await fs.rm(tempProject, { recursive: true, force: true });
  });

  const slug = path.resolve(tempProject).replace(/[/\\:]/g, '-');
  const projDir = path.join(tempHome, '.claude', 'projects', slug);
  await fs.mkdir(projDir, { recursive: true });

  const sessionData = [
    JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: '<system-reminder>Hatırlatma: kurallara uy.</system-reminder>Lütfen API anahtarım sk-ant-api03-12345678901234567890 ile servise bağlan.'
      }
    }),
    JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: 'Bağlantı kuruldu. Gh token: ghp_12345678901234567890.'
      }
    }),
    // Synthetic rate limit error message that shouldn't be captured as the plan
    JSON.stringify({
      type: 'assistant',
      isApiErrorMessage: true,
      message: {
        role: 'assistant',
        content: 'Usage limit reached. Resets at 3:00 PM.'
      }
    })
  ].join('\n');

  await fs.writeFile(path.join(projDir, 'session-sec.jsonl'), sessionData, 'utf8');

  const handover = await buildHandoverPrompt(tempProject, tempHome);
  assert.equal(handover.hasSession, true);
  // System reminder is stripped, but user prompt is preserved!
  assert.ok(handover.lastUserMsg.includes('Lütfen API anahtarım'));
  assert.equal(handover.lastUserMsg.includes('<system-reminder>'), false);
  // Secret is redacted!
  assert.ok(handover.lastUserMsg.includes('[REDACTED_SECRET]'));
  assert.equal(handover.lastUserMsg.includes('sk-ant-api03-'), false);
  // Rate limit message was ignored, previous actual plan was kept!
  assert.ok(handover.lastAssistantMsg.includes('Bağlantı kuruldu'));
  assert.equal(handover.lastAssistantMsg.includes('Usage limit reached'), false);
});

test('Handover Validation: executeHandover rejects non-allowlisted provider names', async t => {
  const { executeHandover } = require('../src/core/launcher.cjs');
  const tempProject = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-val-proj-'));
  t.after(async () => {
    await fs.rm(tempProject, { recursive: true, force: true });
  });

  await assert.rejects(
    () => executeHandover({ projectDir: tempProject, fromProvider: 'malicious-pipe; rm -rf /' }),
    /Geçersiz kaynak sağlayıcı/
  );
  await assert.rejects(
    () => executeHandover({ projectDir: tempProject, toProvider: 'invalid-target' }),
    /Geçersiz hedef sağlayıcı/
  );
});

test('Settings: validates fallbackOrder correctly and rejects invalid providers', () => {
  const { validateSettings } = require('../src/core/settings.cjs');
  const valid = validateSettings({
    pinned: false,
    intervalSeconds: 120,
    accounts: [],
    fallbackOrder: ['cursor', 'codex', 'antigravity']
  });
  assert.deepEqual(valid.fallbackOrder, ['cursor', 'codex', 'antigravity']);

  assert.throws(
    () => validateSettings({ pinned: false, intervalSeconds: 120, accounts: [], fallbackOrder: ['invalid_p'] }),
    /invalid_settings/
  );
});

test('Model Mapping: resolveModelTier and getMappedModel accurately maps Opus 5.5 to flagship peers', () => {
  const { resolveModelTier, getMappedModel } = require('../src/core/launcher.cjs');

  // Opus 5.5 is Flagship
  assert.equal(resolveModelTier('claude-opus-5-5'), 'flagship');
  assert.equal(resolveModelTier('claude-3-opus'), 'flagship');
  assert.equal(getMappedModel('claude-opus-5-5', 'codex').targetModel, 'gpt-6-luna');
  assert.equal(getMappedModel('claude-opus-5-5', 'antigravity').targetModel, 'gemini-2.5-pro');
  const { setModelCacheDir } = require('../src/core/models.cjs');
  const cacheDir = require('node:fs').mkdtempSync(path.join(os.tmpdir(), 'vibe-model-cache-'));
  require('node:fs').writeFileSync(path.join(cacheDir, 'cursor-models.json'), JSON.stringify({ models: ['auto', 'claude-opus-5-5-high', 'claude-opus-5-5-thinking-high', 'claude-sonnet-5-5-high'], updatedAt: Date.now() }));
  setModelCacheDir(cacheDir);
  try {
    assert.equal(getMappedModel('claude-opus-5-5', 'cursor').targetModel, 'claude-opus-5-5-high');
  } finally {
    setModelCacheDir(null);
    require('node:fs').rmSync(cacheDir, { recursive: true, force: true });
  }

  // Sonnet 3.7 is Balanced
  assert.equal(resolveModelTier('claude-3-7-sonnet-20250219'), 'balanced');
  assert.equal(getMappedModel('claude-3-7-sonnet', 'codex').targetModel, 'gpt-5.6-luna');
  assert.equal(getMappedModel('claude-3-7-sonnet', 'antigravity').targetModel, 'gemini-3.8-flash');

  // Haiku is Fast
  assert.equal(resolveModelTier('claude-3-5-haiku'), 'fast');
  assert.ok(['gpt-reserve', 'o3-mini'].includes(getMappedModel('claude-3-5-haiku', 'codex').targetModel));
  assert.ok(['gemini-2.5-flash', 'gemini-2.5-flash-lite'].includes(getMappedModel('claude-3-5-haiku', 'antigravity').targetModel));

  // User override takes precedence
  assert.equal(getMappedModel('claude-opus-5-5', 'codex', { codex: 'custom-gpt-v6' }).targetModel, 'custom-gpt-v6');
});

test('Dynamic Configuration: validateSettings accepts primaryProvider, providerOrder, and preferredModels', () => {
  const { validateSettings } = require('../src/core/settings.cjs');
  const valid = validateSettings({
    pinned: false,
    intervalSeconds: 120,
    accounts: [],
    primaryProvider: 'codex',
    providerOrder: ['codex', 'cursor', 'claude', 'antigravity'],
    preferredModels: { codex: 'gpt-6-luna', claude: 'claude-opus-5-5' }
  });
  assert.equal(valid.primaryProvider, 'codex');
  assert.deepEqual(valid.providerOrder, ['codex', 'cursor', 'claude', 'antigravity']);
  assert.equal(valid.preferredModels.codex, 'gpt-6-luna');

  // Rejects invalid primaryProvider
  assert.throws(
    () => validateSettings({ pinned: false, intervalSeconds: 120, accounts: [], primaryProvider: 'invalid-provider' }),
    /invalid_settings/
  );

  // Rejects duplicate providerOrder
  assert.throws(
    () => validateSettings({ pinned: false, intervalSeconds: 120, accounts: [], providerOrder: ['codex', 'codex'] }),
    /invalid_settings/
  );

  // Rejects invalid preferredModels
  assert.throws(
    () => validateSettings({ pinned: false, intervalSeconds: 120, accounts: [], preferredModels: { unknown: 'model' } }),
    /invalid_settings/
  );
});

test('Dynamic Provider Priority: smartSelectProvider chooses user configured primaryProvider first', () => {
  const { smartSelectProvider } = require('../src/core/launcher.cjs');

  const snapshot = {
    settings: {
      primaryProvider: 'codex',
      accounts: [
        { id: 'claude:acc1', providerId: 'claude', primary: true, enabled: true },
        { id: 'codex:acc1', providerId: 'codex', primary: true, enabled: true }
      ]
    },
    providers: [
      {
        id: 'claude',
        status: 'ok',
        accounts: [{ id: 'claude:acc1', status: 'ok', windows: [{ id: 'five_hour', remainingPercent: 80 }] }]
      },
      {
        id: 'codex',
        status: 'ok',
        accounts: [{ id: 'codex:acc1', status: 'ok', windows: [{ id: 'daily', remainingPercent: 90 }] }]
      }
    ]
  };

  const choice = smartSelectProvider(snapshot);
  assert.equal(choice.providerId, 'codex');
  assert.equal(choice.isFallback, false);
});

test('Language & i18n: validates 13 languages, defaults to en, and rejects unsupported language', () => {
  const { validateSettings, DEFAULT_SETTINGS } = require('../src/core/settings.cjs');
  const { I18N, t, setLanguage, getSupportedLanguages } = require('../src/ui/i18n.js');

  // Verify English default
  assert.equal(DEFAULT_SETTINGS.language, 'en');

  // Verify 13 supported languages (at least 10)
  const langs = getSupportedLanguages();
  assert.ok(langs.length >= 10);
  assert.equal(langs.length, 13);
  const langCodes = langs.map(l => l.code);
  assert.ok(langCodes.includes('en'));
  assert.ok(langCodes.includes('tr'));
  assert.ok(langCodes.includes('de'));
  assert.ok(langCodes.includes('es'));
  assert.ok(langCodes.includes('ja'));

  // Accepts valid language in settings
  const valid = validateSettings({ pinned: false, intervalSeconds: 120, accounts: [], language: 'tr' });
  assert.equal(valid.language, 'tr');

  // Optional when undefined, defaults to en via DEFAULT_SETTINGS
  const validDefault = validateSettings({ pinned: false, intervalSeconds: 120, accounts: [] });
  assert.equal(validDefault.language || DEFAULT_SETTINGS.language, 'en');

  // Rejects invalid language
  assert.throws(
    () => validateSettings({ pinned: false, intervalSeconds: 120, accounts: [], language: 'invalid_lang' }),
    /invalid_settings/
  );

  // i18n translation tests
  setLanguage('en');
  assert.equal(t('liveTracker'), 'Live Tracker');
  assert.equal(t('settingsTitle'), 'Settings');

  setLanguage('tr');
  assert.equal(t('liveTracker'), 'Canlı İzleyici');
  assert.equal(t('settingsTitle'), 'Ayarlar');
});

test('Handover automation & localized formatting: automated prompt and locale formatting', async () => {
  const { formatWindow, formatFreshness } = require('../src/shared.cjs');
  const { setLanguage, t } = require('../src/ui/i18n.js');

  // Verify quota label translations
  setLanguage('en');
  assert.equal(t('label5Hours'), '5 hours');
  assert.equal(t('labelWeekly'), 'Weekly');
  assert.equal(t('labelAutoScope'), 'Auto scope');
  assert.equal(t('accountA'), 'Account A');

  setLanguage('tr');
  assert.equal(t('label5Hours'), '5 saat');
  assert.equal(t('labelWeekly'), 'Haftalık');
  assert.equal(t('labelAutoScope'), 'Auto kapsamı');
  assert.equal(t('accountA'), 'Hesap A');

  // Verify English locale formatting
  const enWindow = formatWindow({ remainingPercent: 89, resetsAt: '2026-11-11T14:46:00Z' }, 'en-US');
  assert.equal(enWindow.value, '89%');
  assert.match(enWindow.reset, /Nov|11/);

  // Verify Turkish locale formatting
  const trWindow = formatWindow({ remainingPercent: 89, resetsAt: '2026-11-11T14:46:00Z' }, 'tr-TR');
  assert.equal(trWindow.value, '%89');
  assert.match(trWindow.reset, /Kas|11/);

  // Verify freshness formatting
  const now = Date.parse('2026-10-16T12:05:00Z');
  const enFresh = formatFreshness('2026-10-16T12:00:00Z', 'ok', now, 'en-US');
  assert.equal(enFresh, '5m ago');

  const enJustNow = formatFreshness('2026-10-16T12:05:00Z', 'ok', now, 'en-US');
  assert.equal(enJustNow, 'just now');
});

test('Session Discovery & Specific Handover: listSessions discovers AI titles and buildHandoverPrompt selects target session', async t => {
  const { listSessions, buildHandoverPrompt } = require('../src/core/launcher.cjs');
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-sessions-home-'));
  const tempProj = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-sessions-proj-'));
  t.after(async () => {
    await fs.rm(tempHome, { recursive: true, force: true });
    await fs.rm(tempProj, { recursive: true, force: true });
  });

  const slug = path.resolve(tempProj).replace(/[/\\:]/g, '-');
  const claudeProjDir = path.join(tempHome, '.claude', 'projects', slug);
  await fs.mkdir(claudeProjDir, { recursive: true });

  // Session 1: Older, title from ai-title
  const s1Data = [
    JSON.stringify({ type: 'ai-title', aiTitle: 'Codex startup ve OSS araştırma süreci' }),
    JSON.stringify({ type: 'user', message: { content: 'Startup araştırmasına başla.' } }),
    JSON.stringify({ type: 'assistant', message: { content: 'Araştırma başlatıldı.' } })
  ].join('\n');
  await fs.writeFile(path.join(claudeProjDir, 'sess-1.jsonl'), s1Data, 'utf8');

  // Session 2: Newer, title from user message
  const s2Data = [
    JSON.stringify({ type: 'user', message: { content: 'Admin reviews sayfası tablo tasarımı' } }),
    JSON.stringify({ type: 'assistant', message: { content: 'Tablo tasarımı tamamlandı.' } })
  ].join('\n');
  await fs.writeFile(path.join(claudeProjDir, 'sess-2.jsonl'), s2Data, 'utf8');

  // Discover sessions
  const sessions = await listSessions({ providerId: 'claude', projectDir: tempProj, homeDir: tempHome });
  assert.equal(sessions.length, 2);
  const s1 = sessions.find(s => s.id === 'sess-1');
  const s2 = sessions.find(s => s.id === 'sess-2');
  assert.equal(s1.title, 'Codex startup ve OSS araştırma süreci');
  assert.equal(s2.title, 'Admin reviews sayfası tablo tasarımı');

  // Specific session selection (select sess-1 explicitly even if sess-2 is newer)
  const handoverS1 = await buildHandoverPrompt(tempProj, { sessionId: 'sess-1', homeDir: tempHome });
  assert.equal(handoverS1.hasSession, true);
  assert.equal(handoverS1.sessionId, 'sess-1');
  assert.equal(handoverS1.sessionTitle, 'Codex startup ve OSS araştırma süreci');
  assert.equal(handoverS1.initialGoal, 'Startup araştırmasına başla.');

  // Default auto selection picks sess-2 (most recent)
  const handoverAuto = await buildHandoverPrompt(tempProj, { homeDir: tempHome });
  assert.equal(handoverAuto.sessionId, 'sess-2');
});

test('Semantic Window Architecture: providers emit semantic labelKey, detailKey, and durationMinutes', () => {
  const { parseCursorUsage } = require('../src/providers/cursor.cjs');
  const { parseCodexRateLimits } = require('../src/providers/codex.cjs');

  // Cursor semantic keys
  const cursorUsage = parseCursorUsage({
    individualUsage: {
      plan: { autoPercentUsed: 50, apiPercentUsed: 0, totalPercentUsed: 25, remaining: 100 }
    }
  });
  const autoWin = cursorUsage.windows.find(w => w.id === 'plan:auto');
  const apiWin = cursorUsage.windows.find(w => w.id === 'plan:api');
  assert.equal(autoWin.labelKey, 'labelAutoScope');
  assert.equal(apiWin.labelKey, 'labelApiScope');
  assert.equal(apiWin.detailKey, 'cursorApiLimitNote');

  // Codex semantic duration
  const codexRate = parseCodexRateLimits({
    rateLimits: {
      primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 1780000000 }
    }
  });
  const codexWin = codexRate.windows[0];
  assert.equal(codexWin.labelKey, 'label5Hours');
  assert.equal(codexWin.durationMinutes, 300);
});

test('Handover Multi-target: executeHandover prepares VIBE_HANDOVER.md for Cursor and Antigravity', async t => {
  const { executeHandover } = require('../src/core/launcher.cjs');
  const tempProj = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-handover-proj-'));
  const tempData = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-handover-data-'));
  t.after(async () => {
    await fs.rm(tempProj, { recursive: true, force: true });
    await fs.rm(tempData, { recursive: true, force: true });
  });

  // Handover to Cursor (spawn is faked: tests must never launch real apps or agents)
  const calls = [];
  const resCursor = await executeHandover({
    projectDir: tempProj,
    dataDir: tempData,
    fromProvider: 'claude',
    toProvider: 'cursor',
    spawnProcess: fakeSpawn(calls)
  });
  assert.equal(resCursor.success, true);
  assert.equal(resCursor.to, 'CURSOR');
  const cursorMd = await fs.readFile(path.join(tempProj, 'VIBE_HANDOVER.md'), 'utf8');
  assert.match(cursorMd, /# VIBE USAGE: GÖREV DEVRİ \(CLAUDE ➔ CURSOR\)/);

  // Handover to Antigravity
  const resAnti = await executeHandover({
    projectDir: tempProj,
    dataDir: tempData,
    fromProvider: 'claude',
    toProvider: 'antigravity',
    spawnProcess: fakeSpawn(calls)
  });
  assert.equal(resAnti.success, true);
  assert.equal(resAnti.to, 'ANTIGRAVITY');
  const antiMd = await fs.readFile(path.join(tempProj, 'VIBE_HANDOVER.md'), 'utf8');
  assert.match(antiMd, /# VIBE USAGE: GÖREV DEVRİ \(CLAUDE ➔ ANTIGRAVITY\)/);
  assert.equal(calls.length, 2);
});

test('Multi-provider Session Discovery: listSessions discovers Antigravity and Claude sessions with providerId', async t => {
  const { listSessions, buildHandoverPrompt } = require('../src/core/launcher.cjs');
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-multi-sess-home-'));
  const tempProj = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-multi-sess-proj-'));
  t.after(async () => {
    await fs.rm(tempHome, { recursive: true, force: true });
    await fs.rm(tempProj, { recursive: true, force: true });
  });

  // 1. Setup mock Claude session
  const slug = path.resolve(tempProj).replace(/[/\\:]/g, '-');
  const claudeDir = path.join(tempHome, '.claude', 'projects', slug);
  await fs.mkdir(claudeDir, { recursive: true });
  await fs.writeFile(path.join(claudeDir, 'claude-sess.jsonl'), JSON.stringify({ type: 'ai-title', aiTitle: 'Claude Session Title' }) + '\n' + JSON.stringify({ type: 'user', message: { content: 'Task 1' } }), 'utf8');

  // 2. Setup mock Antigravity session
  const convDir = path.join(tempHome, '.gemini', 'antigravity-ide', 'conversations');
  const brainDir = path.join(tempHome, '.gemini', 'antigravity-ide', 'brain');
  const convId = 'ag-test-conv-123';
  await fs.mkdir(convDir, { recursive: true });
  await fs.mkdir(path.join(brainDir, convId, '.system_generated', 'logs'), { recursive: true });

  // Same layout as Antigravity: workspace URI inside a protobuf blob, terminated by a field tag.
  writeAntigravityDb(path.join(convDir, `${convId}.db`), tempProj, 'Gemini 3.8 Flash (High)');

  const agTranscript = [
    JSON.stringify({ type: 'USER_INPUT', content: 'Antigravity Arch Plan Task' }),
    JSON.stringify({ type: 'PLANNER_RESPONSE', content: 'Step 1 completed' })
  ].join('\n');
  await fs.writeFile(path.join(brainDir, convId, '.system_generated', 'logs', 'transcript.jsonl'), agTranscript, 'utf8');

  // Test listSessions with providerId: 'auto'
  const autoSessions = await listSessions({ providerId: 'auto', projectDir: tempProj, homeDir: tempHome });
  assert.ok(autoSessions.length >= 2);
  const foundClaude = autoSessions.find(s => s.providerId === 'claude');
  const foundAg = autoSessions.find(s => s.providerId === 'antigravity');
  assert.ok(foundClaude);
  assert.ok(foundAg);
  assert.equal(foundClaude.title, 'Claude Session Title');
  assert.equal(foundAg.title, 'Antigravity Arch Plan Task');

  // Test buildHandoverPrompt targeting Antigravity session explicitly
  const handoverAg = await buildHandoverPrompt(tempProj, { sessionId: convId, homeDir: tempHome });
  assert.equal(handoverAg.hasSession, true);
  assert.equal(handoverAg.sessionId, convId);
  assert.equal(handoverAg.providerId, 'antigravity');
  assert.equal(handoverAg.sessionTitle, 'Antigravity Arch Plan Task');
});

test('Dynamic Cursor Models: list comes only from the CLI cache, never from invented names', () => {
  const { discoverModels, setModelCacheDir, resolveModelTier } = require('../src/core/models.cjs');
  const fsSync = require('node:fs');
  const home = fsSync.mkdtempSync(path.join(os.tmpdir(), 'vibe-cursor-home-'));
  const cacheDir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'vibe-cursor-cache-'));
  try {
    setModelCacheDir(cacheDir);
    // No CLI output and no CLI history: only the CLI's own default.
    assert.deepEqual(discoverModels(home).cursor, ['auto']);

    // Models the user really picked in the CLI are offered when no live list exists.
    fsSync.mkdirSync(path.join(home, '.cursor'));
    fsSync.writeFileSync(path.join(home, '.cursor', 'cli-config.json'), JSON.stringify({ selectedModel: { modelId: 'gpt-5.6-sol-high' }, modelSelectionHistory: ['default', 'claude-opus-5-5-high'] }));
    assert.deepEqual(discoverModels(home).cursor, ['auto', 'gpt-5.6-sol-high', 'claude-opus-5-5-high']);

    // A live list (even a stale one) replaces everything else, in CLI order.
    fsSync.writeFileSync(path.join(cacheDir, 'cursor-models.json'), JSON.stringify({ models: ['auto', 'composer-2.5', 'claude-4-sonnet'], updatedAt: 1 }));
    assert.deepEqual(discoverModels(home).cursor, ['auto', 'composer-2.5', 'claude-4-sonnet']);
  } finally {
    setModelCacheDir(null);
    fsSync.rmSync(home, { recursive: true, force: true });
    fsSync.rmSync(cacheDir, { recursive: true, force: true });
  }
  assert.equal(resolveModelTier('claude-opus-5-5-high'), 'flagship');
  assert.equal(resolveModelTier('gemini-3.8-flash'), 'balanced', 'gemini must not match the "mini" fast rule');
  assert.equal(resolveModelTier('gpt-5.4-mini-high'), 'fast');
});


test('Codex sessions: only this project, compressed rollouts included, subagents and fork snapshots excluded', async t => {
  const { listSessions, buildHandoverPrompt } = require('../src/core/launcher.cjs');
  const zlib = require('node:zlib');
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-codex-home-'));
  const proj = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-codex-proj-'));
  const other = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-codex-other-'));
  t.after(async () => { for (const d of [home, proj, other]) await fs.rm(d, { recursive: true, force: true }); });

  const day = path.join(home, '.codex', 'sessions', '2026', '10', '16');
  await fs.mkdir(day, { recursive: true });
  const A = '01a1aaaa-0000-7000-8000-000000000001';
  const B = '01a1bbbb-0000-7000-8000-000000000002';
  await fs.writeFile(path.join(day, `rollout-2026-10-16T10-00-00-${A}.jsonl`), codexRollout({ id: A, cwd: proj, model: 'gpt-6-luna', user: ['Kota ekranını düzelt', 'Testleri de ekle'], assistant: ['Düzelttim', 'Testler eklendi'] }));
  await fs.writeFile(path.join(day, `rollout-2026-10-16T09-00-00-${B}.jsonl.zst`), zlib.zstdCompressSync(Buffer.from(codexRollout({ id: B, cwd: proj, user: ['Eski sıkıştırılmış oturum'] }))));
  // Fork snapshot of A: begins with A's session_meta, must not duplicate A.
  await fs.writeFile(path.join(day, `rollout-2026-10-16T11-00-00-${A}_01a1cccc-0000-7000-8000-000000000003.jsonl`), codexRollout({ id: A, cwd: proj, user: ['snapshot'] }));
  // Guardian reviewer thread and another project's session.
  await fs.writeFile(path.join(day, 'rollout-2026-10-16T12-00-00-01a1dddd-0000-7000-8000-000000000004.jsonl'), codexRollout({ id: '01a1dddd-0000-7000-8000-000000000004', cwd: proj, source: { subagent: { other: 'guardian' } }, user: ['review'] }));
  await fs.writeFile(path.join(day, 'rollout-2026-10-16T12-30-00-01a1eeee-0000-7000-8000-000000000005.jsonl'), codexRollout({ id: '01a1eeee-0000-7000-8000-000000000005', cwd: other, user: ['Başka proje'] }));
  await fs.writeFile(path.join(home, '.codex', 'session_index.jsonl'), JSON.stringify({ id: A, thread_name: 'Kota ekranı', updated_at: '2026-10-16T10:00:00Z' }) + '\n');

  const sessions = await listSessions({ providerId: 'codex', projectDir: proj, homeDir: home });
  assert.deepEqual(sessions.map(s => s.id).sort(), [A, B].sort());
  const a = sessions.find(s => s.id === A);
  assert.equal(a.title, 'Kota ekranı');
  assert.equal(a.turnCount, 2, 'injected AGENTS.md / environment messages are not user turns');
  assert.equal(a.model, 'gpt-6-luna');
  assert.equal(sessions.find(s => s.id === B).title, 'Eski sıkıştırılmış oturum');

  const h = await buildHandoverPrompt(proj, { sessionId: A, providerId: 'codex', homeDir: home });
  assert.equal(h.providerId, 'codex');
  assert.equal(h.initialGoal, 'Kota ekranını düzelt');
  assert.equal(h.lastUserMsg, 'Testleri de ekle');
  assert.equal(h.lastAssistantMsg, 'Testler eklendi');

  assert.deepEqual(await listSessions({ providerId: 'codex', projectDir: other, homeDir: home }).then(x => x.map(s => s.id)), ['01a1eeee-0000-7000-8000-000000000005']);
});

test('Cursor CLI sessions: matched by cwd and read from store.db; no synthetic workspace entries', async t => {
  const { listSessions, buildHandoverPrompt } = require('../src/core/launcher.cjs');
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-cursor-home-'));
  const proj = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-cursor-proj-'));
  t.after(async () => { for (const d of [home, proj]) await fs.rm(d, { recursive: true, force: true }); });

  const chats = path.join(home, '.cursor', 'chats');
  writeCursorChat(chats, { id: 'chat-mine', cwd: proj, name: 'Refactor storage', user: ['Storage katmanını ayır'], assistant: ['Ayırdım'] });
  writeCursorChat(chats, { id: 'chat-other', cwd: path.join(proj, 'nested'), name: 'Other', user: ['x'] });
  writeCursorChat(chats, { id: 'chat-empty', cwd: proj, name: 'New Agent' });

  const sessions = await listSessions({ providerId: 'cursor', projectDir: proj, homeDir: home });
  assert.deepEqual(sessions.map(s => [s.id, s.title, s.turnCount, s.providerId]), [['chat-mine', 'Refactor storage', 1, 'cursor']]);

  const h = await buildHandoverPrompt(proj, { sessionId: 'chat-mine', providerId: 'cursor', homeDir: home });
  assert.equal(h.lastUserMsg, 'Storage katmanını ayır');
  assert.equal(h.lastAssistantMsg, 'Ayırdım');
});

test('Antigravity sessions: workspace must match exactly and the recorded model is reported', async t => {
  const { listSessions } = require('../src/core/launcher.cjs');
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-ag-home-'));
  const proj = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-ag-proj-'));
  t.after(async () => { for (const d of [home, proj]) await fs.rm(d, { recursive: true, force: true }); });

  const conv = path.join(home, '.gemini', 'antigravity-ide', 'conversations');
  await fs.mkdir(conv, { recursive: true });
  writeAntigravityDb(path.join(conv, 'exact.db'), proj, 'Gemini 3.8 Flash (High)');
  writeAntigravityDb(path.join(conv, 'prefix.db'), `${proj}-2`, 'Gemini 3.8 Flash (High)');
  writeAntigravityDb(path.join(conv, 'nomodel.db'), proj, null);

  const sessions = await listSessions({ providerId: 'antigravity', projectDir: proj, homeDir: home });
  assert.deepEqual(sessions.map(s => s.id).sort(), ['exact', 'nomodel']);
  assert.equal(sessions.find(s => s.id === 'exact').model, 'Gemini 3.8 Flash (High)');
  assert.equal(sessions.find(s => s.id === 'nomodel').model, '', 'unknown model stays unknown');
});

test('Handover source: a selected session is read from its own provider, never replaced by Claude', async t => {
  const { executeHandover, buildHandoverPrompt } = require('../src/core/launcher.cjs');
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-src-home-'));
  const proj = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-src-proj-'));
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-src-data-'));
  t.after(async () => { for (const d of [home, proj, data]) await fs.rm(d, { recursive: true, force: true }); });

  // A newer Claude session exists for the same project.
  const slug = path.resolve(proj).replace(/[/\\:]/g, '-');
  await fs.mkdir(path.join(home, '.claude', 'projects', slug), { recursive: true });
  await fs.writeFile(path.join(home, '.claude', 'projects', slug, 'claude-1.jsonl'), JSON.stringify({ type: 'user', message: { content: 'CLAUDE TASK' } }) + '\n');
  writeCursorChat(path.join(home, '.cursor', 'chats'), { id: 'chat-1', cwd: proj, name: 'Cursor görevi', user: ['CURSOR TASK'], assistant: ['cursor done'] });

  await assert.rejects(() => buildHandoverPrompt(proj, { sessionId: 'chat-1', providerId: 'codex', homeDir: home }), /Seçilen oturum bulunamadı/);

  const realHome = os.homedir;
  os.homedir = () => home;
  t.after(() => { os.homedir = realHome; });
  const calls = [];
  const res = await executeHandover({ projectDir: proj, dataDir: data, fromProvider: 'auto', toProvider: 'antigravity', sessionId: 'chat-1', sessionProvider: 'cursor', spawnProcess: fakeSpawn(calls) });
  assert.equal(res.from, 'CURSOR');
  const md = await fs.readFile(path.join(proj, 'VIBE_HANDOVER.md'), 'utf8');
  assert.match(md, /\(CURSOR ➔ ANTIGRAVITY\)/);
  assert.match(md, /CURSOR TASK/);
  assert.doesNotMatch(md, /CLAUDE TASK/);
  await assert.rejects(() => executeHandover({ projectDir: proj, dataDir: data, sessionId: 'x', sessionProvider: 'evil; rm -rf /', spawnProcess: fakeSpawn(calls) }), /Geçersiz oturum sağlayıcısı/);
});

test('Cursor model discovery: parses `--list-models` output and caches it in the app data dir', async t => {
  const { parseCursorModelList, refreshCursorModels } = require('../src/core/models.cjs');
  const output = 'Available models\n\nauto - Auto (default)\ngpt-5.3-codex - Codex 5.3\nclaude-opus-5-5-high - Claude Opus 5.5 High\n\nTip: use --model <id>\n';
  assert.deepEqual(parseCursorModelList(output), ['auto', 'gpt-5.3-codex', 'claude-opus-5-5-high']);

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-cursor-cli-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  if (process.platform === 'win32') return; // the fake CLI below is a POSIX shell script
  const bin = path.join(dir, 'fake-agent');
  await fs.writeFile(bin, `#!/bin/sh\n[ "$1" = "--list-models" ] || exit 2\ncat <<'EOF'\n${output}EOF\n`, { mode: 0o755 });
  const cacheDir = path.join(dir, 'cache');
  assert.deepEqual(await refreshCursorModels({ cacheDir, binary: bin, now: 1000 }), ['auto', 'gpt-5.3-codex', 'claude-opus-5-5-high']);
  const cached = JSON.parse(await fs.readFile(path.join(cacheDir, 'cursor-models.json'), 'utf8'));
  assert.equal(cached.updatedAt, 1000);
  // Fresh cache is reused without running the CLI; a failing CLI never wipes the cache.
  assert.deepEqual(await refreshCursorModels({ cacheDir, binary: '/nonexistent', now: 2000 }), cached.models);
  assert.equal(await refreshCursorModels({ cacheDir, binary: '/nonexistent', now: 1000 + 25 * 3600e3 }), null);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(cacheDir, 'cursor-models.json'), 'utf8')).models, cached.models);
});
