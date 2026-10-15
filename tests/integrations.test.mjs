import test from 'node:test';
import assert from 'node:assert/strict';
import { integrationCatalog, integrationStatus, integrationTest, PROVIDERS, GITHUB_PROFILES, CLI_PROFILES } from '../server/integrations.mjs';
import { handleApi } from '../server/api.mjs';

const noFetch = async () => assert.fail('This test must not contact any provider');
const rpcResponse = (id, result, headers = {}) => new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), { headers: { 'content-type': 'application/json', ...headers } });
const request = (endpoint, { method = 'GET', body, headers = {} } = {}) => new Request(`https://forge.example${endpoint}`, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
const post = (endpoint, body, headers) => request(endpoint, { method: 'POST', body, headers });

function mcpTransport({ endpoint = 'https://huggingface.co/mcp', token, toolName = 'model_search', account } = {}) {
  const calls = [];
  const fetch = async (url, init) => {
    const rpc = JSON.parse(init.body);
    calls.push({ url, init, rpc });
    assert.equal(url, endpoint);
    assert.equal(init.redirect, 'manual');
    assert.equal(init.credentials, undefined);
    assert.equal(init.cache, undefined);
    assert.equal(init.headers.authorization, token ? `Bearer ${token}` : undefined);
    if (rpc.method === 'initialize') return rpcResponse(rpc.id, { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'Verified mock MCP server', version: '1.0.0' } }, { 'mcp-session-id': 'integration-session' });
    assert.equal(init.headers['Mcp-Session-Id'], 'integration-session');
    if (rpc.method === 'notifications/initialized') return new Response(null, { status: 202 });
    if (rpc.method === 'tools/list') return rpcResponse(rpc.id, { tools: [{ name: toolName, description: 'Public read-only discovery metadata', inputSchema: { type: 'object' } }] });
    if (account && rpc.method === 'tools/call') {
      assert.equal(rpc.params.name, 'get_me');
      assert.deepEqual(rpc.params.arguments, {});
      return rpcResponse(rpc.id, { content: [{ type: 'text', text: JSON.stringify(account) }] });
    }
    assert.fail('Discovery must never execute a provider tool');
  };
  return { calls, fetch };
}

test('catalog has unique documented provider metadata and separates public discovery from unresolved services', () => {
  const result = integrationCatalog();
  assert.equal(new Set(result.providers.map(provider => provider.id)).size, PROVIDERS.length);
  for (const provider of result.providers) {
    assert.ok(provider.id && provider.name && provider.kind);
    assert.equal(provider.connected, false);
    assert.ok(provider.reason.length > 20);
  }
  const hf = result.providers.find(provider => provider.id === 'huggingface');
  assert.equal(hf.endpoint, 'https://huggingface.co/mcp');
  assert.equal(hf.verified, true);
  assert.equal(hf.auth, 'none');
  assert.equal(hf.configured, true);
  assert.equal(hf.status, 'configured');
  assert.ok(hf.reason.includes('Public MCP discovery'));
  for (const id of ['reddit', 'nvidia', 'orca', 'omniroute', 'agent-os', 'easy-agent']) {
    const provider = result.providers.find(provider => provider.id === id);
    assert.equal(provider.endpoint, null, id);
    assert.equal(provider.verified, false, id);
    assert.equal(provider.status, 'needs_endpoint', id);
    assert.equal(provider.configured, false, id);
  }
  assert.deepEqual(new Set(GITHUB_PROFILES.map(profile => profile.id)), new Set(['profile', 'repositories', 'pulls', 'issues', 'runs']));
  assert.ok(CLI_PROFILES.github.every(profile => profile.id.startsWith('github.')));
  assert.ok(CLI_PROFILES.google.every(profile => profile.id.startsWith('google.')));
  assert.ok(CLI_PROFILES.huggingface.every(profile => profile.id.startsWith('huggingface.')));
});

test('catalog exposes credential availability without values, and hides credential-bearing or ambiguous URLs', () => {
  const secrets = { GITHUB_TOKEN: 'PRIVATE_GITHUB_VALUE', GH_TOKEN: 'PRIVATE_GH_VALUE', GOOGLE_ACCESS_TOKEN: 'PRIVATE_GOOGLE_VALUE', GOOGLE_SERVICE_ACCOUNT_JSON: '{"private_key":"PRIVATE_GOOGLE_KEY"}', HF_TOKEN: 'PRIVATE_HF_VALUE', CLOUDFLARE_MCP_TOKEN: 'PRIVATE_CLOUDFLARE_VALUE', OAUTH_SESSION_SECRET: 'PRIVATE_SESSION_KEY' };
  const catalog = integrationCatalog(secrets);
  for (const secret of Object.values(secrets)) assert.ok(!JSON.stringify(catalog).includes(secret));
  assert.equal(catalog.providers.find(provider => provider.id === 'github').configured, true);
  assert.equal(catalog.providers.find(provider => provider.id === 'google-vertex').configured, true);
  assert.equal(catalog.providers.find(provider => provider.id === 'cloudflare').configured, true);
  assert.equal(catalog.providers.find(provider => provider.id === 'aweber').canAuthorize, true);
  assert.equal(catalog.providers.find(provider => provider.id === 'huggingface').canAuthorize, false);
  for (const endpoint of ['https://user:PRIVATE_PASSWORD@custom.example/mcp', 'https://custom.example/mcp?token=PRIVATE_QUERY', 'https://custom.example/mcp#PRIVATE_FRAGMENT', 'http://custom.example/mcp', 'not a URL']) {
    const result = integrationCatalog({ ORCA_MCP_URL: endpoint, ORCA_MCP_TOKEN: 'PRIVATE_ORCA_TOKEN' }).providers.find(provider => provider.id === 'orca');
    assert.equal(result.endpoint, null);
    assert.equal(result.configured, false);
    assert.equal(result.status, 'needs_endpoint');
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_PASSWORD|PRIVATE_QUERY|PRIVATE_FRAGMENT|PRIVATE_ORCA_TOKEN/);
  }
});

test('GitHub catalog truthfully retains the fixed endpoint used by its read adapter', () => {
  const provider = integrationCatalog({ GITHUB_MCP_URL: 'https://unrelated.example/not-github', GITHUB_TOKEN: 'PRIVATE_GITHUB_VALUE' }).providers.find(provider => provider.id === 'github');
  assert.equal(provider.endpoint, 'https://api.githubcopilot.com/mcp/');
});

test('cloud integration status never claims a local CLI exists or that an unconfigured MCP is connected', async () => {
  const result = await integrationStatus({}, { runtime: 'cloud', fetch: noFetch, cliStatus: async () => assert.fail('Cloud runtime cannot invoke local CLI hooks') });
  assert.equal(result.runtime, 'cloud');
  assert.equal(result.github.mcp.configured, false);
  assert.equal(result.github.mcp.connected, false);
  for (const provider of [result.github.cli, result.google.cli, result.huggingface.cli]) {
    assert.equal(provider.installed, false);
    assert.equal(provider.authenticated, false);
  }
  assert.equal(result.google.vertex.configured, false);
  assert.deepEqual(result.profiles.github, GITHUB_PROFILES);
});

test('local status keeps authenticated CLI identity distinct from unconfigured remote MCP', async () => {
  let called = 0;
  const result = await integrationStatus({}, { runtime: 'local', fetch: noFetch, cliStatus: async () => { called++; return { github: { installed: true, authenticated: true, login: 'dazza', version: '2.80.0' }, google: { installed: true, authenticated: false }, huggingface: { installed: true, authenticated: false } }; } });
  assert.equal(called, 1);
  assert.equal(result.github.cli.authenticated, true);
  assert.equal(result.github.cli.login, 'dazza');
  assert.equal(result.github.mcp.connected, false);
  assert.equal(result.github.mcp.code, 'GITHUB_NOT_CONFIGURED');
});

test('provider selection rejects arbitrary endpoints, tools, browser credentials and unknown providers before network', async () => {
  for (const input of [null, [], {}, { providerId: 'unknown' }, { providerId: 'huggingface', url: 'https://evil.example' }, { providerId: 'huggingface', token: 'browser-secret' }, { providerId: 'huggingface', tool: 'execute' }]) await assert.rejects(integrationTest(input, {}, { fetch: noFetch }), error => error.status === 400);
  for (const providerId of ['reddit', 'orca', 'nvidia', 'omniroute']) await assert.rejects(integrationTest({ providerId }, { ORCA_MCP_TOKEN: 'private-value' }, { fetch: noFetch }), error => error.code === 'MCP_ENDPOINT_REQUIRED');
  for (const providerId of ['aweber', 'getresponse', 'sandcastles', 'cloudflare', 'sentry', 'google-vertex']) await assert.rejects(integrationTest({ providerId }, {}, { fetch: noFetch }), error => error.code === 'MCP_AUTH_REQUIRED');
});

test('verified Hugging Face public discovery works without credentials and never calls a tool', async () => {
  const mock = mcpTransport();
  const result = await integrationTest({ providerId: 'huggingface' }, {}, mock);
  assert.equal(result.providerId, 'huggingface');
  assert.equal(result.status, 'connected');
  assert.equal(result.executionAuthorized, false);
  assert.deepEqual(result.tools, [{ name: 'model_search', description: 'Public read-only discovery metadata' }]);
  assert.deepEqual(mock.calls.map(call => call.rpc.method), ['initialize', 'notifications/initialized', 'tools/list']);
  assert.ok(mock.calls.every(call => !call.init.headers.authorization));
});

test('custom MCP destinations need a server allowlist and cannot send credentials to private addresses', async () => {
  const configured = { REDDIT_MCP_URL: 'https://custom.example/mcp', REDDIT_MCP_TOKEN: 'PRIVATE_CUSTOM_TOKEN' };
  await assert.rejects(integrationTest({ providerId: 'reddit' }, configured, { fetch: noFetch }), error => error.code === 'MCP_HOST_NOT_ALLOWED');
  const mock = mcpTransport({ endpoint: configured.REDDIT_MCP_URL, token: configured.REDDIT_MCP_TOKEN });
  const result = await integrationTest({ providerId: 'reddit' }, { ...configured, MCP_ALLOWED_HOSTS: 'custom.example' }, mock);
  assert.equal(result.status, 'connected');
  assert.equal(result.executionAuthorized, false);
  assert.ok(!JSON.stringify(result).includes(configured.REDDIT_MCP_TOKEN));
  await assert.rejects(integrationTest({ providerId: 'reddit' }, { REDDIT_MCP_URL: 'https://127.0.0.1/mcp', REDDIT_MCP_TOKEN: 'PRIVATE_TOKEN', MCP_ALLOWED_HOSTS: '127.0.0.1' }, { fetch: noFetch }), error => error.code === 'MCP_DESTINATION_BLOCKED');
});

test('API status and catalog GETs expose private no-store metadata without credential values or incidental provider calls', async () => {
  const secrets = { GOOGLE_ACCESS_TOKEN: 'PRIVATE_GOOGLE_TOKEN', HF_TOKEN: 'PRIVATE_HF_TOKEN', CLOUDFLARE_MCP_TOKEN: 'PRIVATE_CLOUDFLARE_TOKEN' };
  for (const endpoint of ['/api/integrations/status', '/api/integrations/catalog']) {
    const response = await handleApi(request(endpoint), secrets, { fetch: noFetch });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('cache-control'), /private.*no-store/);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
    const output = await response.text();
    for (const secret of Object.values(secrets)) assert.ok(!output.includes(secret));
  }
});

test('GET, HEAD, PUT and DELETE cannot execute CLI, MCP discovery or GitHub read action routes', async () => {
  let cliCalls = 0;
  const options = { runtime: 'local', fetch: noFetch, cliRun: async () => { cliCalls++; return {}; } };
  for (const endpoint of ['/api/integrations/cli/run', '/api/integrations/mcp/test', '/api/integrations/github/read']) {
    for (const method of ['GET', 'HEAD', 'PUT', 'DELETE']) {
      const response = await handleApi(request(endpoint, { method }), {}, options);
      assert.ok([404, 405].includes(response.status), `${method} ${endpoint}`);
    }
  }
  assert.equal(cliCalls, 0);
});

test('cross-origin or cross-site JSON posts are rejected before every integration action', async () => {
  let cliCalls = 0;
  const options = { runtime: 'local', fetch: noFetch, cliRun: async () => { cliCalls++; return {}; } };
  for (const endpoint of ['/api/integrations/status', '/api/integrations/catalog', '/api/integrations/cli/run', '/api/integrations/mcp/test', '/api/integrations/github/read']) {
    for (const headers of [{ origin: 'https://attacker.example' }, { 'sec-fetch-site': 'cross-site' }]) {
      const response = await handleApi(post(endpoint, { profile: 'profile', providerId: 'huggingface' }, headers), {}, options);
      assert.equal(response.status, 403);
      assert.equal((await response.json()).error, 'ORIGIN_BLOCKED');
    }
  }
  assert.equal(cliCalls, 0);
});

test('cloud CLI calls and missing or incorrectly typed local hooks produce an explicit setup error', async () => {
  const endpoint = '/api/integrations/cli/run';
  for (const options of [{ runtime: 'cloud', cliRun: async () => assert.fail('Cloud must not run CLI') }, { runtime: 'local' }, { runtime: 'local', cliRun: 'not-a-function' }, { runtime: 'local', cliRun: {} }]) {
    const response = await handleApi(post(endpoint, { profile: 'github.repos' }), {}, options);
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error, 'LOCAL_RUNTIME_REQUIRED');
  }
});

test('valid local CLI function receives the selected profile and returns its typed result unchanged', async () => {
  const selected = { profile: 'github.pulls', repository: 'dazza/forge' };
  const result = { profile: selected.profile, command: 'gh pr list', exitCode: 0, durationMs: 7, output: '[{"number":1}]', data: [{ number: 1, title: 'Reviewed pull' }] };
  let calls = 0;
  const response = await handleApi(post('/api/integrations/cli/run', selected, { origin: 'https://forge.example' }), {}, { runtime: 'local', cliRun: async input => { calls++; assert.deepEqual(input, selected); return result; }, fetch: noFetch });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), result);
  assert.equal(calls, 1);
});

test('API forwards public MCP discovery and fixed GitHub reads through their actual guarded adapters', async () => {
  const publicMock = mcpTransport();
  const discovered = await handleApi(post('/api/integrations/mcp/test', { providerId: 'huggingface' }), {}, publicMock);
  assert.equal(discovered.status, 200);
  assert.equal((await discovered.json()).executionAuthorized, false);
  assert.equal(publicMock.calls.length, 3);
  const githubMock = mcpTransport({ endpoint: 'https://api.githubcopilot.com/mcp/', token: 'PRIVATE_GITHUB_TOKEN', toolName: 'get_me', account: { login: 'dazza', id: 4, html_url: 'https://github.com/dazza', accessToken: 'must-not-return' } });
  const read = await handleApi(post('/api/integrations/github/read', { profile: 'profile' }), { GITHUB_TOKEN: 'PRIVATE_GITHUB_TOKEN' }, githubMock);
  assert.equal(read.status, 200);
  const output = await read.json();
  assert.equal(output.account.login, 'dazza');
  assert.equal(output.readonly, true);
  assert.doesNotMatch(JSON.stringify(output), /PRIVATE_GITHUB_TOKEN|must-not-return/);
  assert.equal(githubMock.calls.at(-1).rpc.method, 'tools/call');
});

test('API GitHub missing credentials and rejected remote authentication stay failures without fabricated items', async () => {
  const missing = await handleApi(post('/api/integrations/github/read', { profile: 'profile' }), {}, { fetch: noFetch });
  assert.equal(missing.status, 503);
  assert.equal((await missing.json()).error, 'GITHUB_NOT_CONFIGURED');
  const failed = await handleApi(post('/api/integrations/github/read', { profile: 'profile' }), { GH_TOKEN: 'PRIVATE_REJECTED_TOKEN' }, { fetch: async () => new Response('Echo PRIVATE_REJECTED_TOKEN', { status: 401 }) });
  assert.equal(failed.status, 401);
  const output = await failed.json();
  assert.equal(output.error, 'GITHUB_AUTH_FAILED');
  assert.equal(output.items, undefined);
  assert.doesNotMatch(JSON.stringify(output), /PRIVATE_REJECTED_TOKEN/);
});

async function fakeAweberOAuth() {
  const secret = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const env = Object.freeze({ OAUTH_SESSION_SECRET: secret });
  const accessToken = 'FAKE_VISITOR_AWEBER_ACCESS_TOKEN';
  const calls = [];
  let authorization;
  const fetch = async (url, init) => {
    calls.push({ url, init });
    assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'manual');
    if (url === 'https://mcp.aweber.com/oauth/register') {
      const body = JSON.parse(init.body);
      assert.deepEqual(body.redirect_uris, ['https://forge.example/api/integrations/oauth/callback/aweber']);
      assert.equal(body.token_endpoint_auth_method, 'none');
      return new Response(JSON.stringify({ client_id: 'fake-public-pkce-client', token_endpoint_auth_method: 'none', redirect_uris: body.redirect_uris }));
    }
    assert.equal(url, 'https://mcp.aweber.com/oauth/token');
    const body = new URLSearchParams(init.body);
    assert.equal(body.get('grant_type'), 'authorization_code');
    assert.equal(body.get('code'), 'fake-one-use-provider-code');
    assert.equal(body.get('client_id'), 'fake-public-pkce-client');
    assert.equal(body.get('resource'), 'https://mcp.aweber.com');
    const challenge = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body.get('code_verifier')))))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    assert.equal(challenge, authorization.searchParams.get('code_challenge'));
    return new Response(JSON.stringify({ access_token: accessToken, token_type: 'Bearer', expires_in: 3600, scope: 'account.read list.read' }));
  };
  const started = await handleApi(post('/api/integrations/oauth/start', { providerId: 'aweber' }, { origin: 'https://forge.example' }), env, { fetch });
  assert.equal(started.status, 200);
  const startCookies = started.headers.getSetCookie();
  assert.equal(startCookies.length, 1);
  assert.match(startCookies[0], /^__Host-ea_oauth_state_aweber=v1\./);
  assert.match(startCookies[0], /HttpOnly; SameSite=Lax; Max-Age=600; Secure/);
  authorization = new URL((await started.json()).authorizationUrl);
  assert.equal(authorization.origin + authorization.pathname, 'https://mcp.aweber.com/oauth/authorize');
  assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(authorization.searchParams.get('resource'), 'https://mcp.aweber.com');
  assert.ok(authorization.searchParams.get('state'));
  const callbackUrl = new URL(authorization.searchParams.get('redirect_uri'));
  callbackUrl.searchParams.set('state', authorization.searchParams.get('state'));
  callbackUrl.searchParams.set('code', 'fake-one-use-provider-code');
  const completed = await handleApi(new Request(callbackUrl, { headers: { cookie: startCookies[0].split(';')[0] } }), env, { fetch });
  assert.equal(completed.status, 303);
  assert.equal(new URL(completed.headers.get('location')).searchParams.get('oauth'), 'connected');
  const accountCookie = completed.headers.getSetCookie().find(cookie => cookie.startsWith('__Host-ea_oauth_account_aweber='));
  assert.ok(accountCookie);
  assert.match(accountCookie, /^__Host-ea_oauth_account_aweber=v1\./);
  assert.match(accountCookie, /HttpOnly; SameSite=Lax; Max-Age=3600; Secure/);
  assert.ok(!accountCookie.includes(accessToken));
  assert.deepEqual(calls.map(call => call.url), ['https://mcp.aweber.com/oauth/register', 'https://mcp.aweber.com/oauth/token']);
  assert.equal(env.AWEBER_MCP_TOKEN, undefined);
  return { env, accessToken, cookie: accountCookie.split(';')[0] };
}

test('OAuth API round trip produces an encrypted account cookie bound to its provider and application origin', async () => {
  const { env, accessToken, cookie } = await fakeAweberOAuth();
  const connected = await handleApi(request('/api/integrations/catalog', { headers: { cookie } }), env, { fetch: noFetch });
  assert.equal(connected.status, 200);
  const catalog = await connected.json();
  assert.equal(catalog.providers.find(provider => provider.id === 'aweber').connected, true);
  assert.equal(catalog.providers.find(provider => provider.id === 'aweber').status, 'connected');
  assert.ok(catalog.providers.filter(provider => provider.id !== 'aweber').every(provider => !provider.connected));
  assert.doesNotMatch(JSON.stringify(catalog), /FAKE_VISITOR_AWEBER_ACCESS_TOKEN|fake-public-pkce-client/);
  for (const incoming of [request('/api/integrations/catalog'), new Request('https://other.example/api/integrations/catalog', { headers: { cookie } }), request('/api/integrations/catalog', { headers: { cookie: cookie.replace('account_aweber=', 'account_getresponse=') } })]) {
    const response = await handleApi(incoming, env, { fetch: noFetch });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.ok(result.providers.every(provider => !provider.connected));
    assert.ok(!JSON.stringify(result).includes(accessToken));
  }
  assert.equal(env.AWEBER_MCP_TOKEN, undefined);
  const getStart = await handleApi(request('/api/integrations/oauth/start'), env, { fetch: noFetch });
  assert.ok([404, 405].includes(getStart.status));
  const crossOrigin = await handleApi(post('/api/integrations/oauth/start', { providerId: 'aweber' }, { origin: 'https://attacker.example' }), env, { fetch: noFetch });
  assert.equal(crossOrigin.status, 403);
});

test('MCP testing uses only this request encrypted OAuth credential and never mutates global server environment', async () => {
  const { env, accessToken, cookie } = await fakeAweberOAuth();
  const mock = mcpTransport({ endpoint: 'https://mcp.aweber.com/mcp', token: accessToken, toolName: 'account_read' });
  const response = await handleApi(post('/api/integrations/mcp/test', { providerId: 'aweber' }, { origin: 'https://forge.example', cookie }), env, mock);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.status, 'connected');
  assert.equal(result.providerId, 'aweber');
  assert.equal(result.executionAuthorized, false);
  assert.ok(mock.calls.every(call => call.init.headers.authorization === `Bearer ${accessToken}`));
  assert.equal(mock.calls.length, 3);
  assert.ok(!JSON.stringify(result).includes(accessToken));
  assert.equal(env.AWEBER_MCP_TOKEN, undefined);
  for (const [providerId, headers] of [['aweber', {}], ['getresponse', { cookie }]]) {
    const absent = await handleApi(post('/api/integrations/mcp/test', { providerId }, headers), env, { fetch: noFetch });
    assert.equal(absent.status, 503);
    assert.equal((await absent.json()).error, 'MCP_AUTH_REQUIRED');
  }
  assert.deepEqual(Object.keys(env), ['OAUTH_SESSION_SECRET']);
});

test('endpoint overrides cannot forward encrypted OAuth credentials and invalid overrides leave catalog readable', async () => {
  const { env, accessToken, cookie } = await fakeAweberOAuth();
  for (const endpoint of ['https://allowlisted-alternative.example/mcp', 'https://mcp.aweber.com/another-resource', 'not a valid HTTPS URL']) {
    const overridden = Object.freeze({ ...env, AWEBER_MCP_URL: endpoint, MCP_ALLOWED_HOSTS: 'allowlisted-alternative.example,mcp.aweber.com' });
    const catalogResponse = await handleApi(request('/api/integrations/catalog', { headers: { cookie } }), overridden, { fetch: noFetch });
    assert.equal(catalogResponse.status, 200);
    const catalog = await catalogResponse.json();
    const provider = catalog.providers.find(provider => provider.id === 'aweber');
    assert.equal(provider.connected, false);
    assert.equal(provider.canAuthorize, false);
    assert.equal(provider.verified, false);
    assert.ok(!JSON.stringify(catalog).includes(accessToken));
    const response = await handleApi(post('/api/integrations/mcp/test', { providerId: 'aweber' }, { origin: 'https://forge.example', cookie }), overridden, { fetch: noFetch });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error, endpoint === 'not a valid HTTPS URL' ? 'MCP_ENDPOINT_REQUIRED' : 'MCP_AUTH_REQUIRED');
    assert.equal(overridden.AWEBER_MCP_TOKEN, undefined);
  }
  assert.equal(env.AWEBER_MCP_TOKEN, undefined);
});
