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
// Languages that write words without spaces between them. Elsewhere a letter right after a
// placeholder is a leftover the value already carries: "{time}in" showed "5 minin".
const UNSPACED_LANGUAGES: ReadonlySet<string> = new Set(['ja', 'ko', 'zh']);
// Endings whose form depends on how the value before them sounds (Codex'e but Claude'a; 을 or 를).
// A value that varies takes no Turkish suffix, and both Korean forms: "{tool}을(를)".
const TURKISH_SUFFIX = /\{\w+\}['’]\p{L}/u;
const KOREAN_SOUND_PARTICLE = /\{\w+\}(?:[은는이가을를과와로](?!\()|으로)/u;
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

test('no text depends on how a filled-in value ends', () => {
  for (const [language, table] of tables()) {
    for (const [key, text = ''] of Object.entries(table)) {
      if (!UNSPACED_LANGUAGES.has(language)) assert.doesNotMatch(text, /\{\w+\}\p{L}/u, `${language}.${key} glues a word to a value`);
    }
  }
  for (const [key, text] of Object.entries(LOCALES.tr)) assert.doesNotMatch(text, TURKISH_SUFFIX, `tr.${key}`);
  for (const [key, text] of Object.entries(LOCALES.ko)) assert.doesNotMatch(text, KOREAN_SOUND_PARTICLE, `ko.${key}`);
});

test('each language writes one kind of apostrophe', () => {
  for (const [language, table] of tables()) {
    const text = Object.values(table).join('\n');
    assert.ok(!(/\p{L}'\p{L}/u.test(text) && /\p{L}’\p{L}/u.test(text)), `${language} mixes ' and ’`);
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
