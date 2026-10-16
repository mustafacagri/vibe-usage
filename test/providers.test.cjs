const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

test('Claude scoped identity survives reorder and partial response',()=>{
 const {parseClaudeUsage}=require('../src/providers/claude.cjs');
 const row=name=>({kind:'weekly_scoped',percent:20,scope:{model:{id:name.toLowerCase(),display_name:name}}});
 const first=parseClaudeUsage({limits:[row('Fable'),row('Sonnet')]});
 const second=parseClaudeUsage({limits:[row('Sonnet')]});
 assert.equal(first.windows.find(w=>w.scope==='Sonnet').id,second.windows.find(w=>w.scope==='Sonnet').id);
 assert.notEqual(first.windows.find(w=>w.scope==='Fable').id,second.windows.find(w=>w.scope==='Sonnet').id);
});
test('transport enforces total deadline even while response keeps sending data',async()=>{
 const {EventEmitter}=require('node:events');const {getJson}=require('../src/providers/common.cjs');let destroyed=false,interval;
 const requestImpl=(_url,_options,callback)=>{const req=new EventEmitter();req.destroy=()=>{destroyed=true;clearInterval(interval);};const response=new EventEmitter();response.statusCode=200;response.destroy=()=>clearInterval(interval);response.resume=()=>{};queueMicrotask(()=>{callback(response);interval=setInterval(()=>response.emit('data',Buffer.from(' ')),5);});return req;};
 await assert.rejects(getJson('https://api.anthropic.com/api/oauth/usage',{timeoutMs:30,requestImpl}),/request_timeout/);assert.equal(destroyed,true);
});

test('Claude dynamic kinds and inactive Fable survive with missing weekly/reset unknown', () => {
  const { parseClaudeUsage } = require('../src/providers/claude.cjs');
  const value = parseClaudeUsage({ five_hour: { utilization: 90, resets_at: null }, seven_day: null, limits: [
    { kind: 'session', percent: 90, resets_at: null },
    { kind: 'weekly_scoped', percent: 0, is_active: false, resets_at: '2026-10-18T13:00:00Z', scope: { model: { id: 'fable', display_name: 'Fable' } } },
    { kind: 'new_daily_scoped', percent: 25, scope: { model: { display_name: 'Future' } } },
  ] });
  const fable = value.windows.find(w => w.scope === 'Fable');
  assert.equal(fable.active, false); assert.equal(fable.remainingPercent, 100);
  assert.equal(value.windows.find(w => w.id === 'five_hour').resetsAt, null);
  assert.equal(value.windows.find(w => w.id === 'seven_day').remainingPercent, null);
  assert.equal(value.windows.find(w => w.scope === 'Future').remainingPercent, 75);
});

test('Codex all rate limit buckets derive duration from source and prefer map', () => {
  const { parseCodexRateLimits } = require('../src/providers/codex.cjs');
  const value = parseCodexRateLimits({ rateLimitsByLimitId: { codex: { primary: { usedPercent: 53, windowDurationMins: 300, resetsAt: 1792150000 }, secondary: { usedPercent: null, windowDurationMins: 10080, resetsAt: null } }, special: { primary: { usedPercent: 25, windowDurationMins: 60 } } }, rateLimits: { primary: { usedPercent: 99 } } });
  assert.equal(value.windows.length, 3);
  assert.equal(value.windows[0].remainingPercent, 47);
  assert.deepEqual([value.windows[0].labelKey, value.windows[0].labelParams], ['labelNHours', { n: 5 }]);
  assert.equal(value.windows[1].labelKey, 'labelWeekly');
  assert.equal(value.windows[1].remainingPercent, null);
  assert.equal(value.windows[1].resetsAt, null);
  assert.equal(value.windows[2].scope, 'special');
});

test('Cursor auto/api/total pools remain distinct and cents have units', () => {
  const { parseCursorUsage } = require('../src/providers/cursor.cjs');
  const value = parseCursorUsage({ membershipType: 'pro', billingCycleEnd: '2026-11-07T20:30:22Z', individualUsage: { plan: { used: 2000, limit: 2000, remaining: 0, autoPercentUsed: 14.54, apiPercentUsed: 100, totalPercentUsed: 22.37, breakdown: { bonus: 9075 } }, onDemand: { enabled: false, used: 0, limit: null, remaining: null } } });
  assert.equal(value.plan, 'pro');
  assert.deepEqual(value.windows.filter(w => /^plan:(auto|api|total)$/.test(w.id)).map(w => w.usedPercent), [14.54, 100, 22.37]);
  assert.deepEqual(value.windows.find(w => w.id === 'plan:spend').amounts, { used: 2000, limit: 2000, remaining: 0, bonus: 9075 });
  const onDemand = value.windows.find(w => w.id === 'individual:onDemand');
  assert.deepEqual([onDemand.remainingPercent, onDemand.valueKey, onDemand.amounts], [null, 'disabled', { used: 0 }]);
});


test('Claude discovery reads immediate legitimate credential roots, excludes backups and symlinks', async t => {
  const { discoverClaudeAccounts } = require('../src/providers/claude.cjs');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-discovery-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  for (const name of ['.claude', '.claude-secondary', '.claude-backup', '.claude-empty', '.claude-work']) {
    await fs.mkdir(path.join(dir, name));
    if (name !== '.claude-empty') await fs.writeFile(path.join(dir, name, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'fixture-token' } }));
  }
  const accounts = await discoverClaudeAccounts({ home: dir, platform: 'win32' });
  assert.deepEqual(accounts.map(a => a.id).slice(0, 2), ['claude:default', 'claude:secondary']);
  assert.equal(accounts.length, 3);
});

test('transport rejects nonallowlisted hosts and process runner uses no shell', async () => {
  const { getJson, runProcess } = require('../src/providers/common.cjs');
  await assert.rejects(getJson('https://evil.example/usage', {}), /endpoint_not_allowed/);
  await assert.rejects(getJson('https://api.anthropic.com.evil.example/api/oauth/usage', {}), /endpoint_not_allowed/);
  await assert.rejects(runProcess('node -e something', []), /invalid_binary/);
});

test('Claude adapter passes existing token only to exact usage GET and never refreshes expired token', async t => {
  const { createClaudeProvider } = require('../src/providers/claude.cjs');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-claude-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const credential = path.join(dir, '.credentials.json');
  await fs.writeFile(credential, JSON.stringify({ claudeAiOauth: { accessToken: 'fixture-token', subscriptionType: 'team', expiresAt: 200000 } }));
  let calls = 0;
  const provider = createClaudeProvider({ platform: 'win32', clock: () => 100000, getJson: async (url, options) => { calls++; assert.equal(url, 'https://api.anthropic.com/api/oauth/usage'); assert.equal(options.headers.Authorization, 'Bearer fixture-token'); return { five_hour: { utilization: 10 } }; } });
  const value = await provider.fetch({ configDir: dir });
  assert.equal(value.plan, 'team'); assert.equal(JSON.stringify(value).includes('fixture-token'), false);
  await fs.writeFile(credential, JSON.stringify({ claudeAiOauth: { accessToken: 'fixture-token', expiresAt: 1 } }));
  await assert.rejects(provider.fetch({ configDir: dir }), /auth_expired/); assert.equal(calls, 1);
});

test('empty responses are invalid while limit-free schemas report no limits', () => {
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

test('explicit config dirs keep distinct Keychain services', async () => {
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

test('cleanEnvironment keeps explicit overrides such as CODEX_HOME', () => {
  const { cleanEnvironment } = require('../src/providers/common.cjs');
  const res = cleanEnvironment({ CODEX_HOME: '/explicit/path' }, 'win32', { CODEX_HOME: '/inherited/path' });
  assert.equal(res.CODEX_HOME, '/explicit/path');
  assert.equal(cleanEnvironment({ CODEX_HOME: '/x' }).CODEX_HOME, '/x');
});

test('Claude profiles resolve to stable ids and names', () => {
  const { profileAccount } = require('../src/providers/claude.cjs');
  const home = '/fake/home/user';
  const defaultDir = path.join(home, '.claude');
  const def = profileAccount(defaultDir, defaultDir, false);
  assert.deepEqual([def.id, def.labelKey, def.primary, def.configDirExplicit], ['claude:default', 'accountA', true, false]);
  const explicitDefault = profileAccount(defaultDir, defaultDir, true);
  assert.notEqual(explicitDefault.id, 'claude:default', 'an explicit default dir is a different Keychain item');
  const secondary = profileAccount(path.join(home, '.claude-secondary'), defaultDir, true);
  assert.deepEqual([secondary.id, secondary.labelKey, secondary.primary], ['claude:secondary', 'accountB', false]);
  const custom = profileAccount(path.join(home, 'my-claude-profile'), defaultDir, true);
  assert.match(custom.id, /^claude:[0-9a-f]{12}$/);
  assert.equal(custom.label, 'my-claude-profile');
  assert.equal(profileAccount(path.join(home, '.claude-work'), defaultDir, true).label, 'work');
  assert.equal(profileAccount('/', defaultDir, true).label, '/', 'a folder without a name is shown by its path');
});


test('providers emit semantic window keys', () => {
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
  assert.deepEqual([codexWin.labelKey, codexWin.labelParams, codexWin.durationMinutes], ['labelNHours', { n: 5 }, 300]);
});

test('provider data is language-neutral', () => {
  const { parseCodexRateLimits } = require('../src/providers/codex.cjs');
  const { parseCursorUsage } = require('../src/providers/cursor.cjs');
  const codex = parseCodexRateLimits({ rateLimits: { primary: { usedPercent: 11, windowDurationMins: 43200, resetsAt: 1780000000 } } });
  assert.equal(codex.windows[0].labelKey, 'labelNDays');
  assert.deepEqual(codex.windows[0].labelParams, { n: 30 });

  const cursor = parseCursorUsage({
    individualUsage: { plan: { autoPercentUsed: 10, apiPercentUsed: 0, totalPercentUsed: 5, used: 750, limit: 2000, remaining: 1250 } },
    teamUsage: { onDemand: { enabled: false } }
  });
  const spend = cursor.windows.find(w => w.id === 'plan:spend');
  assert.deepEqual(spend.amounts, { used: 750, limit: 2000, remaining: 1250 });
  assert.equal(spend.valueKey, undefined, 'the UI words the remaining amount itself');
  const team = cursor.windows.find(w => w.id === 'team:onDemand');
  assert.equal(team.group, 'team');
  assert.equal(team.labelKey, 'labelOnDemandSpend');
  assert.equal(team.valueKey, 'disabled');
});
