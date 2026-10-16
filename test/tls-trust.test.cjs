'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const tls = require('node:tls');
const { EventEmitter } = require('node:events');

const certificate = fs.readFileSync(path.join(__dirname, 'fixtures/tls/localhost-cert.pem'), 'utf8');
const privateKey = fs.readFileSync(path.join(__dirname, 'fixtures/tls/localhost-key.pem'), 'utf8');
const createQuotaAgent = (...args) => require('../src/providers/tls-trust.cjs').createQuotaAgent(...args);

function testTrust(system = [], defaults = []) {
  return { getCACertificates: type => type === 'system' ? system : defaults };
}

async function localServer(t) {
  const server = https.createServer({ key: privateKey, cert: certificate }, (_request, response) => {
    response.end('verified');
  });
  server.on('tlsClientError', () => {});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return server.address().port;
}

function request(port, agent, servername = 'localhost') {
  return new Promise((resolve, reject) => {
    const req = https.get({ hostname: '127.0.0.1', port, servername, agent, timeout: 2000 }, response => {
      const authorized = response.socket.authorized;
      response.resume();
      response.on('end', () => resolve({ status: response.statusCode, authorized }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(Error('test_timeout')));
  });
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
  t.after(() => agent.destroy());
  assert.deepEqual(await request(port, agent), { status: 200, authorized: true });
});

test('untrusted certificates are rejected before any HTTP request', async t => {
  const port = await localServer(t);
  const agent = createQuotaAgent({ tlsApi: testTrust() });
  t.after(() => agent.destroy());
  await assert.rejects(request(port, agent), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' });
});

test('OS trust never bypasses hostname verification', async t => {
  const port = await localServer(t);
  const agent = createQuotaAgent({ tlsApi: testTrust([certificate]) });
  t.after(() => agent.destroy());
  await assert.rejects(request(port, agent, 'wrong.example'), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
});

test('unavailable platform trust fails explicitly instead of silently using a different trust policy', () => {
  assert.throws(() => createQuotaAgent({ tlsApi: {} }), /trust_store_unavailable/);
  assert.throws(() => createQuotaAgent({ tlsApi: { getCACertificates() { throw Error('private store detail'); } } }), /^Error: trust_store_unavailable$/);
});

test('shared quota HTTP requests use a private agent with platform trust and verification enabled', async () => {
  const { getJson } = require('../src/providers/common.cjs');
  let requestOptions;
  const requestImpl = (_url, options, callback) => {
    requestOptions = options;
    const req = new EventEmitter();
    req.destroy = () => {};
    queueMicrotask(() => {
      const response = new EventEmitter();
      response.statusCode = 200;
      response.destroy = () => {};
      callback(response);
      response.emit('data', Buffer.from('{"ok":true}'));
      response.emit('end');
    });
    return req;
  };
  assert.deepEqual(await getJson('https://cursor.com/api/usage-summary', { requestImpl }), { ok: true });
  assert.equal(requestOptions.rejectUnauthorized, true);
  assert.ok(requestOptions.agent instanceof https.Agent);
  assert.equal(requestOptions.agent.options.rejectUnauthorized, true);
  assert.equal(requestOptions.agent.options.checkServerIdentity, tls.checkServerIdentity);
});

test('shared quota HTTP exposes a safe certificate error without raw certificate details', async () => {
  const { getJson } = require('../src/providers/common.cjs');
  let requestOptions;
  const requestImpl = (_url, options) => {
    requestOptions = options;
    const req = new EventEmitter();
    req.destroy = () => {};
    queueMicrotask(() => req.emit('error', Object.assign(Error('private certificate details'), { code: 'SELF_SIGNED_CERT_IN_CHAIN' })));
    return req;
  };
  await assert.rejects(getJson('https://cursor.com/api/usage-summary', { requestImpl }), error => {
    assert.equal(error.code, 'tls_certificate_error');
    assert.equal(error.message.includes('private'), false);
    return true;
  });
  assert.equal(requestOptions.rejectUnauthorized, true);
  assert.ok(requestOptions.agent instanceof https.Agent);
  assert.equal(requestOptions.agent.options.rejectUnauthorized, true);
  assert.equal(requestOptions.agent.options.checkServerIdentity, tls.checkServerIdentity);
});
