import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { createSandboxRunner } from '../server/sandbox.mjs';

const IMAGE_ID = `sha256:${'a'.repeat(64)}`;
const CONTAINER_ID = 'b'.repeat(64);
const fixture = { command: 'node:test', files: [
  { path: 'src/add.mjs', content: 'export const add = (a, b) => a + b;' },
  { path: 'test/add.test.mjs', content: "import test from 'node:test'; import assert from 'node:assert/strict'; import { add } from '../src/add.mjs'; test('adds', () => assert.equal(add(1, 2), 3));" },
] };

function mockDocker({ runsc = true, imageAvailable = true, execute = { code: 0, output: 'tests passed\n' }, cleanupUncertain = false, alreadyRemoved = false, onStart } = {}) {
  const calls = [];
  const spawnProcess = (command, args, options) => {
    const call = { command, args, options, input: '' };
    calls.push(call);
    const process = new EventEmitter();
    process.stdout = new PassThrough();
    process.stderr = new PassThrough();
    let closed = false, timer;
    const close = code => { if (closed) return; closed = true; clearTimeout(timer); process.emit('close', code); };
    process.kill = signal => { call.killed = signal; queueMicrotask(() => close(null)); return true; };
    process.stdin = new Writable({ write(chunk, encoding, next) { call.input += chunk.toString(); next(); }, final(next) {
      next();
      setImmediate(() => {
        const operation = args[1];
        let result;
        if (operation === 'info') result = { code: 0, output: runsc ? 'runsc\nrunc\n' : 'runc\n' };
        else if (operation === 'image') result = imageAvailable ? { code: 0, output: IMAGE_ID } : { code: 1, output: 'No such image' };
        else if (operation === 'create') result = { code: 0, output: CONTAINER_ID };
        else if (operation === 'start') { onStart?.(); result = execute; }
        else if (operation === 'rm') result = cleanupUncertain || alreadyRemoved ? { code: 1, output: 'removal error' } : { code: 0, output: args.at(-1) };
        else if (operation === 'container') result = cleanupUncertain ? { code: 1, output: 'Cannot connect to the Docker daemon' } : { code: 1, output: `Error: No such container: ${args.at(-1)}\n` };
        else assert.fail(`Unexpected Docker operation ${operation}`);
        if (result.output) process.stdout.write(result.output);
        if (!result.hang) timer = setTimeout(() => close(result.code), result.delay || 0);
      });
    } });
    return process;
  };
  return { calls, spawnProcess };
}

test('sandbox status checks the local daemon, required gVisor runtime, and prebuilt images', async () => {
  const docker = mockDocker();
  const status = await createSandboxRunner(docker).status();
  assert.equal(status.available, true);
  assert.equal(status.runtime, 'runsc');
  assert.equal(status.network, 'none');
  assert.equal(status.images.node.id, IMAGE_ID);
  assert.equal(status.profiles['node:test'], true);
  for (const call of docker.calls) {
    assert.equal(call.command, 'docker');
    assert.equal(call.args[0], '--host=unix:///var/run/docker.sock');
    assert.deepEqual(Object.keys(call.options.env).sort(), ['LANG', 'PATH']);
    assert.equal(call.options.shell, undefined);
  }
});

test('a snapshot runs in a stopped-then-started container with no host mounts or credentials', async () => {
  const docker = mockDocker();
  const result = await createSandboxRunner(docker).run(fixture);
  assert.equal(result.status, 'passed');
  assert.equal(result.exitCode, 0);
  assert.ok(result.durationMs >= 0);
  const created = docker.calls.find(call => call.args[1] === 'create');
  for (const [flag, value] of [['--runtime', 'runsc'], ['--network', 'none'], ['--user', '65534:65534'], ['--cap-drop', 'ALL'], ['--memory', '512m'], ['--memory-swap', '512m'], ['--pids-limit', '64'], ['--cpus', '1'], ['--log-driver', 'none'], ['--security-opt', 'no-new-privileges:true']]) assert.equal(created.args[created.args.indexOf(flag) + 1], value, flag);
  assert.ok(created.args.includes('--read-only'));
  assert.ok(created.args.includes('/workspace:rw,nosuid,nodev,noexec,size=64m,mode=1777'));
  assert.ok(created.args.includes(IMAGE_ID));
  assert.ok(!created.args.includes('--mount') && !created.args.includes('--volume'));
  assert.ok(created.args.includes('HTTPS_PROXY='));
  assert.ok(!created.args.includes(fixture.files[0].content));
  const start = docker.calls.find(call => call.args[1] === 'start');
  assert.deepEqual(JSON.parse(start.input), fixture);
  const removed = docker.calls.find(call => call.args[1] === 'rm');
  assert.equal(removed.args.at(-1), start.args.at(-1));
});

test('missing gVisor or image fails closed without creating or executing a container', async () => {
  for (const config of [{ runsc: false }, { imageAvailable: false }]) {
    const docker = mockDocker(config);
    const result = await createSandboxRunner(docker).run(fixture);
    assert.equal(result.status, 'infrastructure_error');
    assert.ok(!docker.calls.some(call => ['create', 'start'].includes(call.args[1])));
  }
});

test('unsafe paths, credential files, conflicting paths, oversized snapshots, and arbitrary commands are rejected before Docker', async () => {
  const docker = mockDocker();
  const runner = createSandboxRunner(docker);
  for (const path of ['../escape', '/host/path', 'a/../b', 'a//b', 'a\\b', '.git/config', '.env', 'src/.env.local', 'credentials.json', 'service-account-prod.json', 'x\0.js', 'C:/x']) await assert.rejects(runner.run({ ...fixture, files: [{ path, content: '' }] }), error => error.status === 400);
  for (const input of [
    { ...fixture, command: 'node:test && curl attacker' },
    { ...fixture, files: [] },
    { ...fixture, files: [{ path: 'a', content: '' }, { path: 'a', content: '' }] },
    { ...fixture, files: [{ path: 'a', content: '' }, { path: 'a/b', content: '' }] },
    { ...fixture, files: [{ path: 'big', content: 'x'.repeat(262145) }] },
    { ...fixture, files: Array.from({ length: 5 }, (_, i) => ({ path: `big-${i}`, content: 'x'.repeat(240000) })) },
  ]) await assert.rejects(runner.run(input), error => error.status === 400);
  assert.equal(docker.calls.length, 0);
});

test('Python profile uses the Python image and bootstrap and propagates actual test failures', async () => {
  const docker = mockDocker({ execute: { code: 1, output: 'FAILED (failures=1)' } });
  const result = await createSandboxRunner(docker).run({ command: 'python:unittest', files: [{ path: 'test_add.py', content: 'import unittest' }] });
  assert.equal(result.status, 'failed');
  assert.equal(result.exitCode, 1);
  const created = docker.calls.find(call => call.args[1] === 'create');
  assert.equal(created.args[created.args.indexOf('--entrypoint') + 1], 'python');
  assert.ok(created.args.includes('-I') && created.args.includes('-S'));
  assert.ok(created.args.at(-1).includes("unittest.defaultTestLoader.discover('.')"));
  assert.ok(created.args.at(-1).includes('suite.countTestCases() == 0'));
});

test('the fixed npm build profile stays inside the sandbox and uses offline npm', async () => {
  const docker = mockDocker();
  const result = await createSandboxRunner(docker).run({ command: 'npm:build', files: [{ path: 'package.json', content: '{"scripts":{"build":"node --check app.js"}}' }, { path: 'app.js', content: 'const value = 1;' }] });
  assert.equal(result.status, 'passed');
  const created = docker.calls.find(call => call.args[1] === 'create');
  assert.ok(created.args.at(-1).includes("payload.command === 'npm:build'"));
  assert.ok(created.args.at(-1).includes("['--offline', 'run', 'build']"));
  assert.equal(JSON.parse(docker.calls.find(call => call.args[1] === 'start').input).command, 'npm:build');
});

test('output overflow is bounded and forcibly cleaned up', async () => {
  const docker = mockDocker({ execute: { code: 0, output: 'x'.repeat(150000) } });
  const result = await createSandboxRunner(docker).run(fixture);
  assert.equal(result.status, 'failed');
  assert.ok(result.output.endsWith('[Output limit exceeded.]'));
  assert.ok(Buffer.byteLength(result.output) < 132000);
  assert.equal(docker.calls.find(call => call.args[1] === 'start').killed, 'SIGKILL');
  assert.ok(docker.calls.some(call => call.args[1] === 'rm'));
});

test('wall deadline stops a hung test and confirms cleanup', async () => {
  const docker = mockDocker({ execute: { hang: true } });
  const result = await createSandboxRunner({ ...docker, timeoutMs: 1000 }).run(fixture);
  assert.equal(result.status, 'timeout');
  assert.ok(result.output.includes('deadline exceeded'));
  assert.ok(docker.calls.some(call => call.args[1] === 'rm'));
});

test('cancellation waits for container cleanup before rejecting with AbortError', async () => {
  const abort = new AbortController();
  const docker = mockDocker({ execute: { hang: true }, onStart: () => setImmediate(() => abort.abort()) });
  await assert.rejects(createSandboxRunner(docker).run({ ...fixture, signal: abort.signal }), error => error.name === 'AbortError');
  assert.ok(docker.calls.some(call => call.args[1] === 'rm'));
});

test('uncertain cleanup overrides a passing result; confirmed previous removal is accepted', async () => {
  const uncertain = mockDocker({ cleanupUncertain: true });
  const failure = await createSandboxRunner(uncertain).run(fixture);
  assert.equal(failure.status, 'infrastructure_error');
  assert.equal(failure.executionStatus, 'passed');
  assert.ok(failure.output.includes('removal could not be confirmed'));
  const gone = mockDocker({ alreadyRemoved: true });
  assert.equal((await createSandboxRunner(gone).run(fixture)).status, 'passed');
});

test('invalid timeout and image configuration cannot turn into Docker arguments', () => {
  for (const timeoutMs of [0, 999, 60001, Infinity, '1000']) assert.throws(() => createSandboxRunner({ timeoutMs }), /timeout/);
  for (const image of ['--privileged', 'image name', 'name;command', 'name\n']) assert.throws(() => createSandboxRunner({ image }), /image/);
});
