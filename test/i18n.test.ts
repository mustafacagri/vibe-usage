import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { DEFAULT_LANGUAGE, LOCALES, SUPPORTED_LANGUAGES, translate, type MessageKey } from '../src/shared/i18n/index.ts';
import type { AppErrorCode } from '../src/shared/types.ts';

// Compile time: every app error code has a message (the type is `never` when one is missing).
const missingErrorMessages: Exclude<`error_${AppErrorCode}`, MessageKey>[] = [];

const SOURCE = path.join(import.meta.dirname, '..', 'src');
const LOCALE_DIR = path.join(SOURCE, 'shared', 'i18n', 'locales');
// Keys looked up by computed name: `status_<provider code>` and `error_<app code>`.
const DYNAMIC_KEY = /^(status|error)_/;
const NON_TEXT_KEYS = new Set(['name']);
const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;
const placeholders = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/g)].map(m => m[1] ?? '').sort();
const baseKey = (key: string): string => key.replace(PLURAL_SUFFIX, '');
const tables = (): [string, Record<string, string | undefined>][] => SUPPORTED_LANGUAGES.map(language => [language, LOCALES[language]]);
const pluralFamilies = (table: object): string[] =>
  [
    ...new Set(
      Object.keys(table)
        .filter(k => PLURAL_SUFFIX.test(k))
        .map(baseKey)
    )
  ].sort();

async function sourceText(): Promise<string> {
  const files = await fs.readdir(SOURCE, { recursive: true });
  const code = files.map(file => path.join(SOURCE, file)).filter(file => /\.(c?ts|html)$/.test(file) && !file.startsWith(LOCALE_DIR));
  return (await Promise.all(code.map(file => fs.readFile(file, 'utf8')))).join('\n');
}

test('every language has the same placeholders as English, and no empty text', () => {
  const en: Record<string, string | undefined> = LOCALES.en;
  assert.deepEqual(missingErrorMessages, []);
  for (const [language, table] of tables()) {
    assert.deepEqual(pluralFamilies(table), pluralFamilies(en), `${language} plural keys differ`);
    for (const [key, text = ''] of Object.entries(table)) {
      assert.ok(text.trim(), `${language}.${key} is empty`);
      const reference = en[PLURAL_SUFFIX.test(key) ? `${baseKey(key)}_other` : key] ?? '';
      assert.deepEqual(placeholders(text), placeholders(reference), `${language}.${key} placeholders differ`);
    }
  }
});

test('plural keys use only the categories each language distinguishes', () => {
  for (const [language, table] of tables()) {
    const categories: string[] = new Intl.PluralRules(language).resolvedOptions().pluralCategories;
    for (const key of Object.keys(table).filter(k => PLURAL_SUFFIX.test(k))) {
      assert.ok(categories.includes(key.slice(baseKey(key).length + 1)), `${language}.${key} is not a ${language} plural category`);
    }
  }
  assert.equal(translate('ru', 'accountCount', { n: 5 }), '5 аккаунтов');
  assert.equal(translate('ru', 'accountCount', { n: 3 }), '3 аккаунта');
  assert.equal(translate('en', 'labelNHours', { n: 1 }), '1 hour');
  assert.equal(translate('ja', 'labelNHours', { n: 1 }), '1時間');
});

test('every key is referenced by the code', async () => {
  const source = await sourceText();
  const literals = new Set([...source.matchAll(/['"`]([A-Za-z][A-Za-z0-9_]+)['"`]/g)].map(m => m[1]));
  const unused = [...new Set(Object.keys(LOCALES.en).map(baseKey))].filter(
    key => !NON_TEXT_KEYS.has(key) && !DYNAMIC_KEY.test(key) && !literals.has(key)
  );
  assert.deepEqual(unused, []);
});

test('an unknown language falls back to English; parameters are filled in', () => {
  assert.equal(SUPPORTED_LANGUAGES.length, 13);
  assert.equal(translate('tr', 'settingsTitle'), 'Ayarlar');
  assert.equal(translate('xx', 'settingsTitle'), translate(DEFAULT_LANGUAGE, 'settingsTitle'));
  assert.equal(translate('en', 'percentRemaining', { n: '5%' }), '5% remaining');
});
