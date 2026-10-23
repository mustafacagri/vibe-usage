import assert from 'node:assert/strict';
import test from 'node:test';
import { compactLines, needsSignIn, toolNotFound } from '../src/shared/account-state.ts';
import type { AccountStatus, MeasuredAccount, ProviderState, QuotaWindow } from '../src/shared/types.ts';
import { measuredAccount, quotaWindow } from './helpers/fixtures.ts';

const HOUR = 60;

function only<T>(items: readonly T[], index = 0): T {
  const item = items[index];
  assert.ok(item);
  return item;
}
const limit = (id: string, remaining: number, fields: Partial<QuotaWindow> = {}): QuotaWindow =>
  quotaWindow({ id, remainingPercent: remaining, usedPercent: 100 - remaining, ...fields });
const reading = (fields: Partial<MeasuredAccount>): MeasuredAccount =>
  measuredAccount({ id: 'claude:a', status: 'ok', fetchedAt: '2026-10-17T12:00:00.000Z', windows: [], ...fields });
const tool = (accounts: MeasuredAccount[]): ProviderState => ({ id: 'claude', status: 'ok', accounts });

test('signing in is offered when the source asks for it or a read keeps failing, not while waiting', () => {
  const never = (status: AccountStatus) => needsSignIn(reading({ status, windows: [] }));
  assert.equal(never('auth_expired'), true);
  assert.equal(never('app_closed'), true);
  assert.equal(never('invalid_response'), true, 'never read, and it does not pass by itself');
  assert.equal(never('rate_limited'), false);
  assert.equal(never('transport_error'), false);
  assert.equal(never('pending'), false);
  assert.equal(needsSignIn(reading({ status: 'stale', windows: [limit('five_hour', 50)] })), false);
});

test('a tool that is not found is not signed in to: the window sends the user to the diagnostics', () => {
  for (const status of ['binary_missing', 'invalid_binary'] as const) {
    const account = reading({ status, windows: [] });
    assert.equal(toolNotFound(account), true);
    assert.equal(needsSignIn(account), false);
    assert.equal(only(compactLines(tool([account]), 20)).note, 'notFound');
  }
  assert.equal(toolNotFound({ status: 'auth_missing' }), false);
  // A program the system will not start is there: it is blocked, and that is no sign-in matter either.
  const blocked = reading({ status: 'process_blocked', windows: [] });
  assert.deepEqual([toolNotFound(blocked), needsSignIn(blocked), only(compactLines(tool([blocked]), 20)).note], [false, false, 'blocked']);
  assert.equal(toolNotFound({ status: 'unavailable' }), false);
});

test('each account shows its session limit, and a longer one that runs out first beside it', () => {
  const lines = compactLines(
    tool([
      reading({
        id: 'claude:b',
        primary: false,
        windows: [limit('five_hour', 100, { durationMinutes: 5 * HOUR }), limit('seven_day', 8, { durationMinutes: 7 * 24 * HOUR })]
      }),
      reading({
        id: 'claude:a',
        primary: true,
        windows: [limit('seven_day', 70, { durationMinutes: 7 * 24 * HOUR }), limit('five_hour', 56, { durationMinutes: 5 * HOUR })]
      })
    ]),
    20
  );
  const mainLine = only(lines, 0);
  const spareLine = only(lines, 1);
  assert.equal(mainLine.account.id, 'claude:a', 'the main account first');
  assert.equal(mainLine.window?.id, 'five_hour');
  assert.equal(mainLine.tighter, null, 'its weekly has more left');
  assert.equal(spareLine.window?.id, 'five_hour', 'the session limit, not the weekly one');
  assert.equal(spareLine.tighter?.id, 'seven_day');
  assert.deepEqual([spareLine.low, spareLine.tighterLow], [false, true], 'only the weekly one is low');
});

test('a limit on part of the account is not its headline; without a whole-account one, the scoped ones are', () => {
  const lineOf = (windows: QuotaWindow[]) => only(compactLines(tool([reading({ windows })]), 20));
  const cursor = lineOf([limit('plan:auto', 76.5), limit('plan:api', 0, { partial: true }), limit('spend', 5, { section: 'details' })]);
  assert.equal(cursor.window?.id, 'plan:auto');
  assert.equal(cursor.other?.id, 'plan:api', 'the spent API pool is named');
  assert.equal(cursor.tighter, null, 'but it does not run the account out');
  const models = lineOf([
    limit('gemini-week', 76, { scope: 'Gemini', durationMinutes: 7 * 24 * HOUR }),
    limit('gemini-5h', 60, { scope: 'Gemini', durationMinutes: 5 * HOUR }),
    limit('claude-5h', 90, { scope: 'Claude', durationMinutes: 5 * HOUR }),
    limit('spent', 1, { scope: 'Opus', active: false, durationMinutes: 5 * HOUR })
  ]);
  assert.equal(models.window?.id, 'spent', 'the shortest, tightest of them; a scope reported inactive still binds');
  const unknownLength = lineOf([limit('monthly', 10), limit('daily', 80, { durationMinutes: 24 * HOUR })]);
  assert.equal(unknownLength.window?.id, 'daily', 'a window without a length counts as the longest');
  assert.equal(unknownLength.tighter?.id, 'monthly');
});

test('a line without a number says why: reading, waiting, signing in, the app, or no limits', () => {
  const notes = compactLines(
    tool([
      reading({ id: 'a', status: 'pending' }),
      reading({ id: 'b', status: 'rate_limited' }),
      reading({ id: 'c', status: 'auth_expired' }),
      reading({ id: 'd', status: 'app_closed' }),
      reading({ id: 'e', status: 'no_limits_reported' }),
      reading({ id: 'f', status: 'stale', windows: [limit('five_hour', 40)] })
    ]),
    20
  ).map(line => [line.account.id, line.note, line.stale]);
  assert.deepEqual(notes, [
    ['a', 'reading', false],
    ['b', 'waiting', false],
    ['c', 'signIn', false],
    ['d', 'openApp', false],
    ['e', 'noLimits', false],
    ['f', null, true]
  ]);
});

test('the account’s other limit is always named, and marked only when it runs out first', () => {
  const line = (windows: QuotaWindow[]) => only(compactLines(tool([reading({ windows })]), 20));
  const codex = line([limit('primary', 0, { durationMinutes: 5 * HOUR }), limit('secondary', 84, { durationMinutes: 7 * 24 * HOUR })]);
  assert.deepEqual([codex.window?.id, codex.other?.id, codex.tighter], ['primary', 'secondary', null], 'the weekly one, quietly');
  const one = line([limit('five_hour', 40, { durationMinutes: 5 * HOUR })]);
  assert.equal(one.other, null, 'nothing else to name');
});
