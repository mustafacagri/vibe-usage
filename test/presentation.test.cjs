'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { describeWindow, formatFreshness, formatDuration, describeCode } = require('../src/shared.cjs');
const { translate, hasKey } = require('../src/ui/i18n.js');

const NOW = Date.parse('2026-10-16T20:00:00Z');
const context = (language = 'en') => ({ t: (key, params) => translate(language, key, params), locale: language, now: NOW });

test('unknown quota is not treated as full and has no fabricated reset', () => {
  const view = describeWindow({ id: 'w', remainingPercent: null, usedPercent: null, resetsAt: null }, context());
  assert.equal(view.value, 'No data');
  assert.equal(view.percent, null);
  assert.equal(view.reset, '');
});

test('zero remaining is preserved and an inactive model scope shows usage, not entitlement', () => {
  assert.equal(describeWindow({ id: 'w', remainingPercent: 0 }, context()).value, '0% remaining');
  const inactive = describeWindow({ id: 'w', remainingPercent: 100, usedPercent: 0, scope: 'Fable', active: false }, context());
  assert.equal(inactive.value, '0% used');
  assert.equal(inactive.percent, null);
  assert.match(inactive.detail, /Passive at source/);
});

test('inactive metadata on a general window never hides the measured allowance', () => {
  assert.equal(describeWindow({ id: 'w', remainingPercent: 95, usedPercent: 5, active: false }, context()).value, '95% remaining');
});

test('money pools show amounts without inventing a percentage', () => {
  const view = describeWindow({ id: 'w', amounts: { used: 750, limit: 2000, remaining: 1250 } }, context());
  assert.equal(view.value, '$12.50 left');
  assert.equal(view.percent, null);
  assert.equal(view.detail, 'Used: $7.50 · Limit: $20.00 · Remaining: $12.50');
  assert.equal(describeWindow({ id: 'w', valueKey: 'disabled', amounts: {} }, context()).value, 'Disabled');
});

test('invalid numbers and reset dates never leak NaN or "Invalid Date"', () => {
  const view = describeWindow({ id: 'w', remainingPercent: NaN, resetsAt: 'nonsense' }, context());
  assert.equal(view.value, 'No data');
  assert.equal(view.reset, '');
  assert.equal(view.resetAt, '');
});

test('labels come from keys; source names are shown verbatim', () => {
  assert.equal(describeWindow({ id: 'w', labelKey: 'labelNDays', labelParams: { n: 30 } }, context()).label, '30 days');
  assert.equal(describeWindow({ id: 'w', labelKey: 'labelWeekly' }, context('tr')).label, 'Haftalık');
  assert.equal(describeWindow({ id: 'w', label: 'Gemini 3.8 Flash' }, context('tr')).label, 'Gemini 3.8 Flash');
  assert.equal(describeWindow({ id: 'w', labelKey: 'labelOnDemandSpend', group: 'team' }, context()).label, 'Team · On-demand usage');
});

test('percentages, money and countdowns follow the locale', () => {
  const window = { id: 'w', remainingPercent: 89, resetsAt: '2026-10-16T23:11:00Z' };
  assert.equal(describeWindow(window, context('en')).value, '89% remaining');
  assert.equal(describeWindow(window, context('tr')).value, '%89 kaldı');
  assert.equal(describeWindow(window, context('en')).reset, 'resets in 3h 11m');
  assert.equal(describeWindow(window, context('tr')).reset, '3 sa. 11 dk. sonra yenilenir');
  assert.match(describeWindow(window, context('en')).resetAt, /Oct/);
  assert.equal(describeWindow({ id: 'w', remainingPercent: 5, resetsAt: '2026-10-16T19:00:00Z' }, context()).reset, 'resetting now');
});

test('countdowns get coarser with distance', () => {
  const m = 60e3,
    h = 60 * m;
  assert.deepEqual(
    [42 * m, 9 * h + 59 * m, 49 * h, 4 * 24 * h + 5 * h].map(x => formatDuration(x, 'en')),
    ['42m', '9h 59m', '49h', '4d 5h']
  );
});

test('retained data after a failed refresh is labelled stale', () => {
  assert.equal(formatFreshness('2026-10-16T19:56:00Z', 'stale', context()), 'Stale data · 4m ago');
  assert.equal(formatFreshness('2026-10-16T19:59:30Z', 'ok', context()), 'just now');
  assert.equal(formatFreshness(null, 'ok', context()), 'Not measured yet');
});

test('codes resolve to app errors, then provider statuses, then a generic message', () => {
  const ctx = { t: (key, params) => translate('en', key, params), has: hasKey };
  assert.equal(describeCode('session_not_found', ctx), 'The selected session was not found.');
  assert.equal(describeCode('rate_limited', ctx), 'Rate limited; waiting before retrying.');
  assert.equal(describeCode('rpc_error', ctx), translate('en', 'error_unexpected'));
  assert.equal(describeCode('app_not_found', ctx, { app: 'Cursor' }), 'Cursor is not installed in its default location.');
});
