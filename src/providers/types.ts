import type { WindowInput } from '../core/model.ts';
import type { ProviderId } from '../shared/catalog.ts';
import type { Account, QuotaWindow } from '../shared/types.ts';

export interface FetchResult {
  windows: WindowInput[];
  // A complete response replaces the previous set. A partial response retains missing
  // windows as stale, except those the source explicitly says no longer apply.
  completeness?: 'complete' | 'partial';
  removedWindowIds?: readonly string[];
  plan?: string;
  // The e-mail the account is signed in with, as the tool recorded it on this device.
  signedInAs?: string;
  // The source answered and reports no limits for the account.
  status?: 'no_limits_reported';
}

// What a response parser returns: windows already normalized.
export interface ParsedQuota extends FetchResult {
  windows: QuotaWindow[];
}

export type DiscoveredAccount = Omit<Account, 'origin'>;

export interface Discovery {
  kind: 'complete' | 'unknown';
  accounts: DiscoveredAccount[];
}

// A refresh has one wall-clock budget, shared by credential reads, processes and requests.
export interface RefreshContext {
  deadline: number;
  signal: AbortSignal;
}

export type ProviderReading =
  { kind: 'complete' | 'partial' | 'no_limits_reported'; result: FetchResult } | { kind: 'failed'; error: unknown };

export const providerReading = (result: FetchResult): ProviderReading => ({
  kind: result.status === 'no_limits_reported' ? 'no_limits_reported' : (result.completeness ?? 'partial'),
  result
});

// Unknown discovery may add a positively identified account, but never proves absence.
export async function discoverSafely(discover: () => Promise<DiscoveredAccount[]>): Promise<Discovery> {
  try {
    return { kind: 'complete', accounts: await discover() };
  } catch {
    return { kind: 'unknown', accounts: [] };
  }
}

// One quota source. `discover` lists the accounts present on this device; `fetch` reads one
// account's quota and throws a ProviderError when it cannot.
export interface ProviderAdapter {
  readonly id: ProviderId;
  // The longest one read may take, from the adapter's own time limits; the service waits that
  // long before it gives the read up. Without it, the service's default.
  readonly fetchTimeoutMs?: number;
  discover(): Promise<Discovery | DiscoveredAccount[]>;
  fetch(account: Account, context?: RefreshContext): Promise<FetchResult>;
  // Sources shared by several accounts may read them together once per refresh.
  fetchAll?(accounts: readonly Account[], context: RefreshContext): Promise<Map<string, ProviderReading>>;
}
