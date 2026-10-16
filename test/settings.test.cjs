'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  validateSettings,
  migrateSettings,
  saveSettings,
  loadSettings,
  defaultSettingsPath,
  DEFAULT_SETTINGS
} = require('../src/core/settings.cjs');
const { PROVIDER_IDS } = require('../src/catalog.cjs');

const base = { pinned: false, intervalSeconds: 120, accounts: [] };
const account = (fields = {}) => ({ id: 'claude:a', providerId: 'claude', label: 'A', primary: true, enabled: true, ...fields });

test('the default settings path is unavailable inside the test runner', () => {
  assert.throws(() => defaultSettingsPath(), /test_suite_cannot_use_default_settings_path/);
});

test('defaults cover every provider and English', () => {
  assert.deepEqual(DEFAULT_SETTINGS.providerOrder, PROVIDER_IDS);
  assert.equal(DEFAULT_SETTINGS.language, 'en');
});

test('invalid intervals, paths, duplicate primaries and unknown fields are rejected', () => {
  for (const intervalSeconds of [0, 29, 901, '120', NaN])
    assert.throws(() => validateSettings({ ...base, intervalSeconds }), /invalid_interval/);
  for (const configDir of ['relative', '\\\\host\\share', '/tmp/../bad', 'C:\\x\u0000y']) {
    assert.throws(() => validateSettings({ ...base, accounts: [account({ configDir })] }), /invalid_path/);
  }
  assert.throws(() => validateSettings({ ...base, accessToken: 'do-not-save' }), /unknown_setting/);
  assert.throws(() => validateSettings({ ...base, accounts: ['a', 'b'].map(id => account({ id: `claude:${id}` })) }), /duplicate_primary/);
  assert.throws(() => validateSettings({ ...base, language: 'xx' }), /invalid_settings/);
});

test('provider order and preferred models are validated', () => {
  const valid = validateSettings({
    ...base,
    providerOrder: ['codex', 'cursor', 'claude', 'antigravity'],
    preferredModels: { codex: 'gpt-6-luna', claude: 'opus' }
  });
  assert.deepEqual(valid.providerOrder, ['codex', 'cursor', 'claude', 'antigravity']);
  assert.equal(valid.preferredModels.claude, 'opus');
  assert.throws(() => validateSettings({ ...base, providerOrder: ['codex', 'codex'] }), /invalid_settings/);
  assert.throws(() => validateSettings({ ...base, providerOrder: ['nope'] }), /invalid_settings/);
  assert.throws(() => validateSettings({ ...base, preferredModels: { unknown: 'model' } }), /invalid_settings/);
  assert.throws(() => validateSettings({ ...base, preferredModels: { codex: 'bad model' } }), /invalid_settings/);
  assert.throws(() => validateSettings({ ...base, preferredModels: { codex: '--flag' } }), /invalid_settings/);
  assert.equal(validateSettings({ ...base, preferredModels: { claude: 'sonnet[1m]' } }).preferredModels.claude, 'sonnet[1m]');
});

test('an account is named by the user or by a known label key, never by neither', () => {
  const keyed = validateSettings({ ...base, accounts: [account({ label: undefined, labelKey: 'accountA' })] }).accounts[0];
  assert.equal(keyed.labelKey, 'accountA');
  assert.equal('label' in keyed, false);
  const named = validateSettings({ ...base, accounts: [account({ label: ' Work ', labelKey: 'accountA' })] }).accounts[0];
  assert.deepEqual([named.label, named.labelKey], ['Work', undefined], 'a typed name replaces the key');
  assert.throws(() => validateSettings({ ...base, accounts: [account({ label: undefined })] }), /invalid_account_label/);
  assert.throws(
    () => validateSettings({ ...base, accounts: [account({ label: undefined, labelKey: 'madeUp' })] }),
    /invalid_account_label/
  );
});

test('settings written by 0.1.x migrate to the current shape', () => {
  const legacy = {
    ...base,
    primaryProvider: 'codex',
    fallbackOrder: ['claude', 'codex', 'cursor'],
    providerOrder: ['claude', 'codex', 'cursor', 'antigravity'],
    preferredModels: { antigravity: 'gemini-3.8-flash', codex: 'gpt-6-luna' },
    accounts: [
      account({ id: 'claude:default', label: 'Hesap A' }),
      account({ id: 'codex:default', providerId: 'codex', label: 'Mevcut hesap' }),
      account({ id: 'antigravity:abc', providerId: 'antigravity', label: 'Antigravity (me@example.com)', email: 'me@example.com' }),
      account({ id: 'claude:work', label: 'Work', primary: false })
    ]
  };
  const migrated = validateSettings(migrateSettings(legacy));
  assert.deepEqual(migrated.providerOrder, ['codex', 'claude', 'cursor', 'antigravity']);
  assert.deepEqual(
    migrated.accounts.map(a => a.label || `key:${a.labelKey}`),
    ['key:accountA', 'key:defaultAccount', 'me@example.com', 'Work']
  );
  assert.equal('fallbackOrder' in migrated || 'primaryProvider' in migrated, false);
  assert.deepEqual(migrated.preferredModels, { codex: 'gpt-6-luna' }, 'app-only tools take no model');
});

test('atomic round trip persists only public settings and migrates on load', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibe-settings-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'settings.json');
  const settings = {
    pinned: true,
    intervalSeconds: 180,
    accounts: [account({ id: 'claude:secondary', label: 'Work', configDir: dir })],
    window: { x: 1, y: 2, width: 380, height: 760 }
  };
  await saveSettings(file, settings);
  assert.deepEqual(await loadSettings(file), settings);
  assert.deepEqual(await fs.readdir(dir), ['settings.json']);
  await assert.rejects(saveSettings(file, { ...settings, token: 'secret' }), /unknown_setting/);
  await fs.writeFile(file, JSON.stringify({ ...base, fallbackOrder: ['cursor'] }));
  assert.deepEqual((await loadSettings(file)).providerOrder, ['cursor', 'claude', 'codex', 'antigravity']);
});
