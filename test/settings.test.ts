import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { appDataDir, defaultSettings, loadSettings, saveSettings, validateSettings } from '../src/core/settings.ts';
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

test('defaults cover every tool work moves between and English; absent fields get them', () => {
  assert.deepEqual(defaultSettings().providerOrder, ['claude', 'codex', 'cursor', 'antigravity']);
  assert.equal(defaultSettings().language, 'en');
  assert.equal(defaultSettings().notifications, false);
  assert.deepEqual(validateSettings(base), defaultSettings());
  assert.equal(validateSettings({ ...base, notifications: true }).notifications, true);
  assert.throws(() => validateSettings({ ...base, notifications: 'yes' }), /invalid_notifications/);
  assert.equal(defaultSettings().compareAccounts, false);
  assert.equal(validateSettings({ ...base, compareAccounts: true }).compareAccounts, true);
  assert.throws(() => validateSettings({ ...base, compareAccounts: 1 }), /invalid_compare_accounts/);
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
  assert.equal(valid.homeOrder, undefined, 'without a home order the fallback order is shown');
  assert.deepEqual(validateSettings({ ...base, homeOrder: ['cursor', 'claude'] }).homeOrder, ['cursor', 'claude']);
  for (const invalid of [
    { homeOrder: ['claude', 'claude'] },
    { providerOrder: ['codex', 'codex'] },
    { providerOrder: ['nope'] },
    { preferredModels: { unknown: 'model' } },
    { preferredModels: { codex: 'bad model' } },
    { preferredModels: { codex: '--flag' } },
    { preferredModels: { antigravity: 'gemini-3.8-flash' } }
  ]) {
    assert.throws(() => validateSettings({ ...base, ...invalid }), /invalid_settings/);
  }
  assert.equal(validateSettings({ ...base, preferredModels: { claude: 'sonnet[1m]' } }).preferredModels.claude, 'sonnet[1m]');
});

test('a settings file from an earlier version is read without the settings that no longer exist', () => {
  const settings = validateSettings({ ...base, globalShortcut: true });
  assert.equal('globalShortcut' in settings, false);
  assert.throws(() => validateSettings({ ...base, madeUp: true }), /unknown_setting/, 'an unknown setting is still refused');
});

test('a typed account name keeps the app-supplied key beside it, so clearing the name brings it back', () => {
  const keyed = validateSettings({ ...base, accounts: [account({ label: undefined, labelKey: 'accountA' })] }).accounts[0];
  assert.equal(keyed?.labelKey, 'accountA');
  assert.equal('label' in keyed, false);
  const named = validateSettings({ ...base, accounts: [account({ label: ' Work ', labelKey: 'accountA' })] }).accounts[0];
  assert.deepEqual([named?.label, named?.labelKey], ['Work', 'accountA'], 'the typed name is shown; the key stays');
  const cleared = validateSettings({ ...base, accounts: [account({ label: undefined, labelKey: 'accountA' })] }).accounts[0];
  assert.deepEqual([cleared?.label, cleared?.labelKey], [undefined, 'accountA'], 'cleared: the app-supplied name again');
  const unnamed = validateSettings({ ...base, accounts: [{ id: 'codex:work', providerId: 'codex', primary: true, enabled: true }] })
    .accounts[0];
  assert.deepEqual(
    [unnamed?.label, unnamed?.labelKey],
    [undefined, undefined],
    'a folder account cleared of its name is shown by its sign-in'
  );
  assert.throws(
    () => validateSettings({ ...base, accounts: [account({ label: undefined, labelKey: 'madeUp' })] }),
    /invalid_account_label/
  );
});

test('atomic round trip persists only public settings', async t => {
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
  assert.deepEqual((await fs.readdir(dir)).sort(), ['settings.json', 'settings.json.lock.sqlite']);
  await assert.rejects(saveSettings(file, { ...settings, token: 'secret' }), /unknown_setting/);
  await fs.writeFile(file, JSON.stringify({ ...base, fallbackOrder: ['cursor'] }));
  await assert.rejects(loadSettings(file), /unknown_setting/);
  await fs.writeFile(file, '{ not json');
  await assert.rejects(loadSettings(file), /invalid_settings: malformed_file/);
  assert.equal(await loadSettings(path.join(dir, 'missing.json')), null);
});

test('hidden tools are a duplicate-free list of known tools that leaves at least one visible', () => {
  assert.deepEqual(validateSettings(base).hiddenProviders, []);
  assert.deepEqual(validateSettings({ ...base, hiddenProviders: ['antigravity', 'cursor'] }).hiddenProviders, ['antigravity', 'cursor']);
  for (const hiddenProviders of [['cursor', 'cursor'], ['nope'], 'cursor', ['claude', 'codex', 'cursor', 'antigravity', 'copilot']])
    assert.throws(() => validateSettings({ ...base, hiddenProviders }), /invalid_/, JSON.stringify(hiddenProviders));
});

test('looking at the status pages is on until it is turned off, and only a boolean says so', () => {
  assert.equal(validateSettings(base).checkServiceStatus, true);
  assert.equal(validateSettings({ ...base, checkServiceStatus: false }).checkServiceStatus, false);
  assert.throws(() => validateSettings({ ...base, checkServiceStatus: 'no' }), /invalid_settings/);
});

test("a tool that only reports its quota can be hidden, but is never a fallback or a project's tool", () => {
  assert.deepEqual(validateSettings({ ...base, hiddenProviders: ['copilot'] }).hiddenProviders, ['copilot']);
  assert.throws(() => validateSettings({ ...base, providerOrder: ['copilot', 'claude'] }), /invalid_provider_order/);
  const projectDir = path.resolve('project');
  assert.throws(
    () => validateSettings({ ...base, projectPreferences: [{ projectDir, tool: 'copilot', autoContinue: 'inherit' }] }),
    /invalid_project_preference/
  );
});

test('the order the window shows holds every tool, the fallback order only those that run work', () => {
  const home = ['copilot', 'claude', 'codex', 'cursor', 'antigravity'];
  assert.deepEqual(validateSettings({ ...base, homeOrder: home }).homeOrder, home);
  assert.throws(() => validateSettings({ ...base, homeOrder: ['nope'] }), /invalid_provider_order/);
});
