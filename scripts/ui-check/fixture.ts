// A snapshot covering every kind of window and status the UI renders. Times are relative to
// `now` so countdowns are stable.
import type { ProviderId } from '../../src/shared/catalog.ts';
import type { Language } from '../../src/shared/i18n/index.ts';
import type { HistorySeries, ModelCatalog, SessionSummary, SmartLaunchPreview } from '../../src/shared/ipc.ts';
import type {
  Account,
  AccountTokens,
  Diagnostics,
  MeasuredAccount,
  ProviderState,
  Snapshot,
  TransitionRecord
} from '../../src/shared/types.ts';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MEGABYTE = 1024 * 1024;

const ACCOUNTS: Account[] = [
  { id: 'codex:default', providerId: 'codex', labelKey: 'defaultAccount', primary: true, enabled: true },
  { id: 'claude:default', providerId: 'claude', labelKey: 'accountA', configDir: '/home/me/.claude', primary: true, enabled: true },
  { id: 'claude:work', providerId: 'claude', label: 'Work', configDir: '/home/me/.claude-work', primary: false, enabled: true },
  { id: 'cursor:default', providerId: 'cursor', labelKey: 'defaultAccount', primary: true, enabled: true },
  { id: 'antigravity:a', providerId: 'antigravity', label: 'me@example.com', primary: true, enabled: true },
  { id: 'copilot:default', providerId: 'copilot', label: 'octo-user', primary: true, enabled: true }
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
    serviceIssues: [{ providerId: 'cursor', status: 'partial_outage' }],
    settings: {
      schemaVersion: 1,
      language,
      intervalSeconds: 120,
      pinned: false,
      notifications: false,
      compareAccounts: false,
      autoContinue: 'off',
      returnToPrimary: 'ask',
      reopenAfterRestart: 'ask',
      compact: false,
      checkUpdates: true,
      checkServiceStatus: true,
      // A project with every choice made, one of them an account that has since been removed.
      projectPreferences: [
        {
          projectDir: '/home/me/projects/a-rather-long-project-folder-name',
          tool: 'claude',
          model: 'opus',
          accountId: 'claude:gone',
          autoContinue: 'off'
        },
        { projectDir: '/home/me/projects/site', autoContinue: 'inherit' }
      ],
      lowQuotaPercent: 15,
      quietHours: { start: '22:30', end: '07:00' },
      providerOrder: ['codex', 'claude', 'cursor', 'antigravity'],
      hiddenProviders: [],
      preferredModels: {},
      dismissedAccountIds: ['claude:old'],
      accounts: ACCOUNTS
    },
    settingsNotice: 'recovered',
    // The longest suggestion a window shows: a long project folder and an e-mail as the target.
    suggestions: [
      {
        id: 'low:claude:default',
        kind: 'low',
        providerId: 'claude',
        accountId: 'claude:default',
        remainingPercent: 12,
        target: { providerId: 'claude', accountId: 'claude:work' },
        projectDir: '/home/me/projects/a-rather-long-project-folder-name',
        sessionProvider: 'claude'
      },
      {
        id: 'return:codex:default',
        kind: 'return',
        providerId: 'codex',
        accountId: 'codex:default',
        remainingPercent: 100,
        target: { providerId: 'codex', accountId: 'codex:default' },
        projectDir: '/home/me/projects/app',
        sessionProvider: 'cursor'
      },
      {
        id: 'reopen:claude:session-1',
        kind: 'reopen',
        providerId: 'claude',
        accountId: 'claude:work',
        remainingPercent: 80,
        target: { providerId: 'claude', accountId: 'claude:default' },
        projectDir: '/home/me/projects/a-rather-long-project-folder-name',
        sessionProvider: 'claude'
      }
    ],
    // The banner with the most text: an unsigned macOS copy, its Download button and the note.
    update: {
      version: '0.2.0',
      url: 'https://github.com/mustafacagri/vibe-usage/releases/tag/v0.2.0',
      download: 'https://github.com/mustafacagri/vibe-usage/releases/download/v0.2.0/Vibe-Usage-0.2.0-mac-arm64.dmg'
    },
    updateInstall: { state: 'unsupported', reason: 'unsigned' },
    providers: [
      provider('codex', 'stale', [
        measured('codex:default', {
          status: 'stale',
          plan: 'free',
          // The longest name a card shows: an e-mail address.
          signedInAs: 'someone.with.a.long.address@example.com',
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
              resetsAt: at(3 * HOUR + 11 * MINUTE),
              exhaustsAt: at(HOUR + 25 * MINUTE)
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
              partial: true,
              except: ['auto'],
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
      provider('copilot', 'ok', [
        measured('copilot:default', {
          status: 'ok',
          fetchedAt,
          plan: 'free',
          windows: [
            { id: 'chat', labelKey: 'copilotChat', usedPercent: 25, remainingPercent: 75, resetsAt: at(11 * 24 * HOUR) },
            { id: 'completions', labelKey: 'copilotCompletions', usedPercent: 0, remainingPercent: 100, resetsAt: at(11 * 24 * HOUR) }
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

export function transitions(now = Date.now()): TransitionRecord[] {
  const record = (id: string, status: TransitionRecord['status'], minutesAgo: number, errorCode: TransitionRecord['errorCode'] = null) => ({
    id,
    suggestionId: `low:${id}`,
    createdAt: now - minutesAgo * MINUTE,
    updatedAt: now - minutesAgo * MINUTE,
    projectDir: '/home/me/projects/a-rather-long-project-folder-name',
    source: { providerId: 'claude' as const, accountId: 'claude:default', sessionId: 'session-1' },
    target: { providerId: 'codex' as const, accountId: 'codex:default', sessionId: null },
    status,
    errorCode
  });
  return [record('a', 'dispatched', 90), record('b', 'failed', 20, 'launch_failed'), record('c', 'interrupted', 5)];
}

export const DIAGNOSTICS: Diagnostics = {
  generatedAt: 0,
  intervalSeconds: 120,
  refreshing: false,
  providers: [
    {
      id: 'claude',
      installed: true,
      status: 'stale',
      messageCode: null,
      accountCount: 2,
      enabledCount: 2,
      ageMs: 20 * MINUTE,
      stale: true,
      remedy: 'remedySignIn',
      accounts: [
        { ordinal: 1, enabled: true, primary: true, status: 'ok', messageCode: null, ageMs: MINUTE, stale: false, remedy: null },
        {
          ordinal: 2,
          enabled: true,
          primary: false,
          status: 'stale',
          messageCode: 'auth_expired',
          ageMs: 20 * MINUTE,
          stale: true,
          remedy: 'remedySignIn'
        }
      ]
    },
    {
      id: 'codex',
      installed: true,
      status: 'ok',
      messageCode: null,
      accountCount: 1,
      enabledCount: 1,
      ageMs: MINUTE,
      stale: false,
      remedy: null,
      accounts: [{ ordinal: 1, enabled: true, primary: true, status: 'ok', messageCode: null, ageMs: MINUTE, stale: false, remedy: null }]
    },
    {
      id: 'cursor',
      installed: null,
      status: 'transport_error',
      messageCode: 'transport_error',
      accountCount: 1,
      enabledCount: 1,
      ageMs: null,
      stale: false,
      remedy: 'remedyCheckNetwork',
      accounts: [
        {
          ordinal: 1,
          enabled: true,
          primary: true,
          status: 'transport_error',
          messageCode: 'transport_error',
          ageMs: null,
          stale: false,
          remedy: 'remedyCheckNetwork'
        }
      ]
    },
    {
      id: 'copilot',
      installed: true,
      status: 'ok',
      messageCode: null,
      accountCount: 1,
      enabledCount: 1,
      ageMs: 20_000,
      stale: false,
      remedy: null,
      accounts: [{ ordinal: 1, enabled: true, primary: true, status: 'ok', messageCode: null, ageMs: 20_000, stale: false, remedy: null }]
    },
    {
      id: 'antigravity',
      installed: false,
      status: 'unavailable',
      messageCode: 'no_accounts',
      accountCount: 0,
      enabledCount: 0,
      ageMs: null,
      stale: false,
      remedy: 'remedyInstallTool',
      accounts: []
    }
  ]
};

export const MODELS: ModelCatalog = { claude: ['opus', 'sonnet'], codex: ['gpt-6-luna'], cursor: ['auto'], antigravity: [], copilot: [] };

export const SMART_PREVIEW: SmartLaunchPreview = {
  providerId: 'codex',
  verified: true,
  isFallback: false,
  headroomPercent: 89,
  model: 'gpt-6-luna'
};

// A week of readings: the 5-hour window filling and resetting, the weekly one climbing.
export function history(now = Date.now()): HistorySeries[] {
  const samples = (value: (hoursAgo: number) => number): [number, number][] =>
    Array.from({ length: 7 * 24 }, (_, i) => 7 * 24 - i).map(hoursAgo => [now - hoursAgo * HOUR, Math.round(value(hoursAgo))]);
  return [
    { accountId: 'claude:default', windowId: 'five_hour', samples: samples(h => ((7 * 24 - h) % 5) * 18 + 5) },
    { accountId: 'claude:default', windowId: 'seven_day', samples: samples(h => (7 * 24 - h) / 2.4) }
  ];
}

// A week of Claude's tokens, mostly cache reads, as the logs show, and Codex's under a model its log never named.
export function tokenUsage(): AccountTokens[] {
  return [
    {
      accountId: 'claude:default',
      today: { input: 5_800, output: 2_488_750, cacheRead: 1_062_652_813, cacheWrite: 16_101_828 },
      week: { input: 100_360, output: 29_295_926, cacheRead: 13_962_842_680, cacheWrite: 212_887_769 },
      models: [
        { model: 'claude-opus-5-5', tokens: { input: 90_000, output: 27_000_000, cacheRead: 13_000_000_000, cacheWrite: 200_000_000 } },
        { model: 'claude-sonnet-5-5', tokens: { input: 10_360, output: 2_295_926, cacheRead: 962_842_680, cacheWrite: 12_887_769 } }
      ]
    },
    {
      accountId: 'codex:default',
      today: { input: 5_157_101, output: 361_667, cacheRead: 125_437_696, cacheWrite: 0 },
      week: { input: 53_648_530, output: 2_854_323, cacheRead: 1_123_740_288, cacheWrite: 0 },
      models: [{ model: '', tokens: { input: 53_648_530, output: 2_854_323, cacheRead: 1_123_740_288, cacheWrite: 0 } }]
    }
  ];
}

export function sessions(now = Date.now()): SessionSummary[] {
  return [
    {
      id: 's1',
      source: { id: 's1', version: 'fixture-v1' },
      providerId: 'claude',
      title: 'Quota UI polish',
      updatedAt: now - 2 * HOUR,
      turnCount: 12,
      model: 'claude-opus-5-5',
      sizeBytes: 3.2 * MEGABYTE
    },
    {
      id: 's2',
      source: { id: 's2', version: 'fixture-v1' },
      providerId: 'cursor',
      title: 'Refactor storage',
      updatedAt: now - 26 * HOUR,
      turnCount: 3,
      model: '',
      sizeBytes: 0
    }
  ];
}
