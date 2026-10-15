import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { handleApi, json } from '../server/api.mjs';
import { createLocalServices } from '../server/local-service.mjs';
import { createRunStore } from '../server/run-store.mjs';
import { createCompanionServer } from '../server/companion.mjs';

const nativeFetch = globalThis.fetch.bind(globalThis);
const deviceKey = 'sk-proj-FAKE_DEVICE_KEY_FOR_INTEGRATION_TESTS_0123456789';
const hostedKey = 'sk-proj-FAKE_HOSTED_KEY_FOR_INTEGRATION_TESTS_0123456789';
const bridgeSecret = Buffer.alloc(32, 61).toString('base64url');
const noFetch = async () => assert.fail('Unconfigured providers must not make outbound requests');
const request = (pathname, { origin = 'https://hosted.example', method = 'GET', body, headers = {} } = {}) => new Request(origin + pathname, { method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
const modelIds = output => output.models.map(model => typeof model === 'string' ? model : model.id);

async function fixture(t, { device = deviceKey, hosted, records = [] } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-openai-integration-'));
  const workspace = path.join(root, 'repository');
  const state = path.join(root, 'private-state');
  await fs.mkdir(workspace);
  await fs.writeFile(path.join(workspace, 'main.mjs'), 'export const value = 1;\n');
  const store = createRunStore(state);
  for (const record of records) await store.save(record);
  const providerCalls = [], bridgeCalls = [];
  let companionOrigin;
  const providerFetch = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin === companionOrigin) { bridgeCalls.push({ url: url.href, init }); return nativeFetch(input, init); }
    if (url.href === 'http://127.0.0.1:11434/api/tags') return new Response(JSON.stringify({ models: [{ name: 'fixture-local-coder' }] }), { headers: { 'Content-Type': 'application/json' } });
    assert.equal(url.href, 'https://api.openai.com/v1/models');
    assert.equal(init.method || 'GET', 'GET');
    const authorization = new Headers(init.headers).get('authorization');
    assert.ok([`Bearer ${deviceKey}`, `Bearer ${hostedKey}`].includes(authorization));
    providerCalls.push({ url: url.href, authorization });
    const id = authorization === `Bearer ${deviceKey}` ? 'device-coder-model' : 'hosted-coder-model';
    return new Response(JSON.stringify({ object: 'list', data: [{ id, object: 'model', created: 1720000000, owned_by: 'fixture-provider' }] }), { headers: { 'Content-Type': 'application/json' } });
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = providerFetch;
  let services, companion;
  t.after(async () => {
    try { await companion?.stop(); await services?.stop(); }
    finally { globalThis.fetch = originalFetch; await fs.rm(root, { recursive: true, force: true }); }
  });
  const peerEnv = Object.freeze({ FORGE_WORKSPACE: workspace, FORGE_STATE_DIR: state, FORGE_COMPANION_SECRET: bridgeSecret, HOME: root, ...(device ? { OPENAI_API_KEY: device } : {}) });
  const runner = { status: async () => ({ available: true, runtime: 'fake-isolated' }), run: async () => assert.fail('Model discovery and usage reporting must not execute candidate code') };
  services = await createLocalServices({ env: peerEnv, appRoot: root, store, runner });
  companion = await createCompanionServer({ env: peerEnv, appRoot: root, services });
  await new Promise((resolve, reject) => { companion.server.once('error', reject); companion.server.listen(0, '127.0.0.1', resolve); });
  companionOrigin = `http://127.0.0.1:${companion.server.address().port}`;
  const cloudEnv = Object.freeze({ FORGE_COMPANION_URL: companionOrigin, FORGE_COMPANION_SECRET: bridgeSecret, ...(hosted ? { OPENAI_API_KEY: hosted } : {}) });
  const cloudOptions = { runtime: 'cloud', bridgeOptions: { allowLocal: true }, fetch: providerFetch };
  const localOptions = { runtime: 'local', fetch: providerFetch, providerHealth: services.health, localHandler: async (endpoint, input, incoming) => { const result = await services.route(endpoint, input, incoming); return json(result.data, result.statusCode || 200); } };
  return { root, store, services, peerEnv, cloudEnv, cloudOptions, localOptions, providerCalls, bridgeCalls, cloud: incoming => handleApi(incoming, cloudEnv, cloudOptions), local: incoming => handleApi(incoming, peerEnv, localOptions) };
}

function usageFixtures() {
  const common = { task: 'PRIVATE_TASK_DO_NOT_RETURN', output: 'PRIVATE_OUTPUT_DO_NOT_RETURN', apiKey: deviceKey, events: [], proposals: [] };
  return [
    { ...common, id: randomUUID(), provider: 'openai', model: 'device-coder-model', status: 'completed', createdAt: '2026-10-10T10:00:00.000Z', inferenceCalls: 2, usage: { promptTokenCount: 120, candidatesTokenCount: 40, totalTokenCount: 160, cachedInputTokenCount: 30, reasoningTokenCount: 5 }, usageCoverage: { reportedCalls: 2, unreportedCalls: 0 } },
    { ...common, id: randomUUID(), provider: 'openai', model: 'device-coder-model', status: 'failed', createdAt: '2026-10-11T10:00:00.000Z', inferenceCalls: 2, usage: { promptTokenCount: 50, candidatesTokenCount: 8, totalTokenCount: 58 }, usageCoverage: { reportedCalls: 1, unreportedCalls: 1 }, error: { message: `PRIVATE_ERROR ${deviceKey}` } },
    { ...common, id: randomUUID(), provider: 'openai', model: 'device-coder-model', status: 'failed', createdAt: '2026-10-12T10:00:00.000Z', inferenceCalls: 1, usage: { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 }, usageCoverage: { reportedCalls: 0, unreportedCalls: 1 } },
    { ...common, id: randomUUID(), provider: 'local', model: 'fixture-local-coder', status: 'completed', createdAt: '2026-10-13T10:00:00.000Z', inferenceCalls: 1, usage: { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 }, usageCoverage: { reportedCalls: 1, unreportedCalls: 0 } },
  ];
}

test('a PC-only key verifies workspace models over actual signed HTTP without configuring hosted model discovery', async t => {
  const f = await fixture(t);
  const hosted = await f.cloud(request('/api/provider/models/hosted'));
  assert.equal(hosted.status, 200);
  const hostedModels = (await hosted.json()).openai;
  assert.equal(hostedModels.configured, false);
  assert.equal(hostedModels.verified, false);
  assert.deepEqual(hostedModels.models, []);
  assert.equal(f.providerCalls.length, 0);
  assert.equal(f.bridgeCalls.length, 0);
  const workspace = await f.cloud(request('/api/provider/models'));
  assert.equal(workspace.status, 200);
  const workspaceModels = (await workspace.json()).openai;
  assert.equal(workspaceModels.configured, true);
  assert.equal(workspaceModels.verified, true);
  assert.deepEqual(modelIds(workspaceModels), ['device-coder-model']);
  assert.equal(f.providerCalls.length, 1);
  assert.equal(f.providerCalls[0].authorization, `Bearer ${deviceKey}`);
  assert.equal(f.bridgeCalls.length, 1);
  assert.ok(new Headers(f.bridgeCalls[0].init.headers).has('x-ea-signature'));
  assert.equal(f.cloudEnv.OPENAI_API_KEY, undefined);
  assert.equal(f.peerEnv.OPENAI_API_KEY, deviceKey);
  assert.ok(!JSON.stringify(workspaceModels).includes(deviceKey));
  const status = await (await f.cloud(request('/api/status'))).json();
  assert.equal(status.providers.openai.configured, true);
  assert.equal(status.quickTaskProviders.openai.configured, false);
});

test('separately configured hosted and companion catalogs use only their own fake credentials', async t => {
  const f = await fixture(t, { hosted: hostedKey });
  const hosted = (await (await f.cloud(request('/api/provider/models/hosted'))).json()).openai;
  const peer = (await (await f.cloud(request('/api/provider/models'))).json()).openai;
  assert.deepEqual(modelIds(hosted), ['hosted-coder-model']);
  assert.deepEqual(modelIds(peer), ['device-coder-model']);
  assert.deepEqual(f.providerCalls.map(call => call.authorization), [`Bearer ${hostedKey}`, `Bearer ${deviceKey}`]);
  assert.equal(f.bridgeCalls.length, 1);
  const status = await (await f.cloud(request('/api/status'))).json();
  assert.equal(status.runtime, 'hybrid');
  assert.equal(status.providers.openai.configured, true);
  assert.equal(status.quickTaskProviders.openai.configured, true);
  assert.doesNotMatch(JSON.stringify({ hosted, peer, status }), /sk-proj-FAKE_|OPENAI_API_KEY=/);
});

test('keyless local and hybrid catalogs and hosted quick tasks fail closed without contacting OpenAI', async t => {
  const f = await fixture(t, { device: null });
  for (const invoke of [() => f.local(request('/api/provider/models', { origin: 'http://127.0.0.1:3000' })), () => f.cloud(request('/api/provider/models')), () => f.cloud(request('/api/provider/models/hosted'))]) {
    const response = await invoke();
    assert.equal(response.status, 200);
    const provider = (await response.json()).openai;
    assert.equal(provider.configured, false);
    assert.equal(provider.verified, false);
    assert.deepEqual(provider.models, []);
  }
  const quickTask = await f.cloud(request('/api/run', { method: 'POST', body: { task: 'Plan a source review', provider: 'openai', model: 'device-coder-model', mode: 'plan', maxAgents: 1 }, headers: { Origin: 'https://hosted.example' } }));
  assert.equal(quickTask.status, 503);
  const failure = await quickTask.json();
  assert.equal(failure.status, undefined);
  assert.ok(/NOT_CONFIGURED|KEY_REQUIRED/.test(failure.error));
  assert.equal(f.providerCalls.length, 0);
});

test('local and signed hybrid usage summarize actual persisted successful and partial failed runs without prompts or credentials', async t => {
  const records = usageFixtures();
  const f = await fixture(t, { records });
  assert.equal((await createRunStore(path.join(f.root, 'private-state')).list()).length, 4);
  const localResponse = await f.local(request('/api/usage', { origin: 'http://127.0.0.1:3000' }));
  const hybridResponse = await f.cloud(request('/api/usage'));
  assert.equal(localResponse.status, 200);
  assert.equal(hybridResponse.status, 200);
  const local = await localResponse.json(), hybrid = await hybridResponse.json();
  assert.equal(local.runtime, 'local');
  assert.equal(hybrid.runtime, 'hybrid');
  for (const summary of [local.repository, hybrid.repository]) {
    assert.equal(summary.scope, 'repository');
    assert.equal(summary.window.records, 4);
    assert.equal(summary.runs.total, 4);
    assert.equal(summary.runs.completed, 2);
    assert.equal(summary.runs.failed, 2);
    assert.equal(summary.runs.withUsage, 3);
    assert.equal(summary.runs.withoutUsage, 1);
    assert.equal(summary.runs.zeroUsage, 1);
    assert.equal(summary.calls.reported, 6);
    assert.equal(summary.calls.completedWithUsage, 4);
    assert.equal(summary.calls.completedWithoutUsage, 2);
    assert.deepEqual(summary.tokens, { promptTokenCount: 170, candidatesTokenCount: 48, totalTokenCount: 218, cachedInputTokenCount: 30, reasoningTokenCount: 5 });
    const partial = summary.recent.find(record => record.id === records[1].id);
    assert.equal(partial.status, 'failed');
    assert.equal(partial.usage.totalTokenCount, 58);
    assert.deepEqual(partial.usageCoverage, { reportedCalls: 1, unreportedCalls: 1 });
    assert.equal(summary.recent.find(record => record.id === records[2].id).usageStatus, 'missing');
    assert.equal(summary.recent.find(record => record.id === records[3].id).usageStatus, 'zero');
    assert.doesNotMatch(JSON.stringify(summary), /PRIVATE_TASK|PRIVATE_OUTPUT|PRIVATE_ERROR|sk-proj-FAKE_|apiKey/);
    for (const unsupported of ['costUsd', 'balance', 'remainingCredits', 'subscriptionAllowance', 'invoiceTotal']) assert.equal(summary[unsupported], undefined);
  }
  assert.deepEqual(hybrid.repository.tokens, local.repository.tokens);
  assert.equal(f.providerCalls.length, 0);
});

test('catalog and usage method guards reject unsupported verbs before discovery, signing, or store mutation', async t => {
  const f = await fixture(t, { records: usageFixtures() });
  for (const invoke of [(pathname, method) => f.local(request(pathname, { method, ...(method === 'POST' ? { body: {} } : {}), origin: 'http://127.0.0.1:3000' })), (pathname, method) => f.cloud(request(pathname, { method, ...(method === 'POST' ? { body: {} } : {}) }))]) {
    for (const pathname of ['/api/usage', '/api/provider/models', '/api/provider/models/hosted']) for (const method of ['HEAD', 'POST', 'PUT', 'DELETE']) {
      const response = await invoke(pathname, method);
      assert.ok([404, 405].includes(response.status), `${method} ${pathname} returned ${response.status}`);
    }
  }
  assert.equal(f.providerCalls.length, 0);
  assert.equal(f.bridgeCalls.length, 0);
  assert.equal((await f.store.list()).length, 4);
  const crossOrigin = await f.cloud(request('/api/provider/models', { method: 'POST', body: {}, headers: { Origin: 'https://attacker.example' } }));
  assert.equal(crossOrigin.status, 403);
});

test('unconfigured cloud usage reports its scope without inventing saved records or billing data', async () => {
  const response = await handleApi(request('/api/usage'), {}, { runtime: 'cloud', fetch: noFetch });
  assert.equal(response.status, 200);
  const output = await response.json();
  assert.equal(output.runtime, 'cloud');
  assert.equal(output.repository, null);
  assert.equal(output.balance, undefined);
  assert.ok(output.reason.includes('companion'));
});
