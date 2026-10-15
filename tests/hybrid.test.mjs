import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { handleApi } from '../server/api.mjs';
import { createCompanionServer } from '../server/companion.mjs';
import { createRepositoryService } from '../server/repository.mjs';

const exec = promisify(execFile);
const noFetch = async () => assert.fail('This test must not contact an external provider or an unconfigured companion');
const secret = Buffer.alloc(32, 73).toString('base64url');
const nativeFetch = globalThis.fetch.bind(globalThis);
const request = (pathname, { method = 'GET', body, headers = {} } = {}) => new Request(`https://hosted.example${pathname}`, { method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}) });
const post = (pathname, body = {}, headers = {}) => request(pathname, { method: 'POST', body, headers: { Origin: 'https://hosted.example', ...headers } });

async function fixture(t, { cloud = {} } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-hybrid-test-'));
  const workspace = path.join(root, 'repository');
  await fs.mkdir(path.join(workspace, 'src'), { recursive: true });
  await fs.writeFile(path.join(workspace, 'src', '雪.mjs'), 'export const value = 1;\n');
  const git = async (...args) => (await exec('git', args, { cwd: workspace, env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } })).stdout;
  await git('init', '-q', '-b', 'main');
  await git('config', 'user.name', 'Hybrid Test');
  await git('config', 'user.email', 'test@example.invalid');
  await git('add', '--', 'src/雪.mjs');
  await git('commit', '-q', '-m', 'Initial source');
  const repository = createRepositoryService(workspace);
  const calls = [], cliCalls = [], outbound = [], mcpCalls = [];
  const health = async () => ({ local: { configured: true, reachable: true, models: ['peer-coder:latest'], model: 'peer-coder:latest', reason: 'Scripted local provider availability' } });
  const cliStatus = { github: { installed: true, authenticated: true, login: 'peer-github-user', version: '2.80.0' }, google: { installed: true, authenticated: false, version: '589.0.0' }, huggingface: { installed: true, authenticated: true, login: 'peer-hf-user', version: '2.2.0' } };
  const services = {
    health,
    cliStatus: async () => cliStatus,
    cliRun: async input => { cliCalls.push(input); return { profile: input.profile, command: 'gh repo list', exitCode: 0, output: '[{"nameWithOwner":"peer/project"}]', data: [{ nameWithOwner: 'peer/project' }] }; },
    route: async (endpoint, input, incoming) => {
      calls.push({ endpoint, input, headers: new Headers(incoming.headers) });
      if (endpoint === '/api/repository/status') return { data: { configured: true, runtime: 'local', repository: await repository.info(), models: await health(), sandbox: { available: true, runtime: 'runsc' } } };
      if (endpoint === '/api/provider/models') return { data: await health() };
      if (endpoint === '/api/repository/tree') return { data: await repository.tree() };
      if (endpoint === '/api/repository/read') return { data: await repository.readFile(input.path) };
      if (endpoint === '/api/repository/apply') return { data: await repository.applyChanges(input) };
      if (endpoint === '/api/repository/git/status') return { data: await repository.gitStatus() };
      if (endpoint === '/api/coding/runs') return { data: { runs: [] } };
      assert.fail(`Unexpected companion service route: ${endpoint}`);
    },
    stop: async () => {},
  };
  const peerEnv = { FORGE_COMPANION_SECRET: secret, GOOGLE_ACCESS_TOKEN: 'PRIVATE_PEER_VERTEX_TOKEN', GOOGLE_CLOUD_PROJECT: 'peer-project', VERTEX_MODEL: 'peer-vertex-model', GH_TOKEN: 'PRIVATE_PEER_GH_TOKEN', HOME: root };
  const companion = await createCompanionServer({ env: peerEnv, appRoot: root, services });
  await new Promise((resolve, reject) => { companion.server.once('error', reject); companion.server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => { await companion.stop(); await fs.rm(root, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${companion.server.address().port}`;
  const env = Object.freeze({ FORGE_COMPANION_URL: origin, FORGE_COMPANION_SECRET: secret, GOOGLE_ACCESS_TOKEN: 'PRIVATE_CLOUD_VERTEX_TOKEN', GOOGLE_CLOUD_PROJECT: 'cloud-project', VERTEX_MODEL: 'cloud-vertex-model', ...cloud });
  const fetch = async (url, init) => {
    outbound.push({ url, init });
    if (new URL(url).origin === origin) return nativeFetch(url, init);
    assert.equal(url, 'https://api.githubcopilot.com/mcp/');
    assert.equal(init.headers.authorization, `Bearer ${env.GITHUB_TOKEN || env.GH_TOKEN}`);
    assert.ok(!JSON.stringify(init.headers).includes('PRIVATE_PEER_GH_TOKEN'));
    mcpCalls.push({ url, init });
    return new Response('Private remote authentication diagnostic', { status: 401 });
  };
  const options = { runtime: 'cloud', bridgeOptions: { allowLocal: true }, fetch };
  const api = incoming => handleApi(incoming, env, options);
  return { root, workspace, repository, git, origin, env, options, api, calls, cliCalls, outbound, mcpCalls, cliStatus };
}

test('unset companion remains cloud-only, never makes outbound calls, and rejects browser configuration input', async () => {
  for (const incoming of [request('/api/hybrid/status'), post('/api/hybrid/test')]) {
    const response = await handleApi(incoming, {}, { runtime: 'cloud', fetch: noFetch });
    assert.equal(response.status, 200);
    const status = await response.json();
    assert.equal(status.mode, 'cloud-only');
    assert.equal(status.configured, false);
    assert.equal(status.connected, false);
    assert.equal(status.companion.endpointConfigured, false);
    assert.equal(status.companion.secretConfigured, false);
  }
  const invalid = await handleApi(post('/api/hybrid/test', { url: 'https://browser-selected.example', secret: 'browser-selected' }), {}, { fetch: noFetch });
  assert.equal(invalid.status, 400);
  const repository = await handleApi(request('/api/repository/status'), {}, { fetch: noFetch });
  assert.deepEqual({ configured: (await repository.json()).configured, status: repository.status }, { configured: false, status: 200 });
  const cli = await handleApi(post('/api/integrations/cli/run', { profile: 'github.repos' }), {}, { fetch: noFetch });
  assert.equal(cli.status, 503);
});

test('hosted readiness and repository status interoperate with the real signed HTTP listener and actual Git repository', async t => {
  const f = await fixture(t);
  for (const incoming of [request('/api/hybrid/status'), post('/api/hybrid/test')]) {
    const response = await f.api(incoming);
    assert.equal(response.status, 200);
    const status = await response.json();
    assert.equal(status.mode, 'hybrid');
    assert.equal(status.configured, true);
    assert.equal(status.connected, true);
    assert.equal(status.repositoryConfigured, true);
    assert.equal(status.companion.host, '127.0.0.1');
    assert.ok(!JSON.stringify(status).includes(secret));
  }
  const repository = await f.api(request('/api/repository/status'));
  assert.equal(repository.status, 200);
  const status = await repository.json();
  assert.equal(status.runtime, 'hybrid');
  assert.equal(status.repository.root, f.workspace);
  assert.equal(status.repository.branch, 'main');
  assert.equal(status.repository.head, (await f.git('rev-parse', 'HEAD')).trim());
  assert.equal(status.sandbox.available, true);
  const models = await f.api(request('/api/provider/models'));
  assert.equal((await models.json()).local.model, 'peer-coder:latest');
  assert.ok(f.outbound.every(call => new URL(call.url).origin === f.origin));
});

test('global status reports peer coding providers while keeping cloud quick-task model configuration separate', async t => {
  const f = await fixture(t);
  const response = await f.api(request('/api/status'));
  assert.equal(response.status, 200);
  const status = await response.json();
  assert.equal(status.runtime, 'hybrid');
  assert.deepEqual(status.hybrid, { configured: true, connected: true });
  assert.equal(status.providers.local.configured, true);
  assert.equal(status.providers.local.model, 'peer-coder:latest');
  assert.equal(status.providers.vertex.model, 'peer-vertex-model');
  assert.equal(status.providers.vertex.projectId, 'peer-project');
  assert.equal(status.quickTaskProviders.local.configured, false);
  assert.equal(status.quickTaskProviders.vertex.model, 'cloud-vertex-model');
  assert.equal(status.quickTaskProviders.vertex.projectId, 'cloud-project');
  assert.doesNotMatch(JSON.stringify(status), /PRIVATE_PEER_VERTEX_TOKEN|PRIVATE_CLOUD_VERTEX_TOKEN/);
});

test('integration status merges companion CLI identity while remote MCP authenticates only with cloud credentials', async t => {
  const f = await fixture(t, { cloud: { GITHUB_TOKEN: 'PRIVATE_CLOUD_GH_TOKEN' } });
  const response = await f.api(request('/api/integrations/status'));
  assert.equal(response.status, 200);
  const status = await response.json();
  assert.equal(status.runtime, 'hybrid');
  assert.equal(status.github.cli.authenticated, true);
  assert.equal(status.github.cli.login, 'peer-github-user');
  assert.equal(status.google.cli.installed, true);
  assert.equal(status.huggingface.cli.login, 'peer-hf-user');
  assert.equal(status.github.mcp.configured, true);
  assert.equal(status.github.mcp.connected, false);
  assert.equal(status.github.mcp.code, 'GITHUB_AUTH_FAILED');
  assert.equal(f.mcpCalls.length, 1);
  assert.doesNotMatch(JSON.stringify(status), /PRIVATE_CLOUD_GH_TOKEN|PRIVATE_PEER_GH_TOKEN|Private remote authentication diagnostic/);
});

test('typed CLI and exact JSON repository actions proxy across HTTP without forwarding browser headers', async t => {
  const f = await fixture(t);
  const selected = { profile: 'github.repos', repository: 'peer/project' };
  const cli = await f.api(post('/api/integrations/cli/run', selected, { Cookie: 'private-browser-cookie', Authorization: 'Bearer private-browser-token' }));
  assert.equal(cli.status, 200);
  assert.equal(cli.headers.get('x-ea-bridge'), 'companion');
  assert.deepEqual(f.cliCalls, [selected]);
  assert.deepEqual((await cli.json()).data, [{ nameWithOwner: 'peer/project' }]);
  const read = await f.api(post('/api/repository/read', '{ "path": "src/雪.mjs" }', { Cookie: 'private-browser-cookie', Authorization: 'Bearer private-browser-token' }));
  assert.equal(read.status, 200);
  const source = await read.json();
  assert.equal(source.content, 'export const value = 1;\n');
  const call = f.calls.find(call => call.endpoint === '/api/repository/read');
  assert.equal(call.headers.get('cookie'), null);
  assert.equal(call.headers.get('authorization'), null);
  assert.equal(call.headers.get('origin'), null);
  assert.equal(await fs.readFile(path.join(f.workspace, 'src', '雪.mjs'), 'utf8'), source.content);
  const applied = await f.api(post('/api/repository/apply', { changes: [{ path: source.path, content: 'export const value = 2;\n', baseHash: source.hash }] }));
  assert.equal(applied.status, 200);
  assert.equal(await fs.readFile(path.join(f.workspace, 'src', '雪.mjs'), 'utf8'), 'export const value = 2;\n');
  const stale = await f.api(post('/api/repository/apply', { changes: [{ path: source.path, content: 'must not replace', baseHash: source.hash }] }));
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).error, 'FILE_CONFLICT');
});

test('method, query and cross-origin guards block hybrid mutations before any signed peer request', async t => {
  const f = await fixture(t);
  for (const pathname of ['/api/repository/apply', '/api/repository/git/commit', '/api/coding/start', '/api/integrations/cli/run']) for (const method of ['GET', 'HEAD', 'PUT', 'DELETE']) {
    const response = await f.api(request(pathname, { method }));
    assert.ok([404, 405].includes(response.status));
  }
  for (const pathname of ['/api/repository/apply', '/api/coding/start', '/api/integrations/cli/run', '/api/hybrid/test']) {
    const response = await f.api(post(pathname, {}, { Origin: 'https://attacker.example' }));
    assert.equal(response.status, 403);
  }
  const query = await f.api(request('/api/repository/status?unsigned=selector'));
  assert.equal(query.status, 400);
  assert.equal(f.outbound.length, 0);
  assert.equal(f.calls.length, 0);
  assert.equal(f.cliCalls.length, 0);
});

test('misconfigured shared keys and unavailable peers fail honestly without returning repository or credential details', async t => {
  const f = await fixture(t);
  const wrong = { ...f.env, FORGE_COMPANION_SECRET: Buffer.alloc(32, 29).toString('base64url') };
  const rejected = await handleApi(request('/api/repository/status'), wrong, f.options);
  assert.equal(rejected.status, 401);
  assert.doesNotMatch(await rejected.text(), /PRIVATE_|repository.*root/);
  const status = await handleApi(request('/api/hybrid/status'), wrong, f.options);
  assert.equal((await status.json()).connected, false);
  const unreachable = await handleApi(request('/api/hybrid/status'), f.env, { ...f.options, fetch: async () => { throw new Error('PRIVATE_TUNNEL_DIAGNOSTIC'); } });
  const result = await unreachable.json();
  assert.equal(result.configured, true);
  assert.equal(result.connected, false);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_TUNNEL_DIAGNOSTIC/);
});
