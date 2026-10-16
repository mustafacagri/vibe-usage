'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeWindow, safePlan } = require('../src/core/model.cjs');

test('unknown numbers and resets stay unknown; measured percentages are clamped', () => {
  assert.deepEqual(normalizeWindow({ id: 'weekly', labelKey: 'labelWeekly', usedPercent: null }), {
    id: 'weekly',
    usedPercent: null,
    remainingPercent: null,
    resetsAt: null,
    labelKey: 'labelWeekly'
  });
  assert.equal(normalizeWindow({ id: 'a', usedPercent: 140 }).remainingPercent, 0);
  assert.equal(normalizeWindow({ id: 'b', usedPercent: '0' }).remainingPercent, null);
  assert.equal(normalizeWindow({ id: 'c', remainingPercent: NaN }).usedPercent, null);
});

test('only contract fields survive; amounts keep finite numbers only', () => {
  const window = normalizeWindow({
    id: 'spend',
    section: 'details',
    group: 'team',
    amounts: { used: 5, limit: Infinity, remaining: '7', bonus: 1 },
    source: 'IDE',
    valueText: 'legacy',
    section2: 'x'
  });
  assert.deepEqual(window, {
    id: 'spend',
    usedPercent: null,
    remainingPercent: null,
    resetsAt: null,
    group: 'team',
    section: 'details',
    amounts: { used: 5, bonus: 1 }
  });
  assert.equal(normalizeWindow({ id: 'x', group: 'individual', section: 'main' }).group, undefined);
});

test('plan names are kept only when they look like a plan name', () => {
  assert.equal(safePlan('pro'), 'pro');
  assert.equal(safePlan('Team Plus'), 'Team Plus');
  assert.equal(safePlan('<script>'), undefined);
  assert.equal(safePlan(42), undefined);
});
