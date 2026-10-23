// The invented accounts shown in the README media: two Claude Code accounts, two Codex ones and
// two Antigravity ones (Cursor reads one sign-in). Claude's personal 5-hour window is nearly
// spent, so Smart Launch recommends Codex; times are relative to `now`.
import type { Language } from '../../src/shared/i18n/index.ts';
import type { ModelCatalog, SessionSummary, SmartLaunchPreview } from '../../src/shared/ipc.ts';
import type { Account, Diagnostics, MeasuredAccount, QuotaWindow, Settings, Snapshot, TransitionRecord } from '../../src/shared/types.ts';
import { DURATION_MS, PROVIDER_IDS, type ProviderId } from '../../src/shared/catalog.ts';

const { MINUTE, HOUR, DAY } = DURATION_MS;

const ACCOUNTS: Account[] = [
  { id: 'claude:default', providerId: 'claude', label: 'Personal', configDir: '/Users/you/.claude', primary: true, enabled: true },
  { id: 'claude:work', providerId: 'claude', label: 'Work', configDir: '/Users/you/.claude-work', primary: false, enabled: true },
  { id: 'codex:default', providerId: 'codex', label: 'Personal', configDir: '/Users/you/.codex', primary: true, enabled: true },
  { id: 'codex:work', providerId: 'codex', label: 'Work', configDir: '/Users/you/.codex-work', primary: false, enabled: true },
  { id: 'cursor:default', providerId: 'cursor', labelKey: 'defaultAccount', primary: true, enabled: true },
  { id: 'antigravity:you', providerId: 'antigravity', label: 'you@example.com', email: 'you@example.com', primary: true, enabled: true },
  {
    id: 'antigravity:work',
    providerId: 'antigravity',
    label: 'you@work.example',
    email: 'you@work.example',
    primary: false,
    enabled: true
  }
];

export const PROJECT_DIR = '/Users/you/projects/acme-app';
export const MODELS: ModelCatalog = { claude: ['opus', 'sonnet'], codex: ['gpt-6-luna'], cursor: ['auto'], antigravity: [], copilot: [] };
export const SMART_LAUNCH: SmartLaunchPreview = {
  providerId: 'codex',
  verified: true,
  isFallback: false,
  headroomPercent: 58,
  model: 'gpt-6-luna',
  passedOver: []
};

// `view` changes how the window shows them (accounts side by side, the compact view).
export function snapshot(
  language: Language,
  now = Date.now(),
  view: Partial<Pick<Settings, 'compareAccounts' | 'compact'>> = {}
): Snapshot {
  const fetchedAt = new Date(now - 40 * 1000).toISOString();
  const fiveHours = { labelKey: 'labelNHours', labelParams: { n: 5 } } as const;
  const weekly = { labelKey: 'labelWeekly' } as const;
  const window = (id: string, remainingPercent: number, resetsIn: number, extra: Partial<QuotaWindow> = {}): QuotaWindow => ({
    id,
    usedPercent: 100 - remainingPercent,
    remainingPercent,
    resetsAt: new Date(now + resetsIn).toISOString(),
    ...extra
  });
  const measured = (id: string, plan: string | undefined, windows: QuotaWindow[]): MeasuredAccount => {
    const account = ACCOUNTS.find(a => a.id === id);
    if (!account) throw new Error(`unknown demo account ${id}`);
    return { ...account, status: 'ok', fetchedAt, windows, ...(plan && { plan }) };
  };
  return {
    refreshing: false,
    settings: {
      schemaVersion: 1,
      language,
      intervalSeconds: 120,
      pinned: false,
      notifications: true,
      compareAccounts: view.compareAccounts ?? false,
      // Settings as someone who uses them would have them, for the screenshots of Settings.
      autoContinue: 'tools',
      returnToPrimary: 'ask',
      reopenAfterRestart: 'auto',
      compact: view.compact ?? false,
      checkUpdates: true,
      checkServiceStatus: true,
      projectPreferences: [{ projectDir: PROJECT_DIR, tool: 'claude', model: 'opus', accountId: 'claude:work', autoContinue: 'accounts' }],
      lowQuotaPercent: 20,
      quietHours: { start: '23:00', end: '08:00' },
      providerOrder: [...PROVIDER_IDS],
      hiddenProviders: [],
      preferredModels: { claude: 'opus', codex: 'gpt-6-luna' },
      dismissedAccountIds: [],
      accounts: ACCOUNTS
    },
    providers: [
      {
        id: 'claude',
        status: 'ok',
        fetchedAt,
        accounts: [
          measured('claude:default', 'max', [
            window('five_hour', 4, 1 * HOUR + 48 * MINUTE, fiveHours),
            window('seven_day', 46, 2.6 * DAY, weekly)
          ]),
          measured('claude:work', 'team', [
            window('five_hour', 81, 3 * HOUR + 5 * MINUTE, fiveHours),
            window('seven_day', 73, 5.2 * DAY, weekly)
          ])
        ]
      },
      {
        id: 'codex',
        status: 'ok',
        fetchedAt,
        accounts: [
          measured('codex:default', 'plus', [
            window('codex:primary', 72, 2 * HOUR + 14 * MINUTE, fiveHours),
            window('codex:secondary', 58, 4.4 * DAY, weekly)
          ]),
          measured('codex:work', 'pro', [
            window('codex:primary', 37, 41 * MINUTE, fiveHours),
            window('codex:secondary', 66, 2.1 * DAY, weekly)
          ])
        ]
      },
      {
        id: 'cursor',
        status: 'ok',
        fetchedAt,
        accounts: [
          measured('cursor:default', 'pro', [
            window('plan:auto', 64, 18.3 * DAY, { labelKey: 'labelAutoScope' }),
            window('plan:api', 91, 18.3 * DAY, { labelKey: 'labelApiScope' }),
            {
              id: 'plan:spend',
              usedPercent: null,
              remainingPercent: null,
              resetsAt: null,
              labelKey: 'labelIncludedSpend',
              section: 'details',
              amounts: { used: 820, limit: 2000, remaining: 1180 }
            }
          ])
        ]
      },
      {
        id: 'antigravity',
        status: 'ok',
        fetchedAt,
        accounts: [
          measured('antigravity:you', undefined, [
            window('gemini:5h', 95, 3 * HOUR + 30 * MINUTE, { ...fiveHours, scope: 'Gemini Models' }),
            window('gemini:weekly', 88, 5.1 * DAY, { ...weekly, scope: 'Gemini Models' }),
            window('partner:5h', 70, 1 * HOUR + 12 * MINUTE, { ...fiveHours, scope: 'Claude and GPT models' })
          ]),
          measured('antigravity:work', undefined, [
            window('gemini:5h', 54, 2 * HOUR + 5 * MINUTE, { ...fiveHours, scope: 'Gemini Models' }),
            window('gemini:weekly', 79, 3.4 * DAY, { ...weekly, scope: 'Gemini Models' }),
            window('partner:5h', 18, 48 * MINUTE, { ...fiveHours, scope: 'Claude and GPT models' })
          ])
        ]
      }
    ]
  };
}

// Work that moved when a limit ran out: to the other Claude account, then on to Codex; the last
// start failed and can be tried again.
export function transitions(now = Date.now()): TransitionRecord[] {
  const moved = (
    id: string,
    minutesAgo: number,
    source: TransitionRecord['source'],
    target: TransitionRecord['target'],
    failed = false
  ): TransitionRecord => ({
    id,
    suggestionId: `limit:${id}`,
    createdAt: now - minutesAgo * MINUTE,
    updatedAt: now - minutesAgo * MINUTE,
    projectDir: PROJECT_DIR,
    source,
    target,
    status: failed ? 'failed' : 'dispatched',
    errorCode: failed ? 'launch_failed' : null,
    ...(failed && { retryable: true })
  });
  return [
    moved(
      'to-work',
      150,
      { providerId: 'claude', accountId: 'claude:default', sessionId: 'csv-export' },
      { providerId: 'claude', accountId: 'claude:work', sessionId: 'csv-export' }
    ),
    moved(
      'to-codex',
      45,
      { providerId: 'claude', accountId: 'claude:work', sessionId: 'csv-export' },
      { providerId: 'codex', accountId: 'codex:default', sessionId: null }
    ),
    moved(
      'to-cursor',
      8,
      { providerId: 'codex', accountId: 'codex:work', sessionId: 'flaky-login' },
      { providerId: 'cursor', accountId: 'cursor:default', sessionId: null },
      true
    )
  ];
}

// Every tool installed and read a moment ago.
export function diagnostics(): Diagnostics {
  const counts: Record<ProviderId, number> = { claude: 2, codex: 2, cursor: 1, antigravity: 2, copilot: 0 };
  return {
    generatedAt: 0,
    intervalSeconds: 120,
    faults: [],
    refreshing: false,
    providers: PROVIDER_IDS.map(id => ({
      id,
      installed: true,
      status: 'ok' as const,
      messageCode: null,
      accountCount: counts[id],
      enabledCount: counts[id],
      ageMs: 40 * 1000,
      stale: false,
      remedy: null,
      accounts: Array.from({ length: counts[id] }, (_, i) => ({
        ordinal: i + 1,
        enabled: true,
        primary: i === 0,
        status: 'ok' as const,
        messageCode: null,
        ageMs: 40 * 1000,
        stale: false,
        remedy: null
      }))
    }))
  };
}

export function sessions(now = Date.now()): SessionSummary[] {
  return [
    {
      id: 'csv-export',
      source: { id: 'csv-export', version: 'fixture-v1' },
      providerId: 'claude',
      title: 'Add CSV export to reports',
      updatedAt: now - 25 * MINUTE,
      turnCount: 38,
      model: 'claude-opus-5-5',
      sizeBytes: 4_100_000
    },
    {
      id: 'flaky-login',
      source: { id: 'flaky-login', version: 'fixture-v1' },
      providerId: 'codex',
      title: 'Fix flaky login test',
      updatedAt: now - 3 * HOUR,
      turnCount: 12,
      model: 'gpt-6-luna',
      sizeBytes: 900_000
    }
  ];
}
