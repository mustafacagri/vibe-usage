import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import type { ClientRequest, IncomingMessage } from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import tls from 'node:tls';
import { ProviderError } from '../src/core/errors.ts';
import { getJson } from '../src/providers/common.ts';
import { createQuotaAgent, type CertificateSource } from '../src/providers/tls-trust.ts';

const FIXTURES = path.join(import.meta.dirname, 'fixtures/tls');
const certificate = fs.readFileSync(path.join(FIXTURES, 'localhost-cert.pem'), 'utf8');
const privateKey = fs.readFileSync(path.join(FIXTURES, 'localhost-key.pem'), 'utf8');

const testTrust = (system: string[] = [], defaults: string[] = []): CertificateSource => ({
  getCACertificates: type => (type === 'system' ? system : defaults)
});

async function localServer(t: TestContext): Promise<number> {
  const server = https.createServer({ key: privateKey, cert: certificate }, (_request, response) => {
    response.end('verified');
  });
  server.on('tlsClientError', () => undefined);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return (server.address() as AddressInfo).port;
}

function request(port: number, agent: https.Agent, servername = 'localhost'): Promise<{ status: number | undefined; authorized: boolean }> {
  return new Promise((resolve, reject) => {
    const req = https.get({ hostname: '127.0.0.1', port, servername, agent, timeout: 2000 }, response => {
      const { authorized } = response.socket as tls.TLSSocket;
      response.resume();
      response.on('end', () => {
        resolve({ status: response.statusCode, authorized });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('test_timeout')));
  });
}

// An https.get stand-in that records its options and answers with `respond`.
function fakeGet(respond: (request: EventEmitter, callback: (response: IncomingMessage) => void) => void) {
  const seen: { options?: https.RequestOptions } = {};
  const requestImpl = (_url: URL, options: https.RequestOptions, callback: (response: IncomingMessage) => void): ClientRequest => {
    seen.options = options;
    const req = Object.assign(new EventEmitter(), { destroy: () => undefined });
    queueMicrotask(() => {
      respond(req, callback);
    });
    return req as unknown as ClientRequest;
  };
  return { requestImpl, seen };
}

function assertVerifiedAgent(options: https.RequestOptions | undefined): void {
  assert.equal(options?.rejectUnauthorized, true);
  const agent = options.agent;
  assert.ok(agent instanceof https.Agent);
  assert.equal(agent.options.rejectUnauthorized, true);
  assert.equal(agent.options.checkServerIdentity, tls.checkServerIdentity);
}

test('quota trust includes OS roots and configured defaults without changing global TLS policy', () => {
  const globalAgent = https.globalAgent;
  const defaultRoots = tls.getCACertificates('default');
  const agent = createQuotaAgent({ tlsApi: testTrust(['os-root', 'duplicate'], ['default-root', 'duplicate']) });
  assert.deepEqual(agent.options.ca, ['default-root', 'duplicate', 'os-root']);
  assert.equal(agent.options.rejectUnauthorized, true);
  assert.equal(agent.options.checkServerIdentity, tls.checkServerIdentity);
  assert.equal(https.globalAgent, globalAgent);
  assert.deepEqual(tls.getCACertificates('default'), defaultRoots);
  agent.destroy();
});

test('a certificate trusted only by the OS source passes a real TLS handshake', async t => {
  const port = await localServer(t);
  const agent = createQuotaAgent({ tlsApi: testTrust([certificate]) });
  t.after(() => {
    agent.destroy();
  });
  assert.deepEqual(await request(port, agent), { status: 200, authorized: true });
});

test('untrusted certificates are rejected before any HTTP request', async t => {
  const port = await localServer(t);
  const agent = createQuotaAgent({ tlsApi: testTrust() });
  t.after(() => {
    agent.destroy();
  });
  await assert.rejects(request(port, agent), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' });
});

test('OS trust never bypasses hostname verification', async t => {
  const port = await localServer(t);
  const agent = createQuotaAgent({ tlsApi: testTrust([certificate]) });
  t.after(() => {
    agent.destroy();
  });
  await assert.rejects(request(port, agent, 'wrong.example'), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
});

test('unavailable platform trust fails explicitly instead of silently using a different trust policy', () => {
  const unavailable = (tlsApi: CertificateSource) => () => createQuotaAgent({ tlsApi });
  const failure = (error: unknown): boolean =>
    error instanceof ProviderError && error.code === 'trust_store_unavailable' && !error.message.includes('private');
  assert.throws(
    unavailable({
      getCACertificates() {
        throw new Error('private store detail');
      }
    }),
    failure
  );
  assert.throws(unavailable({ getCACertificates: () => 'not a list' as unknown as string[] }), failure);
});

test('shared quota HTTP requests use a private agent with platform trust and verification enabled', async () => {
  const { requestImpl, seen } = fakeGet((_request, callback) => {
    const response = Object.assign(new EventEmitter(), { statusCode: 200, headers: {}, destroy: () => undefined });
    callback(response as unknown as IncomingMessage);
    response.emit('data', Buffer.from('{"ok":true}'));
    response.emit('end');
  });
  assert.deepEqual(await getJson('https://cursor.com/api/usage-summary', { requestImpl }), { ok: true });
  assertVerifiedAgent(seen.options);
});

test('shared quota HTTP exposes a safe certificate error without raw certificate details', async () => {
  const { requestImpl, seen } = fakeGet(req => {
    req.emit('error', Object.assign(new Error('private certificate details'), { code: 'SELF_SIGNED_CERT_IN_CHAIN' }));
  });
  await assert.rejects(
    getJson('https://cursor.com/api/usage-summary', { requestImpl }),
    (error: unknown) => error instanceof ProviderError && error.code === 'tls_certificate_error' && !error.message.includes('private')
  );
  assertVerifiedAgent(seen.options);
});
