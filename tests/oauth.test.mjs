import test from 'node:test';
import assert from 'node:assert/strict';
import { OAUTH_PROVIDERS, startOAuth, callbackOAuth, getOAuthToken, oauthStatus, disconnectOAuth } from '../server/oauth.mjs';

const env = { OAUTH_SESSION_SECRET: Buffer.alloc(32, 7).toString('base64url') };
const origin = 'https://forge.example';
const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const request = (pathname, options = {}) => new Request(`${options.origin || origin}${pathname}`, { method: options.method || 'GET', headers: { ...(options.cookie ? { Cookie: options.cookie } : {}), ...options.headers } });
const cookies = response => response.headers.getSetCookie();
const cookiePair = cookie => cookie.split(';')[0];
async function flow(providerId = 'aweber', options = {}) {
  const appOrigin = options.origin || origin;
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    assert.equal(init.redirect, 'manual');
    if (url === OAUTH_PROVIDERS[providerId].registrationEndpoint) return jsonResponse({ client_id: 'fixture-client', token_endpoint_auth_method: options.authMethod || 'none', ...(options.authMethod && options.authMethod !== 'none' ? { client_secret: 'fixture-client-secret' } : {}), ...options.registration });
    assert.equal(url, OAUTH_PROVIDERS[providerId].tokenEndpoint, 'Tokens are sent only to the fixed provider endpoint');
    return options.tokenResponse ? options.tokenResponse() : jsonResponse({ access_token: 'fixture-access-token', token_type: 'Bearer', expires_in: 3600, ...options.token });
  };
  const started = await startOAuth(providerId, request(`/api/integrations/oauth/start/${providerId}`, { origin: appOrigin, method: 'POST' }), env, { fetch, now: options.now });
  assert.equal(started.status, 200);
  const authorization = new URL((await started.json()).authorizationUrl);
  const stateCookie = cookies(started)[0];
  const callbackRequest = ({ state = authorization.searchParams.get('state'), code = 'fixture-one-use-code', cookie = cookiePair(stateCookie), origin: callbackOrigin = appOrigin, extra = '' } = {}) => request(`/api/integrations/oauth/callback/${providerId}?state=${encodeURIComponent(state)}&code=${encodeURIComponent(code)}${extra}`, { origin: callbackOrigin, cookie });
  return { started, authorization, stateCookie, calls, fetch, callbackRequest, providerId };
}

test('each verified provider uses DCR, PKCE and an encrypted session without exposing tokens to the browser', async () => {
  for (const id of Object.keys(OAUTH_PROVIDERS)) {
    const f = await flow(id);
    const provider = OAUTH_PROVIDERS[id];
    assert.equal(f.calls.length, 1, 'Starting authorization registers a client but does not exchange tokens');
    const registration = JSON.parse(f.calls[0].init.body);
    assert.deepEqual(registration.redirect_uris, [`${origin}/api/integrations/oauth/callback/${id}`]);
    assert.equal(registration.token_endpoint_auth_method, 'none');
    assert.deepEqual(registration.grant_types, ['authorization_code']);
    assert.equal(f.authorization.origin, new URL(provider.authorizationEndpoint).origin);
    assert.equal(f.authorization.pathname, new URL(provider.authorizationEndpoint).pathname);
    assert.equal(f.authorization.searchParams.get('resource'), provider.resource);
    assert.equal(f.authorization.searchParams.get('scope'), provider.scopes.join(' '));
    assert.equal(f.authorization.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(f.authorization.searchParams.get('state').length, 43);
    assert.match(f.stateCookie, /HttpOnly; SameSite=Lax; Max-Age=600; Secure/);
    assert.ok(f.stateCookie.startsWith('__Host-'));
    assert.ok(f.stateCookie.length <= 4096);
    assert.ok(!f.stateCookie.includes('fixture-client'));
    assert.ok(!f.stateCookie.includes(f.authorization.searchParams.get('state')));
    assert.equal(await getOAuthToken(id, request('/', { cookie: cookiePair(f.stateCookie) }), env), undefined);

    const callback = await callbackOAuth(id, f.callbackRequest(), env, { fetch: f.fetch });
    assert.equal(callback.status, 303);
    assert.equal(callback.headers.get('location'), `${origin}/?integration=${id}&oauth=connected`);
    assert.equal(await callback.text(), '');
    const callbackCookies = cookies(callback);
    assert.equal(callbackCookies.length, 2);
    assert.match(callbackCookies[0], /Max-Age=0/);
    const accountCookie = callbackCookies.find(cookie => cookie.includes(`ea_oauth_account_${id}=`));
    assert.ok(accountCookie && accountCookie.length <= 4096);
    assert.ok(!accountCookie.includes('fixture-access-token'));
    const exchange = f.calls[1].init.body;
    assert.equal(exchange.get('code'), 'fixture-one-use-code');
    assert.equal(exchange.get('client_id'), 'fixture-client');
    assert.equal(exchange.get('redirect_uri'), `${origin}/api/integrations/oauth/callback/${id}`);
    const challenge = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(exchange.get('code_verifier')))).toString('base64url');
    assert.equal(challenge, f.authorization.searchParams.get('code_challenge'));
    const authenticated = request('/', { cookie: cookiePair(accountCookie) });
    assert.equal(await getOAuthToken(id, authenticated, env), 'fixture-access-token');
    const status = await oauthStatus(id, authenticated, env);
    assert.equal(status.connected, true);
    assert.ok(!JSON.stringify(status).includes('fixture-access-token'));
    assert.equal(status.scope, provider.scopes.join(' '));
    assert.equal(callback.headers.get('cache-control'), 'no-store');
  }
});

test('scope requests are limited to the fixed documented minimums and cannot be overridden by input', async () => {
  const f = await flow('sandcastles');
  assert.equal(f.authorization.searchParams.get('scope'), 'openid');
  assert.equal(f.authorization.searchParams.has('client_secret'), false);
  assert.equal(f.authorization.searchParams.has('refresh_token'), false);
  assert.deepEqual(Object.keys(OAUTH_PROVIDERS), ['aweber', 'getresponse', 'sandcastles']);
  const denied = await startOAuth('cloudflare', request('/api/start', { method: 'POST' }), env, { fetch: () => assert.fail('Unverified provider must not register') });
  assert.equal(denied.status, 404);
});

test('invalid server secrets, insecure origins, cross-site starts and wrong methods fail before provider access', async () => {
  const fetch = () => assert.fail('Invalid request must not reach provider');
  for (const secret of [undefined, 'short', Buffer.alloc(31).toString('base64url'), Buffer.alloc(33).toString('base64url'), 'x'.repeat(43) + '=']) {
    const response = await startOAuth('aweber', request('/api/start', { method: 'POST' }), { OAUTH_SESSION_SECRET: secret }, { fetch });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error, 'OAUTH_NOT_CONFIGURED');
  }
  const insecure = await startOAuth('aweber', request('/api/start', { origin: 'http://public.example', method: 'POST' }), env, { fetch });
  assert.equal(insecure.status, 400);
  for (const headers of [{ origin: 'https://evil.example' }, { 'sec-fetch-site': 'cross-site' }, { origin: 'null' }]) {
    const response = await startOAuth('aweber', request('/api/start', { method: 'POST', headers }), env, { fetch });
    assert.equal(response.status, 403);
  }
  const wrongMethod = await startOAuth('aweber', request('/api/start'), env, { fetch });
  assert.equal(wrongMethod.status, 405);
});

test('state is validated, expires in ten minutes, is provider/origin bound, and is consumed once per isolate', async () => {
  const f = await flow('aweber', { now: () => 1000000000 });
  for (const [callbackRequest, options] of [
    [f.callbackRequest({ state: 'incorrect-state' }), { now: () => 1000000000 }],
    [f.callbackRequest({ cookie: '' }), { now: () => 1000000000 }],
    [f.callbackRequest(), { now: () => 1000000000 + 601000 }],
    [f.callbackRequest({ origin: 'https://other.example' }), { now: () => 1000000000 }],
  ]) {
    const failed = await callbackOAuth('aweber', callbackRequest, env, { ...options, fetch: () => assert.fail('Invalid state must not exchange a token') });
    assert.equal(failed.status, 303);
    assert.ok(failed.headers.get('location').includes('oauth=error'));
    assert.match(cookies(failed)[0], /Max-Age=0/);
  }
  const providerCookie = cookiePair(f.stateCookie).replace('ea_oauth_state_aweber=', 'ea_oauth_state_getresponse=');
  const wrongProvider = await callbackOAuth('getresponse', request(`/api/integrations/oauth/callback/getresponse?state=${f.authorization.searchParams.get('state')}&code=code`, { cookie: providerCookie }), env, { now: () => 1000000000, fetch: () => assert.fail('Provider-bound cookie must not decrypt for a different provider') });
  assert.ok(wrongProvider.headers.get('location').includes('oauth=error'));
  const success = await callbackOAuth('aweber', f.callbackRequest(), env, { fetch: f.fetch, now: () => 1000000000 });
  assert.ok(success.headers.get('location').includes('oauth=connected'));
  const replay = await callbackOAuth('aweber', f.callbackRequest(), env, { fetch: () => assert.fail('Consumed state must not exchange another token'), now: () => 1000000000 });
  assert.ok(replay.headers.get('location').includes('oauth=error'));
});

test('declined consent and invalid authorization codes clear state without a token exchange', async () => {
  for (const extra of ['&error=access_denied&error_description=private-provider-detail', '']) {
    const f = await flow();
    const response = await callbackOAuth('aweber', f.callbackRequest({ code: extra ? 'code' : '', extra }), env, { fetch: () => assert.fail('Declined consent or empty code must not exchange tokens') });
    assert.equal(response.status, 303);
    assert.ok(response.headers.get('location').endsWith('oauth=error&reason=authorization_failed'));
    assert.ok(!response.headers.get('location').includes('private-provider-detail'));
    assert.match(cookies(response)[0], /Max-Age=0/);
  }
});

test('account cookies are origin/provider bound, encrypted against modification, and expire at provider lifetime', async () => {
  const now = () => 2000000000;
  const f = await flow('aweber', { now, token: { expires_in: 60 } });
  const callback = await callbackOAuth('aweber', f.callbackRequest(), env, { fetch: f.fetch, now });
  const accountCookie = cookies(callback).find(cookie => cookie.includes('ea_oauth_account_aweber='));
  const originalPair = cookiePair(accountCookie);
  assert.equal(await getOAuthToken('aweber', request('/', { cookie: originalPair }), env, { now }), 'fixture-access-token');
  assert.equal(await getOAuthToken('aweber', request('/', { cookie: originalPair }), env, { now: () => now() + 61000 }), undefined);
  const expired = await oauthStatus('aweber', request('/', { cookie: originalPair }), env, { now: () => now() + 61000 });
  assert.equal(expired.connected, false);
  assert.ok(expired.reason.includes('expired'));
  assert.equal(await getOAuthToken('aweber', request('/', { cookie: originalPair, origin: 'https://other.example' }), env, { now }), undefined);
  const otherProvider = originalPair.replace('ea_oauth_account_aweber=', 'ea_oauth_account_getresponse=');
  assert.equal(await getOAuthToken('getresponse', request('/', { cookie: otherProvider }), env, { now }), undefined);
  const tampered = originalPair.slice(0, -4) + 'AAAA';
  assert.equal(await getOAuthToken('aweber', request('/', { cookie: tampered }), env, { now }), undefined);
  assert.equal(await getOAuthToken('aweber', request('/', { cookie: `${originalPair}; ${originalPair}` }), env, { now }), undefined);
});

test('session lifetime is capped at a day and large provider tokens fail closed within cookie bounds', async () => {
  const f = await flow('aweber', { token: { expires_in: 864000 } });
  const callback = await callbackOAuth('aweber', f.callbackRequest(), env, { fetch: f.fetch });
  assert.match(cookies(callback).find(cookie => cookie.includes('ea_oauth_account_aweber=')), /Max-Age=86400/);
  const large = await flow('aweber', { token: { access_token: 'secret'.repeat(600) } });
  const failed = await callbackOAuth('aweber', large.callbackRequest(), env, { fetch: large.fetch });
  assert.ok(failed.headers.get('location').includes('oauth=error'));
  assert.equal(cookies(failed).length, 1, 'No oversized account cookie is issued');
  assert.ok(cookies(failed).every(cookie => cookie.length <= 4096));
});

test('verified Sandcastles confidential registration methods keep client secrets server-side', async () => {
  for (const authMethod of ['client_secret_post', 'client_secret_basic']) {
    const f = await flow('sandcastles', { authMethod });
    assert.ok(!f.stateCookie.includes('fixture-client-secret'));
    assert.ok(!f.authorization.href.includes('fixture-client-secret'));
    const callback = await callbackOAuth('sandcastles', f.callbackRequest(), env, { fetch: f.fetch });
    assert.ok(callback.headers.get('location').includes('oauth=connected'));
    const exchange = f.calls[1].init;
    if (authMethod === 'client_secret_post') assert.equal(exchange.body.get('client_secret'), 'fixture-client-secret');
    else assert.equal(Buffer.from(exchange.headers.Authorization.slice(6), 'base64').toString(), 'fixture-client:fixture-client-secret');
  }
});

test('provider errors, unsafe DCR responses and thrown fetch details are sanitized', async () => {
  for (const fetch of [
    async () => jsonResponse({ error: 'sensitive-error', client_secret: 'secret-do-not-display' }, 400),
    async () => { throw new Error('Bearer private-token /private/path'); },
    async () => jsonResponse({ client_id: 'fixture', token_endpoint_auth_method: 'client_secret_basic', client_secret: 'private-secret' }),
    async () => jsonResponse({ client_id: 'fixture', redirect_uris: ['https://evil.example/callback'] }),
    async () => new Response('not json private-token'),
    async () => new Response('x'.repeat(65537)),
  ]) {
    const response = await startOAuth('aweber', request('/api/start', { method: 'POST' }), env, { fetch });
    assert.equal(response.status, 502);
    assert.ok(!JSON.stringify(await response.json()).includes('private-token'));
  }
  const f = await flow('aweber', { tokenResponse: () => jsonResponse({ access_token: 'never-display', token_type: 'Bearer', expires_in: -1 }) });
  const failed = await callbackOAuth('aweber', f.callbackRequest(), env, { fetch: f.fetch });
  assert.ok(failed.headers.get('location').includes('oauth=error'));
  assert.ok(!JSON.stringify([...failed.headers]).includes('never-display'));
});

test('localhost development cookies work without Secure and disconnect clears state and account only', async () => {
  const f = await flow('getresponse', { origin: 'http://localhost:3000' });
  assert.ok(!f.stateCookie.includes('; Secure'));
  assert.ok(!f.stateCookie.startsWith('__Host-'));
  const callback = await callbackOAuth('getresponse', f.callbackRequest(), env, { fetch: f.fetch });
  const account = cookies(callback).find(cookie => cookie.includes('ea_oauth_account_getresponse='));
  assert.equal(await getOAuthToken('getresponse', request('/', { origin: 'http://localhost:3000', cookie: cookiePair(account) }), env), 'fixture-access-token');
  const disconnected = await disconnectOAuth('getresponse', request('/api/disconnect', { origin: 'http://localhost:3000', method: 'POST', cookie: cookiePair(account) }), {});
  assert.equal(disconnected.status, 200);
  assert.deepEqual(await disconnected.json(), { disconnected: true });
  assert.equal(cookies(disconnected).length, 2);
  assert.ok(cookies(disconnected).every(cookie => cookie.includes('Max-Age=0') && !cookie.includes('fixture-access-token')));
  const blocked = await disconnectOAuth('aweber', request('/api/disconnect', { method: 'POST', headers: { origin: 'https://evil.example' } }), env);
  assert.equal(blocked.status, 403);
  const unsupported = await oauthStatus('orca', request('/'), env);
  assert.equal(unsupported.supported, false);
});

test('default fetch preserves the Worker global receiver for both registration and token exchange', async () => {
  const originalFetch = globalThis.fetch;
  const observed = [];
  try {
    globalThis.fetch = function (url, init) {
      assert.equal(this, globalThis, 'Worker fetch requires its global receiver');
      observed.push({ url, init });
      if (url === OAUTH_PROVIDERS.aweber.registrationEndpoint) return Promise.resolve(jsonResponse({ client_id: 'bound-client', token_endpoint_auth_method: 'none' }));
      assert.equal(url, OAUTH_PROVIDERS.aweber.tokenEndpoint);
      return Promise.resolve(jsonResponse({ access_token: 'bound-token', token_type: 'Bearer', expires_in: 60 }));
    };
    const started = await startOAuth('aweber', request('/api/integrations/oauth/start/aweber', { method: 'POST' }), env);
    assert.equal(started.status, 200);
    const authorization = new URL((await started.json()).authorizationUrl);
    assert.equal(authorization.searchParams.get('resource'), 'https://mcp.aweber.com', 'Audience follows verified protected-resource metadata');
    const stateCookie = cookiePair(cookies(started)[0]);
    const callback = await callbackOAuth('aweber', request(`/api/integrations/oauth/callback/aweber?state=${authorization.searchParams.get('state')}&code=bound-code`, { cookie: stateCookie }), env);
    assert.equal(callback.status, 303);
    assert.ok(callback.headers.get('location').includes('oauth=connected'));
    assert.deepEqual(observed.map(call => call.url), [OAUTH_PROVIDERS.aweber.registrationEndpoint, OAUTH_PROVIDERS.aweber.tokenEndpoint]);
    const accountCookie = cookies(callback).find(cookie => cookie.includes('ea_oauth_account_aweber='));
    assert.equal(await getOAuthToken('aweber', request('/', { cookie: cookiePair(accountCookie) }), env), 'bound-token');
  } finally { globalThis.fetch = originalFetch; }
});

test('OAuth rejects registration and token redirects without following or leaking provider details', async () => {
  const sensitiveLocation = 'https://evil.example/collect?token=private-provider-detail';
  let registrationCalls = 0;
  const registration = await startOAuth('aweber', request('/api/integrations/oauth/start/aweber', { method: 'POST' }), env, { fetch: async (url, init) => {
    registrationCalls++;
    assert.equal(url, OAUTH_PROVIDERS.aweber.registrationEndpoint);
    assert.equal(init.redirect, 'manual');
    return new Response('private-registration-response', { status: 302, headers: { Location: sensitiveLocation } });
  } });
  assert.equal(registration.status, 502);
  assert.equal(registrationCalls, 1, 'No second request follows a registration redirect');
  assert.equal(registration.headers.get('location'), null);
  const safeError = JSON.stringify(await registration.json());
  assert.ok(!safeError.includes('private-'));
  assert.ok(!safeError.includes('evil.example'));

  const f = await flow('aweber', { tokenResponse: () => new Response('private-token-response', { status: 302, headers: { Location: sensitiveLocation } }) });
  const callback = await callbackOAuth('aweber', f.callbackRequest(), env, { fetch: f.fetch });
  assert.equal(callback.status, 303);
  assert.equal(f.calls.length, 2, 'Only registration and the fixed token endpoint are requested');
  assert.equal(f.calls[1].init.redirect, 'manual');
  assert.ok(callback.headers.get('location').startsWith(`${origin}/?integration=aweber&oauth=error`));
  assert.ok(!JSON.stringify([...callback.headers]).includes('private-'));
  assert.ok(!JSON.stringify([...callback.headers]).includes('evil.example'));
  assert.equal(cookies(callback).length, 1, 'Failed exchange clears state without issuing an account cookie');
});
