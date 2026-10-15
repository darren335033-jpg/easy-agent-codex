import test from 'node:test';
import assert from 'node:assert/strict';
import { executeGithubRead, getGithubStatus, GITHUB_MCP_ENDPOINT } from '../server/github.mjs';

const env = { GITHUB_TOKEN: 'server-only-github-token' };
const string = { type: 'string' }, integer = { type: 'integer', minimum: 1, maximum: 100 };
const schema = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const scope = { owner: string, repo: string, perPage: integer, page: integer };
const tools = [
  { name: 'get_me', description: 'Read authenticated account', inputSchema: { type: 'object' } },
  { name: 'search_repositories', description: 'Search repositories', inputSchema: schema({ query: string, perPage: integer, page: integer, minimal_output: { type: 'boolean' } }, ['query']) },
  { name: 'list_pull_requests', description: 'List pull requests', inputSchema: schema({ ...scope, state: { type: 'string', enum: ['open', 'closed', 'all'] } }, ['owner', 'repo']) },
  { name: 'list_issues', description: 'List issues', inputSchema: schema({ owner: string, repo: string, perPage: integer, state: { type: 'string', enum: ['OPEN', 'CLOSED'] } }, ['owner', 'repo']) },
  { name: 'actions_list', description: 'List workflow runs', inputSchema: schema({ ...scope, method: { type: 'string', enum: ['list_workflow_runs', 'list_workflows'] } }, ['owner', 'repo', 'method']) },
];
const rpcResponse = (id, result, headers = {}) => new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), { headers: { 'content-type': 'application/json', ...headers } });
const toolResult = payload => ({ content: [{ type: 'text', text: JSON.stringify(payload) }] });
const account = { login: 'dazza', id: 42, name: 'Dazza', html_url: 'https://github.com/dazza', email: 'private@example.invalid', access_token: 'must-not-return' };

function transport(options = {}) {
  const calls = [];
  const fetch = async (url, init) => {
    const rpc = JSON.parse(init.body);
    calls.push({ url, init, rpc });
    assert.equal(url, GITHUB_MCP_ENDPOINT);
    assert.equal(init.redirect, 'manual');
    assert.equal(init.credentials, undefined);
    assert.equal(init.cache, undefined);
    assert.equal(init.headers['X-MCP-Readonly'], 'true');
    assert.equal(init.headers['X-MCP-Toolsets'], 'context,repos,pull_requests,issues,actions');
    assert.deepEqual(init.headers['X-MCP-Tools'].split(','), tools.map(tool => tool.name));
    if (options.fetch) return options.fetch(rpc, init, calls);
    if (rpc.method === 'initialize') return rpcResponse(rpc.id, { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'GitHub MCP', version: 'test-version' } }, { 'mcp-session-id': 'test-session' });
    assert.equal(init.headers['Mcp-Session-Id'], 'test-session');
    if (rpc.method === 'notifications/initialized') return new Response(null, { status: 202 });
    if (rpc.method === 'tools/list') return rpcResponse(rpc.id, { tools: options.tools || tools });
    if (rpc.method === 'tools/call') return rpcResponse(rpc.id, options.call ? await options.call(rpc.params.name, rpc.params.arguments, rpc.id) : toolResult(account));
    assert.fail('No arbitrary protocol methods are allowed');
  };
  return { calls, fetch };
}

test('unconfigured status and read actions fail honestly without making network requests', async () => {
  const fetch = async () => assert.fail('No credentials must mean no network');
  const status = await getGithubStatus({}, { fetch });
  assert.equal(status.configured, false);
  assert.equal(status.connected, false);
  assert.equal(status.code, 'GITHUB_NOT_CONFIGURED');
  assert.ok(status.profiles.every(profile => !profile.available));
  await assert.rejects(executeGithubRead({ profile: 'profile' }, {}, { fetch }), error => error.status === 503 && error.code === 'GITHUB_NOT_CONFIGURED');
});

test('authenticated discovery retains session and reports only the fixed available read profiles', async () => {
  const mock = transport({ tools: [...tools, { name: 'delete_repository', description: 'must never be shown', inputSchema: schema() }] });
  const status = await getGithubStatus(env, mock);
  assert.equal(status.configured, true);
  assert.equal(status.connected, true);
  assert.equal(status.readonly, true);
  assert.equal(status.profiles.length, 5);
  assert.ok(status.profiles.every(profile => profile.available));
  assert.deepEqual(mock.calls.map(call => call.rpc.method), ['initialize', 'notifications/initialized', 'tools/list']);
  assert.equal(mock.calls[0].init.headers.authorization, 'Bearer server-only-github-token');
  assert.ok(mock.calls.every(call => call.init.headers['MCP-Protocol-Version'] === '2025-03-26'));
  assert.doesNotMatch(JSON.stringify(status), /server-only-github-token|delete_repository/);
});

test('a configured CLI token rejected by remote MCP never appears connected or leaks authentication details', async () => {
  const mock = transport({ fetch: async () => new Response(`Echo ${env.GITHUB_TOKEN}`, { status: 401 }) });
  const status = await getGithubStatus(env, mock);
  assert.equal(status.configured, true);
  assert.equal(status.connected, false);
  assert.equal(status.code, 'GITHUB_AUTH_FAILED');
  assert.equal(status.httpStatus, 401);
  assert.doesNotMatch(JSON.stringify(status), /server-only-github-token/);
  assert.ok(status.profiles.every(profile => !profile.available));
});

test('profile uses get_me only and returns selected public fields without tokens or email', async () => {
  const mock = transport();
  const result = await executeGithubRead({ profile: 'profile' }, env, mock);
  assert.equal(result.readonly, true);
  assert.equal(result.tool.name, 'get_me');
  assert.deepEqual(result.toolsUsed, ['get_me']);
  assert.equal(result.account.login, 'dazza');
  assert.equal(result.account.id, 42);
  assert.equal(result.items.length, 1);
  assert.doesNotMatch(JSON.stringify(result), /private@example|must-not-return|server-only-github-token/);
  assert.deepEqual(mock.calls.at(-1).rpc.params, { name: 'get_me', arguments: {} });
});

test('repository discovery scopes a quoted literal search to the authenticated account and bounds results', async () => {
  const mock = transport({ call: async (name, args) => {
    if (name === 'get_me') return toolResult(account);
    assert.equal(name, 'search_repositories');
    assert.deepEqual(args, { query: 'user:dazza "my project"', perPage: 2, page: 1, minimal_output: true });
    return toolResult({ total_count: 50, items: Array.from({ length: 4 }, (_, index) => ({ id: index + 1, name: `project-${index}`, full_name: `dazza/project-${index}`, description: 'd'.repeat(2000), html_url: `https://github.com/dazza/project-${index}`, private: true, clone_url: 'never returned' })) });
  } });
  const result = await executeGithubRead({ profile: 'repositories', query: 'my project', limit: 2 }, env, mock);
  assert.equal(result.items.length, 2);
  assert.equal(result.totalCount, 50);
  assert.equal(result.truncated, true);
  assert.equal(result.items[0].description.length, 1000);
  assert.equal(result.items[0].private, true);
  assert.deepEqual(result.toolsUsed, ['get_me', 'search_repositories']);
  assert.ok(!Object.hasOwn(result.items[0], 'clone_url'));
});

test('Enterprise Managed User identities containing an underscore remain safely scoped', async () => {
  const mock = transport({ call: async (name, args) => {
    if (name === 'get_me') return toolResult({ ...account, login: 'dazza_enterprise' });
    assert.equal(args.query, 'user:dazza_enterprise');
    return toolResult({ total_count: 0, items: [] });
  } });
  const result = await executeGithubRead({ profile: 'repositories' }, env, mock);
  assert.equal(result.count, 0);
  assert.equal(result.totalCount, 0);
  assert.equal(result.truncated, false);
});

test('open pull and issue profiles use documented state enums and pagination without arbitrary searches', async () => {
  for (const profile of ['pulls', 'issues']) {
    const mock = transport({ call: async (name, args) => {
      assert.equal(name, profile === 'pulls' ? 'list_pull_requests' : 'list_issues');
      assert.deepEqual(args, { owner: 'dazza', repo: 'forge', perPage: 3, state: profile === 'pulls' ? 'open' : 'OPEN', ...(profile === 'pulls' ? { page: 1 } : {}) });
      const item = { id: 123, number: 7, title: 'Improve code', state: 'open', html_url: 'https://github.com/dazza/forge/issues/7', user: { login: 'author' }, body: 'Untrusted issue body must not be returned' };
      return toolResult(profile === 'pulls' ? [item] : { issues: [item], totalCount: 12, pageInfo: { hasNextPage: true } });
    } });
    const result = await executeGithubRead({ profile, repository: 'dazza/forge', limit: 3 }, env, mock);
    assert.equal(result.owner, 'dazza');
    assert.equal(result.repo, 'forge');
    assert.equal(result.items[0].number, 7);
    assert.equal(result.items[0].author, 'author');
    assert.equal(result.totalCount, profile === 'pulls' ? null : 12);
    assert.equal(result.truncated, profile === 'issues');
    assert.doesNotMatch(JSON.stringify(result), /Untrusted issue body/);
  }
});

test('workflow runs support both documented text output and modern discriminated structured output', async () => {
  for (const modern of [false, true]) {
    const payload = { total_count: 4, workflow_runs: [{ id: 987, run_number: 2, name: 'CI', status: 'completed', conclusion: 'success', html_url: 'https://github.com/dazza/forge/actions/runs/987', head_branch: 'main', environment: { SECRET: 'never returned' } }] };
    const mock = transport({ call: async (name, args) => {
      assert.equal(name, 'actions_list');
      assert.deepEqual(args, { owner: 'dazza', repo: 'forge', perPage: 20, method: 'list_workflow_runs', page: 1 });
      return modern ? { structuredContent: { method: 'list_workflow_runs', workflow_runs: payload } } : toolResult(payload);
    } });
    const result = await executeGithubRead({ profile: 'runs', owner: 'dazza', repo: 'forge' }, env, mock);
    assert.equal(result.items[0].id, 987);
    assert.equal(result.items[0].status, 'completed');
    assert.equal(result.items[0].branch, 'main');
    assert.equal(result.totalCount, 4);
    assert.doesNotMatch(JSON.stringify(result), /SECRET|never returned/);
  }
});

test('input cannot select tools, URLs, credentials, unbounded pages, or inject repository search qualifiers', async () => {
  const fetch = async () => assert.fail('Invalid inputs must not send credentials');
  const inputs = [
    { profile: 'delete_repository' }, { profile: 'profile', token: 'browser-secret' }, { profile: 'profile', url: 'https://evil.example' }, { profile: 'profile', tool: 'get_me' },
    { profile: 'profile', limit: 0 }, { profile: 'profile', limit: 51 }, { profile: 'profile', limit: 1.5 },
    { profile: 'runs', repository: '../outside' }, { profile: 'runs', repository: 'owner/repo/extra' }, { profile: 'runs', repository: 'owner/repo', owner: 'owner' },
    { profile: 'pulls', owner: 'owner:evil', repo: 'repo' }, { profile: 'issues', owner: 'owner', repo: 'https://evil' }, { profile: 'issues', owner: 'owner', repo: '..' },
    { profile: 'issues', repository: 'owner/repo', query: 'override' }, { profile: 'repositories', owner: 'other' },
    { profile: 'repositories', query: 'repo:other/secret' }, { profile: 'repositories', query: '" OR user:other' }, { profile: 'repositories', query: 'x'.repeat(161) }, null,
  ];
  for (const input of inputs) await assert.rejects(executeGithubRead(input, env, { fetch }), error => error.status === 400 && error.code === 'GITHUB_INVALID_REQUEST');
});

test('unavailable or writable-marked tools and incompatible schemas fail before tool execution', async () => {
  const cases = [[], [{ ...tools[0], annotations: { readOnlyHint: false } }], [{ ...tools[0], inputSchema: schema({ extra: string }, ['extra']) }], [{ ...tools[0], inputSchema: { type: 'array' } }]];
  for (const available of cases) {
    const mock = transport({ tools: available });
    await assert.rejects(executeGithubRead({ profile: 'profile' }, env, mock), error => error.code === 'GITHUB_TOOL_UNAVAILABLE');
    assert.ok(!mock.calls.some(call => call.rpc.method === 'tools/call'));
  }
  const mock = transport({ tools: tools.map(tool => tool.name === 'list_issues' ? { ...tool, inputSchema: schema({ owner: string, repo: string, perPage: integer, state: { type: 'string', enum: ['closed'] } }) } : tool) });
  await assert.rejects(executeGithubRead({ profile: 'issues', repository: 'dazza/forge' }, env, mock), error => error.code === 'GITHUB_TOOL_UNAVAILABLE');
});

test('HTTP, transport, RPC, and tool errors are sanitized and never fabricate successful empty results', async () => {
  for (const [status, code] of [[401, 'GITHUB_AUTH_FAILED'], [403, 'GITHUB_ACCESS_DENIED'], [429, 'GITHUB_RATE_LIMITED'], [500, 'GITHUB_HTTP_ERROR']]) {
    await assert.rejects(executeGithubRead({ profile: 'profile' }, env, { fetch: async () => new Response(`private ${env.GITHUB_TOKEN}`, { status }) }), error => error.code === code && !error.message.includes(env.GITHUB_TOKEN));
  }
  const mocks = [
    transport({ fetch: async () => { throw new Error(`https://private/${env.GITHUB_TOKEN}`); } }),
    transport({ fetch: async rpc => new Response(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, error: { message: env.GITHUB_TOKEN } })) }),
    transport({ call: async () => ({ isError: true, content: [{ type: 'text', text: env.GITHUB_TOKEN }] }) }),
    transport({ call: async () => ({ content: [{ type: 'text', text: 'not JSON' }] }) }),
  ];
  for (const mock of mocks) await assert.rejects(executeGithubRead({ profile: 'profile' }, env, mock), error => error.code.startsWith('GITHUB_') && !error.message.includes(env.GITHUB_TOKEN));
});

test('GitHub manual redirects fail after one request without credentials reaching Location or error text', async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    let calls = 0;
    await assert.rejects(executeGithubRead({ profile: 'profile' }, env, { fetch: async (url, init) => {
      calls++;
      assert.equal(url, GITHUB_MCP_ENDPOINT);
      assert.equal(init.redirect, 'manual');
      assert.equal(init.headers.authorization, `Bearer ${env.GITHUB_TOKEN}`);
      assert.equal(calls, 1);
      return new Response(`Echo ${env.GITHUB_TOKEN}`, { status, headers: { Location: `https://credential-sink.example/${env.GITHUB_TOKEN}` } });
    } }), error => error.code === 'GITHUB_HTTP_ERROR' && error.status === 502 && !error.message.includes(env.GITHUB_TOKEN) && !error.message.includes('credential-sink'));
    assert.equal(calls, 1);
  }
});

test('normalization removes unsafe URLs, arbitrary response fields, and echoed server tokens', async () => {
  const mock = transport({ call: async () => toolResult({ total_count: 1, items: [{ name: 'forge', full_name: 'dazza/forge', description: `Echo ${env.GITHUB_TOKEN} github_pat_ABC123`, html_url: 'https://evil.example/secret', token: env.GITHUB_TOKEN }] }) });
  // Repository discovery must establish the actual account first.
  const baseFetch = mock.fetch;
  const fetch = async (url, init) => {
    const rpc = JSON.parse(init.body);
    if (rpc.method === 'tools/call' && rpc.params.name === 'get_me') return rpcResponse(rpc.id, toolResult(account));
    return baseFetch(url, init);
  };
  const result = await executeGithubRead({ profile: 'repositories' }, env, { fetch });
  assert.equal(result.items[0].url, undefined);
  assert.ok(result.items[0].description.includes('[redacted]'));
  assert.doesNotMatch(JSON.stringify(result), /server-only-github-token|github_pat_ABC123|evil\.example/);
});

test('GH_TOKEN and a server tokenProvider are accepted without ever accepting browser credentials', async () => {
  for (const [configuration, extra] of [[{ GH_TOKEN: 'alternative-token' }, {}], [{}, { tokenProvider: async () => 'provided-token' }]]) {
    const mock = transport();
    const result = await executeGithubRead({ profile: 'profile' }, configuration, { ...mock, ...extra });
    assert.equal(result.account.login, 'dazza');
    assert.ok(['Bearer alternative-token', 'Bearer provided-token'].includes(mock.calls[0].init.headers.authorization));
    assert.doesNotMatch(JSON.stringify(result), /alternative-token|provided-token/);
  }
});

test('persistent SSE responses finish on matching result and cancel the stream', async () => {
  let cancelled = 0;
  const mock = transport({ fetch: async rpc => {
    if (rpc.method === 'initialize') return rpcResponse(rpc.id, { protocolVersion: '2025-03-26', serverInfo: { name: 'GitHub', version: '1' } });
    if (rpc.method === 'notifications/initialized') return new Response(null, { status: 202 });
    const result = rpc.method === 'tools/list' ? { tools } : toolResult(account);
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress' })}\r\n\r\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result })}\r`));
      controller.enqueue(new TextEncoder().encode('\n\r\n'));
    }, cancel() { cancelled++; } }), { headers: { 'content-type': 'text/event-stream' } });
  } });
  const result = await executeGithubRead({ profile: 'profile' }, env, { ...mock, timeoutMs: 1000 });
  assert.equal(result.account.login, 'dazza');
  assert.equal(cancelled, 2);
});

test('Worker native fetch is bound without browser-only options and caller-injected transport is not rebound', async () => {
  const original = globalThis.fetch;
  const nativeMock = transport();
  const injectedMock = transport();
  globalThis.fetch = async function(url, init) {
    if (this !== globalThis) throw new TypeError('Illegal invocation');
    if (Object.hasOwn(init, 'cache') || Object.hasOwn(init, 'credentials')) throw new TypeError('Unsupported Worker RequestInit option');
    return nativeMock.fetch(url, init);
  };
  try {
    const native = await executeGithubRead({ profile: 'profile' }, env);
    assert.equal(native.account.login, 'dazza');
    assert.equal(nativeMock.calls.length, 4);
    const injected = await executeGithubRead({ profile: 'profile' }, env, { fetch: async function(url, init) {
      assert.equal(this, undefined);
      return injectedMock.fetch(url, init);
    } });
    assert.equal(injected.account.login, 'dazza');
    assert.equal(injectedMock.calls.length, 4);
    assert.equal(nativeMock.calls.length, 4);
  } finally { globalThis.fetch = original; }
});

test('one deadline bounds credentials, handshake and tool execution and aborts the active fetch', async () => {
  let signal;
  await assert.rejects(executeGithubRead({ profile: 'profile' }, env, { timeoutMs: 10, fetch: async (url, init) => { signal = init.signal; return new Promise(() => {}); } }), error => error.code === 'GITHUB_TIMEOUT' && error.status === 504);
  assert.equal(signal.aborted, true);
  await assert.rejects(executeGithubRead({ profile: 'profile' }, {}, { timeoutMs: 10, tokenProvider: async () => new Promise(() => {}), fetch: async () => assert.fail('No token has arrived') }), error => error.code === 'GITHUB_TIMEOUT');
});

test('oversized, malformed, wrong-ID and incompatible protocol responses fail safely', async () => {
  for (const response of [
    () => new Response('x', { headers: { 'content-length': String(1024 * 1024 + 1) } }),
    () => new Response('x'.repeat(1024 * 1024 + 1)),
    () => new Response('not JSON'),
    () => rpcResponse(999, { protocolVersion: '2025-03-26' }),
    () => rpcResponse(1, { protocolVersion: '2024-11-05', serverInfo: { name: 'GitHub', version: 'old' } }),
  ]) await assert.rejects(executeGithubRead({ profile: 'profile' }, env, { fetch: async () => response() }), error => error.status === 502 && error.code.startsWith('GITHUB_'));
});
