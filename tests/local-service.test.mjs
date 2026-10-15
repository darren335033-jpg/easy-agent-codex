import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { createLocalServices } from '../server/local-service.mjs';
import { createRunStore } from '../server/run-store.mjs';
import { handleApi, json } from '../server/api.mjs';
import { generate } from '../server/providers.mjs';
import { sourceFileAllowed, sourceDirectoryAllowed } from '../scripts/source-files.mjs';

const exec = promisify(execFile);
const before = 'export const add = (a,b) => a-b;\n';
const after = 'export const add = (a,b) => a+b;\n';
const input = { task: 'Correct addition and verify it', provider: 'local', model: 'scripted-model', maxAgents: 3, maxSteps: 8 };
const decision = (tool, args = {}) => ({ tool, arguments: args });
const script = () => [decision('read_file', { path: 'add.mjs' }), decision('propose_changes', { changes: [{ path: 'add.mjs', content: after, reason: 'Add instead of subtract' }] }), decision('run_tests', { command: 'node:test' }), decision('finish', { output: 'Prepared and verified the proposed addition fix.' })];
const request = (endpoint, method = 'POST', headers = {}) => new Request(`http://127.0.0.1:3000${endpoint}`, { method, headers });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function scriptedProvider(actions = script()) {
  const calls = [];
  const generate = async (parameters, env, options) => {
    const index = calls.length;
    calls.push({ parameters, env, options });
    assert.ok(index < actions.length, 'Only scripted fake inference is allowed');
    const action = actions[index];
    const result = typeof action === 'function' ? await action(parameters, env, options) : action;
    return { text: typeof result === 'string' ? result : JSON.stringify(result), usage: { promptTokenCount: 7, candidatesTokenCount: 3, totalTokenCount: 10 } };
  };
  return { generate, calls };
}

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-local-service-test-'));
  const workspace = path.join(root, 'workspace');
  const state = path.join(root, 'private-state');
  await fs.mkdir(workspace);
  const git = async (...args) => (await exec('git', args, { cwd: workspace, env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } })).stdout;
  await git('init', '-q', '-b', 'main');
  await git('config', 'user.name', 'Local Service Test');
  await git('config', 'user.email', 'test@example.invalid');
  await fs.writeFile(path.join(workspace, 'add.mjs'), before);
  await fs.writeFile(path.join(workspace, 'add.test.mjs'), "import assert from 'node:assert/strict';\nimport {add} from './add.mjs';\nassert.equal(add(2,3),5);\n");
  await fs.writeFile(path.join(workspace, '.env'), 'PRIVATE_REPOSITORY_TOKEN=keep-private\n');
  await git('add', '--', 'add.mjs', 'add.test.mjs');
  await git('commit', '-q', '-m', 'Initial implementation');
  const diskStore = createRunStore(state);
  const persisted = [];
  const store = { ...diskStore,
    save: async record => { const result = await diskStore.save(record); persisted.push({ status: result.status, eventCount: result.events?.length || 0 }); return result; },
    update: async (...args) => { const result = await diskStore.update(...args); persisted.push({ status: result.status, eventCount: result.events?.length || 0 }); return result; },
  };
  const provider = options.provider || scriptedProvider();
  const runs = [];
  const runner = options.runner || { status: async () => ({ available: true, runtime: 'fake-isolated' }), run: async parameters => {
    runs.push(parameters);
    assert.equal(parameters.command, 'node:test');
    assert.equal(parameters.files.find(file => file.path === 'add.mjs').content, after);
    assert.ok(!parameters.files.some(file => file.path === '.env'));
    return { status: 'passed', exitCode: 0, stdout: 'Scripted isolated test result', stderr: '', durationMs: 1 };
  } };
  const env = { FORGE_WORKSPACE: workspace, FORGE_STATE_DIR: state, GOOGLE_ACCESS_TOKEN: 'PRIVATE_SERVER_TOKEN', ...(options.env || {}) };
  let services;
  t.after(async () => { await services?.stop(); await fs.rm(root, { recursive: true, force: true }); });
  services = await createLocalServices({ env, appRoot: root, store, runner, generate: provider.generate, tokenProvider: options.tokenProvider });
  const localHandler = async (endpoint, body, incoming) => { const result = await services.route(endpoint, body, incoming); return json(result.data, result.statusCode || 200); };
  const api = incoming => handleApi(incoming, env, { runtime: 'local', localHandler });
  return { root, workspace, state, services, store: diskStore, persisted, provider, runner, runs, git, api };
}

async function settled(store, id) {
  const deadline = Date.now() + 5000;
  for (;;) {
    const record = await store.get(id);
    if (!['queued', 'running'].includes(record.status)) return record;
    assert.ok(Date.now() < deadline, 'A scripted run should settle promptly');
    await delay(5);
  }
}
const start = (services, task = input, headers = {}) => services.route('/api/coding/start', task, request('/api/coding/start', 'POST', headers));

test('real Git project run persists queued/running/completed trace and proposals, then writes only after explicit review', async t => {
  const f = await fixture(t);
  const initialHead = (await f.git('rev-parse', 'HEAD')).trim();
  const response = await start(f.services, { ...input, GOOGLE_ACCESS_TOKEN: 'UNTRUSTED_INPUT_TOKEN', apiKey: 'UNTRUSTED_INPUT_KEY' });
  assert.equal(response.statusCode, 202);
  assert.equal(response.data.status, 'queued');
  const result = await settled(f.store, response.data.id);
  assert.equal(result.status, 'completed');
  assert.equal(result.verification.status, 'passed');
  assert.equal(result.proposals[0].content, after);
  assert.equal(result.proposals[0].beforeContent, before);
  assert.deepEqual(result.appliedPaths, []);
  assert.equal(result.events.at(-1).type, 'task_finished');
  assert.ok(result.events.some(event => event.type === 'tool_completed' && event.tool === 'run_tests'));
  assert.deepEqual(result.usage, { promptTokenCount: 28, candidatesTokenCount: 12, totalTokenCount: 40 });
  assert.equal(result.repository.root, f.workspace);
  assert.equal(f.persisted[0].status, 'queued');
  assert.ok(f.persisted.some(item => item.status === 'running' && item.eventCount > 0));
  assert.equal(f.persisted.at(-1).status, 'completed');
  assert.equal(await fs.readFile(path.join(f.workspace, 'add.mjs'), 'utf8'), before);
  assert.equal((await f.git('rev-parse', 'HEAD')).trim(), initialHead);
  const raw = await fs.readFile(path.join(f.state, result.id + '.json'), 'utf8');
  assert.doesNotMatch(raw, /PRIVATE_SERVER_TOKEN|UNTRUSTED_INPUT_TOKEN|UNTRUSTED_INPUT_KEY|PRIVATE_REPOSITORY_TOKEN|keep-private/);
  const reloaded = await createRunStore(f.state).get(result.id);
  assert.deepEqual(reloaded.events, result.events);
  const apply = await f.services.route(`/api/coding/runs/${result.id}/apply`, { paths: ['add.mjs'] }, request(`/api/coding/runs/${result.id}/apply`));
  assert.deepEqual(apply.data.changedPaths, ['add.mjs']);
  assert.equal(await fs.readFile(path.join(f.workspace, 'add.mjs'), 'utf8'), after);
  assert.deepEqual(apply.data.run.appliedPaths, ['add.mjs']);
  assert.equal((await f.git('rev-parse', 'HEAD')).trim(), initialHead, 'Applying a proposal must not make a Git commit');
  await assert.rejects(f.services.route(`/api/coding/runs/${result.id}/apply`, { paths: ['add.mjs'] }, request(`/api/coding/runs/${result.id}/apply`)), error => error.status === 409);
});

test('stale repository hashes reject reviewed proposals and preserve the external editor change', async t => {
  const f = await fixture(t);
  const { data } = await start(f.services);
  const result = await settled(f.store, data.id);
  await fs.writeFile(path.join(f.workspace, 'add.mjs'), 'external editor change\n');
  await assert.rejects(f.services.route(`/api/coding/runs/${result.id}/apply`, { paths: ['add.mjs'] }, request(`/api/coding/runs/${result.id}/apply`)), error => error.code === 'FILE_CONFLICT');
  assert.equal(await fs.readFile(path.join(f.workspace, 'add.mjs'), 'utf8'), 'external editor change\n');
  assert.deepEqual((await f.store.get(result.id)).appliedPaths, []);
});

test('GET requests cannot start, cancel, apply, commit, branch, test, or mutate repository state', async t => {
  const f = await fixture(t);
  const { data } = await start(f.services);
  await settled(f.store, data.id);
  const paths = ['/api/coding/start', `/api/coding/runs/${data.id}/cancel`, `/api/coding/runs/${data.id}/apply`, '/api/repository/apply', '/api/repository/git/commit', '/api/repository/git/branch', '/api/repository/test', '/api/terminal'];
  for (const endpoint of paths) {
    await assert.rejects(f.services.route(endpoint, { task: input.task, paths: ['add.mjs'] }, request(endpoint, 'GET')), error => error.status === 405 && error.code === 'METHOD_NOT_ALLOWED');
    const response = await f.api(request(endpoint, 'GET'));
    assert.equal(response.status, 405);
  }
  const read = await f.api(request(`/api/coding/runs/${data.id}`, 'GET'));
  assert.equal(read.status, 200);
  assert.equal((await read.json()).id, data.id);
  assert.equal(await fs.readFile(path.join(f.workspace, 'add.mjs'), 'utf8'), before);
  assert.equal((await f.store.list()).length, 1);
});

test('cross-origin JSON API actions return 403 before local task admission or repository mutation', async t => {
  const f = await fixture(t);
  for (const headers of [{ origin: 'https://attacker.example' }, { 'sec-fetch-site': 'cross-site' }]) {
    const response = await f.api(new Request('http://127.0.0.1:3000/api/coding/start', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(input) }));
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error, 'ORIGIN_BLOCKED');
  }
  assert.equal(f.provider.calls.length, 0);
  assert.deepEqual(await f.store.list(), []);
  assert.equal(await fs.readFile(path.join(f.workspace, 'add.mjs'), 'utf8'), before);
});

test('simultaneous admissions allow only two active jobs and durable idempotency does not duplicate one', async t => {
  const entered = deferred();
  let active = 0;
  const provider = scriptedProvider([async (parameters, env, { signal }) => {
    active++;
    if (active === 2) entered.resolve();
    await new Promise((resolve, reject) => { if (signal.aborted) reject(signal.reason); else signal.addEventListener('abort', () => reject(signal.reason), { once: true }); });
  }, async (parameters, env, { signal }) => {
    active++;
    if (active === 2) entered.resolve();
    await new Promise((resolve, reject) => { if (signal.aborted) reject(signal.reason); else signal.addEventListener('abort', () => reject(signal.reason), { once: true }); });
  }]);
  const f = await fixture(t, { provider });
  const outcomes = await Promise.allSettled([start(f.services, input, { 'Idempotency-Key': 'local-one' }), start(f.services, input, { 'Idempotency-Key': 'local-two' }), start(f.services, input, { 'Idempotency-Key': 'local-three' })]);
  assert.equal(outcomes.filter(outcome => outcome.status === 'fulfilled').length, 2);
  const failure = outcomes.find(outcome => outcome.status === 'rejected').reason;
  assert.equal(failure.code, 'RUN_LIMIT');
  assert.equal(failure.status, 429);
  await entered.promise;
  const replay = await start(f.services, input, { 'Idempotency-Key': 'local-one' });
  assert.equal(replay.data.id, outcomes[0].value.data.id);
  assert.equal(provider.calls.length, 2);
  await assert.rejects(start(f.services, { ...input, task: 'A different task' }, { 'Idempotency-Key': 'local-one' }), error => error.status === 409);
  await f.services.stop();
  const records = await f.store.list();
  assert.equal(records.length, 2);
  assert.ok(records.every(record => record.status === 'cancelled'));
});

test('cancellation remains in progress until the isolated runner finishes cleanup and releases admission', async t => {
  const entered = deferred();
  const aborted = deferred();
  const cleanup = deferred();
  t.after(() => cleanup.resolve());
  let removed = false;
  const runner = { status: async () => ({ available: true }), run: async ({ signal }) => {
    entered.resolve();
    await new Promise(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', resolve, { once: true }); });
    aborted.resolve();
    await cleanup.promise;
    removed = true;
    throw new DOMException('The fake isolated container has been removed.', 'AbortError');
  } };
  const f = await fixture(t, { runner });
  const { data } = await start(f.services);
  await entered.promise;
  const cancelled = await f.services.route(`/api/coding/runs/${data.id}/cancel`, {}, request(`/api/coding/runs/${data.id}/cancel`));
  assert.equal(cancelled.data.status, 'cancelling');
  await aborted.promise;
  assert.equal(removed, false);
  assert.equal((await f.store.get(data.id)).status, 'running');
  let stopped = false;
  const stopping = f.services.stop().then(() => { stopped = true; });
  await delay(10);
  assert.equal(stopped, false);
  cleanup.resolve();
  await stopping;
  assert.equal(removed, true);
  const result = await f.store.get(data.id);
  assert.equal(result.status, 'cancelled');
  assert.equal(result.verification.status, 'not_run');
  assert.equal(result.tests.length, 0);
  assert.equal(result.proposals[0].content, after);
  assert.ok(result.events.some(event => event.type === 'task_cancelled' && event.tool === 'run_tests'));
  assert.equal(await fs.readFile(path.join(f.workspace, 'add.mjs'), 'utf8'), before);
});

test('repository and terminal tests share two sandbox slots and block coding admission until released', async t => {
  const entered = deferred();
  const releases = [deferred(), deferred()];
  t.after(() => releases.forEach(gate => gate.resolve()));
  const calls = [];
  const runner = { status: async () => ({ available: true }), run: async parameters => {
    const index = calls.length;
    calls.push(parameters);
    if (calls.length === 2) entered.resolve();
    if (index < 2) await releases[index].promise;
    return { status: 'passed', exitCode: 0, stdout: 'Scripted isolated run completed', stderr: '' };
  } };
  const f = await fixture(t, { runner });
  const manual = [
    f.services.route('/api/repository/test', { command: 'node:test' }, request('/api/repository/test')),
    f.services.route('/api/terminal', { command: 'npm test' }, request('/api/terminal')),
  ];
  await entered.promise;
  assert.deepEqual(new Set(calls.map(call => call.command)), new Set(['node:test', 'npm:test']));
  await assert.rejects(f.services.route('/api/terminal', { command: 'npm run build' }, request('/api/terminal')), error => error.status === 429);
  await assert.rejects(start(f.services), error => error.status === 429);
  assert.equal(calls.length, 2);
  assert.equal(f.provider.calls.length, 0);
  assert.deepEqual(await f.store.list(), []);
  releases.forEach(gate => gate.resolve());
  assert.ok((await Promise.all(manual)).every(result => result.data.status === 'passed'));
  const { data } = await start(f.services);
  assert.equal((await settled(f.store, data.id)).status, 'completed');
  assert.equal(calls.length, 3);
});

for (const kind of ['runner failure', 'cancellation']) {
  test(`manual sandbox capacity remains reserved through ${kind} cleanup and releases afterward`, async t => {
    const entered = deferred();
    const abortObserved = deferred();
    const cleanup = deferred();
    const otherFinished = deferred();
    t.after(() => { cleanup.resolve(); otherFinished.resolve(); });
    const controller = new AbortController();
    const failure = kind === 'cancellation' ? new DOMException('Fake container cleanup completed after abort.', 'AbortError') : new Error('Fake isolated runner failed after cleanup.');
    let calls = 0;
    let controlledRunStarted = false;
    let firstSettled = false;
    const runner = { status: async () => ({ available: true }), run: async ({ signal, command }) => {
      calls++;
      if (calls === 2) entered.resolve();
      if (command === 'node:test' && !controlledRunStarted) {
        controlledRunStarted = true;
        if (signal) signal.addEventListener('abort', () => abortObserved.resolve(), { once: true });
        await cleanup.promise;
        throw failure;
      }
      if (command === 'npm:test') await otherFinished.promise;
      return { status: 'passed', exitCode: 0, stdout: '', stderr: '' };
    } };
    const f = await fixture(t, { runner });
    const first = f.services.route('/api/repository/test', { command: 'node:test' }, new Request('http://127.0.0.1:3000/api/repository/test', { method: 'POST', signal: controller.signal })).then(value => { firstSettled = true; return { value }; }, error => { firstSettled = true; return { error }; });
    const second = f.services.route('/api/terminal', { command: 'npm test' }, request('/api/terminal'));
    await entered.promise;
    if (kind === 'cancellation') { controller.abort(); await abortObserved.promise; }
    assert.equal(firstSettled, false);
    await assert.rejects(f.services.route('/api/repository/test', { command: 'node:test' }, request('/api/repository/test')), error => error.status === 429);
    await assert.rejects(start(f.services), error => error.status === 429);
    cleanup.resolve();
    assert.equal((await first).error, failure);
    const next = await f.services.route('/api/repository/test', { command: 'node:test' }, request('/api/repository/test'));
    assert.equal(next.data.status, 'passed');
    assert.equal(calls, 3);
    otherFinished.resolve();
    assert.equal((await second).data.status, 'passed');
    assert.equal(await fs.readFile(path.join(f.workspace, 'add.mjs'), 'utf8'), before);
  });
}

test('Ollama receives native conversation history, JSON format and bounded configured context without cloud authorization', async () => {
  const history = [{ role: 'user', content: 'Inspect add.mjs' }, { role: 'assistant', content: '{"tool":"read_file","arguments":{"path":"add.mjs"}}' }, { role: 'user', content: 'Actual tool observation: source contents' }];
  for (const [context, expected] of [['16384', 16384], ['invalid', 8192], ['131073', 8192], ['1024', 8192]]) {
    let call;
    const result = await generate({ provider: 'local', model: 'test-model', system: 'Coding coordinator', prompt: 'Legacy fallback', responseFormat: 'json', messages: history }, { OLLAMA_CONTEXT_WINDOW: context, GOOGLE_ACCESS_TOKEN: 'PRIVATE_CLOUD_TOKEN' }, { runtime: 'local', fetch: async (url, init) => { call = { url, init }; return new Response(JSON.stringify({ message: { content: '{"output":"ready"}' }, prompt_eval_count: 11, eval_count: 5 })); } });
    assert.equal(String(call.url), 'http://127.0.0.1:11434/api/chat');
    assert.deepEqual(JSON.parse(call.init.body).messages, [{ role: 'system', content: 'Coding coordinator' }, ...history]);
    assert.equal(JSON.parse(call.init.body).format, 'json');
    assert.equal(JSON.parse(call.init.body).stream, false);
    assert.equal(JSON.parse(call.init.body).options.num_ctx, expected);
    assert.equal(call.init.redirect, 'manual');
    assert.doesNotMatch(JSON.stringify(call.init.headers), /PRIVATE_CLOUD_TOKEN|Authorization/i);
    assert.deepEqual(result.usage, { promptTokenCount: 11, candidatesTokenCount: 5, totalTokenCount: 16 });
  }
});

test('local Vertex coding tasks pass ADC through the actual provider adapter without saving tokens', async t => {
  let tokens = 0;
  let networkRequests = 0;
  const tokenProvider = async () => { tokens++; return 'EPHEMERAL_FAKE_ADC_TOKEN'; };
  const provider = { generate: (parameters, env, options) => generate(parameters, env, { ...options, fetch: async (url, init) => {
    networkRequests++;
    assert.equal(url, 'https://aiplatform.googleapis.com/mcp/generate');
    assert.equal(init.headers.Authorization, 'Bearer EPHEMERAL_FAKE_ADC_TOKEN');
    return new Response(JSON.stringify({ result: { structuredContent: { candidates: [{ content: { parts: [{ text: JSON.stringify(decision('finish', { output: 'Inspected the task; no changes proposed.' })) }] } }] } } }));
  } }) };
  const f = await fixture(t, { provider, tokenProvider, env: { GOOGLE_ACCESS_TOKEN: '', GOOGLE_CLOUD_PROJECT: 'fixture-project' } });
  const { data } = await start(f.services, { ...input, provider: 'vertex', model: 'fixture-cloud-model' });
  const result = await settled(f.store, data.id);
  assert.equal(result.status, 'completed');
  assert.equal(tokens, 1);
  assert.equal(networkRequests, 1);
  assert.equal(result.inferenceCalls, 1);
  assert.doesNotMatch(await fs.readFile(path.join(f.state, data.id + '.json'), 'utf8'), /EPHEMERAL_FAKE_ADC_TOKEN/);
});

test('source archive admits only approved brand assets and excludes all runtime job history paths', () => {
  for (const asset of ['assets/founder-portrait.jpg', 'assets/founder-brand-reference.jpg', 'assets/media-thumbnail.jpg', 'assets/mascot-studio.mp4']) assert.equal(sourceFileAllowed(asset), true, asset);
  for (const excluded of ['.forge/coding-runs/00000000-0000-0000-0000-000000000000.json', 'server/coding-runs/private-history.json', 'assets/private.jpg', 'assets/customer-upload.mp4', 'devkit/evaluation/results/run.json', 'private-state/running.json']) assert.equal(sourceFileAllowed(excluded), false, excluded);
  assert.equal(sourceDirectoryAllowed('.forge/coding-runs'), false);
});
