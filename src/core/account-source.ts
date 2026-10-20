import crypto from 'node:crypto';
import type { Account } from '../shared/types.ts';
import { normalizeEmail } from './model.ts';

type AccountSource = Pick<Account, 'providerId' | 'configDir' | 'configDirExplicit' | 'email'>;

// Only fields that select credentials or bind a reading to an account. Display edits do
// not change the source. Persist the digest so measurements need no raw e-mail address.
export function accountSourceKey(account: AccountSource): string {
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify([
        account.providerId,
        account.configDir ?? null,
        account.configDirExplicit ?? null,
        normalizeEmail(account.email ?? '')
      ])
    )
    .digest('hex');
}

export const sameAccountSource = (first: AccountSource, second: AccountSource): boolean =>
  accountSourceKey(first) === accountSourceKey(second);
