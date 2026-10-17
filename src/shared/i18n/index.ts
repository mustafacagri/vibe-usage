// UI strings and their lookup, shared by the renderer, the main process and the CLI. Each of
// them holds its own language; nothing here is stateful.
import type { MessageKey, Messages, PluralKey } from './messages.ts';
import { de } from './locales/de.ts';
import { en } from './locales/en.ts';
import { es } from './locales/es.ts';
import { fr } from './locales/fr.ts';
import { it } from './locales/it.ts';
import { ja } from './locales/ja.ts';
import { ko } from './locales/ko.ts';
import { nl } from './locales/nl.ts';
import { pl } from './locales/pl.ts';
import { pt } from './locales/pt.ts';
import { ru } from './locales/ru.ts';
import { tr } from './locales/tr.ts';
import { zh } from './locales/zh.ts';

export type { MessageKey } from './messages.ts';

export const SUPPORTED_LANGUAGES = ['en', 'tr', 'de', 'es', 'fr', 'it', 'pt', 'nl', 'pl', 'ja', 'ko', 'zh', 'ru'] as const;
export type Language = (typeof SUPPORTED_LANGUAGES)[number];
export const DEFAULT_LANGUAGE: Language = 'en';

export const LOCALES: Readonly<Record<Language, Messages>> = { en, tr, de, es, fr, it, pt, nl, pl, ja, ko, zh, ru };

export type Params = Readonly<Record<string, string | number>>;
export type Translate = (key: MessageKey, params?: Params) => string;

const PLURAL_SUFFIX = '_other';
const PLURAL_FAMILIES: ReadonlySet<string> = new Set(
  Object.keys(en)
    .filter(key => key.endsWith(PLURAL_SUFFIX))
    .map(key => key.slice(0, -PLURAL_SUFFIX.length))
);

const isPluralKey = (key: string): key is PluralKey => PLURAL_FAMILIES.has(key);

export function isLanguage(value: unknown): value is Language {
  return typeof value === 'string' && Object.hasOwn(LOCALES, value);
}

// Key names computed at run time (`error_<code>`) are checked before lookup.
export function hasKey(key: string): key is MessageKey {
  return Object.hasOwn(en, key) || isPluralKey(key);
}

// A plural key resolves by `params.n`; without a number it uses the `_other` form.
function pluralText(language: Language, key: PluralKey, n: unknown): string {
  const table = LOCALES[language];
  const category = typeof n === 'number' ? new Intl.PluralRules(language).select(n) : 'other';
  return (category === 'other' ? undefined : table[`${key}_${category}`]) ?? table[`${key}_other`];
}

export function translate(language: string, key: MessageKey, params: Params = {}): string {
  const resolved = isLanguage(language) ? language : DEFAULT_LANGUAGE;
  const text = isPluralKey(key) ? pluralText(resolved, key, params.n) : LOCALES[resolved][key];
  return Object.entries(params).reduce((result, [name, value]) => result.replaceAll(`{${name}}`, String(value)), text);
}

export const translator =
  (language: string): Translate =>
  (key, params) =>
    translate(language, key, params);
