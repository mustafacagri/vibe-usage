import assert from 'node:assert/strict';
import test from 'node:test';
import { snapshot } from '../scripts/ui-check/fixture.ts';
import { renderSnapshot } from '../src/cli.ts';
import { translator, type Language } from '../src/shared/i18n/index.ts';

test('status output renders every kind of window in the chosen language', () => {
  const now = Date.parse('2026-10-16T20:00:00Z');
  const languages: Language[] = ['en', 'tr', 'ru'];
  for (const language of languages) {
    const output = renderSnapshot(snapshot(language, now), { t: translator(language), locale: language, now });
    assert.match(output, /^CODEX\n/);
    assert.doesNotMatch(output, /undefined|NaN|Invalid Date|\blabel[A-Z]\w+|\bstatus_\w+/, `${language} output leaks raw values`);
  }
  const english = renderSnapshot(snapshot('en', now), { t: translator('en'), locale: 'en', now });
  assert.match(english, /5 hours: 57% remaining · resets in/);
  assert.match(english, /Included usage · spend: \$12\.50 left/);
  assert.match(english, /Weekly \/ Fable: 0% used/);
  assert.match(english, /Rate limited; waiting before retrying\./);
});
