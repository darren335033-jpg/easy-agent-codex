import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { createCompanionVerifier, validateCompanionSecret } from '../server/bridge-auth.mjs';
import { createCompanionServer, companionRouteAllowed } from '../server/companion.mjs';
import { createLocalServices } from '../server/local-service.mjs';

const exec = promisify(execFile);
const freshSecret = () => randomBytes(32).toString('base64url');
const freshNonce = () => randomBytes(16).toString('base64url');
function signed(secret, { method = 'GET', pathname = '/api/repository/status', body = '', timestamp = Math.floor(Date.now() / 1000), nonce = freshNonce() } = {}) {
  const canonical = `${timestamp}\n${nonce}\n${method}\n${pathname}\n${createHash('sha256').update(body).digest('hex')}`;
  return { 'x-ea-timestamp': String(timestamp), 'x-ea-nonce': nonce, 'x-ea-signature': createHmac('sha256', Buffer.from(secret, 'base64url')).update(canonical).digest('base64url') };
}
const unauthorized = promise => assert.rejects(promise, error => error.status === 401 && error.code === 'COMPANION_UNAUTHORIZED');
async function temp(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easy-agent-companion-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
async function listener(t, { services, env = {}, appRoot } = {}) {
  const secret = env.FORGE_COMPANION_SECRET || freshSecret();
  const calls = [];
  let stops = 0;
  const fakeServices = { route: async (endpoint, input, request) => { calls.push({ endpoint, input, request }); return { data: { endpoint, input } }; }, health: async () => ({ local: { configured: true, model: 'test-installed-model' } }), cliStatus: async () => ({ github: { installed: true, authenticated: false }, google: { installed: false, authenticated: false }, huggingface: { installed: true, authenticated: false } }), cliRun: async input => ({ profile: input.profile, exitCode: 0, output: '[]', data: [] }), stop: async () => { stops++; } };
  const companion = await createCompanionServer({ env: { ...env, FORGE_COMPANION_SECRET: secret }, appRoot: appRoot || await temp(t), services: services || fakeServices });
  await new Promise(resolve => companion.server.listen(0, '127.0.0.1', resolve));
  t.after(() => companion.stop());
  const base = `http://127.0.0.1:${companion.server.address().port}`;
  async function send(pathname, { method = 'GET', input, body = input === undefined ? method === 'POST' ? '{}' : '' : JSON.stringify(input), headers = {}, ...signing } = {}) {
    return fetch(`${base}${pathname}`, { method, headers: { ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}), ...signed(secret, { method, pathname, body, ...signing }), ...headers }, ...(method === 'POST' ? { body } : {}) });
  }
  return { ...companion, base, send, secret, calls, stops: () => stops };
}

test('canonical HMAC protocol interoperates with independent Node crypto and exact Unicode request bytes', async () => {
  const secret = freshSecret();
  const verifier = createCompanionVerifier(secret);
  const body = Buffer.from('{ "task": "Fix café 🦘" }\n');
  const headers = signed(secret, { method: 'POST', pathname: '/api/coding/start', body });
  assert.equal(await verifier.verify({ method: 'POST', pathname: '/api/coding/start', headers: new Headers(headers), body }), true);
});

test('signature verification binds method, path, body, timestamp, nonce, and secret without claiming invalid nonces', async () => {
  const secret = freshSecret();
  const verifier = createCompanionVerifier(secret);
  const body = Buffer.from('{"path":"main.js"}');
  const headers = signed(secret, { method: 'POST', pathname: '/api/repository/read', body });
  for (const changes of [
    { method: 'GET' }, { pathname: '/api/repository/apply' }, { body: Buffer.from('{"path":".env"}') },
    { headers: { ...headers, 'x-ea-timestamp': String(Number(headers['x-ea-timestamp']) + 1) } },
    { headers: { ...headers, 'x-ea-nonce': freshNonce() } },
    { headers: signed(freshSecret(), { method: 'POST', pathname: '/api/repository/read', body, nonce: headers['x-ea-nonce'] }) },
  ]) await unauthorized(verifier.verify({ method: 'POST', pathname: '/api/repository/read', body, headers, ...changes }));
  assert.equal(await verifier.verify({ method: 'POST', pathname: '/api/repository/read', body, headers }), true);
});

test('malformed secrets, signatures, nonces, duplicate headers, and timestamps fail with safe errors', async () => {
  for (const value of [undefined, '', 'private-invalid-value', 'a'.repeat(43), `${freshSecret()}=`]) {
    assert.throws(() => validateCompanionSecret(value), error => {
      assert.equal(error.code, 'COMPANION_SECRET_REQUIRED');
      if (value) assert.ok(!error.message.includes(value));
      return true;
    });
  }
  const secret = freshSecret();
  const verifier = createCompanionVerifier(secret);
  const good = signed(secret);
  for (const headers of [
    {}, { ...good, 'x-ea-signature': 'a'.repeat(43) }, { ...good, 'x-ea-signature': `${good['x-ea-signature']}=` },
    { ...good, 'x-ea-nonce': 'a'.repeat(22) }, { ...good, 'x-ea-nonce': 'short' },
    { ...good, 'x-ea-timestamp': '01' }, { ...good, 'x-ea-timestamp': '1e9' },
    { ...good, 'x-ea-timestamp': [good['x-ea-timestamp'], good['x-ea-timestamp']] },
    { ...good, 'x-ea-signature': `${good['x-ea-signature']}, ${good['x-ea-signature']}` },
  ]) await unauthorized(verifier.verify({ method: 'GET', pathname: '/api/repository/status', headers }));
});

test('clock skew is limited to 60 seconds and nonce replay claims are atomic across concurrent verification', async () => {
  const secret = freshSecret();
  const now = 1_800_000_000_000;
  const verifier = createCompanionVerifier(secret, { now: () => now });
  for (const offset of [-61, 61]) await unauthorized(verifier.verify({ method: 'GET', pathname: '/api/repository/status', headers: signed(secret, { timestamp: now / 1000 + offset }) }));
  for (const offset of [-60, 60]) assert.equal(await verifier.verify({ method: 'GET', pathname: '/api/repository/status', headers: signed(secret, { timestamp: now / 1000 + offset }) }), true);
  const headers = signed(secret, { timestamp: now / 1000 });
  const results = await Promise.allSettled(Array.from({ length: 6 }, () => verifier.verify({ method: 'GET', pathname: '/api/repository/status', headers })));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.ok(results.filter(result => result.status === 'rejected').every(result => result.reason.code === 'COMPANION_REPLAY'));
});

test('replay cache refuses capacity instead of evicting protected nonces and expires entries after 120 seconds', async () => {
  const secret = freshSecret();
  let now = 1_800_000_000_000;
  const verifier = createCompanionVerifier(secret, { now: () => now, maxNonces: 2 });
  const headers = signed(secret, { timestamp: now / 1000 });
  await verifier.verify({ method: 'GET', pathname: '/api/repository/status', headers });
  await verifier.verify({ method: 'GET', pathname: '/api/repository/status', headers: signed(secret, { timestamp: now / 1000 }) });
  await assert.rejects(verifier.verify({ method: 'GET', pathname: '/api/repository/status', headers: signed(secret, { timestamp: now / 1000 }) }), error => error.code === 'COMPANION_BUSY');
  await assert.rejects(verifier.verify({ method: 'GET', pathname: '/api/repository/status', headers }), error => error.code === 'COMPANION_REPLAY');
  now += 121_000;
  assert.equal(await verifier.verify({ method: 'GET', pathname: '/api/repository/status', headers: signed(secret, { timestamp: now / 1000 }) }), true);
});

test('companion requires secret and valid port before initializing local services', async t => {
  const appRoot = await temp(t);
  for (const env of [{}, { FORGE_COMPANION_SECRET: 'invalid' }, ...[0, 80, 65536, 'bad'].map(COMPANION_PORT => ({ FORGE_COMPANION_SECRET: freshSecret(), COMPANION_PORT }))]) await assert.rejects(createCompanionServer({ env, appRoot }), error => error.status === 503);
  assert.deepEqual(await fs.readdir(appRoot), []);
});

test('unauthenticated health is generic; all repository and provider details require signatures', async t => {
  const f = await listener(t);
  const health = await fetch(`${f.base}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ready: true });
  assert.equal(health.headers.get('access-control-allow-origin'), null);
  for (const pathname of ['/api/status', '/api/repository/status', '/api/provider/models', '/api/coding/runs', '/api/companion/cli/status']) {
    const response = await fetch(`${f.base}${pathname}`);
    assert.equal(response.status, 401, pathname);
  }
  assert.equal(f.calls.length, 0);
});

test('signed requests route with exact JSON while browser cookies, authorization, and unrelated headers are stripped', async t => {
  const f = await listener(t, { env: { GOOGLE_ACCESS_TOKEN: 'server-only-provider-secret' } });
  const response = await f.send('/api/repository/read', { method: 'POST', input: { path: 'src/main.js' }, headers: { Cookie: 'session=browser-private', Authorization: 'Bearer browser-private', 'X-Provider-Key': 'browser-private' } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { endpoint: '/api/repository/read', input: { path: 'src/main.js' } });
  assert.equal(f.calls[0].request.headers.get('cookie'), null);
  assert.equal(f.calls[0].request.headers.get('authorization'), null);
  assert.equal(f.calls[0].request.headers.get('x-provider-key'), null);
  assert.equal(f.calls[0].request.headers.get('x-ea-signature'), null);
  assert.equal(f.calls[0].request.headers.get('content-type'), 'application/json');
});

test('signed status returns real service health and typed CLI hooks expose only the two authorized routes', async t => {
  const f = await listener(t);
  const status = await f.send('/api/status');
  assert.equal(status.status, 200);
  const value = await status.json();
  assert.equal(value.runtime, 'local');
  assert.equal(value.providers.local.model, 'test-installed-model');
  assert.equal(value.providers.local.configured, true);
  const cliStatus = await f.send('/api/companion/cli/status');
  assert.equal(cliStatus.status, 200);
  assert.equal((await cliStatus.json()).github.installed, true);
  const cli = await f.send('/api/integrations/cli/run', { method: 'POST', input: { profile: 'github.repos' } });
  assert.equal(cli.status, 200);
  assert.deepEqual((await cli.json()).data, []);
  assert.equal(f.calls.length, 0);
});

test('allowlist rejects arbitrary APIs, shell routes, OAuth, non-CLI integrations, queries, encoded aliases and wrong methods', async t => {
  const f = await listener(t);
  for (const pathname of ['/api/terminal', '/api/run', '/api/integrations/status', '/api/integrations/catalog', '/api/integrations/oauth/start', '/api/integrations/github/read', '/api/integrations/mcp/test', '/download/source.zip', '/api/repository/read?path=main.js', '/api/repository/%72ead']) {
    const response = await f.send(pathname, { method: 'POST' });
    assert.equal(response.status, 404, pathname);
  }
  assert.equal((await f.send('/api/repository/read')).status, 404);
  assert.equal((await f.send('/api/status', { method: 'POST' })).status, 404);
  assert.equal((await f.send('/api/coding/runs/bad-id')).status, 404);
  assert.equal(f.calls.length, 0);
  assert.equal(companionRouteAllowed('POST', '/api/terminal'), false);
  assert.equal(companionRouteAllowed('GET', '/api/coding/runs/10000000-0000-4000-8000-000000000000'), true);
  assert.equal(companionRouteAllowed('POST', '/api/coding/runs/10000000-0000-4000-8000-000000000000/apply'), true);
});

test('browser requests, bad JSON/content types, tampering, and replay fail before services run', async t => {
  const f = await listener(t);
  assert.equal((await f.send('/api/repository/read', { method: 'POST', headers: { Origin: 'https://browser.example' } })).status, 403);
  assert.equal((await f.send('/api/repository/read', { method: 'POST', headers: { 'Sec-Fetch-Site': 'same-origin' } })).status, 403);
  assert.equal((await f.send('/api/repository/read', { method: 'POST', headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await f.send('/api/repository/read', { method: 'POST', body: '{invalid' })).status, 400);
  const headers = signed(f.secret, { method: 'POST', pathname: '/api/repository/read', body: '{"path":"main.js"}' });
  const tampered = await fetch(`${f.base}/api/repository/read`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{"path":".env"}' });
  assert.equal(tampered.status, 401);
  assert.equal(f.calls.length, 0);
  const options = { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{"path":"main.js"}' };
  assert.equal((await fetch(`${f.base}/api/repository/read`, options)).status, 200);
  assert.equal((await fetch(`${f.base}/api/repository/read`, options)).status, 409);
  assert.equal(f.calls.length, 1);
});

test('oversized declared and chunked bodies are rejected without valid authentication or service execution', async t => {
  const f = await listener(t);
  const oversized = await fetch(`${f.base}/api/repository/read`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'x'.repeat(500_001) });
  assert.equal(oversized.status, 413);
  const chunked = await new Promise((resolve, reject) => {
    const request = http.request(`${f.base}/api/repository/read`, { method: 'POST', headers: { 'Content-Type': 'application/json' } }, response => {
      response.resume();
      response.once('end', () => resolve(response.statusCode));
    });
    request.on('error', reject);
    request.write('x'.repeat(250_000));
    request.end('y'.repeat(250_001));
  });
  assert.equal(chunked, 413);
  assert.equal(f.calls.length, 0);
});

test('stop closes the owned listener and cancels services exactly once', async t => {
  const f = await listener(t);
  await Promise.all([f.stop(), f.stop()]);
  assert.equal(f.stops(), 1);
  assert.equal(f.server.listening, false);
  await assert.rejects(fetch(`${f.base}/health`));
});

test('signed HTTP performs a real repository coding-review-apply-branch-commit flow without executing generated code on the host', async t => {
  const root = await temp(t);
  const workspace = path.join(root, 'project');
  await fs.mkdir(workspace);
  const before = 'export const add = (a,b) => a-b;\n';
  const after = 'export const add = (a,b) => a+b;\n';
  const gitEnv = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  const git = async (...args) => (await exec('git', args, { cwd: workspace, env: gitEnv })).stdout;
  await git('init', '-q', '-b', 'main');
  await git('config', 'user.name', 'Companion Test');
  await git('config', 'user.email', 'test@example.invalid');
  await fs.writeFile(path.join(workspace, 'add.mjs'), before);
  await fs.writeFile(path.join(workspace, '.env'), 'REPOSITORY_SECRET=never-forward');
  await git('add', '--', 'add.mjs');
  await git('commit', '-q', '-m', 'Initial');
  const decisions = [
    { tool: 'read_file', arguments: { path: 'add.mjs' } },
    { tool: 'propose_changes', arguments: { changes: [{ path: 'add.mjs', content: after, reason: 'Correct addition' }] } },
    { tool: 'run_tests', arguments: { command: 'node:test' } },
    { tool: 'finish', arguments: { output: 'Prepared the requested fix with a controlled test-double result.' } },
  ];
  let modelCalls = 0;
  let evaluations = 0;
  const env = { FORGE_COMPANION_SECRET: freshSecret(), FORGE_WORKSPACE: workspace, FORGE_STATE_DIR: path.join(root, 'state'), GOOGLE_ACCESS_TOKEN: 'SERVER_ONLY_CREDENTIAL' };
  const services = await createLocalServices({ env, appRoot: root, generate: async (_parameters, providerEnv) => {
    assert.equal(providerEnv.GOOGLE_ACCESS_TOKEN, 'SERVER_ONLY_CREDENTIAL');
    assert.ok(modelCalls < decisions.length);
    return { text: JSON.stringify(decisions[modelCalls++]), usage: {} };
  }, runner: { status: async () => ({ available: true, runtime: 'controlled-test-double' }), run: async ({ files, command }) => {
    evaluations++;
    assert.equal(command, 'node:test');
    assert.equal(files.find(file => file.path === 'add.mjs').content, after);
    assert.ok(!files.some(file => file.path === '.env'));
    return { status: 'passed', exitCode: 0, output: 'Controlled runner double; no source was executed.' };
  } } });
  const f = await listener(t, { services, env, appRoot: root });
  const tree = await f.send('/api/repository/tree', { method: 'POST' });
  assert.deepEqual((await tree.json()).files.map(file => file.path), ['add.mjs']);
  const start = await f.send('/api/coding/start', { method: 'POST', input: { task: 'Correct addition using the smallest change', provider: 'local', maxAgents: 2, maxSteps: 6, GOOGLE_ACCESS_TOKEN: 'BROWSER_ATTEMPTED_CREDENTIAL' } });
  assert.equal(start.status, 202);
  const { id } = await start.json();
  let record;
  const deadline = Date.now() + 5000;
  do {
    record = await (await f.send(`/api/coding/runs/${id}`)).json();
    assert.ok(Date.now() < deadline);
    if (['queued', 'running'].includes(record.status)) await delay(5);
  } while (['queued', 'running'].includes(record.status));
  assert.equal(record.status, 'completed');
  assert.equal(record.verification.status, 'passed');
  assert.equal(evaluations, 1);
  assert.equal(modelCalls, 4);
  assert.doesNotMatch(JSON.stringify(record), /SERVER_ONLY_CREDENTIAL|BROWSER_ATTEMPTED_CREDENTIAL|never-forward/);
  assert.equal(await fs.readFile(path.join(workspace, 'add.mjs'), 'utf8'), before);
  const apply = await f.send(`/api/coding/runs/${id}/apply`, { method: 'POST', input: { paths: ['add.mjs'] } });
  assert.equal(apply.status, 200);
  assert.equal(await fs.readFile(path.join(workspace, 'add.mjs'), 'utf8'), after);
  const branch = await f.send('/api/repository/git/branch', { method: 'POST', input: { name: 'companion/addition-fix' } });
  assert.equal(branch.status, 200);
  const commit = await f.send('/api/repository/git/commit', { method: 'POST', input: { message: 'Correct addition through reviewed companion changes', paths: ['add.mjs'] } });
  assert.equal(commit.status, 200);
  const committed = await commit.json();
  assert.equal(committed.sha, (await git('rev-parse', 'HEAD')).trim());
  assert.equal(await git('show', 'HEAD:add.mjs'), after);
});
