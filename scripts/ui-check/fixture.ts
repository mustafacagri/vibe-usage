// A snapshot covering every kind of window and status the UI renders. Times are relative to
// `now` so countdowns are stable.
import type { ProviderId } from '../../src/shared/catalog.ts';
import type { Language } from '../../src/shared/i18n/index.ts';
import type { ModelCatalog, SessionSummary, SmartLaunchPreview } from '../../src/shared/ipc.ts';
import type { Account, MeasuredAccount, ProviderState, Snapshot } from '../../src/shared/types.ts';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MEGABYTE = 1024 * 1024;

const ACCOUNTS: Account[] = [
  { id: 'codex:default', providerId: 'codex', labelKey: 'defaultAccount', primary: true, enabled: true },
  { id: 'claude:default', providerId: 'claude', labelKey: 'accountA', configDir: '/home/me/.claude', primary: true, enabled: true },
  { id: 'claude:work', providerId: 'claude', label: 'Work', configDir: '/home/me/.claude-work', primary: false, enabled: true },
  { id: 'cursor:default', providerId: 'cursor', labelKey: 'defaultAccount', primary: true, enabled: true },
  { id: 'antigravity:a', providerId: 'antigravity', label: 'me@example.com', primary: true, enabled: true }
];

export function snapshot(language: Language, now = Date.now()): Snapshot {
  const at = (ms: number): string => new Date(now + ms).toISOString();
  const fetchedAt = new Date(now).toISOString();
  const measured = (id: string, measurement: Omit<MeasuredAccount, keyof Account>): MeasuredAccount => {
    const account = ACCOUNTS.find(a => a.id === id);
    if (!account) throw new Error(`unknown fixture account ${id}`);
    return { ...account, ...measurement };
  };
  const provider = (id: ProviderId, status: ProviderState['status'], accounts: MeasuredAccount[]): ProviderState => ({
    id,
    status,
    fetchedAt,
    accounts
  });
  const unmeasured = { usedPercent: null, remainingPercent: null, resetsAt: null };
  return {
    refreshing: false,
    settings: {
      language,
      intervalSeconds: 120,
      pinned: false,
      providerOrder: ['codex', 'claude', 'cursor', 'antigravity'],
      preferredModels: {},
      dismissedAccountIds: ['claude:old'],
      accounts: ACCOUNTS
    },
    providers: [
      provider('codex', 'stale', [
        measured('codex:default', {
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
              resetsAt: at(25.6 * DAY)
            }
          ]
        })
      ]),
      provider('claude', 'ok', [
        measured('claude:default', {
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
              resetsAt: at(3 * HOUR + 11 * MINUTE)
            },
            { id: 'seven_day', labelKey: 'labelWeekly', usedPercent: 30, remainingPercent: 70, resetsAt: at(49 * HOUR) },
            { id: 'fable', labelKey: 'labelWeekly', scope: 'Fable', active: false, usedPercent: 0, remainingPercent: 100, resetsAt: null }
          ]
        }),
        measured('claude:work', { status: 'auth_expired', messageCode: 'auth_expired', windows: [] })
      ]),
      provider('cursor', 'ok', [
        measured('cursor:default', {
          status: 'ok',
          plan: 'pro',
          fetchedAt,
          windows: [
            { id: 'plan:auto', labelKey: 'labelAutoScope', usedPercent: 18, remainingPercent: 82, resetsAt: at(21.3 * DAY) },
            {
              id: 'plan:api',
              labelKey: 'labelApiScope',
              detailKey: 'cursorApiLimitNote',
              usedPercent: 100,
              remainingPercent: 0,
              resetsAt: at(21.3 * DAY)
            },
            {
              id: 'plan:total',
              labelKey: 'labelTotalUsage',
              detailKey: 'totalQuotaDesc',
              section: 'details',
              usedPercent: 40,
              remainingPercent: 60,
              resetsAt: null
            },
            {
              ...unmeasured,
              id: 'plan:spend',
              labelKey: 'labelIncludedSpend',
              section: 'details',
              amounts: { used: 750, limit: 2000, remaining: 1250 }
            },
            {
              ...unmeasured,
              id: 'team:onDemand',
              labelKey: 'labelOnDemandSpend',
              group: 'team',
              section: 'details',
              valueKey: 'disabled',
              amounts: {}
            }
          ]
        })
      ]),
      provider('antigravity', 'ok', [
        measured('antigravity:a', {
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
              resetsAt: at(4.2 * DAY)
            },
            {
              id: 'g:5',
              labelKey: 'labelNHours',
              labelParams: { n: 5 },
              scope: 'Gemini Models',
              detailKey: 'antigravitySourceNote',
              remainingPercent: 60,
              usedPercent: 40,
              resetsAt: at(42 * MINUTE)
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
        })
      ])
    ]
  };
}

export const MODELS: ModelCatalog = { claude: ['opus', 'sonnet'], codex: ['gpt-6-luna'], cursor: ['auto'], antigravity: [] };

export const SMART_PREVIEW: SmartLaunchPreview = {
  providerId: 'codex',
  verified: true,
  isFallback: false,
  headroomPercent: 89,
  model: 'gpt-6-luna'
};

export function sessions(now = Date.now()): SessionSummary[] {
  return [
    {
      id: 's1',
      providerId: 'claude',
      title: 'Quota UI polish',
      updatedAt: now - 2 * HOUR,
      turnCount: 12,
      model: 'claude-opus-5-5',
      sizeBytes: 3.2 * MEGABYTE
    },
    { id: 's2', providerId: 'cursor', title: 'Refactor storage', updatedAt: now - 26 * HOUR, turnCount: 3, model: '', sizeBytes: 0 }
  ];
}
