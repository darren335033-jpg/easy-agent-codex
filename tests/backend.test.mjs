import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { validateRun, safePath, parseChanges, executeRun } from '../server/run.mjs';
import { generate, readProviderJson, providerStatus } from '../server/providers.mjs';
import { googleToken } from '../server/auth.mjs';
import { handleApi } from '../server/api.mjs';

const task = { task: 'Build a useful project', provider: 'vertex', maxAgents: 3, concurrency: 2, files: [{ path: 'src/main.js', content: 'export const value = 1;' }] };
const vertexEnv = { GOOGLE_ACCESS_TOKEN: 'server-only-token', GOOGLE_CLOUD_PROJECT: 'test-project', VERTEX_MODEL: 'test-model' };
const jsonResponse = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const request = (path, input, headers = {}) => new Request(`https://forge.example${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(input) });

test('task validation trims input, supplies bounds, and rejects malformed or excessive context', () => {
  const valid = validateRun({ task: '  Review code  ', provider: 'local' });
  assert.equal(valid.task, 'Review code');
  assert.equal(valid.mode, 'build');
  assert.equal(valid.maxAgents, 5);
  assert.equal(valid.concurrency, 3);
  assert.deepEqual(valid.files, []);
  const invalid = [
    null, [], {}, { ...task, task: 'hi' }, { ...task, task: 'x'.repeat(16001) },
    { ...task, provider: 'other' }, { ...task, maxAgents: 0 }, { ...task, maxAgents: 51 },
    { ...task, maxAgents: 2.5 }, { ...task, concurrency: 9 }, { ...task, concurrency: 0 },
    { ...task, enabledAgentIds: [123] }, { ...task, enabledAgentIds: 'atlas' },
    { ...task, files: Array.from({ length: 81 }, (_, i) => ({ path: `file-${i}`, content: '' })) },
    { ...task, files: [{ path: 'main.js', content: 'x'.repeat(100001) }] },
    { ...task, files: [{ path: 'main.js', content: 1 }] },
    { ...task, files: [{ path: '.env', content: 'secret' }] },
    { ...task, files: [{ path: 'main.js', content: '' }, { path: 'main.js', content: '' }] },
    { ...task, files: Array.from({ length: 4 }, (_, i) => ({ path: `file-${i}`, content: 'x'.repeat(80000) })) },
  ];
  for (const input of invalid) assert.throws(() => validateRun(input), error => error.status === 400);
});

test('safe paths exclude traversal, absolute paths, controls, and common credential files', () => {
  for (const path of ['src/main.js', 'README.md', 'src/.gitignore', 'a file.txt', 'src/config.example.json']) assert.equal(safePath(path), true, path);
  for (const path of ['', '/root/file', '../file', 'a/../file', './file', 'a//file', 'a/./file', 'a/', 'C:/file', 'a\\file', 'nul\0.js', 'a\nfile', '.env', '.env.local', 'src/.env.production', '.git/config', 'keys/id_rsa', 'id_ed25519', 'credentials.json', 'config/service-account-prod.json', 'x'.repeat(241), null]) assert.equal(safePath(path), false, String(path));
});

test('change parsing accepts fenced JSON and strips unsafe, duplicate, oversized, or malformed proposals', () => {
  const content = { output: 'Review these proposals.', changes: [
    { path: 'src/main.js', content: 'safe', reason: 'a'.repeat(1100) },
    { path: 'src/main.js', content: 'duplicate' },
    { path: '../escape', content: 'danger' }, { path: '/absolute', content: 'danger' },
    { path: '.env', content: 'SECRET=value' }, { path: '.git/config', content: 'danger' },
    { path: 'service_account.json', content: 'danger' },
    { path: 'oversized', content: 'x'.repeat(100001) }, { path: 'number', content: 3 }, null,
    { path: 'README.md', content: 'Useful docs' },
  ] };
  const result = parseChanges(`Here is the result:\n\`\`\`json\n${JSON.stringify(content)}\n\`\`\``);
  assert.equal(result.output, content.output);
  assert.deepEqual(result.changes.map(change => change.path), ['src/main.js', 'README.md']);
  assert.equal(result.changes[0].reason.length, 1000);
  assert.equal(result.changes[1].reason, 'Proposed change');
  assert.equal(parseChanges(JSON.stringify({ changes: Array.from({ length: 50 }, (_, i) => ({ path: `file-${i}`, content: '' })) })).changes.length, 40);
});

test('non-object, malformed, or plain-text model output remains reviewable without inventing changes', () => {
  for (const output of ['null', '[]', '123', '"hello"', 'I cannot propose code.', '{broken']) {
    assert.deepEqual(parseChanges(output), { output, changes: [] });
  }
});

test('orchestration actually runs a lead, parallel specialists, then synthesis and adds all inference usage', async () => {
  const calls = [];
  const finishedSpecialists = [];
  let active = 0;
  let peak = 0;
  const result = await executeRun(task, {}, { generate: async input => {
    calls.push(input);
    const index = calls.length;
    if (index === 1) return { text: 'Lead implementation plan', usage: { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12 } };
    if (input.prompt.includes('Synthesize the team')) {
      assert.equal(finishedSpecialists.length, 2);
      for (const output of finishedSpecialists) assert.ok(input.prompt.includes(output));
      return { text: JSON.stringify({ output: 'Team result; validation is still required.', changes: [{ path: 'src/main.js', content: 'export const value = 2;', reason: 'Complete implementation' }] }), usage: { promptTokenCount: 40, candidatesTokenCount: 8, totalTokenCount: 48 } };
    }
    assert.ok(input.prompt.includes('Lead implementation plan'));
    active++;
    peak = Math.max(peak, active);
    await delay(index === 2 ? 10 : 1);
    active--;
    const text = `Specialist ${index} findings`;
    finishedSpecialists.push(text);
    return { text, usage: { promptTokenCount: 20, candidatesTokenCount: 4, totalTokenCount: 24 } };
  } });
  assert.equal(calls.length, 4);
  assert.equal(peak, 2);
  assert.equal(result.inferenceCalls, 4);
  assert.equal(result.status, 'completed');
  assert.equal(result.agents.length, 3);
  assert.deepEqual(result.usage, { promptTokenCount: 90, candidatesTokenCount: 18, totalTokenCount: 108 });
  assert.equal(result.agents[0].output, JSON.stringify({ output: 'Team result; validation is still required.', changes: [{ path: 'src/main.js', content: 'export const value = 2;', reason: 'Complete implementation' }] }));
  assert.equal(result.changes[0].content, 'export const value = 2;');
  assert.equal(result.output, 'Team result; validation is still required.');
  for (const call of calls) {
    assert.ok(call.system.includes('you have no shell or execution tools'));
    assert.ok(call.prompt.includes('src/main.js'));
  }
});

test('review mode suppresses file changes even when model synthesis attempts them', async () => {
  const result = await executeRun({ ...task, mode: 'review' }, {}, { generate: async () => ({ text: JSON.stringify({ output: 'Review findings', changes: [{ path: 'main.js', content: 'do not apply' }] }) }) });
  assert.deepEqual(result.changes, []);
  assert.equal(result.status, 'completed');
});

test('one-agent planning uses one real inference and zero enabled agents are rejected', async () => {
  let calls = 0;
  const result = await executeRun({ ...task, maxAgents: 1, mode: 'plan' }, {}, { generate: async () => { calls++; return { text: 'A practical plan' }; } });
  assert.equal(calls, 1);
  assert.equal(result.inferenceCalls, 1);
  assert.equal(result.output, 'A practical plan');
  await assert.rejects(executeRun({ ...task, enabledAgentIds: [] }, {}, { generate: async () => assert.fail('Disabled agents must not invoke a provider') }), /Enable at least one agent/);
});

test('provider failures at planning, specialist work, or synthesis propagate instead of successful results', async () => {
  for (const failAt of [1, 2, 4]) {
    let calls = 0;
    const failure = Object.assign(new Error('mock provider failure'), { status: 502 });
    await assert.rejects(executeRun({ ...task, concurrency: 1 }, {}, { generate: async () => {
      if (++calls === failAt) throw failure;
      return { text: 'real provider response' };
    } }), error => error === failure);
    assert.equal(calls, failAt);
  }
});

test('local result identifies the Ollama model that was actually selected', async () => {
  const result = await executeRun({ ...task, provider: 'local', maxAgents: 1, mode: 'plan' }, { OLLAMA_MODEL: 'custom-coder:latest', VERTEX_MODEL: 'unrelated-cloud-model' }, { runtime: 'local', fetch: async () => jsonResponse({ message: { content: 'Useful plan' }, prompt_eval_count: 12, eval_count: 3 }) });
  assert.equal(result.model, 'custom-coder:latest');
  assert.deepEqual(result.usage, { promptTokenCount: 12, candidatesTokenCount: 3, totalTokenCount: 15 });
});

test('Vertex request uses server credentials and project resource and excludes thought text', async () => {
  const observed = [];
  const result = await generate({ provider: 'vertex', system: 'Engineer', prompt: 'Implement a feature' }, vertexEnv, { fetch: async (url, init) => {
    observed.push({ url, init });
    return jsonResponse({ result: { content: [{ type: 'text', text: JSON.stringify({ candidates: [{ content: { parts: [{ text: 'private chain', thought: true }, { text: 'Useful implementation' }] } }], usageMetadata: { totalTokenCount: 17 } }) }] } });
  } });
  assert.equal(observed.length, 1);
  const { url, init } = observed[0];
  assert.equal(url, 'https://aiplatform.googleapis.com/mcp/generate');
  assert.equal(init.headers.Authorization, 'Bearer server-only-token');
  assert.equal(init.redirect, 'manual');
  const body = JSON.parse(init.body);
  assert.equal(body.method, 'tools/call');
  assert.equal(body.params.name, 'generate_content');
  assert.equal(body.params.arguments.model, 'projects/test-project/locations/global/publishers/google/models/test-model');
  assert.equal(result.text, 'Useful implementation');
  assert.equal(result.usage.totalTokenCount, 17);
});

test('missing credentials and cloud local-model requests fail before any network call', async () => {
  const fetch = async () => assert.fail('A provider must not be called');
  await assert.rejects(generate({ provider: 'vertex', projectId: 'project', prompt: 'Task' }, {}, { fetch }), error => error.code === 'PROVIDER_NOT_CONFIGURED');
  await assert.rejects(generate({ provider: 'local', model: 'model', prompt: 'Task' }, {}, { runtime: 'cloud', fetch }), error => error.code === 'LOCAL_RUNTIME_REQUIRED');
  assert.equal(providerStatus({}, 'cloud').vertex.configured, false);
  assert.equal(providerStatus({}, 'cloud').local.configured, false);
  assert.equal(providerStatus({}, 'local').local.configured, true);
});

test('Vertex native HTTP transport retains the global receiver required by Worker runtimes', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = function (url, init) {
    assert.equal(this, globalThis);
    assert.equal(url, 'https://aiplatform.googleapis.com/mcp/generate');
    assert.equal(init.method, 'POST');
    calls++;
    return Promise.resolve(jsonResponse({ result: { structuredContent: { candidates: [{ content: { parts: [{ text: 'Verified worker transport' }] } }] } } }));
  };
  try {
    const result = await generate({ provider: 'vertex', system: 'Engineer', prompt: 'Task' }, vertexEnv);
    assert.equal(result.text, 'Verified worker transport');
    assert.equal(calls, 1);
  } finally { globalThis.fetch = original; }
});

test('provider redirects are refused without following or exposing the destination', async () => {
  let calls = 0;
  await assert.rejects(generate({ provider: 'vertex', system: 'Engineer', prompt: 'Task' }, vertexEnv, { fetch: async (url, init) => {
    calls++;
    assert.equal(url, 'https://aiplatform.googleapis.com/mcp/generate');
    assert.equal(init.redirect, 'manual');
    return new Response('PRIVATE_REDIRECT_BODY', { status: 302, headers: { Location: 'https://other.example/PRIVATE_DESTINATION' } });
  } }), error => error.status === 502 && error.code === 'PROVIDER_ERROR' && !error.message.includes('PRIVATE'));
  assert.equal(calls, 1);
});

test('empty, blocked, malformed, and failed provider responses reject without leaking response data', async () => {
  const input = { provider: 'vertex', system: 'Engineer', prompt: 'Task' };
  const cases = [
    [() => jsonResponse({ result: { structuredContent: { candidates: [] } } }), 'EMPTY_OUTPUT'],
    [() => jsonResponse({ result: { isError: true, content: [{ text: 'sensitive internal detail' }] } }), 'PROVIDER_ERROR'],
    [() => jsonResponse({ error: { message: 'sensitive internal detail' } }), 'PROVIDER_ERROR'],
    [() => new Response('sensitive internal detail', { status: 403 }), 'PROVIDER_ERROR'],
    [() => new Response('not JSON'), 'PROVIDER_ERROR'],
  ];
  for (const [response, code] of cases) await assert.rejects(generate(input, vertexEnv, { fetch: async () => response() }), error => error.code === code && !error.message.includes('sensitive internal detail'));
  await assert.rejects(generate({ provider: 'local', system: '', prompt: '' }, {}, { runtime: 'local', fetch: async () => jsonResponse({ message: {} }) }), error => error.code === 'EMPTY_OUTPUT');
  await assert.rejects(readProviderJson(new Response('x'.repeat(2097153))), /size limit/);
});

test('Vertex persistent SSE completes as soon as its tool result arrives', async () => {
  let stream;
  let cancelled = false;
  const response = new Response(new ReadableStream({
    start(controller) {
      stream = controller;
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { structuredContent: { candidates: [{ content: { parts: [{ text: 'Finished result' }] } }] } } })}\n\n`));
    },
    cancel() { cancelled = true; },
  }), { headers: { 'content-type': 'text/event-stream' } });
  const pending = generate({ provider: 'vertex', system: '', prompt: 'Task' }, vertexEnv, { fetch: async () => response });
  let timer;
  try {
    const result = await Promise.race([pending, new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('Provider kept waiting after a complete SSE result')), 100); })]);
    assert.equal(result.text, 'Finished result');
    assert.equal(cancelled, true);
  } finally {
    clearTimeout(timer);
    if (!cancelled) stream.close();
    await pending.catch(() => {});
  }
});

test('API rejects cross-origin requests before calling providers or local commands', async () => {
  let called = false;
  for (const headers of [{ origin: 'https://evil.example' }, { 'sec-fetch-site': 'cross-site' }]) {
    const response = await handleApi(request('/api/run', task, headers), {}, { generate: async () => { called = true; return { text: 'Must not happen' }; } });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error, 'ORIGIN_BLOCKED');
  }
  assert.equal(called, false);
});

test('API returns provider/setup errors without fabricated completed runs or secret error details', async () => {
  const unavailable = await handleApi(request('/api/run', { ...task, projectId: 'test-project' }), {}, { fetch: async () => assert.fail('No configured provider') });
  assert.equal(unavailable.status, 503);
  const unavailableBody = await unavailable.json();
  assert.equal(unavailableBody.error, 'PROVIDER_NOT_CONFIGURED');
  assert.equal(unavailableBody.status, undefined);
  const failed = await handleApi(request('/api/run', task), {}, { generate: async () => { throw new Error('token=private-credential file=/secret/path'); } });
  assert.equal(failed.status, 502);
  const failedBody = await failed.json();
  assert.equal(failedBody.error, 'REQUEST_FAILED');
  assert.ok(!JSON.stringify(failedBody).includes('private-credential'));
  assert.equal(failedBody.status, undefined);
});

test('API idempotency reuses completed results and rejects mismatched request bodies', async () => {
  const headers = { 'Idempotency-Key': 'backend-test-once' };
  let calls = 0;
  const options = { generate: async () => { calls++; return { text: JSON.stringify({ output: 'A result', changes: [] }) }; } };
  const input = { ...task, maxAgents: 1, mode: 'plan' };
  const first = await handleApi(request('/api/run', input, headers), {}, options);
  const second = await handleApi(request('/api/run', input, headers), {}, options);
  assert.equal(first.status, 200);
  assert.deepEqual(await second.json(), await first.json());
  assert.equal(calls, 1);
  const conflict = await handleApi(request('/api/run', { ...input, task: 'A different task' }, headers), {}, options);
  assert.equal(conflict.status, 409);
  assert.equal(calls, 1);
});

test('API enforces JSON input and request limits before model invocation', async () => {
  const options = { generate: async () => assert.fail('Invalid requests must not invoke inference') };
  for (const [body, headers, status] of [
    ['{}', { 'content-type': 'text/plain' }, 415],
    ['{bad', { 'content-type': 'application/json' }, 400],
    ['x'.repeat(500001), { 'content-type': 'application/json' }, 413],
  ]) {
    const response = await handleApi(new Request('https://forge.example/api/run', { method: 'POST', headers, body }), {}, options);
    assert.equal(response.status, status);
  }
});

test('Google credential configuration errors are actionable and do not expose secrets', async () => {
  for (const value of ['{bad json', '{}', JSON.stringify({ client_email: 'service@example.com', private_key: 'secret-invalid-pem' })]) {
    await assert.rejects(googleToken({ GOOGLE_SERVICE_ACCOUNT_JSON: value }, { fetch: async () => assert.fail('Invalid credentials must not be sent') }), error => error.code === 'PROVIDER_NOT_CONFIGURED' && !error.message.includes('secret-invalid-pem'));
  }
});
