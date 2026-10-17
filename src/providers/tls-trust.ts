import https from 'node:https';
import tls from 'node:tls';
import { ProviderError } from '../core/errors.ts';
import { asArray } from '../core/files.ts';

export type CertificateSource = Pick<typeof tls, 'getCACertificates'>;

// Node's bundled roots alone do not represent Windows/macOS trust. This uses the platform
// store, keeps the configured default and extra roots, and applies only to quota requests:
// no global TLS state is changed.
export function createQuotaAgent({ tlsApi = tls }: { tlsApi?: CertificateSource } = {}): https.Agent {
  let roots: unknown[];
  try {
    roots = [tlsApi.getCACertificates('default'), tlsApi.getCACertificates('system')];
  } catch (error) {
    throw new ProviderError('trust_store_unavailable', { cause: error });
  }
  if (!roots.every(Array.isArray)) throw new ProviderError('trust_store_unavailable');
  return new https.Agent({
    ca: [...new Set(roots.flatMap(list => asArray(list).filter(root => typeof root === 'string')))],
    rejectUnauthorized: true,
    checkServerIdentity: tls.checkServerIdentity,
    keepAlive: false
  });
}

let quotaAgent: https.Agent | undefined;
export function getQuotaAgent(): https.Agent {
  quotaAgent ??= createQuotaAgent();
  return quotaAgent;
}
