import assert from 'node:assert/strict';
import test from 'node:test';
import {
  describeCode,
  describeWindow,
  formatDuration,
  formatFreshness,
  gridTimes,
  hasOwnName,
  type FormatContext
} from '../src/shared/format.ts';
import { translator, type Language } from '../src/shared/i18n/index.ts';
import { quotaWindow } from './helpers/fixtures.ts';

const NOW = Date.parse('2026-10-16T20:00:00Z');
const context = (language: Language = 'en'): FormatContext => ({ t: translator(language), locale: language, now: NOW });

test('unknown quota is not treated as full and has no fabricated reset', () => {
  const view = describeWindow(quotaWindow(), context());
  assert.equal(view.value, 'No data');
  assert.equal(view.percent, null);
  assert.equal(view.reset, '');
});

test('zero remaining is preserved and an inactive model scope shows usage, not entitlement', () => {
  assert.equal(describeWindow(quotaWindow({ remainingPercent: 0 }), context()).value, '0% remaining');
  const inactive = describeWindow(quotaWindow({ remainingPercent: 100, usedPercent: 0, scope: 'Fable', active: false }), context());
  assert.equal(inactive.value, '0% used');
  assert.equal(inactive.percent, null);
  assert.match(inactive.detail, /Passive at source/);
});

test('inactive metadata on a general window never hides the measured allowance', () => {
  assert.equal(describeWindow(quotaWindow({ remainingPercent: 95, usedPercent: 5, active: false }), context()).value, '95% remaining');
});

test('money pools show amounts without inventing a percentage', () => {
  const view = describeWindow(quotaWindow({ amounts: { used: 750, limit: 2000, remaining: 1250 } }), context());
  assert.equal(view.value, '$12.50 left');
  assert.equal(view.percent, null);
  assert.equal(view.detail, 'Used: $7.50 · Limit: $20.00 · Remaining: $12.50');
  assert.equal(describeWindow(quotaWindow({ valueKey: 'disabled', amounts: {} }), context()).value, 'Disabled');
});

test('invalid numbers and reset dates never leak NaN or "Invalid Date"', () => {
  const view = describeWindow(quotaWindow({ remainingPercent: NaN, resetsAt: 'nonsense' }), context());
  assert.equal(view.value, 'No data');
  assert.equal(view.reset, '');
  assert.equal(view.resetAt, '');
});

test('labels come from keys; source names are shown verbatim', () => {
  assert.equal(describeWindow(quotaWindow({ labelKey: 'labelNDays', labelParams: { n: 30 } }), context()).label, '30 days');
  assert.equal(describeWindow(quotaWindow({ labelKey: 'labelWeekly' }), context('tr')).label, 'Haftalık');
  assert.equal(describeWindow(quotaWindow({ label: 'Gemini 3.8 Flash' }), context('tr')).label, 'Gemini 3.8 Flash');
  assert.equal(describeWindow(quotaWindow({ labelKey: 'labelOnDemandSpend', group: 'team' }), context()).label, 'Team · On-demand usage');
});

test('percentages, money and countdowns follow the locale', () => {
  const window = quotaWindow({ remainingPercent: 89, resetsAt: '2026-10-16T23:11:00Z' });
  assert.equal(describeWindow(window, context('en')).value, '89% remaining');
  assert.equal(describeWindow(window, context('tr')).value, '%89 kaldı');
  assert.equal(describeWindow(window, context('en')).reset, 'resets in 3h 11m');
  assert.equal(describeWindow(window, context('tr')).reset, '3 sa. 11 dk. sonra yenilenir');
  assert.match(describeWindow(window, context('en')).resetAt, /Oct/);
  assert.equal(describeWindow(quotaWindow({ remainingPercent: 5, resetsAt: '2026-10-16T19:00:00Z' }), context()).reset, 'resetting now');
});

test('countdowns get coarser with distance', () => {
  const minute = 60e3;
  const hour = 60 * minute;
  assert.deepEqual(
    [42 * minute, 9 * hour + 59 * minute, 49 * hour, 4 * 24 * hour + 5 * hour].map(ms => formatDuration(ms, 'en')),
    ['42m', '9h 59m', '49h', '4d 5h']
  );
});

test('retained data after a failed refresh is labelled stale', () => {
  assert.equal(formatFreshness('2026-10-16T19:56:00Z', 'stale', context()), 'Stale data · 4m ago');
  assert.equal(formatFreshness('2026-10-16T19:59:30Z', 'ok', context()), 'just now');
  assert.equal(formatFreshness(undefined, 'ok', context()), 'Not measured yet');
});

test('codes resolve to app errors, then provider statuses, then a generic message', () => {
  const t = translator('en');
  assert.equal(describeCode('session_not_found', t), 'The selected session was not found.');
  assert.equal(describeCode('rate_limited', t), 'Rate limited; waiting before retrying.');
  assert.equal(describeCode('rpc_error', t), 'The Codex app server answered with an error.');
  assert.equal(describeCode('not_a_code', t), t('error_unexpected'), 'only a code the app does not know is generic');
  assert.equal(describeCode('app_not_found', t, { app: 'Cursor' }), 'Cursor is not installed in its default location.');
});

test('an account has a name of its own unless it only has the shared fallback', () => {
  assert.equal(hasOwnName({}), false);
  assert.equal(hasOwnName({ labelKey: 'defaultAccount' }), false);
  assert.equal(hasOwnName({ labelKey: 'newAccount' }), true);
  assert.equal(hasOwnName({ signedInAs: 'someone@example.com' }), true);
  assert.equal(hasOwnName({ label: 'Current account' }), true, 'a typed name that reads like the fallback is still a name');
});

test('chart grid lines fall on the local clock: midnights for a week, every fourth hour for a day', () => {
  const at = (day: number, hour: number): number => new Date(2026, 9, day, hour, 30).getTime();
  assert.deepEqual(
    gridTimes(at(14, 10), at(17, 9), 24),
    [new Date(2026, 9, 15).getTime(), new Date(2026, 9, 16).getTime(), new Date(2026, 9, 17).getTime()],
    'each local midnight inside the span, none outside'
  );
  assert.deepEqual(
    gridTimes(at(16, 9), at(16, 22), 4),
    [12, 16, 20].map(hour => new Date(2026, 9, 16, hour).getTime()),
    'whole four-hour marks of the local clock'
  );
  assert.deepEqual(gridTimes(at(16, 9), at(16, 9), 4), [], 'an empty span has no lines');
});
