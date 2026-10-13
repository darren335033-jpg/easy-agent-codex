import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { handle, status } from './sandcastles-status-mcp.mjs';
const request = (method, params, id = 1) => ({ jsonrpc: '2.0', id, method, params });
async function fixture(fn) { const cwd = await mkdtemp(path.join(tmpdir(), 'ea-sandcastles-')); try { await fn(cwd); } finally { await rm(cwd, { recursive: true, force: true }); } }
test('status is a basename-only inventory, excludes symlinks and never reads secrets', async () => fixture(async cwd => {
  assert.equal((await status(cwd)).configured, false);
  const root = path.join(cwd, '.sandcastle');
  await mkdir(path.join(root, 'worktrees', 'shot-one'), { recursive: true });
  await writeFile(path.join(root, 'main.ts'), 'api_key: DO_NOT_EXPOSE');
  await writeFile(path.join(root, 'worktrees', 'plain-file'), 'not a worktree');
  await symlink(path.join(root, 'worktrees', 'shot-one'), path.join(root, 'worktrees', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const actual = await status(cwd);
  if (process.platform === 'win32') { const alternateCase = await status(cwd.toUpperCase()); assert.equal(alternateCase.configured, true); assert.deepEqual(alternateCase.worktrees, ['shot-one']); }
  assert.equal(actual.upstream, 'https://github.com/mattpocock/sandcastle'); assert.equal(actual.configured, true); assert.deepEqual(actual.worktrees, ['shot-one']); assert.equal(actual.runtimeStatus, 'unverified');
  await rm(path.join(root, 'main.ts')); await writeFile(path.join(root, 'main.mts'), 'DO_NOT_EXPOSE'); assert.equal((await status(cwd)).configured, true); assert.ok(!JSON.stringify(actual).includes(cwd)); assert.ok(!JSON.stringify(actual).includes('DO_NOT_EXPOSE'));
}));
test('root and worktree-root symlinks are never traversed', async () => fixture(async cwd => {
  await mkdir(path.join(cwd, 'outside', 'worktrees', 'secret'), { recursive: true });
  await writeFile(path.join(cwd, 'outside', 'main.ts'), 'secret');
  await symlink(path.join(cwd, 'outside'), path.join(cwd, '.sandcastle'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await status(cwd)).configured, false); assert.deepEqual((await status(cwd)).worktrees, []);
  await rm(path.join(cwd, '.sandcastle'));
  await mkdir(path.join(cwd, '.sandcastle'));
  await symlink(path.join(cwd, 'outside', 'worktrees'), path.join(cwd, '.sandcastle', 'worktrees'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.deepEqual((await status(cwd)).worktrees, []);
}));
test('protocol handshake and read-only surface', async () => {
  const init = await handle(request('initialize', { protocolVersion: '2024-11-05' }));
  assert.equal(init.result.protocolVersion, '2025-03-26');
  const list = await handle(request('tools/list'));
  assert.equal(list.result.tools.length, 1); assert.equal(list.result.tools[0].annotations.readOnlyHint, true);
  const call = await handle(request('tools/call', { name: 'easy_agent_sandcastles_status', arguments: {} }));
  assert.equal(JSON.parse(call.result.content[0].text).bridge, 'easy-agent-read-only-status');
  assert.equal((await handle(request('tools/call', { name: 'run_docker' }))).error.code, -32602);
  assert.equal((await handle(request('tools/call', { name: 'easy_agent_sandcastles_status', arguments: { path: '/' } }))).error.code, -32602);
  assert.deepEqual((await handle(request('resources/list'))).result.resources, []);
  assert.deepEqual((await handle(request('ping'))).result, {});
  assert.equal(await handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), undefined);
});
test('stdio parses fragmented lines and recovers from malformed/oversized input without reflection', async () => fixture(async cwd => {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./sandcastles-status-mcp.mjs', import.meta.url))], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '', err = ''; child.stdout.on('data', chunk => out += chunk); child.stderr.on('data', chunk => err += chunk);
  const exit = new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(Error(`exit ${code}`))); });
  child.stdin.write('{"jsonrpc":"2.0",'); child.stdin.write('"id":1,"method":"initialize","params":{}}\n');
  child.stdin.write('SECRET malformed\n');
  child.stdin.write('x'.repeat(65537) + '\n');
  child.stdin.end(JSON.stringify(request('ping', undefined, 2)) + '\n');
  await exit; const messages = out.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(messages.length, 4); assert.equal(messages[0].result.protocolVersion, '2025-03-26');
  assert.equal(messages[1].error.code, -32700); assert.equal(messages[2].error.code, -32700); assert.deepEqual(messages[3].result, {});
  assert.ok(!out.includes('SECRET')); assert.equal(err, '');
}));
