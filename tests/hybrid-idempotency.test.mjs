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
import { handleApi } from '../server/api.mjs';
import { createCompanionServer } from '../server/companion.mjs';
import { createLocalServices } from '../server/local-service.mjs';

const exec = promisify(execFile);
function sign(secret, method, pathname, body, requestKey) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = randomBytes(16).toString('base64url');
  const canonical = `${timestamp}\n${nonce}\n${method}\n${pathname}\n${createHash('sha256').update(body).digest('hex')}${requestKey === undefined ? '' : `\n${requestKey}`}`;
  return { 'X-EA-Timestamp': timestamp, 'X-EA-Nonce': nonce, 'X-EA-Signature': createHmac('sha256', Buffer.from(secret, 'base64url')).update(canonical).digest('base64url'), ...(requestKey === undefined ? {} : { 'Idempotency-Key': requestKey }) };
}
async function rawRequest(origin, pathname, { method = 'POST', body = Buffer.from('{ "task": "Review café 🦘" }\n'), headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(`${origin}${pathname}`, { method, headers: { ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}), ...headers } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.once('error', reject);
      response.once('end', () => resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    request.once('error', reject);
    request.end(method === 'POST' ? body : undefined);
  });
}
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easy-agent-hybrid-key-test-'));
  const companions = [];
  const secret = randomBytes(32).toString('base64url');
  const env = { FORGE_COMPANION_SECRET: secret, FORGE_WORKSPACE: path.join(root, 'repository'), FORGE_STATE_DIR: path.join(root, 'private-state'), HOME: root };
  let release = () => {};
  t.after(async () => {
    release();
    for (const companion of companions) await companion.stop();
    await fs.rm(root, { recursive: true, force: true });
  });
  async function open(services) {
    const companion = await createCompanionServer({ env, appRoot: root, services });
    companions.push(companion);
    await new Promise((resolve, reject) => { companion.server.once('error', reject); companion.server.listen(0, '127.0.0.1', resolve); });
    const origin = `http://127.0.0.1:${companion.server.address().port}`;
    const cloudEnv = { FORGE_COMPANION_URL: origin, FORGE_COMPANION_SECRET: secret };
    const api = (pathname, input, requestKey) => handleApi(new Request(`https://hosted.example${pathname}`, {
      method: input === undefined ? 'GET' : 'POST',
      headers: { ...(input === undefined ? {} : { 'Content-Type': 'application/json', Origin: 'https://hosted.example' }), ...(requestKey === undefined ? {} : { 'Idempotency-Key': requestKey }) },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    }), cloudEnv, { runtime: 'cloud', bridgeOptions: { allowLocal: true } });
    return { ...companion, origin, api };
  }
  return { root, secret, env, open, onCleanup: callback => { release = callback; } };
}

test('raw signed HTTP authenticates coding retry identifiers and rejects added, removed, changed, malformed or misrouted headers before services', async t => {
  const f = await fixture(t);
  const calls = [];
  const peer = await f.open({ route: async (endpoint, input, request) => {
    calls.push({ endpoint, input, headers: new Headers(request.headers) });
    return { statusCode: 202, data: { requestKey: request.headers.get('Idempotency-Key') } };
  }, stop: async () => {} });
  const pathname = '/api/coding/start';
  const body = Buffer.from('{ "task": "Review café 🦘" }\n');
  const signed = sign(f.secret, 'POST', pathname, body, 'raw-retry-1');
  const removed = { ...signed }; delete removed['Idempotency-Key'];
  for (const headers of [removed, { ...signed, 'Idempotency-Key': 'raw-retry-2' }, { ...sign(f.secret, 'POST', pathname, body), 'Idempotency-Key': 'added-key' }]) {
    assert.equal((await rawRequest(peer.origin, pathname, { body, headers })).status, 401);
  }
  assert.equal(calls.length, 0);
  const valid = await rawRequest(peer.origin, pathname, { body, headers: { ...signed, Cookie: 'must-not-forward', Authorization: 'Bearer must-not-forward', 'X-Arbitrary-Header': 'must-not-forward' } });
  assert.equal(valid.status, 202);
  assert.deepEqual(valid.body, { requestKey: 'raw-retry-1' });
  assert.deepEqual(calls[0].input, { task: 'Review café 🦘' });
  for (const name of ['cookie', 'authorization', 'x-arbitrary-header', 'x-ea-signature']) assert.equal(calls[0].headers.get(name), null);
  assert.equal(calls[0].headers.get('Idempotency-Key'), 'raw-retry-1');
  const legacy = await rawRequest(peer.origin, pathname, { body, headers: sign(f.secret, 'POST', pathname, body) });
  assert.equal(legacy.status, 202);
  assert.deepEqual(legacy.body, { requestKey: null });
  for (const requestKey of ['', 'a'.repeat(101), 'invalid_key', 'invalid key', ['one', 'two']]) {
    assert.equal((await rawRequest(peer.origin, pathname, { body, headers: sign(f.secret, 'POST', pathname, body, requestKey) })).status, 401);
  }
  for (const [method, otherPath] of [['GET', '/health'], ['GET', '/api/repository/status'], ['POST', '/api/repository/read']]) {
    assert.equal((await rawRequest(peer.origin, otherPath, { method, body, headers: sign(f.secret, method, otherPath, method === 'GET' ? '' : body, 'unsupported-key') })).status, 401);
  }
  assert.equal(calls.length, 2);
});

test('cloud-to-companion coding admission deduplicates concurrent retries and preserves the same durable run after restart', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  await fs.mkdir(f.env.FORGE_WORKSPACE);
  const source = 'export const value = 1;\n';
  await fs.writeFile(path.join(f.env.FORGE_WORKSPACE, 'value.mjs'), source);
  const gitEnv = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  await exec('git', ['init', '-q', '-b', 'main'], { cwd: f.env.FORGE_WORKSPACE, env: gitEnv });
  let inferenceCalls = 0;
  const entered = Promise.withResolvers();
  const finish = Promise.withResolvers();
  f.onCleanup(() => finish.resolve());
  const runner = { status: async () => ({ available: true, runtime: 'controlled-test-double' }), run: async () => assert.fail('This plan-only test must never execute source code') };
  const generate = async () => {
    inferenceCalls++;
    entered.resolve();
    await finish.promise;
    return { text: JSON.stringify({ tool: 'finish', arguments: { output: 'This controlled provider double completed the requested plan.' } }), usage: { promptTokenCount: 5, candidatesTokenCount: 3, totalTokenCount: 8 } };
  };
  const services = await createLocalServices({ env: f.env, appRoot: f.root, generate, runner });
  const peer = await f.open(services);
  const input = { task: 'Plan a small improvement to the implementation', provider: 'local', mode: 'plan', maxSteps: 1 };
  const responses = await Promise.all([peer.api('/api/coding/start', input, 'durable-hybrid-retry'), peer.api('/api/coding/start', input, 'durable-hybrid-retry')]);
  assert.ok(responses.every(response => response.status === 202));
  const admissions = await Promise.all(responses.map(response => response.json()));
  assert.equal(admissions[0].id, admissions[1].id);
  await entered.promise;
  assert.equal(inferenceCalls, 1);
  const conflict = await peer.api('/api/coding/start', { ...input, task: 'Plan a different task' }, 'durable-hybrid-retry');
  assert.equal(conflict.status, 409);
  finish.resolve();
  let record;
  const deadline = Date.now() + 5000;
  do {
    const response = await peer.api(`/api/coding/runs/${admissions[0].id}`);
    assert.equal(response.status, 200);
    record = await response.json();
    if (!['queued', 'running'].includes(record.status)) break;
    assert.ok(Date.now() < deadline, 'Controlled inference should settle promptly');
    await delay(10);
  } while (true);
  assert.equal(record.status, 'completed');
  assert.equal(record.requestKey, 'durable-hybrid-retry');
  assert.equal((await services.store.list()).length, 1);
  assert.equal(await fs.readFile(path.join(f.env.FORGE_WORKSPACE, 'value.mjs'), 'utf8'), source);
  await peer.stop();
  const restartedServices = await createLocalServices({ env: f.env, appRoot: f.root, generate: async () => assert.fail('A durable retry must not invoke inference again'), runner });
  const restarted = await f.open(restartedServices);
  const retry = await restarted.api('/api/coding/start', input, 'durable-hybrid-retry');
  assert.equal(retry.status, 202);
  assert.deepEqual(await retry.json(), { id: admissions[0].id, status: 'completed' });
  assert.equal((await restarted.api('/api/coding/start', { ...input, task: 'Plan a different task' }, 'durable-hybrid-retry')).status, 409);
  assert.equal((await restartedServices.store.list()).length, 1);
  assert.equal(inferenceCalls, 1);
});
