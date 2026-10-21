import assert from 'node:assert/strict';
import test from 'node:test';
import type { Attempt } from '../src/core/continuity.ts';
import { createQuotaWatch, describeAlert, describeNotice, trayTool, trayTooltip } from '../src/core/glance.ts';
import { defaultSettings } from '../src/core/settings.ts';
import { PROVIDER_IDS, type ProviderId } from '../src/shared/catalog.ts';
import { translator } from '../src/shared/i18n/index.ts';
import type { ErrorCode, MeasuredAccount, Snapshot } from '../src/shared/types.ts';
import { account as configured, measuredAccount, quotaWindow } from './helpers/fixtures.ts';

const NOW = Date.parse('2026-10-17T12:00:00Z');
const inMinutes = (minutes: number): string => new Date(NOW + minutes * 60 * 1000).toISOString();
const context = { t: translator('en'), locale: 'en', now: NOW };

const reading = (id: string, providerId: ProviderId, five: number | null, fields: Partial<MeasuredAccount> = {}): MeasuredAccount =>
  measuredAccount({
    id,
    providerId,
    windows: [
      quotaWindow({ id: 'five_hour', labelKey: 'labelNHours', labelParams: { n: 5 }, remainingPercent: five, resetsAt: inMinutes(108) })
    ],
    ...fields
  });

function snapshot(accounts: MeasuredAccount[], providerOrder: ProviderId[] = [...PROVIDER_IDS]): Snapshot {
  const ids = [...new Set(accounts.map(a => a.providerId))];
  return {
    refreshing: false,
    settings: { ...defaultSettings(), providerOrder },
    providers: ids.map(id => ({ id, status: 'ok', accounts: accounts.filter(a => a.providerId === id) }))
  };
}

test('the tooltip gives each tool with accounts its best tightest limit, in the user order', () => {
  const tooltip = trayTooltip(
    snapshot(
      [
        reading('claude:personal', 'claude', 4),
        reading('claude:work', 'claude', 80),
        reading('codex:default', 'codex', 58, { windows: [quotaWindow({ id: 'week', remainingPercent: 58 })] }),
        reading('cursor:default', 'cursor', 90, { status: 'auth_expired' })
      ],
      ['codex', 'claude', 'cursor', 'antigravity']
    ),
    context
  );
  assert.equal(tooltip, 'Vibe Usage\nCodex 58%\nClaude 80% · 1h 48m\nCursor —');
});

test('the tooltip follows the home order when the user set one, not the fallback order', () => {
  const state = snapshot([reading('claude:work', 'claude', 80), reading('cursor:default', 'cursor', 90)], ['claude', 'cursor']);
  state.settings.homeOrder = ['cursor'];
  assert.match(trayTooltip(state, context), /^Vibe Usage\nCursor .*\nClaude /);
});

test('the tooltip is only the app name before any account is known', () => {
  assert.equal(trayTooltip(snapshot([]), context), 'Vibe Usage');
});

test('a watch reports an account crossing the low line, both ways, but not its first reading', () => {
  const watch = createQuotaWatch();
  const at = (five: number | null, status: MeasuredAccount['status'] = 'ok') =>
    watch(snapshot([reading('claude:a', 'claude', five, { status })])).map(alert => alert.kind);
  assert.deepEqual(at(10), [], 'the first reading is the baseline');
  assert.deepEqual(at(60), ['available']);
  assert.deepEqual(at(40), []);
  assert.deepEqual(at(20), ['low'], 'at the line counts as low');
  assert.deepEqual(at(5), []);
  assert.deepEqual(at(90, 'auth_expired'), [], 'a failed reading is ignored');
  assert.deepEqual(at(null), [], 'an unknown limit is ignored');
  assert.deepEqual(at(21), ['available']);
});

test('an alert names the tool, the account and the limit that decided it', () => {
  const account = reading('claude:a', 'claude', 4, { label: 'Personal' });
  const [window] = account.windows;
  if (window?.remainingPercent == null) throw new Error('fixture window is unmeasured');
  const known = { ...window, remainingPercent: window.remainingPercent };
  assert.deepEqual(describeAlert({ kind: 'low', providerId: 'claude', account, window: known }, context), {
    title: 'Claude · Personal',
    body: '5 hours: 4% remaining · resets in 1h 48m'
  });
  const { label: _typed, ...unnamed } = { ...account, signedInAs: 'me@example.com' };
  assert.equal(
    describeAlert({ kind: 'low', providerId: 'claude', account: unnamed, window: known }, context).title,
    'Claude · me@example.com'
  );
  assert.equal(
    describeAlert({ kind: 'available', providerId: 'claude', account, window: known }, context).body,
    'Available again\n5 hours: 4% remaining · resets in 1h 48m'
  );
});

test('a session cut off when the computer went down is offered, reported reopened, or reported not reopened', () => {
  const main = configured({ id: 'claude:a', label: 'Main' });
  const from = reading('claude:a', 'claude', 80, { label: 'Main' });
  const suggestion = {
    id: 'reopen:claude:session-1',
    kind: 'reopen' as const,
    providerId: 'claude' as const,
    accountId: 'claude:a',
    remainingPercent: 80,
    target: { providerId: 'claude' as const, accountId: 'claude:a' },
    projectDir: '/work/app',
    sessionProvider: 'claude' as const
  };
  assert.deepEqual(describeNotice({ kind: 'suggested', suggestion }, context, [main]), {
    title: 'Claude · Main',
    body: 'A session was open when the computer went down. Reopen it?'
  });
  const result = { to: 'claude' as const, accountId: 'claude:a', resumed: true, mode: 'terminal' as const };
  const to = { providerId: 'claude' as const, account: main };
  assert.equal(
    describeNotice({ kind: 'reopened', from, to, result, projectDir: '/work/app' }, context, [main]).body,
    'app is open again on Main, where it left off.'
  );
  assert.match(
    describeNotice({ kind: 'failed', from, code: 'launch_failed', attempt: 'reopen' }, context, [main]).body,
    /^A session cut off when the computer went down could not be reopened: /
  );
  assert.match(describeNotice({ kind: 'failed', from, code: 'launch_failed' }, context, [main]).body, /^Ran out/);
});

// A return that fails is reported from the home account, which has quota again: "ran out, but the
// work could not be moved" would be wrong on both counts. The notice says what failed.
test('a failed return is told apart from a failed move: the home account has quota, the work stays away', () => {
  const home = reading('claude:a', 'claude', 90, { labelKey: 'accountA', primary: true });
  const failed = (code: ErrorCode, attempt?: Attempt) =>
    describeNotice({ kind: 'failed', from: home, code, ...(attempt ? { attempt } : {}) }, context, [home]);
  assert.deepEqual(failed('session_still_running', 'return'), {
    title: 'Claude · Account A',
    body: "Has quota again, but the work could not be brought back: The session's previous process could not be stopped, so it was not started a second time. Close it there, then try again."
  });
  assert.match(failed('session_still_running').body, /^Ran out, but the work could not be moved: /, 'told, never guessed from the code');
});

test('a hidden tool is left out of the tray icon, the tooltip and the alerts', () => {
  const state = snapshot([reading('claude:work', 'claude', 80), reading('cursor:default', 'cursor', 90)], ['cursor', 'claude']);
  assert.equal(trayTool(state)?.providerId, 'cursor');
  state.settings.hiddenProviders = ['cursor'];
  assert.equal(trayTool(state)?.providerId, 'claude');
  assert.doesNotMatch(trayTooltip(state, context), /Cursor/);
  const watch = createQuotaWatch();
  const at = (cursor: number) =>
    watch({ ...state, providers: snapshot([reading('claude:work', 'claude', 80), reading('cursor:default', 'cursor', cursor)]).providers });
  at(90);
  assert.deepEqual(at(5), [], 'its quota running low raises nothing');
  state.settings.hiddenProviders = [];
  assert.deepEqual(at(5), [], 'shown again, its first reading is only a baseline');
  assert.deepEqual(
    at(90).map(alert => alert.kind),
    ['available']
  );
  // Seen while shown, then hidden through a drop: showing it again does not announce the drop.
  at(90);
  state.settings.hiddenProviders = ['cursor'];
  at(5);
  state.settings.hiddenProviders = [];
  assert.deepEqual(at(5), [], 'what happened while hidden is not news');
});
