// GitHub Copilot's quota, read with the GitHub sign-in the machine already has: the token in the
// environment, else the one the GitHub CLI keeps. It goes to the one Copilot endpoint, which is
// not documented: a change on GitHub's side shows up as an invalid response, never as a guess.
import os from 'node:os';
import { ProviderError } from '../core/errors.ts';
import { isObject } from '../core/files.ts';
import { normalizeWindow, safePlan, safeText, type WindowInput } from '../core/model.ts';
import { accountId, DEFAULT_ACCOUNT_KEY } from '../shared/catalog.ts';
import type { MessageKey } from '../shared/i18n/index.ts';
import {
  findBinary as defaultFindBinary,
  getJson as defaultGetJson,
  QUOTA_ENDPOINTS,
  remainingTimeout,
  runProcess as defaultRunProcess,
  USER_AGENT,
  type GetJson,
  type RunProcess
} from './common.ts';
import type { Discovery, FetchResult, ProviderAdapter, RefreshContext } from './types.ts';

const GH_BINARY = 'gh';
const GITHUB_HOST = 'github.com';
const USAGE_TIMEOUT_MS = 15000;
// The variables the GitHub CLI itself reads for its token, in its order.
const TOKEN_VARIABLES = ['GH_TOKEN', 'GITHUB_TOKEN'] as const;
// The free plan reports `copilot_plan: individual` as well, which says nothing of what it is.
const FREE_PLAN_SKU_PREFIX = 'free';
const FREE_PLAN = 'free';

const QUOTA_LABELS: Readonly<Record<string, MessageKey>> = {
  chat: 'copilotChat',
  completions: 'copilotCompletions',
  premium_interactions: 'copilotPremium'
};

// The quotas that limit the account: not an unlimited one, nor one the plan has none of.
function parseWindows(snapshots: unknown, resetsAt: unknown): WindowInput[] {
  if (!isObject(snapshots)) throw new ProviderError('invalid_response');
  return Object.entries(snapshots).flatMap(([key, quota]): WindowInput[] => {
    if (!isObject(quota)) throw new ProviderError('invalid_response');
    if (quota.unlimited === true || quota.has_quota === false) return [];
    const id = safeText(typeof quota.quota_id === 'string' ? quota.quota_id : key, key);
    const labelKey = QUOTA_LABELS[id];
    return [{ id, remainingPercent: quota.percent_remaining, resetsAt, ...(labelKey ? { labelKey } : { label: id }) }];
  });
}

export function parseCopilotUsage(response: unknown): FetchResult {
  if (!isObject(response) || !('quota_snapshots' in response)) throw new ProviderError('invalid_response');
  const windows = parseWindows(response.quota_snapshots, response.quota_reset_date_utc).map(window => normalizeWindow(window));
  const sku = typeof response.access_type_sku === 'string' ? response.access_type_sku : '';
  const plan = sku.startsWith(FREE_PLAN_SKU_PREFIX) ? FREE_PLAN : safePlan(response.copilot_plan);
  const login = safeText(response.login);
  return {
    windows,
    completeness: 'complete',
    ...(plan ? { plan } : {}),
    ...(login ? { signedInAs: login } : {}),
    ...(windows.length ? {} : { status: 'no_limits_reported' as const })
  };
}

export interface CopilotProviderOptions {
  env?: NodeJS.ProcessEnv;
  getJson?: GetJson;
  runProcess?: RunProcess;
  findBinary?: (name: string) => Promise<string>;
}

export function createCopilotProvider(options: CopilotProviderOptions = {}): ProviderAdapter {
  const env = options.env ?? process.env;
  const getJson = options.getJson ?? defaultGetJson;
  const runProcess = options.runProcess ?? defaultRunProcess;
  const findBinary = options.findBinary ?? ((name: string) => defaultFindBinary(name, { env, home: os.homedir() }));

  // The token the GitHub CLI would use: the environment's, else the one it stored.
  async function readToken(context?: RefreshContext): Promise<string> {
    for (const name of TOKEN_VARIABLES) {
      const token = env[name]?.trim();
      if (token) return token;
    }
    const binary = await findBinary(GH_BINARY);
    remainingTimeout(USAGE_TIMEOUT_MS, context);
    // `gh` fails when nobody is signed in; the process error is that answer, not a fault.
    const token = await runProcess(binary, ['auth', 'token', '--hostname', GITHUB_HOST], { ...context }).catch((error: unknown) => {
      throw error instanceof ProviderError && error.code === 'process_failed' ? new ProviderError('auth_missing') : error;
    });
    if (!token.trim()) throw new ProviderError('auth_missing');
    return token.trim();
  }

  return {
    id: 'copilot',
    fetchTimeoutMs: 2 * USAGE_TIMEOUT_MS,
    // The account exists where a sign-in does. A reading that could not be completed (a timeout)
    // proves nothing either way.
    async discover(): Promise<Discovery> {
      try {
        await readToken();
        return {
          kind: 'complete',
          accounts: [
            {
              id: accountId('copilot', DEFAULT_ACCOUNT_KEY),
              providerId: 'copilot',
              labelKey: 'defaultAccount',
              primary: true,
              enabled: true
            }
          ]
        };
      } catch (error) {
        const absent = error instanceof ProviderError && (error.code === 'binary_missing' || error.code === 'auth_missing');
        return { kind: absent ? 'complete' : 'unknown', accounts: [] };
      }
    },
    async fetch(_account, context): Promise<FetchResult> {
      const token = await readToken(context);
      const usage = await getJson(QUOTA_ENDPOINTS.copilot, {
        headers: { Authorization: `token ${token}`, Accept: 'application/json', 'User-Agent': USER_AGENT },
        timeoutMs: USAGE_TIMEOUT_MS,
        ...context
      });
      return parseCopilotUsage(usage);
    }
  };
}
