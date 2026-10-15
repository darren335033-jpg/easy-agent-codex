import test from 'node:test';
import assert from 'node:assert/strict';
import { testMcpConnection } from '../server/mcp.mjs';

const endpoint = 'https://mcp.example.com/mcp';
const allowedHosts = ['mcp.example.com'];
const initialize = {
  protocolVersion: '2025-03-26', capabilities: { tools: {} },
  serverInfo: { name: 'Example developer server', version: '2.3.0' },
};

function jsonResponse(id, result, extra = {}) {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), {
    headers: { 'content-type': 'application/json', ...extra },
  });
}

test('performs the MCP handshake, preserves the session, and discovers tools without calling them', async () => {
  const requests = [];
  const result = await testMcpConnection({ url: endpoint, token: 'ephemeral-secret' }, {
    allowedHosts,
    fetch: async (url, init) => {
      const request = JSON.parse(init.body);
      requests.push({ url, init, request });
      if (request.method === 'initialize') return jsonResponse(request.id, initialize, { 'mcp-session-id': 'session-123' });
      if (request.method === 'notifications/initialized') return new Response(null, { status: 202 });
      return jsonResponse(request.id, { tools: [{ name: 'read_file', description: 'Read workspace file', inputSchema: {} }] });
    },
  });
  assert.deepEqual(result, {
    status: 'connected', name: 'Example developer server', version: '2.3.0',
    tools: [{ name: 'read_file', description: 'Read workspace file' }],
  });
  assert.deepEqual(requests.map(item => item.request.method), ['initialize', 'notifications/initialized', 'tools/list']);
  assert.equal(requests[0].request.params.protocolVersion, '2025-03-26');
  assert.deepEqual(requests[0].request.params.capabilities, {});
  assert.equal(requests[1].request.id, undefined);
  assert.equal(requests[0].init.headers['Mcp-Session-Id'], undefined);
  for (const { url, init } of requests) {
    assert.equal(url, endpoint);
    assert.equal(init.redirect, 'manual');
    assert.equal(init.credentials, undefined);
    assert.equal(init.cache, undefined);
    assert.equal(init.headers.authorization, 'Bearer ephemeral-secret');
  }
  assert.equal(requests[1].init.headers['Mcp-Session-Id'], 'session-123');
  assert.equal(requests[2].init.headers['Mcp-Session-Id'], 'session-123');
  assert.ok(!JSON.stringify(result).includes('ephemeral-secret'));
});

test('parses SSE responses and follows tool-list pagination', async () => {
  const requests = [];
  const result = await testMcpConnection({ url: endpoint }, {
    allowedHosts,
    fetch: async (_, init) => {
      const request = JSON.parse(init.body);
      requests.push(request);
      if (request.method === 'initialize') return jsonResponse(request.id, initialize);
      if (request.method === 'notifications/initialized') return new Response(null, { status: 202 });
      const response = request.params.cursor
        ? { tools: [{ name: 'search_code' }] }
        : { tools: [{ name: 'read_file', description: 'Read a file' }], nextCursor: 'page-2' };
      return new Response(`: heartbeat\r\n\r\nevent: message\r\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: {} })}\r\n\r\nevent: message\r\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: response })}\r\n\r\n`, {
        headers: { 'content-type': 'text/event-stream; charset=utf-8' },
      });
    },
  });
  assert.deepEqual(result.tools, [{ name: 'read_file', description: 'Read a file' }, { name: 'search_code', description: '' }]);
  assert.deepEqual(requests.at(-1).params, { cursor: 'page-2' });
});

test('uses the documented stateless Google protocol without initialize', async () => {
  const requests = [];
  const result = await testMcpConnection({ url: 'https://aiplatform.googleapis.com/mcp/generate', token: 'google-token' }, {
    allowedHosts: ['aiplatform.googleapis.com'],
    fetch: async (url, init) => {
      const request = JSON.parse(init.body);
      requests.push({ url, init, request });
      return jsonResponse(request.id, { tools: [{ name: 'generate_content', description: 'Generate content' }] });
    },
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].request.method, 'tools/list');
  assert.equal(requests[0].init.headers['MCP-Protocol-Version'], '2026-07-28');
  assert.equal(requests[0].init.headers.authorization, 'Bearer google-token');
  assert.equal(result.name, 'Google Vertex AI');
  assert.equal(result.version, '2026-07-28');
});

test('finishes discovery when a persistent SSE stream delivers the matching response', async () => {
  let cancelled = false;
  const result = await testMcpConnection({ url: 'https://aiplatform.googleapis.com/mcp/generate' }, {
    allowedHosts: ['aiplatform.googleapis.com'], timeoutMs: 100,
    fetch: async (_, init) => {
      const id = JSON.parse(init.body).id;
      return new Response(new ReadableStream({
        start(controller) {
          const payload = JSON.stringify({ jsonrpc: '2.0', id, result: { tools: [{ name: 'generate_content' }] } });
          controller.enqueue(new TextEncoder().encode(`: heartbeat\r\n\r\ndata: ${payload}\r`));
          controller.enqueue(new TextEncoder().encode('\n\r\n'));
        },
        cancel() { cancelled = true; },
      }), { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  assert.equal(result.status, 'connected');
  assert.equal(cancelled, true);
});

test('blocks private, local, metadata, and credential-bearing URLs before sending credentials', async () => {
  let requests = 0;
  const blocked = [
    'http://mcp.example.com/mcp', 'https://localhost/mcp', 'https://localhost./mcp',
    'https://foo.local/mcp', 'https://foo.localhost/mcp', 'https://metadata.google.internal/computeMetadata/v1',
    'https://10.0.0.1/mcp', 'https://172.16.0.1/mcp', 'https://192.168.2.1/mcp',
    'https://169.254.169.254/mcp', 'https://100.64.0.1/mcp', 'https://127.0.0.1/mcp',
    'https://2130706433/mcp', 'https://0x7f000001/mcp', 'https://[::1]/mcp',
    'https://[::]/mcp', 'https://[fc00::1]/mcp', 'https://[fe80::1]/mcp',
    'https://[::ffff:127.0.0.1]/mcp', 'https://[2002:a00:1::]/mcp',
    'https://user:secret@mcp.example.com/mcp', 'https://mcp.example.com/mcp#secret',
  ];
  for (const url of blocked) {
    await assert.rejects(testMcpConnection({ url, token: 'must-not-leak' }, {
      allowedHosts: [...allowedHosts, new URL(url).hostname],
      fetch: async () => { requests++; throw new Error('Should not fetch'); },
    }), error => error.status === 400 || error.status === 403, url);
  }
  assert.equal(requests, 0);
});

test('requires the server-configured hostname allowlist for public endpoints', async () => {
  for (const options of [{}, { allowedHosts: ['other.example.com'] }, { allowedHosts: ['*.example.com'] }]) {
    await assert.rejects(testMcpConnection({ url: endpoint }, options), error =>
      error.status === 403 && error.code === 'MCP_HOST_NOT_ALLOWED');
  }
});

test('native Worker fetch retains its global receiver and omits unsupported browser options while injected fetch stays untouched', async () => {
  const original = globalThis.fetch;
  let nativeCalls = 0, injectedCalls = 0;
  const respond = async (url, init) => {
    assert.equal(url, endpoint);
    assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'manual');
    if (Object.hasOwn(init, 'cache') || Object.hasOwn(init, 'credentials')) throw new TypeError('Unsupported Worker RequestInit option');
    const request = JSON.parse(init.body);
    if (request.method === 'initialize') return jsonResponse(request.id, initialize);
    if (request.method === 'notifications/initialized') return new Response(null, { status: 202 });
    assert.equal(request.method, 'tools/list');
    return jsonResponse(request.id, { tools: [{ name: 'read_file' }] });
  };
  globalThis.fetch = async function(url, init) {
    if (this !== globalThis) throw new TypeError('Illegal invocation');
    nativeCalls++;
    return respond(url, init);
  };
  try {
    const native = await testMcpConnection({ url: endpoint }, { allowedHosts });
    assert.equal(native.status, 'connected');
    assert.equal(nativeCalls, 3);
    const injected = await testMcpConnection({ url: endpoint }, { allowedHosts, fetch: async function(url, init) {
      assert.equal(this, undefined);
      injectedCalls++;
      return respond(url, init);
    } });
    assert.equal(injected.status, 'connected');
    assert.equal(injectedCalls, 3);
    assert.equal(nativeCalls, 3);
  } finally { globalThis.fetch = original; }
});

test('explicit local runtime option permits loopback but still blocks LAN destinations', async () => {
  const methods = [];
  const result = await testMcpConnection({ url: 'http://127.0.0.1:8080/mcp' }, {
    allowLocal: true,
    fetch: async (_, init) => {
      const request = JSON.parse(init.body);
      methods.push(request.method);
      if (request.method === 'initialize') return jsonResponse(request.id, initialize);
      if (request.method === 'notifications/initialized') return new Response(null, { status: 202 });
      return jsonResponse(request.id, { tools: [] });
    },
  });
  assert.equal(result.status, 'connected');
  assert.equal(methods.length, 3);
  await assert.rejects(testMcpConnection({ url: 'https://192.168.0.1/mcp' }, {
    allowLocal: true, allowedHosts: ['192.168.0.1'],
  }), error => error.code === 'MCP_DESTINATION_BLOCKED');
});

test('returns safe authentication and network errors without leaking response text or credentials', async () => {
  const secret = 'super-secret-token';
  for (const [status, code] of [[401, 'MCP_AUTH_FAILED'], [403, 'MCP_ACCESS_DENIED'], [429, 'MCP_RATE_LIMITED'], [500, 'MCP_HTTP_ERROR']]) {
    await assert.rejects(testMcpConnection({ url: endpoint, token: secret }, {
      allowedHosts, fetch: async () => new Response(`server echoed ${secret}`, { status }),
    }), error => {
      assert.equal(error.code, code);
      assert.ok(!error.message.includes(secret));
      return true;
    });
  }
  await assert.rejects(testMcpConnection({ url: endpoint, token: secret }, {
    allowedHosts, fetch: async () => { throw new Error(`redirect to https://secret.example/${secret}`); },
  }), error => error.code === 'MCP_NETWORK_ERROR' && !error.message.includes(secret));
});

test('manual redirects reject every 3xx after one request without forwarding tokens or exposing Location', async () => {
  const secret = 'private-mcp-redirect-token';
  for (const status of [301, 302, 303, 307, 308]) {
    let calls = 0;
    await assert.rejects(testMcpConnection({ url: endpoint, token: secret }, { allowedHosts, fetch: async (url, init) => {
      calls++;
      assert.equal(url, endpoint);
      assert.equal(init.redirect, 'manual');
      assert.equal(init.headers.authorization, `Bearer ${secret}`);
      assert.equal(calls, 1);
      return new Response(`Private response ${secret}`, { status, headers: { Location: `https://credential-sink.example/${secret}` } });
    } }), error => error.code === 'MCP_HTTP_ERROR' && error.status === 502 && !error.message.includes(secret) && !error.message.includes('credential-sink'));
    assert.equal(calls, 1);
  }
});

test('enforces one timeout across the MCP handshake', async () => {
  let signal;
  await assert.rejects(testMcpConnection({ url: endpoint }, {
    allowedHosts, timeoutMs: 10,
    fetch: async (_, init) => { signal = init.signal; return new Promise(() => {}); },
  }), error => error.status === 504 && error.code === 'MCP_TIMEOUT');
  assert.equal(signal.aborted, true);
});

test('rejects oversized responses from both content length and streamed data', async () => {
  for (const headers of [{ 'content-length': String(1024 * 1024 + 1) }, {}]) {
    await assert.rejects(testMcpConnection({ url: endpoint }, {
      allowedHosts,
      fetch: async () => new Response('x'.repeat(1024 * 1024 + 1), { headers }),
    }), error => error.code === 'MCP_RESPONSE_TOO_LARGE');
  }
});

test('rejects malformed, mismatched, and error JSON-RPC responses safely', async () => {
  const responses = [
    'not JSON',
    JSON.stringify({ jsonrpc: '2.0', id: 999, result: initialize }),
    JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32603, message: 'secret internal details' } }),
    JSON.stringify({ jsonrpc: '2.0', id: 1, result: { serverInfo: { name: 'incomplete' } } }),
  ];
  for (const body of responses) {
    await assert.rejects(testMcpConnection({ url: endpoint }, {
      allowedHosts, fetch: async () => new Response(body),
    }), error => error.status === 502 && !error.message.includes('secret internal details'));
  }
});

test('rejects repeating tool-list cursors instead of looping', async () => {
  let requests = 0;
  await assert.rejects(testMcpConnection({ url: 'https://aiplatform.googleapis.com/mcp/generate' }, {
    allowedHosts: ['aiplatform.googleapis.com'],
    fetch: async (_, init) => {
      requests++;
      return jsonResponse(JSON.parse(init.body).id, { tools: [], nextCursor: 'same' });
    },
  }), error => error.code === 'MCP_INVALID_RESPONSE');
  assert.equal(requests, 2);
});
