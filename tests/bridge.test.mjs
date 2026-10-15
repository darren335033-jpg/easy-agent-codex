import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { bridgeStatus, proxyCompanion, isCompanionRequest } from '../server/bridge.mjs';
import { createCompanionVerifier } from '../server/bridge-auth.mjs';

const secret = Buffer.alloc(32, 17).toString('base64url');
const env = { FORGE_COMPANION_URL: 'https://companion.example', FORGE_COMPANION_SECRET: secret };
const noFetch = async () => assert.fail('Rejected bridge requests must not contact any destination');
const incoming = (pathname, { method = 'GET', body, headers = {}, signal, origin = 'https://workspace.example' } = {}) => new Request(origin + pathname, { method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}), ...(signal ? { signal } : {}) });
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers } });
const decode = value => new TextDecoder().decode(value);

test('status reveals safe readiness booleans and a public origin, without the shared key', () => {
  assert.deepEqual(bridgeStatus({}).configured, false);
  const ready = bridgeStatus(env);
  assert.equal(ready.configured, true);
  assert.equal(ready.endpointConfigured, true);
  assert.equal(ready.secretConfigured, true);
  assert.equal(ready.endpoint, 'https://companion.example');
  assert.ok(!JSON.stringify(ready).includes(secret));
  assert.equal(bridgeStatus({ ...env, FORGE_COMPANION_URL: 'https://companion.example:443/' }).configured, true);
  for (const value of ['', 'invalid', 'x'.repeat(43), Buffer.alloc(32).toString('base64'), 'A'.repeat(42) + 'B']) {
    assert.equal(bridgeStatus({ ...env, FORGE_COMPANION_SECRET: value }).configured, false);
  }
});

test('configured URLs cannot contain credentials, paths, queries, fragments, private addresses or nonstandard ports', async () => {
  const blocked = ['http://companion.example', 'https://user:PRIVATE_PASSWORD@companion.example', 'https://companion.example/path', 'https://companion.example/?secret=PRIVATE_QUERY', 'https://companion.example/#PRIVATE_FRAGMENT', 'https://companion.example:8443', 'https://localhost', 'https://foo.localhost', 'https://foo.local', 'https://metadata.google.internal', 'https://10.0.0.1', 'https://127.0.0.1', 'https://192.168.1.1', 'https://172.16.0.1', 'https://169.254.169.254', 'https://100.64.0.1', 'https://2130706433', 'https://[::1]', 'https://[::]', 'https://[fc00::1]', 'https://[::ffff:127.0.0.1]', 'https://[2002:a00:1::]', 'https://[2001:db8::1]'];
  for (const url of blocked) {
    const configured = { ...env, FORGE_COMPANION_URL: url };
    const status = bridgeStatus(configured);
    assert.equal(status.endpointConfigured, false, url);
    assert.doesNotMatch(JSON.stringify(status), /PRIVATE_PASSWORD|PRIVATE_QUERY|PRIVATE_FRAGMENT/);
    const result = await proxyCompanion(incoming('/api/status'), configured, { fetch: noFetch });
    assert.equal(result.status, 503, url);
    assert.equal((await result.json()).error, 'BRIDGE_NOT_CONFIGURED');
  }
});

test('loopback is available only through an explicit trusted test option and self-origin proxy loops are blocked', async () => {
  const local = { ...env, FORGE_COMPANION_URL: 'http://127.0.0.1:8788' };
  const denied = await proxyCompanion(incoming('/api/status'), local, { fetch: noFetch });
  assert.equal(denied.status, 503);
  let calls = 0;
  const allowed = await proxyCompanion(incoming('/api/status'), local, { allowLocal: true, fetch: async url => { calls++; assert.equal(url, 'http://127.0.0.1:8788/api/status'); return json({ runtime: 'local' }); } });
  assert.equal(allowed.status, 200);
  assert.equal(calls, 1);
  const loop = await proxyCompanion(incoming('/api/status', { origin: 'https://companion.example' }), env, { fetch: noFetch });
  assert.equal(loop.status, 503);
  assert.equal((await loop.json()).error, 'BRIDGE_LOOP_BLOCKED');
  assert.equal(bridgeStatus({ ...local, FORGE_COMPANION_URL: 'http://localhost:8788' }, { allowLocal: true }).configured, false);
});

test('HMAC signs exact raw UTF-8 body bytes and strips every browser-controlled credential and forwarding header', async () => {
  const raw = '{ "path": "src/雪.js", "content": "α\\nβ" }';
  const before = Math.floor(Date.now() / 1000);
  let observed;
  const result = await proxyCompanion(incoming('/api/repository/read', { method: 'POST', body: raw, headers: { Origin: 'https://workspace.example', Cookie: 'private_browser_cookie', Authorization: 'Bearer private-browser-token', 'X-EA-Signature': 'forged', 'X-EA-Timestamp': '0', 'X-EA-Nonce': 'forged', 'X-Forwarded-Host': 'evil.example', 'X-Extra-Secret': 'private-extra-header' } }), env, { fetch: async (url, init) => {
    observed = { url, init };
    assert.equal(url, 'https://companion.example/api/repository/read');
    assert.equal(decode(init.body), raw);
    assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'manual');
    assert.equal(init.credentials, undefined);
    assert.equal(init.cache, undefined);
    const headers = new Headers(init.headers);
    assert.equal(headers.get('cookie'), null);
    assert.equal(headers.get('authorization'), null);
    assert.equal(headers.get('origin'), null);
    assert.equal(headers.get('x-forwarded-host'), null);
    assert.equal(headers.get('x-extra-secret'), null);
    assert.match(headers.get('x-ea-nonce'), /^[A-Za-z0-9_-]{22}$/);
    assert.match(headers.get('x-ea-signature'), /^[A-Za-z0-9_-]{43}$/);
    assert.ok(Number(headers.get('x-ea-timestamp')) >= before);
    const canonical = `${headers.get('x-ea-timestamp')}\n${headers.get('x-ea-nonce')}\nPOST\n/api/repository/read\n${createHash('sha256').update(Buffer.from(init.body)).digest('hex')}`;
    assert.equal(headers.get('x-ea-signature'), createHmac('sha256', Buffer.from(secret, 'base64url')).update(canonical).digest('base64url'));
    return json({ path: 'src/雪.js', content: 'intended source', privateEcho: secret }, 200, { 'Set-Cookie': 'upstream-private-cookie=must-not-forward', Authorization: 'must-not-forward', 'X-EA-Signature': 'must-not-forward' });
  } });
  assert.ok(observed);
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('x-ea-bridge'), 'companion');
  assert.equal(result.headers.get('cache-control'), 'private, no-store');
  assert.equal(result.headers.get('set-cookie'), null);
  assert.equal(result.headers.get('authorization'), null);
  assert.equal(result.headers.get('x-ea-signature'), null);
  const body = await result.json();
  assert.equal(body.content, 'intended source');
  assert.equal(body.privateEcho, '[redacted]');
});

test('gateway signatures interoperate with the companion verifier and cannot authorize changed paths, bodies or replays', async () => {
  const verifier = createCompanionVerifier(secret);
  const result = await proxyCompanion(incoming('/api/repository/read', { method: 'POST', body: { path: 'src/main.js' } }), env, { fetch: async (url, init) => {
    const signed = { method: init.method, pathname: new URL(url).pathname, headers: new Headers(init.headers), body: init.body };
    assert.equal(await verifier.verify(signed), true);
    await assert.rejects(verifier.verify({ ...signed, pathname: '/api/repository/apply' }), error => error.status === 401);
    await assert.rejects(verifier.verify({ ...signed, body: new TextEncoder().encode('{"path":"different.js"}') }), error => error.status === 401);
    await assert.rejects(verifier.verify(signed), error => error.code === 'COMPANION_REPLAY' && error.status === 409);
    return json({ verified: true });
  } });
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { verified: true });
});

test('coding retry identifiers are the only extra forwarded header and are covered by the HMAC', async () => {
  for (const requestKey of ['A', 'Retry-123', 'a'.repeat(100)]) {
    const result = await proxyCompanion(incoming('/api/coding/start', { method: 'POST', body: { task: 'Review café 🦘', provider: 'local' }, headers: { 'Idempotency-Key': requestKey, 'X-Extra-Header': 'must-not-forward' } }), env, { fetch: async (url, init) => {
      const headers = new Headers(init.headers);
      assert.equal(headers.get('idempotency-key'), requestKey);
      assert.equal(headers.get('x-extra-header'), null);
      const canonical = `${headers.get('x-ea-timestamp')}\n${headers.get('x-ea-nonce')}\nPOST\n/api/coding/start\n${createHash('sha256').update(Buffer.from(init.body)).digest('hex')}\n${requestKey}`;
      assert.equal(headers.get('x-ea-signature'), createHmac('sha256', Buffer.from(secret, 'base64url')).update(canonical).digest('base64url'));
      const verifier = createCompanionVerifier(secret);
      const signed = { method: init.method, pathname: new URL(url).pathname, headers, body: init.body };
      for (const changed of [null, `${requestKey === 'A' ? 'B' : 'A'}`]) {
        const tampered = new Headers(headers);
        if (changed === null) tampered.delete('idempotency-key'); else tampered.set('idempotency-key', changed);
        await assert.rejects(verifier.verify({ ...signed, headers: tampered }), error => error.status === 401);
      }
      assert.equal(await verifier.verify(signed), true);
      return json({ id: '10000000-0000-4000-8000-000000000000' }, 202);
    } });
    assert.equal(result.status, 202);
  }
});

test('invalid or unsupported coding retry identifiers are rejected before transport', async () => {
  for (const requestKey of ['', 'a'.repeat(101), 'has_underscore', 'has space', 'café', 'first,second']) {
    const result = await proxyCompanion(incoming('/api/coding/start', { method: 'POST', body: {}, headers: { 'Idempotency-Key': requestKey } }), env, { fetch: noFetch });
    assert.equal(result.status, 400, requestKey);
    assert.equal((await result.json()).error, 'BRIDGE_INVALID_REQUEST');
  }
  for (const [pathname, method] of [['/api/repository/status', 'GET'], ['/api/repository/read', 'POST'], ['/api/coding/runs/10000000-0000-4000-8000-000000000000/cancel', 'POST']]) {
    const result = await proxyCompanion(incoming(pathname, { method, ...(method === 'POST' ? { body: {} } : {}), headers: { 'Idempotency-Key': 'valid-key' } }), env, { fetch: noFetch });
    assert.equal(result.status, 400, pathname);
  }
});

test('every allowed read/action route has its exact method and unique nonces, including durable start and typed CLI', async () => {
  const id = 'a23fb848-cf18-4b91-b55e-43c133b1a124';
  const reads = ['/api/status', '/api/provider/models', '/api/repository/status', '/api/coding/runs', `/api/coding/runs/${id}`, '/api/companion/cli/status'];
  const actions = ['/api/repository/tree', '/api/repository/read', '/api/repository/search', '/api/repository/apply', '/api/repository/test', '/api/repository/git/status', '/api/repository/git/diff', '/api/repository/git/branch', '/api/repository/git/commit', '/api/coding/start', `/api/coding/runs/${id}/apply`, `/api/coding/runs/${id}/cancel`, '/api/integrations/cli/run'];
  const nonces = new Set();
  const fetch = async (url, init) => {
    const headers = new Headers(init.headers);
    assert.ok(!nonces.has(headers.get('x-ea-nonce')));
    nonces.add(headers.get('x-ea-nonce'));
    const route = new URL(url).pathname;
    const content = init.method === 'GET' ? Buffer.alloc(0) : Buffer.from(init.body);
    const expected = createHmac('sha256', Buffer.from(secret, 'base64url')).update(`${headers.get('x-ea-timestamp')}\n${headers.get('x-ea-nonce')}\n${init.method}\n${route}\n${createHash('sha256').update(content).digest('hex')}`).digest('base64url');
    assert.equal(headers.get('x-ea-signature'), expected);
    if (init.method === 'GET') assert.equal(init.body, undefined);
    return json({ route }, route === '/api/coding/start' ? 202 : 200);
  };
  for (const route of reads) { assert.equal(isCompanionRequest('GET', route), true); assert.equal(isCompanionRequest('POST', route), false); assert.equal((await proxyCompanion(incoming(route), env, { fetch })).status, 200, route); }
  for (const route of actions) { assert.equal(isCompanionRequest('POST', route), true); assert.equal(isCompanionRequest('GET', route), false); assert.equal((await proxyCompanion(incoming(route, { method: 'POST', body: {} }), env, { fetch })).status, route === '/api/coding/start' ? 202 : 200, route); }
  assert.equal(nonces.size, reads.length + actions.length);
});

test('unknown routes, queries, method changes, HEAD mutation attempts and cross-origin actions cannot reach the companion', async () => {
  for (const path of ['/api/terminal', '/api/run', '/api/integrations/oauth/start', '/api/integrations/mcp/test', '/api/integrations/github/read', '/api/admin', '/api/coding/runs/../../apply']) assert.equal((await proxyCompanion(incoming(path), env, { fetch: noFetch })).status, 404, path);
  for (const method of ['GET', 'HEAD', 'PUT', 'DELETE']) assert.equal((await proxyCompanion(incoming('/api/repository/apply', { method }), env, { fetch: noFetch })).status, 405, method);
  assert.equal((await proxyCompanion(incoming('/api/repository/status', { method: 'POST', body: {} }), env, { fetch: noFetch })).status, 405);
  assert.equal((await proxyCompanion(incoming('/api/status?forward=https://evil.example'), env, { fetch: noFetch })).status, 400);
  assert.equal((await proxyCompanion(incoming('/api/repository/read', { method: 'POST', body: {}, headers: { Origin: 'https://attacker.example' } }), env, { fetch: noFetch })).status, 403);
});

test('invalid JSON, MIME types and both announced and streamed oversized requests fail before signing or fetch', async () => {
  for (const [body, headers, expected] of [['{broken', {}, 400], ['{}', { 'content-type': 'text/plain' }, 415], ['{}', { 'content-length': '500001' }, 413], [JSON.stringify({ content: 'x'.repeat(500000) }), {}, 413]]) {
    const result = await proxyCompanion(incoming('/api/repository/read', { method: 'POST', body, headers }), env, { fetch: noFetch });
    assert.equal(result.status, expected);
  }
});

test('redirects never forward signatures to Location and never expose destination or secret text', async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    let calls = 0;
    const result = await proxyCompanion(incoming('/api/status'), env, { fetch: async (url, init) => {
      calls++;
      assert.equal(url, 'https://companion.example/api/status');
      assert.equal(init.redirect, 'manual');
      return new Response(`private ${secret}`, { status, headers: { Location: `https://credential-sink.example/${secret}` } });
    } });
    assert.equal(calls, 1);
    assert.equal(result.status, 502);
    const body = await result.json();
    assert.equal(body.error, 'BRIDGE_REDIRECT_BLOCKED');
    assert.doesNotMatch(JSON.stringify(body), /credential-sink/);
    assert.ok(!JSON.stringify(body).includes(secret));
  }
});

test('valid upstream failures preserve status with safe conflict guidance and omit arbitrary error diagnostics', async () => {
  for (const status of [400, 401, 403, 404, 409, 429, 500, 503]) {
    const result = await proxyCompanion(incoming('/api/status'), env, { fetch: async () => json({ error: 'PRIVATE_PROVIDER_DIAGNOSTIC', message: `access_token=${secret}`, stack: '/private/server/path' }, status) });
    assert.equal(result.status, status);
    const body = await result.json();
    assert.doesNotMatch(JSON.stringify(body), /PRIVATE_PROVIDER_DIAGNOSTIC|access_token|private\/server/);
    assert.ok(!JSON.stringify(body).includes(secret));
    if (status === 409) { assert.equal(body.error, 'FILE_CONFLICT'); assert.match(body.message, /changed.*Refresh/); }
  }
});

test('non-JSON, malformed, oversized and network failures are bounded and sanitized', async () => {
  for (const fetch of [async () => new Response('PRIVATE_HTML', { headers: { 'Content-Type': 'text/html' } }), async () => new Response('PRIVATE_INVALID_JSON', { headers: { 'Content-Type': 'application/json' } }), async () => json({}, 200, { 'Content-Length': String(8 * 1024 * 1024 + 1) }), async () => new Response('x'.repeat(8 * 1024 * 1024 + 1), { headers: { 'Content-Type': 'application/json' } }), async () => { throw new Error(`PRIVATE_NETWORK_ERROR ${secret}`); }, async () => { throw new DOMException('PRIVATE_NETWORK_ERROR', 'NetworkError'); }]) {
    const result = await proxyCompanion(incoming('/api/status'), env, { fetch });
    assert.equal(result.status, 502);
    const output = await result.text();
    assert.doesNotMatch(output, /PRIVATE_HTML|PRIVATE_INVALID_JSON|PRIVATE_NETWORK_ERROR/);
    assert.ok(!output.includes(secret));
  }
});

test('deadlines and cancellation abort active companion requests without reporting successful work', async () => {
  let timeoutSignal;
  const timedOut = await proxyCompanion(incoming('/api/status'), env, { timeoutMs: 1000, fetch: async (url, init) => { timeoutSignal = init.signal; return new Promise(() => {}); } });
  assert.equal(timedOut.status, 504);
  assert.equal((await timedOut.json()).error, 'BRIDGE_TIMEOUT');
  assert.equal(timeoutSignal.aborted, true);
  const controller = new AbortController();
  let observed;
  const pending = proxyCompanion(incoming('/api/repository/read', { method: 'POST', body: { path: 'main.js' }, signal: controller.signal }), env, { fetch: async (url, init) => { observed = init.signal; controller.abort(); return new Promise(() => {}); } });
  const cancelled = await pending;
  assert.equal(cancelled.status, 408);
  assert.equal((await cancelled.json()).error, 'BRIDGE_CANCELLED');
  assert.equal(observed.aborted, true);
});

test('the same deadline bounds stalled request uploads and stalled companion response streams', async () => {
  let uploadCancelled = false;
  const upload = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"task":"pending"}')); }, cancel() { uploadCancelled = true; } });
  const request = new Request('https://workspace.example/api/coding/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: upload, duplex: 'half' });
  const stalledUpload = await proxyCompanion(request, env, { timeoutMs: 10, fetch: noFetch });
  assert.equal(stalledUpload.status, 504);
  assert.equal(uploadCancelled, true);
  let responseCancelled = false;
  // Leave enough time for asynchronous HMAC work under the parallel test suite;
  // this case verifies a stalled response stream after transport has started.
  const stalledResponse = await proxyCompanion(incoming('/api/status'), env, { timeoutMs: 1000, fetch: async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"pending":')); }, cancel() { responseCancelled = true; } }), { headers: { 'Content-Type': 'application/json' } }) });
  assert.equal(stalledResponse.status, 504);
  assert.equal(responseCancelled, true);
});

test('native Worker fetch keeps its required receiver and caller-provided fetch is never rebound', async () => {
  const original = globalThis.fetch;
  let nativeCalls = 0;
  globalThis.fetch = async function(url, init) {
    if (this !== globalThis) throw new TypeError('Illegal invocation');
    assert.equal(init.redirect, 'manual');
    assert.equal(init.credentials, undefined);
    assert.equal(init.cache, undefined);
    nativeCalls++;
    return json({ ready: true });
  };
  try {
    assert.equal((await proxyCompanion(incoming('/api/status'), env)).status, 200);
    const injected = await proxyCompanion(incoming('/api/status'), env, { fetch: async function() { assert.equal(this, undefined); return json({ ready: true }); } });
    assert.equal(injected.status, 200);
    assert.equal(nativeCalls, 1);
  } finally { globalThis.fetch = original; }
});
