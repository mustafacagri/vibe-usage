import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { appDataDir, defaultSettings, loadSettings, migrateSettings, saveSettings, validateSettings } from '../src/core/settings.ts';
import { PROVIDER_IDS } from '../src/shared/catalog.ts';
import { tempDir } from './helpers/fixtures.ts';

const base = { pinned: false, intervalSeconds: 120, accounts: [] };
const account = (fields: Record<string, unknown> = {}) => ({
  id: 'claude:a',
  providerId: 'claude',
  label: 'A',
  primary: true,
  enabled: true,
  ...fields
});

test('defaults cover every provider and English; absent fields get them', () => {
  assert.deepEqual(defaultSettings().providerOrder, PROVIDER_IDS);
  assert.equal(defaultSettings().language, 'en');
  assert.deepEqual(validateSettings(base), defaultSettings());
});

test('the data folder follows VIBE_DATA_DIR, else the platform convention', () => {
  assert.equal(appDataDir({ VIBE_DATA_DIR: '/tmp/vibe' }, 'darwin'), path.resolve('/tmp/vibe'));
  assert.equal(
    appDataDir({ APPDATA: 'C:\\Users\\me\\AppData\\Roaming' }, 'win32'),
    path.join('C:\\Users\\me\\AppData\\Roaming', 'Vibe Usage')
  );
  assert.match(appDataDir({}, 'darwin'), /Library[\\/]Application Support[\\/]Vibe Usage$/);
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
  for (const invalid of [
    { providerOrder: ['codex', 'codex'] },
    { providerOrder: ['nope'] },
    { preferredModels: { unknown: 'model' } },
    { preferredModels: { codex: 'bad model' } },
    { preferredModels: { codex: '--flag' } }
  ]) {
    assert.throws(() => validateSettings({ ...base, ...invalid }), /invalid_settings/);
  }
  assert.equal(validateSettings({ ...base, preferredModels: { claude: 'sonnet[1m]' } }).preferredModels.claude, 'sonnet[1m]');
});

test('an account is named by the user or by a known label key, never by neither', () => {
  const keyed = validateSettings({ ...base, accounts: [account({ label: undefined, labelKey: 'accountA' })] }).accounts[0];
  assert.equal(keyed?.labelKey, 'accountA');
  assert.equal('label' in keyed, false);
  const named = validateSettings({ ...base, accounts: [account({ label: ' Work ', labelKey: 'accountA' })] }).accounts[0];
  assert.deepEqual([named?.label, named?.labelKey], ['Work', undefined], 'a typed name replaces the key');
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
    migrated.accounts.map(a => a.label ?? `key:${a.labelKey}`),
    ['key:accountA', 'key:defaultAccount', 'me@example.com', 'Work']
  );
  assert.equal('fallbackOrder' in migrated || 'primaryProvider' in migrated, false);
  assert.deepEqual(migrated.preferredModels, { codex: 'gpt-6-luna' }, 'app-only tools take no model');
});

test('atomic round trip persists only public settings and migrates on load', async t => {
  const dir = await tempDir(t, 'vibe-settings-');
  const file = path.join(dir, 'settings.json');
  const settings = {
    ...defaultSettings(),
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
  assert.deepEqual((await loadSettings(file))?.providerOrder, ['cursor', 'claude', 'codex', 'antigravity']);
  await fs.writeFile(file, '{ not json');
  await assert.rejects(loadSettings(file), /invalid_settings: malformed_file/);
  assert.equal(await loadSettings(path.join(dir, 'missing.json')), null);
});
