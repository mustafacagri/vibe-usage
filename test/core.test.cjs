const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

test('window settings saved during refresh do not detach accounts from results', async t=>{
 const {createService}=require('../src/core/service.cjs');
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'vibe-window-race-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 let complete;const response=new Promise(resolve=>{complete=resolve;});
 const svc=await createService({settingsPath:path.join(dir,'s.json'),providers:[{id:'claude',name:'Claude',discover:async()=>[{id:'claude:default',providerId:'claude',label:'A',primary:true,enabled:true}],fetch:()=>response}]});
 const refresh=svc.refresh();await svc.updateSettings({window:{x:0,y:0,width:430,height:800}});complete({windows:[{id:'five_hour',usedPercent:20}]});await refresh;
 assert.equal(svc.snapshot().providers[0].accounts[0].status,'ok');assert.equal(svc.snapshot().providers[0].accounts[0].windows[0].remainingPercent,80);
});

test('normalization keeps unknown numbers/reset unknown and clamps measured percentages', () => {
  const { normalizeWindow } = require('../src/core/model.cjs');
  assert.deepEqual(normalizeWindow({ id: 'weekly', label: 'Weekly', usedPercent: null }), {
    id: 'weekly', label: 'Weekly', usedPercent: null, remainingPercent: null, resetsAt: null,
  });
  assert.equal(normalizeWindow({ id: 'a', usedPercent: 140 }).remainingPercent, 0);
  assert.equal(normalizeWindow({ id: 'b', usedPercent: '0' }).remainingPercent, null);
  assert.equal(normalizeWindow({ id: 'c', remainingPercent: NaN }).usedPercent, null);
});

test('eligibility refuses unknown, stale, exhausted, inactive model records and absent scope', () => {
  const { isAccountEligible } = require('../src/core/model.cjs');
  const account = { status: 'ok', windows: [{ remainingPercent: 40 }] };
  assert.equal(isAccountEligible(account), true);
  assert.equal(isAccountEligible({ ...account, status: 'stale' }), false);
  assert.equal(isAccountEligible({ status: 'ok', windows: [{ remainingPercent: null }] }), false);
  assert.equal(isAccountEligible({ status: 'ok', windows: [] }), false);
  assert.equal(isAccountEligible(account, 'Fable'), false);
  assert.equal(isAccountEligible({ status: 'ok', windows: [...account.windows, { scope: 'Fable', active: false, remainingPercent: 100 }] }, 'Fable'), false);
});

test('settings reject invalid intervals, relative/network paths, duplicate primary and credential fields', () => {
  const { validateSettings } = require('../src/core/settings.cjs');
  const base = { pinned: false, intervalSeconds: 120, accounts: [] };
  for (const intervalSeconds of [0, 29, 901, '120', NaN]) assert.throws(() => validateSettings({ ...base, intervalSeconds }), /invalid_interval/);
  for (const configDir of ['relative', '\\\\host\\share', '/tmp/../bad', 'C:\\x\u0000y']) {
    assert.throws(() => validateSettings({ ...base, accounts: [{ id: 'claude:a', providerId: 'claude', label: 'A', primary: true, enabled: true, configDir }] }), /invalid_config_path/);
  }
  assert.throws(() => validateSettings({ ...base, accessToken: 'do-not-save' }), /unknown_setting/);
  assert.throws(() => validateSettings({ ...base, accounts: ['a', 'b'].map(id => ({ id, providerId: 'claude', label: id, primary: true, enabled: true })) }), /duplicate_primary/);
});

test('atomic settings round trip persists only public settings', async t => {
  const { saveSettings, loadSettings } = require('../src/core/settings.cjs');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-core-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'settings.json');
  const settings = { pinned: true, intervalSeconds: 180, accounts: [{ id: 'claude:secondary', providerId: 'claude', label: 'Work', configDir: dir, primary: true, enabled: true }], window: { x: 1, y: 2, width: 380, height: 760 } };
  await saveSettings(file, settings);
  assert.deepEqual(await loadSettings(file), settings);
  assert.deepEqual(await fs.readdir(dir), ['settings.json']);
  await assert.rejects(saveSettings(file, { ...settings, token: 'secret' }), /unknown_setting/);
});

test('service isolates accounts, deduplicates refresh, preserves last-good on failure and sanitizes errors', async t => {
  const { createService } = require('../src/core/service.cjs');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-service-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  let failed = false, calls = 0, time = 100000;
  const provider = { id: 'claude', name: 'Claude', discover: async () => [
    { id: 'claude:default', providerId: 'claude', label: 'Default', primary: true, enabled: true },
    { id: 'claude:secondary', providerId: 'claude', label: 'Secondary', primary: false, enabled: true },
  ], fetch: async account => { calls++; await new Promise(resolve => setTimeout(resolve, 5)); if (failed) throw new Error('secret-token-raw-response'); return { plan: 'pro', windows: [{ id: 'session', label: '5 hours', usedPercent: account.primary ? 90 : 0 }] }; } };
  const svc = await createService({ settingsPath: path.join(dir, 'settings.json'), providers: [provider], clock: () => time });
  const [first] = await Promise.all([svc.refresh(), svc.refresh()]);
  assert.equal(calls, 2);
  assert.deepEqual(first.providers[0].accounts.map(a => a.windows[0].remainingPercent), [10, 100]);
  const fetchedAt = first.providers[0].fetchedAt;
  failed = true; time += 1000;
  const second = await svc.refresh();
  assert.equal(second.providers[0].status, 'stale');
  assert.equal(second.providers[0].fetchedAt, fetchedAt);
  assert.equal(second.providers[0].accounts[0].windows[0].remainingPercent, 10);
  assert.equal(second.providers[0].accounts[0].status, 'stale');
  assert.equal(JSON.stringify(second).includes('secret-token'), false);
  const copy = svc.snapshot(); copy.settings.pinned = true;
  assert.equal(svc.snapshot().settings.pinned, false);
  await svc.updateSettings({ pinned: true, intervalSeconds: 60 });
  assert.equal(svc.snapshot().settings.pinned, true);
});

test('rate-limited account waits for bounded backoff without classifying exhaustion', async t => {
  const { createService } = require('../src/core/service.cjs');
  const { ProviderError } = require('../src/providers/common.cjs');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-backoff-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  let time = 100000, calls = 0;
  const svc = await createService({ settingsPath: path.join(dir, 's.json'), clock: () => time, providers: [{ id: 'cursor', name: 'Cursor', discover: async () => [{ id: 'cursor:default', providerId: 'cursor', label: 'Current', primary: true, enabled: true }], fetch: async () => { calls++; throw new ProviderError('rate_limited', { retryAfterSeconds: 90 }); } }] });
  await svc.refresh(); await svc.refresh(); assert.equal(calls, 1);
  assert.equal(svc.snapshot().providers[0].accounts[0].status, 'rate_limited');
  time += 91000; await svc.refresh(); assert.equal(calls, 2);
});
