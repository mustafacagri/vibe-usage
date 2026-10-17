import type { WindowInput } from '../core/model.ts';
import type { ProviderId } from '../shared/catalog.ts';
import type { Account, QuotaWindow } from '../shared/types.ts';

export interface FetchResult {
  windows: WindowInput[];
  plan?: string;
  // The source answered and reports no limits for the account.
  status?: 'no_limits_reported';
}

// What a response parser returns: windows already normalized.
export interface ParsedQuota extends FetchResult {
  windows: QuotaWindow[];
}

export type DiscoveredAccount = Omit<Account, 'origin'>;

// One quota source. `discover` lists the accounts present on this device; `fetch` reads one
// account's quota and throws a ProviderError when it cannot.
export interface ProviderAdapter {
  readonly id: ProviderId;
  discover(): Promise<DiscoveredAccount[]>;
  fetch(account: Account): Promise<FetchResult>;
}
