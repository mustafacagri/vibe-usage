import type { en } from './locales/en.ts';

type EnglishKey = keyof typeof en;
type PluralCategory = Intl.LDMLPluralRule;
type PluralFamily<K> = K extends `${infer Base}_other` ? Base : never;

// Keys with CLDR plural variants (`key_one`, `key_few`, … `key_other`), looked up by base name.
export type PluralKey = PluralFamily<EnglishKey>;
type PluralVariant = `${PluralKey}_${PluralCategory}`;
type SingularKey = Exclude<EnglishKey, PluralVariant>;

export type MessageKey = SingularKey | PluralKey;

// A locale defines every singular key and `_other` for every plural family, plus only the
// plural categories its grammar distinguishes. English is the reference.
export type Messages = Record<SingularKey, string> &
  Record<`${PluralKey}_other`, string> &
  Partial<Record<`${PluralKey}_${Exclude<PluralCategory, 'other'>}`, string>>;
