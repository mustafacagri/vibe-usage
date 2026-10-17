import assert from 'node:assert/strict';
import test from 'node:test';
import { isoDate, isoFromUnixSeconds, normalizeWindow, safePlan } from '../src/core/model.ts';

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
  const input = {
    id: 'spend',
    section: 'details',
    group: 'team',
    amounts: { used: 5, limit: Infinity, remaining: '7', bonus: 1 },
    source: 'IDE'
  } as const;
  assert.deepEqual(normalizeWindow(input), {
    id: 'spend',
    usedPercent: null,
    remainingPercent: null,
    resetsAt: null,
    group: 'team',
    section: 'details',
    amounts: { used: 5, bonus: 1 }
  });
  assert.equal(normalizeWindow({ id: 'x', group: 'individual' }).group, undefined);
});

test('dates are accepted as ISO text, Date or epoch seconds only', () => {
  assert.equal(isoDate('2026-10-16T20:00:00Z'), '2026-10-16T20:00:00.000Z');
  assert.equal(isoDate(1792150000), null, 'a bare number is not a date string');
  assert.equal(isoDate('nonsense'), null);
  assert.equal(isoFromUnixSeconds(1792150000), '2026-10-16T11:26:40.000Z');
  assert.equal(isoFromUnixSeconds('1792150000'), null);
});

test('plan names are kept only when they look like a plan name', () => {
  assert.equal(safePlan('pro'), 'pro');
  assert.equal(safePlan('Team Plus'), 'Team Plus');
  assert.equal(safePlan('<script>'), undefined);
  assert.equal(safePlan(42), undefined);
});
