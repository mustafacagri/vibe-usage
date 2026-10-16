'use strict';
const https = require('node:https');
const tls = require('node:tls');

// Node's bundled roots alone do not represent Windows/macOS trust. Use the
// documented platform store API, preserving configured default/extra roots.
// This policy is private to external quota requests; no global TLS mutation.
function createQuotaAgent({ tlsApi = tls } = {}) {
  let defaults, system;
  try {
    if (typeof tlsApi.getCACertificates !== 'function') throw Error();
    defaults = tlsApi.getCACertificates('default');
    system = tlsApi.getCACertificates('system');
    if (!Array.isArray(defaults) || !Array.isArray(system)) throw Error();
  } catch {
    throw Error('trust_store_unavailable');
  }
  return new https.Agent({
    ca: [...new Set([...defaults, ...system])],
    rejectUnauthorized: true,
    checkServerIdentity: tls.checkServerIdentity,
    keepAlive: false,
  });
}

let quotaAgent;
function getQuotaAgent() {
  if (!quotaAgent) quotaAgent = createQuotaAgent();
  return quotaAgent;
}

module.exports = { createQuotaAgent, getQuotaAgent };
