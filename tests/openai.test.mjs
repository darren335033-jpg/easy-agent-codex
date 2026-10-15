import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverOpenAIModels, generateOpenAI, hasOpenAIKey } from '../server/openai.mjs';
import { generate, providerStatus } from '../server/providers.mjs';
import { executeRun } from '../server/run.mjs';
import { executeCodingTask } from '../server/coding.mjs';

const env = { OPENAI_API_KEY: 'PRIVATE_TEST_API_KEY', OPENAI_MODEL: 'project-coding-model' };
const input = { model: 'selected-model', system: 'You are an engineer.', prompt: 'Inspect this source.' };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const completed = (text = 'Useful output', extra = {}) => ({ status: 'completed', output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] }], ...extra });
const noFetch = async () => assert.fail('No external request is allowed');
const usage = { input_tokens: 12, output_tokens: 8, total_tokens: 20, input_tokens_details: { cached_tokens: 4 }, output_tokens_details: { reasoning_tokens: 3 } };

test('Responses uses the fixed API endpoint, server key, independent role messages and no response storage', async () => {
  let seen;
  const result = await generate({ ...input, provider: 'openai', responseFormat: 'json', messages: [{ role: 'user', content: 'First turn' }, { role: 'assistant', content: '{"tool":"read_file"}' }, { role: 'user', content: 'Real observation' }], apiKey: 'BROWSER_KEY', baseURL: 'https://attacker.invalid' }, env, { fetch: async (url, init) => { seen = { url, init, body: JSON.parse(init.body) }; return json(completed('{"output":"Done"}', { usage })); } });
  assert.equal(seen.url, 'https://api.openai.com/v1/responses');
  assert.equal(seen.init.headers.Authorization, 'Bearer PRIVATE_TEST_API_KEY');
  assert.equal(seen.init.redirect, 'manual');
  assert.equal(seen.body.model, 'selected-model');
  assert.equal(seen.body.store, false);
  assert.equal(seen.body.stream, false);
  assert.equal(seen.body.max_output_tokens, 16384);
  assert.equal(Object.hasOwn(seen.body, 'temperature'), false);
  assert.equal(Object.hasOwn(seen.body, 'tools'), false);
  assert.deepEqual(seen.body.input.map(message => message.role), ['user', 'assistant', 'user']);
  assert.match(seen.body.instructions, /JSON object/);
  assert.deepEqual(seen.body.text, { format: { type: 'json_object' } });
  assert.equal(JSON.stringify(seen.body).includes('BROWSER_KEY'), false);
  assert.equal(result.text, '{"output":"Done"}');
  assert.equal(result.usageReported, true);
  assert.deepEqual(result.usage, { promptTokenCount: 12, candidatesTokenCount: 8, totalTokenCount: 20, cachedInputTokenCount: 4, reasoningTokenCount: 3 });
});

test('all completed assistant text parts are extracted while reasoning and convenience fields are ignored', async () => {
  const result = await generateOpenAI(input, env, { fetch: async () => json({ status: 'completed', output_text: 'Untrusted convenience field', output: [{ type: 'reasoning', summary: [{ text: 'Private reasoning' }] }, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'First' }, { type: 'image', text: 'Not text' }, { type: 'output_text', text: 'Second' }] }, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Third' }] }] }) });
  assert.equal(result.text, 'First\nSecond\nThird');
  assert.deepEqual(result.usage, {});
  assert.equal(result.usageReported, false);
});

test('missing keys, invalid credentials and absent model IDs fail closed without provider calls', async () => {
  assert.equal(hasOpenAIKey({ OPENAI_API_KEY: 'bad\r\nHeader' }), false);
  await assert.rejects(generateOpenAI(input, {}, { fetch: noFetch }), error => error.code === 'PROVIDER_NOT_CONFIGURED');
  await assert.rejects(generateOpenAI({ ...input, model: '' }, { OPENAI_API_KEY: env.OPENAI_API_KEY }, { fetch: noFetch }), /Choose an OpenAI model ID/);
  for (const model of ['https://attacker.invalid', 'model\nheader', 'sk-privatekey']) await assert.rejects(generateOpenAI({ ...input, model }, env, { fetch: noFetch }), /Choose an OpenAI model ID/);
  assert.equal(providerStatus({}, 'cloud').openai.configured, false);
  assert.equal(providerStatus(env, 'local').openai.configured, true);
  assert.equal(providerStatus(env).openai.verified, false);
  assert.equal(providerStatus({ OPENAI_API_KEY: env.OPENAI_API_KEY }).openai.model, '');
  assert.equal(JSON.stringify(providerStatus(env)).includes(env.OPENAI_API_KEY), false);
});

test('server-selected model is used when caller omits it, without an invented fallback', async () => {
  await generateOpenAI({ prompt: 'Plan code' }, env, { fetch: async (_, init) => { assert.equal(JSON.parse(init.body).model, env.OPENAI_MODEL); return json(completed()); } });
});

test('incomplete, failed, refused and empty output are rejected instead of yielding partial code', async () => {
  const cases = [completed('partial', { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }), completed('partial', { status: 'failed', error: { message: 'sensitive internal detail' } }), completed('partial', { incomplete_details: { reason: 'content_filter' } }), { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'partial' }, { type: 'refusal', refusal: 'Sensitive provider detail' }] }] }, { status: 'completed', output: [{ type: 'message', role: 'assistant', status: 'incomplete', content: [{ type: 'output_text', text: 'partial' }] }] }, completed(' '), { status: 'completed', output: [{ type: 'reasoning' }] }];
  for (const value of cases) await assert.rejects(generateOpenAI(input, env, { fetch: async () => json(value) }), error => ['PROVIDER_ERROR', 'EMPTY_OUTPUT'].includes(error.code) && !/sensitive|partial/i.test(error.message.replace('partial output was not accepted', '')));
});

test('HTTP failures and redirects never reveal provider bodies or follow redirected credentials', async () => {
  for (const status of [302, 400, 401, 403, 404, 429, 500]) {
    let calls = 0;
    await assert.rejects(generateOpenAI(input, env, { fetch: async (url, init) => { calls++; assert.equal(url, 'https://api.openai.com/v1/responses'); assert.equal(init.redirect, 'manual'); return new Response('PRIVATE_TEST_API_KEY sensitive upstream body', { status, headers: { Location: 'https://attacker.invalid/secret' } }); } }), error => error.code === 'PROVIDER_ERROR' && !/PRIVATE_TEST|sensitive|attacker/.test(error.message));
    assert.equal(calls, 1);
  }
  await assert.rejects(generateOpenAI(input, env, { fetch: async () => { throw new Error('PRIVATE_TEST_API_KEY sensitive network detail'); } }), error => error.code === 'PROVIDER_ERROR' && !/PRIVATE_TEST|sensitive/.test(error.message));
});

test('malformed and oversized JSON responses are bounded and rejected safely', async () => {
  await assert.rejects(generateOpenAI(input, env, { fetch: async () => new Response('sensitive malformed data') }), /unreadable response/);
  let cancelled = false;
  const huge = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(2097153)); }, cancel() { cancelled = true; } });
  await assert.rejects(generateOpenAI(input, env, { fetch: async () => new Response(huge) }), /size limit/);
  assert.equal(cancelled, true);
});

test('invalid or missing usage remains unreported while a provider-reported zero stays explicit', async () => {
  for (const source of [undefined, {}, { input_tokens: 1, output_tokens: 2 }, { input_tokens: -1, output_tokens: 2, total_tokens: 1 }, { input_tokens: '1', output_tokens: 2, total_tokens: 3 }, { input_tokens: Infinity, output_tokens: 2, total_tokens: 3 }]) {
    const result = await generateOpenAI(input, env, { fetch: async () => json(completed('Text', { usage: source })) });
    assert.equal(result.usageReported, false); assert.deepEqual(result.usage, {});
  }
  const result = await generateOpenAI(input, env, { fetch: async () => json(completed('Text', { usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0, input_tokens_details: { cached_tokens: -2 }, output_tokens_details: {} } })) });
  assert.equal(result.usageReported, true);
  assert.deepEqual(result.usage, { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 });
});

test('model discovery is keyless fail-closed and reports the actual catalog without claiming compatibility', async () => {
  assert.deepEqual((await discoverOpenAIModels({}, { fetch: noFetch })).models, []);
  assert.equal((await discoverOpenAIModels({}, { fetch: noFetch })).configured, false);
  let calls = 0;
  const result = await discoverOpenAIModels(env, { fetch: async (url, init) => { calls++; assert.equal(url, 'https://api.openai.com/v1/models'); assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'manual'); assert.equal(init.headers.Authorization, 'Bearer PRIVATE_TEST_API_KEY'); return json({ object: 'list', data: [{ object: 'model', id: 'text-model' }, { object: 'model', id: 'embedding-model' }, { object: 'model', id: 'text-model' }] }); } });
  assert.equal(calls, 1);
  assert.equal(result.verified, true);
  assert.deepEqual(result.models, ['embedding-model', 'text-model']);
  assert.match(result.reason, /may not support Responses or JSON/);
});

test('model discovery caps returned IDs and does not follow unknown pagination or external URLs', async () => {
  const result = await discoverOpenAIModels(env, { fetch: async () => json({ object: 'list', data: Array.from({ length: 550 }, (_, index) => ({ object: 'model', id: `model-${index}` })), next: 'https://attacker.invalid' }) });
  assert.equal(result.models.length, 500);
  assert.equal(result.truncated, true);
});

test('model discovery rejects malformed catalogs and sanitizes errors', async () => {
  for (const response of [() => json({ data: [] }), () => json({ object: 'list', data: [{ id: 'sk-PRIVATE_TEST_API_KEY', object: 'model' }] }), () => new Response('PRIVATE_TEST_API_KEY', { status: 401 }), () => new Response('PRIVATE_TEST_API_KEY', { status: 302, headers: { Location: 'https://attacker.invalid' } })]) {
    const result = await discoverOpenAIModels(env, { fetch: async () => response() });
    assert.equal(result.configured, true); assert.equal(result.verified, false); assert.deepEqual(result.models, []); assert.equal(/PRIVATE_TEST|attacker/.test(result.reason), false);
  }
});

test('native OpenAI fetch retains the Worker global receiver', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = function (url, init) { assert.equal(this, globalThis); assert.equal(url, 'https://api.openai.com/v1/responses'); assert.equal(init.redirect, 'manual'); return Promise.resolve(json(completed())); };
    assert.equal((await generateOpenAI(input, env)).text, 'Useful output');
  } finally { globalThis.fetch = original; }
});

test('cancellation prevents an API call and interrupts a stalled response body', async () => {
  const before = new AbortController(); before.abort();
  await assert.rejects(generateOpenAI(input, env, { fetch: noFetch, signal: before.signal }), error => error.name === 'AbortError');
  const controller = new AbortController(); let cancelled = false;
  const stream = new ReadableStream({ cancel() { cancelled = true; } });
  const pending = generateOpenAI(input, env, { signal: controller.signal, fetch: async () => { queueMicrotask(() => controller.abort()); return new Response(stream); } });
  await assert.rejects(pending, error => error.name === 'AbortError');
  assert.equal(cancelled, true);
});

test('quick tasks accept OpenAI and distinguish missing usage from reported tokens', async () => {
  let call = 0;
  const result = await executeRun({ task: 'Plan the API', provider: 'openai', mode: 'plan', maxAgents: 2 }, env, { generate: async () => ++call === 1 ? { text: 'Plan', usage: {} } : { text: '{"output":"Reviewed","changes":[]}', usage: { promptTokenCount: 12, candidatesTokenCount: 8, totalTokenCount: 20, cachedInputTokenCount: 4, reasoningTokenCount: 3 }, usageReported: true } });
  assert.equal(result.model, 'project-coding-model');
  assert.deepEqual(result.usageCoverage, { reportedCalls: 2, unreportedCalls: 1 });
  assert.deepEqual(result.usage, { promptTokenCount: 24, candidatesTokenCount: 16, totalTokenCount: 40, cachedInputTokenCount: 8, reasoningTokenCount: 6 });
});

test('coding uses OpenAI JSON decisions and records exact usage evidence without applying source', async () => {
  const repository = { snapshot: async () => ({ files: [] }), readFile: async () => assert.fail('No file read expected'), info: async () => ({ branch: 'main' }) };
  const result = await executeCodingTask({ task: 'Review the empty repository', provider: 'openai', mode: 'review', maxAgents: 1 }, { repository, env, generate: (params, providerEnv, options) => generate(params, providerEnv, { ...options, fetch: async (_, init) => { const body = JSON.parse(init.body); assert.equal(body.model, env.OPENAI_MODEL); assert.deepEqual(body.text, { format: { type: 'json_object' } }); return json(completed('{"tool":"finish","arguments":{"output":"Repository is empty."}}', { usage })); } }) });
  assert.equal(result.status, 'completed');
  assert.equal(result.applied, false);
  assert.equal(result.inferenceCalls, 1);
  assert.deepEqual(result.usageCoverage, { reportedCalls: 1, unreportedCalls: 0 });
  assert.equal(result.events.find(event => event.type === 'model_completed').usageReported, true);
  assert.equal(result.usage.reasoningTokenCount, 3);
  assert.equal(result.usage.totalTokenCount, 20);
});

test('legacy provider missing usage is recorded as missing rather than initialized zero evidence', async () => {
  const result = await executeCodingTask({ task: 'Review the repository', provider: 'local', maxAgents: 1 }, { repository: { snapshot: async () => [], readFile: async () => '' }, generate: async () => ({ text: '{"tool":"finish","arguments":{"output":"Reviewed."}}' }) });
  assert.deepEqual(result.usageCoverage, { reportedCalls: 0, unreportedCalls: 1 });
  assert.equal(result.events.find(event => event.type === 'model_completed').usageReported, false);
});
