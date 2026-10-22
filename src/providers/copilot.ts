// GitHub Copilot's quota, read with the GitHub sign-in the machine already has: the token in the
// environment, else the one the GitHub CLI keeps. It goes to the one Copilot endpoint, which is
// not documented: a change on GitHub's side shows up as an invalid response, never as a guess.
import os from 'node:os';
import { applyEnvironment, environmentChanges } from '../core/environment.ts';
import { ProviderError } from '../core/errors.ts';
import { isObject } from '../core/files.ts';
import { normalizeWindow, safePlan, safeText, type WindowInput } from '../core/model.ts';
import { accountId, DEFAULT_ACCOUNT_KEY, DURATION_MS, MEDIA_TYPE } from '../shared/catalog.ts';
import type { MessageKey } from '../shared/i18n/index.ts';
import {
  findBinary as defaultFindBinary,
  getJson as defaultGetJson,
  QUOTA_ENDPOINTS,
  GITHUB_CLI,
  runProcess as defaultRunProcess,
  USER_AGENT,
  type GetJson,
  type RunProcess
} from './common.ts';
import type { Discovery, FetchResult, ProviderAdapter, RefreshContext } from './types.ts';

const GITHUB_HOST = 'github.com';
// One request, and the GitHub CLI's answer before it.
const USAGE_TIMEOUT_MS = 15 * DURATION_MS.SECOND;
const TOKEN_TIMEOUT_MS = 15 * DURATION_MS.SECOND;
// The variables the GitHub CLI itself reads for its token, in its order.
const TOKEN_VARIABLES = ['GH_TOKEN', 'GITHUB_TOKEN'] as const;
// The free plan's sku starts with its name; it reports `copilot_plan: individual` as well, which says
// nothing of what it is.
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
    // The id is the service's: only the ids listed are names the app has.
    const labelKey = Object.hasOwn(QUOTA_LABELS, id) ? QUOTA_LABELS[id] : undefined;
    return [{ id, remainingPercent: quota.percent_remaining, resetsAt, ...(labelKey ? { labelKey } : { label: id }) }];
  });
}

export function parseCopilotUsage(response: unknown): FetchResult {
  if (!isObject(response) || !('quota_snapshots' in response)) throw new ProviderError('invalid_response');
  const windows = parseWindows(response.quota_snapshots, response.quota_reset_date_utc).map(window => normalizeWindow(window));
  const sku = typeof response.access_type_sku === 'string' ? response.access_type_sku : '';
  const plan = sku.startsWith(FREE_PLAN) ? FREE_PLAN : safePlan(response.copilot_plan);
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

  // The token the GitHub CLI would use from the environment.
  function environmentToken(): string | undefined {
    for (const name of TOKEN_VARIABLES) {
      const token = env[name]?.trim();
      if (token) return token;
    }
    return undefined;
  }

  // The token the GitHub CLI stored. Without the token variables it is asked for, as it hands
  // those back before anything it stored.
  async function storedToken(context?: RefreshContext): Promise<string> {
    const binary = await findBinary(GITHUB_CLI);
    // `gh` fails when nobody is signed in; the process error is that answer, not a fault.
    const token = await runProcess(binary, ['auth', 'token', '--hostname', GITHUB_HOST], {
      env: applyEnvironment(environmentChanges({ unset: TOKEN_VARIABLES })),
      timeoutMs: TOKEN_TIMEOUT_MS,
      ...context
    }).catch((error: unknown) => {
      throw error instanceof ProviderError && error.code === 'process_failed' ? new ProviderError('auth_missing') : error;
    });
    if (!token.trim()) throw new ProviderError('auth_missing');
    return token.trim();
  }

  async function readUsage(token: string, context?: RefreshContext): Promise<FetchResult> {
    const usage = await getJson(QUOTA_ENDPOINTS.copilot, {
      // The `token` scheme is the one GitHub's own clients use for this endpoint; `Bearer` is not used here.
      headers: { Authorization: `token ${token}`, Accept: MEDIA_TYPE.json, 'User-Agent': USER_AGENT },
      timeoutMs: USAGE_TIMEOUT_MS,
      ...context
    });
    return parseCopilotUsage(usage);
  }

  return {
    id: 'copilot',
    // The environment's token, the CLI's after it, and a request for each.
    fetchTimeoutMs: TOKEN_TIMEOUT_MS + 2 * USAGE_TIMEOUT_MS,
    // The account exists where a sign-in does. A reading that could not be completed (a timeout)
    // proves nothing either way.
    async discover(): Promise<Discovery> {
      try {
        if (!environmentToken()) await storedToken();
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
      const fromEnvironment = environmentToken();
      if (!fromEnvironment) return readUsage(await storedToken(context), context);
      try {
        return await readUsage(fromEnvironment, context);
      } catch (error) {
        if (!(error instanceof ProviderError) || error.code !== 'auth_rejected') throw error;
        // A stale token in the environment must not hide the sign-in the GitHub CLI holds.
        const stored = await storedToken(context).catch(() => '');
        if (!stored || stored === fromEnvironment) throw error;
        return readUsage(stored, context);
      }
    }
  };
}
