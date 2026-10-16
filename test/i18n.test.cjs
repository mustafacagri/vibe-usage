'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { I18N, SUPPORTED_LANGUAGES, DEFAULT_LANGUAGE, translate, hasKey, t, setLanguage } = require('../src/ui/i18n.js');

const SOURCE_DIRS = ['src', 'src/core', 'src/providers', 'src/ui'];
// Keys looked up by computed name: `status_<provider code>` and `error_<app code>`.
const DYNAMIC_KEY = /^(status|error)_/;
const NON_TEXT_KEYS = new Set(['name']);
const placeholders = text => [...text.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort();

async function sourceText() {
  const files = [];
  for (const dir of SOURCE_DIRS) {
    for (const name of await fs.readdir(path.join(__dirname, '..', dir))) {
      if (/\.(cjs|js|html)$/.test(name) && name !== 'i18n.js') files.push(path.join(__dirname, '..', dir, name));
    }
  }
  return (await Promise.all(files.map(f => fs.readFile(f, 'utf8')))).join('\n');
}

const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;
const baseKey = key => key.replace(PLURAL_SUFFIX, '');
const pluralFamilies = table => [
  ...new Set(
    Object.keys(table)
      .filter(k => PLURAL_SUFFIX.test(k))
      .map(baseKey)
  )
];

test('every language defines the same keys, non-empty, with the same placeholders', () => {
  const singular = table =>
    Object.keys(table)
      .filter(k => !PLURAL_SUFFIX.test(k))
      .sort();
  const en = I18N[DEFAULT_LANGUAGE];
  for (const language of SUPPORTED_LANGUAGES) {
    const table = I18N[language];
    assert.deepEqual(singular(table), singular(en), `${language} keys differ`);
    assert.deepEqual(pluralFamilies(table).sort(), pluralFamilies(en).sort(), `${language} plural keys differ`);
    for (const key of Object.keys(table)) {
      assert.ok(table[key].trim(), `${language}.${key} is empty`);
      const reference = PLURAL_SUFFIX.test(key) ? en[`${baseKey(key)}_other`] : en[key];
      assert.deepEqual(placeholders(table[key]), placeholders(reference), `${language}.${key} placeholders differ`);
    }
  }
});

test('plural keys use only the categories each language distinguishes', () => {
  for (const language of SUPPORTED_LANGUAGES) {
    const categories = new Intl.PluralRules(language).resolvedOptions().pluralCategories;
    for (const family of pluralFamilies(I18N[language])) {
      assert.ok(`${family}_other` in I18N[language], `${language}.${family}_other missing`);
      for (const key of Object.keys(I18N[language]).filter(k => baseKey(k) === family && k !== family)) {
        assert.ok(categories.includes(key.slice(family.length + 1)), `${language}.${key} is not a ${language} plural category`);
      }
    }
  }
  assert.equal(translate('ru', 'accountCount', { n: 5 }), '5 аккаунтов');
  assert.equal(translate('ru', 'accountCount', { n: 3 }), '3 аккаунта');
  assert.equal(translate('en', 'labelNHours', { n: 1 }), '1 hour');
  assert.equal(translate('ja', 'labelNHours', { n: 1 }), '1時間');
});

test('every key the code references exists, and every key is referenced', async () => {
  const source = await sourceText();
  const literals = new Set([...source.matchAll(/['"`]([A-Za-z][A-Za-z0-9_]+)['"`]/g)].map(m => m[1]));
  const referenced = [...source.matchAll(/\bt\('(\w+)'|data-i18n(?:-title|-aria)?="(\w+)"/g)].map(m => m[1] || m[2]);
  assert.deepEqual(
    referenced.filter(key => !hasKey(key)),
    [],
    'missing keys'
  );
  const unused = [...new Set(Object.keys(I18N.en).map(baseKey))].filter(
    key => !NON_TEXT_KEYS.has(key) && !DYNAMIC_KEY.test(key) && !literals.has(key)
  );
  assert.deepEqual(unused, [], 'unused keys');
});

test('every app error code has a message', async () => {
  const source = await sourceText();
  const codes = new Set([...source.matchAll(/new AppError\('(\w+)'/g)].map(m => m[1]));
  assert.ok(codes.size > 5);
  assert.deepEqual(
    [...codes].filter(code => !(`error_${code}` in I18N.en) && !(`status_${code}` in I18N.en)),
    []
  );
});

test('lookups fall back to English, then to the key', () => {
  assert.equal(SUPPORTED_LANGUAGES.length, 13);
  assert.equal(translate('tr', 'settingsTitle'), 'Ayarlar');
  assert.equal(translate('xx', 'settingsTitle'), 'Settings');
  assert.equal(translate('en', 'no_such_key'), 'no_such_key');
  assert.equal(translate('en', 'percentRemaining', { n: '5%' }), '5% remaining');
  setLanguage('de');
  assert.equal(t('settingsTitle'), I18N.de.settingsTitle);
  setLanguage('xx');
  assert.equal(t('settingsTitle'), I18N.de.settingsTitle, 'unknown languages are ignored');
  setLanguage(DEFAULT_LANGUAGE);
});
