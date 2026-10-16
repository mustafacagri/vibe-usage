'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { renderSnapshot } = require('../src/cli.cjs');
const { translate } = require('../src/ui/i18n.js');
const { snapshot } = require('../scripts/ui-check/fixture.cjs');

test('status output renders every kind of window in the chosen language', () => {
  const now = Date.parse('2026-10-16T20:00:00Z');
  for (const language of ['en', 'tr', 'ru']) {
    const t = (key, params) => translate(language, key, params);
    const output = renderSnapshot(snapshot(language, now), t, language);
    assert.match(output, /^CODEX\n/);
    assert.doesNotMatch(output, /undefined|NaN|Invalid Date|\blabel[A-Z]\w+|\bstatus_\w+/, `${language} output leaks raw values`);
  }
  const english = renderSnapshot(snapshot('en', now), (key, params) => translate('en', key, params), 'en');
  assert.match(english, /5 hours: 57% remaining · resets in/);
  assert.match(english, /Included usage · spend: \$12\.50 left/);
  assert.match(english, /Weekly \/ Fable: 0% used/);
  assert.match(english, /Rate limited; waiting before retrying\./);
});
