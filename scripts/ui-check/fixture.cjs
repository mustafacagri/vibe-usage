'use strict';
// A snapshot covering every kind of window and status the UI renders. Times are relative
// to `now` so countdowns are stable.
const HOUR = 3600 * 1000;

function snapshot(language, now = Date.now()) {
  const at = ms => new Date(now + ms).toISOString();
  const fetchedAt = new Date(now).toISOString();
  return {
    refreshing: false,
    settings: {
      language,
      intervalSeconds: 120,
      pinned: false,
      providerOrder: ['codex', 'claude', 'cursor', 'antigravity'],
      preferredModels: {},
      dismissedAccountIds: ['claude:old'],
      accounts: [
        { id: 'codex:default', providerId: 'codex', labelKey: 'defaultAccount', primary: true, enabled: true },
        { id: 'claude:default', providerId: 'claude', labelKey: 'accountA', configDir: '/home/me/.claude', primary: true, enabled: true },
        { id: 'claude:work', providerId: 'claude', label: 'Work', configDir: '/home/me/.claude-work', primary: false, enabled: true },
        { id: 'cursor:default', providerId: 'cursor', labelKey: 'defaultAccount', primary: true, enabled: true },
        { id: 'antigravity:a', providerId: 'antigravity', label: 'me@example.com', primary: true, enabled: true }
      ]
    },
    providers: [
      {
        id: 'codex',
        name: 'Codex',
        status: 'stale',
        fetchedAt,
        accounts: [
          {
            id: 'codex:default',
            labelKey: 'defaultAccount',
            primary: true,
            status: 'stale',
            plan: 'free',
            fetchedAt,
            messageCode: 'rate_limited',
            windows: [
              {
                id: 'codex:primary',
                labelKey: 'labelNDays',
                labelParams: { n: 30 },
                usedPercent: 11,
                remainingPercent: 89,
                resetsAt: at(25.6 * 24 * HOUR)
              }
            ]
          }
        ]
      },
      {
        id: 'claude',
        name: 'Claude',
        status: 'ok',
        fetchedAt,
        accounts: [
          {
            id: 'claude:default',
            labelKey: 'accountA',
            configDir: '/home/me/.claude',
            primary: true,
            status: 'ok',
            plan: 'pro',
            fetchedAt,
            windows: [
              {
                id: 'five_hour',
                labelKey: 'labelNHours',
                labelParams: { n: 5 },
                usedPercent: 43,
                remainingPercent: 57,
                resetsAt: at(3 * HOUR + 11 * 60 * 1000)
              },
              { id: 'seven_day', labelKey: 'labelWeekly', usedPercent: 30, remainingPercent: 70, resetsAt: at(49 * HOUR) },
              { id: 'fable', labelKey: 'labelWeekly', scope: 'Fable', active: false, usedPercent: 0, remainingPercent: 100 }
            ]
          },
          {
            id: 'claude:work',
            label: 'Work',
            configDir: '/home/me/.claude-work',
            primary: false,
            status: 'auth_expired',
            messageCode: 'auth_expired',
            windows: []
          }
        ]
      },
      {
        id: 'cursor',
        name: 'Cursor',
        status: 'ok',
        fetchedAt,
        accounts: [
          {
            id: 'cursor:default',
            labelKey: 'defaultAccount',
            primary: true,
            status: 'ok',
            plan: 'pro',
            fetchedAt,
            windows: [
              { id: 'plan:auto', labelKey: 'labelAutoScope', usedPercent: 18, remainingPercent: 82, resetsAt: at(21.3 * 24 * HOUR) },
              {
                id: 'plan:api',
                labelKey: 'labelApiScope',
                detailKey: 'cursorApiLimitNote',
                usedPercent: 100,
                remainingPercent: 0,
                resetsAt: at(21.3 * 24 * HOUR)
              },
              {
                id: 'plan:total',
                labelKey: 'labelTotalUsage',
                detailKey: 'totalQuotaDesc',
                section: 'details',
                usedPercent: 40,
                remainingPercent: 60
              },
              {
                id: 'plan:spend',
                labelKey: 'labelIncludedSpend',
                section: 'details',
                amounts: { used: 750, limit: 2000, remaining: 1250 }
              },
              { id: 'team:onDemand', labelKey: 'labelOnDemandSpend', group: 'team', section: 'details', valueKey: 'disabled', amounts: {} }
            ]
          }
        ]
      },
      {
        id: 'antigravity',
        name: 'Antigravity',
        status: 'ok',
        fetchedAt,
        accounts: [
          {
            id: 'antigravity:a',
            label: 'me@example.com',
            primary: true,
            status: 'ok',
            fetchedAt,
            windows: [
              {
                id: 'g:w',
                labelKey: 'labelWeekly',
                scope: 'Gemini Models',
                detailKey: 'antigravitySourceNote',
                remainingPercent: 76,
                usedPercent: 24,
                resetsAt: at(4.2 * 24 * HOUR)
              },
              {
                id: 'g:5',
                labelKey: 'labelNHours',
                labelParams: { n: 5 },
                scope: 'Gemini Models',
                detailKey: 'antigravitySourceNote',
                remainingPercent: 60,
                usedPercent: 40,
                resetsAt: at(42 * 60 * 1000)
              },
              {
                id: 'c:m',
                label: 'claude-opus',
                scope: 'Claude and GPT models',
                detailKey: 'modelQuotaNoPeriod',
                remainingPercent: 100,
                usedPercent: 0,
                resetsAt: at(5 * HOUR)
              },
              {
                id: 'c:s',
                labelKey: 'labelWeekly',
                scope: 'Claude and GPT models',
                detailKey: 'staleWindowDetail',
                stale: true,
                remainingPercent: 40,
                usedPercent: 60,
                resetsAt: at(30 * HOUR)
              }
            ]
          }
        ]
      }
    ]
  };
}

module.exports = { snapshot };
