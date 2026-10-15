import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const DOCKER_HOST = '--host=unix:///var/run/docker.sock';
const OUTPUT_LIMIT = 128 * 1024;
const PROFILES = Object.freeze({ 'node:test': 'node', 'node:check': 'node', 'npm:test': 'node', 'npm:build': 'node', 'python:unittest': 'python' });
const PROXIES = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'FTP_PROXY'];

// This bootstrap is trusted controller code. Snapshot source is passed as JSON
// through stdin and is only interpreted inside the disposable gVisor container.
const NODE_BOOTSTRAP = String.raw`
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const payload = JSON.parse(fs.readFileSync(0, 'utf8'));
for (const file of payload.files) {
  const target = path.join('/workspace', file.path);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, file.content, { mode: 0o600, flag: 'wx' });
}
let commands;
if (payload.command === 'node:test') {
  const tests = payload.files.filter(file => /\.[cm]?js$/.test(file.path) && (/(?:^|\/)test\//.test(file.path) || /(?:^|\/)(?:test(?:[-_].*)?|.*[._-]test)\.[cm]?js$/.test(file.path)));
  if (!tests.length) { console.error('No Node test files found. Add a *.test.mjs, *.test.js, or test/ file.'); process.exit(1); }
  commands = [[process.execPath, ['--test', ...tests.map(file => './' + file.path)]]];
}
else if (payload.command === 'npm:test') commands = [['npm', ['--offline', 'test']]];
else if (payload.command === 'npm:build') commands = [['npm', ['--offline', 'run', 'build']]];
else if (payload.command === 'node:check') {
  const files = payload.files.filter(file => /\.(?:[cm]?js)$/.test(file.path));
  if (!files.length) { console.error('No JavaScript files to check.'); process.exit(1); }
  commands = files.map(file => [process.execPath, ['--check', './' + file.path]]);
} else { console.error('Unsupported test profile.'); process.exit(1); }
for (const [command, args] of commands) {
  const result = cp.spawnSync(command, args, { cwd: '/workspace', stdio: ['ignore', 'inherit', 'inherit'] });
  if (result.error) { console.error(result.error.message); process.exit(1); }
  if (result.status !== 0) process.exit(1);
}
`;

const PYTHON_BOOTSTRAP = String.raw`
import json, pathlib, subprocess, sys
payload = json.load(sys.stdin)
for file in payload['files']:
    target = pathlib.Path('/workspace') / file['path']
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open('x', encoding='utf-8') as output:
        output.write(file['content'])
test_driver = '''import sys, unittest
suite = unittest.defaultTestLoader.discover('.')
if suite.countTestCases() == 0:
    print('No Python unittest tests found.', file=sys.stderr)
    sys.exit(1)
result = unittest.TextTestRunner(verbosity=2).run(suite)
sys.exit(0 if result.wasSuccessful() else 1)
'''
result = subprocess.run([sys.executable, '-c', test_driver], cwd='/workspace', stdin=subprocess.DEVNULL)
sys.exit(0 if result.returncode == 0 else 1)
`;

function invalid(message) {
  return Object.assign(new Error(message), { status: 400, code: 'INVALID_SANDBOX_INPUT' });
}

function validate(input) {
  if (!input || !Object.hasOwn(PROFILES, input.command)) throw invalid('Choose node:test, node:check, npm:test, npm:build, or python:unittest.');
  if (!Array.isArray(input.files) || !input.files.length || input.files.length > 200) throw invalid('A snapshot must contain between 1 and 200 files.');
  const paths = new Set();
  let size = 0;
  const files = input.files.map(file => {
    const name = file?.path;
    if (typeof name !== 'string' || !name || name.length > 240 || /[\\:\x00-\x1f\x7f]/.test(name) || name.startsWith('/') || name.split('/').some(part => !part || part === '.' || part === '..' || part === '.git')) throw invalid('Snapshot contains an unsafe file path.');
    if (name.split('/').some(part => /^\.env(?:\.|$)/i.test(part) && !/^\.env\.example$/i.test(part)) || /(?:^|\/)(?:credentials\.json|service[-_]account[^/]*\.json|id_rsa|id_ed25519)$/i.test(name)) throw invalid('Credential files cannot enter the test sandbox.');
    if (paths.has(name)) throw invalid('Snapshot contains duplicate paths.');
    if (typeof file.content !== 'string' || Buffer.byteLength(file.content) > 256 * 1024) throw invalid('Each snapshot file must be text of at most 256 KiB.');
    size += Buffer.byteLength(file.content);
    paths.add(name);
    return { path: name, content: file.content };
  });
  if (size > 1024 * 1024) throw invalid('Snapshot exceeds 1 MiB.');
  for (const name of paths) {
    const parts = name.split('/');
    for (let i = 1; i < parts.length; i++) if (paths.has(parts.slice(0, i).join('/'))) throw invalid('A snapshot file cannot also be a parent directory.');
  }
  return { files, command: input.command };
}

function abortError() { return Object.assign(new Error('Sandbox run cancelled.'), { name: 'AbortError' }); }

function dockerEnvironment() {
  // Do not forward provider credentials, proxy credentials, or daemon selectors.
  return { PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8' };
}

function captureDocker(args, { payload, timeoutMs = 5000, signal, limit = OUTPUT_LIMIT, spawnProcess = spawn } = {}) {
  return new Promise(resolve => {
    if (signal?.aborted) { resolve({ code: null, output: '', reason: 'aborted' }); return; }
    let child;
    try { child = spawnProcess('docker', [DOCKER_HOST, ...args], { env: dockerEnvironment(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }); }
    catch (error) { resolve({ code: null, output: error.message, reason: 'process_error' }); return; }
    const chunks = [];
    let bytes = 0, reason, settled = false, killDeadline;
    const finish = code => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearTimeout(killDeadline);
      signal?.removeEventListener('abort', onAbort);
      resolve({ code, output: Buffer.concat(chunks).toString('utf8'), ...(reason ? { reason } : {}) });
    };
    const stop = cause => {
      if (reason || settled) return;
      reason = cause;
      child.kill('SIGKILL');
      killDeadline = setTimeout(() => finish(null), 2000);
    };
    const onAbort = () => stop('aborted');
    const receive = chunk => {
      if (reason || settled) return;
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const room = Math.max(0, limit - bytes);
      if (room) { chunks.push(data.subarray(0, room)); bytes += Math.min(data.length, room); }
      if (data.length > room) stop('output_limit');
    };
    const deadline = setTimeout(() => stop('timeout'), timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', receive);
    child.stderr.on('data', receive);
    child.on('error', error => { receive(error.message); reason ||= 'process_error'; finish(null); });
    child.on('close', code => finish(code));
    child.stdin.on('error', () => {}); // An early container exit may close stdin.
    child.stdin.end(payload);
    if (signal?.aborted) onAbort();
  });
}

function imageNames(image) {
  const images = typeof image === 'object' && image ? image : { node: image || 'easy-agent-runner:local', python: 'dazza-forge-eval:local' };
  for (const kind of ['node', 'python']) {
    if (typeof images[kind] !== 'string' || !images[kind] || images[kind].length > 300 || !/^[a-zA-Z0-9][a-zA-Z0-9._/@:-]*$/.test(images[kind])) throw invalid('Sandbox image references must be local image tags or digests.');
  }
  return { node: images.node, python: images.python };
}

export function createSandboxRunner({ image, timeoutMs = 30000, spawnProcess = spawn } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60000) throw invalid('Sandbox timeout must be between 1000 and 60000 ms.');
  const names = imageNames(image);
  const capture = (args, options = {}) => captureDocker(args, { ...options, spawnProcess });

  async function status() {
    const [info, ...inspection] = await Promise.all([
      capture(['info', '--format', '{{range $name, $runtime := .Runtimes}}{{$name}}{{println}}{{end}}'], { limit: 4096 }),
      ...Object.values(names).map(name => capture(['image', 'inspect', '--format', '{{.Id}}', name], { limit: 4096 })),
    ]);
    const runtimeAvailable = info.code === 0 && !info.reason && info.output.split(/\r?\n/).includes('runsc');
    const images = Object.fromEntries(Object.keys(names).map((kind, i) => {
      const result = inspection[i], id = result.output.trim();
      return [kind, { image: names[kind], available: result.code === 0 && !result.reason && /^sha256:[a-f0-9]{64}$/.test(id), ...(/^sha256:[a-f0-9]{64}$/.test(id) ? { id } : {}) }];
    }));
    const docker = info.code === 0 && !info.reason;
    const profiles = Object.fromEntries(Object.entries(PROFILES).map(([profile, kind]) => [profile, docker && runtimeAvailable && images[kind].available]));
    const available = Object.values(profiles).some(Boolean);
    return { available, docker, runtime: 'runsc', runtimeAvailable, network: 'none', timeoutMs, images, profiles,
      ...(!available ? { reason: !docker ? 'Local Docker is unavailable.' : !runtimeAvailable ? 'Required gVisor runtime runsc is unavailable. No fallback is used.' : 'Build the local runner images before testing.' } : {}) };
  }

  async function cleanup(name) {
    const removed = await capture(['rm', '--force', name], { timeoutMs: 3000, limit: 4096 });
    if (removed.code === 0 && !removed.reason) return true;
    const inspect = await capture(['container', 'inspect', '--format', '{{.Id}}', name], { timeoutMs: 3000, limit: 4096 });
    return inspect.code !== 0 && !inspect.reason && inspect.output.split(/\r?\n/).some(line => line === `Error: No such container: ${name}` || line === `Error: No such object: ${name}`);
  }

  async function run(input) {
    const payload = validate(input);
    const signal = input.signal;
    if (signal && (typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function')) throw invalid('signal must be an AbortSignal.');
    if (signal?.aborted) throw abortError();
    const started = performance.now();
    const sandbox = { runtime: 'runsc', network: 'none', memoryMiB: 512, cpus: 1, pids: 64 };
    const ready = await status();
    if (signal?.aborted) throw abortError();
    if (!ready.profiles[payload.command]) return { status: 'infrastructure_error', exitCode: null, output: ready.reason || `Build the local ${PROFILES[payload.command]} runner image before testing.`, durationMs: Math.round(performance.now() - started), sandbox };
    const kind = PROFILES[payload.command];
    const name = `easy-agent-test-${randomUUID()}`;
    // Resolve tags to their already-inspected immutable local image ID. No pull.
    const args = ['create', '--name', name, '--runtime', 'runsc', '--network', 'none', '--read-only', '--interactive', '--user', '65534:65534', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--pids-limit', '64', '--memory', '512m', '--memory-swap', '512m', '--cpus', '1', '--ipc', 'none', '--ulimit', 'nofile=256:256', '--stop-timeout', '1', '--tmpfs', '/workspace:rw,nosuid,nodev,noexec,size=64m,mode=1777', '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=32m,mode=1777', '--workdir', '/workspace', '--log-driver', 'none'];
    for (const variable of [...PROXIES, ...PROXIES.map(value => value.toLowerCase())]) args.push('--env', `${variable}=`);
    args.push('--env', 'HOME=/tmp', '--env', 'PATH=/usr/local/bin:/usr/bin:/bin', '--env', 'NODE_OPTIONS=', '--env', 'PYTHONPATH=', '--env', 'PYTHONDONTWRITEBYTECODE=1', '--env', 'npm_config_cache=/tmp/.npm');
    args.push('--entrypoint', kind === 'node' ? 'node' : 'python', '--', ready.images[kind].id, ...(kind === 'node' ? ['-e', NODE_BOOTSTRAP] : ['-I', '-S', '-c', PYTHON_BOOTSTRAP]));
    let result, cancelled = false;
    try {
      const created = await capture(args, { signal, limit: 4096 });
      if (created.reason === 'aborted') cancelled = true;
      else if (created.code !== 0 || created.reason || !/^[a-f0-9]{64}\s*$/.test(created.output)) result = { status: 'infrastructure_error', exitCode: null, output: created.output || 'Could not create the isolated test container.' };
      else {
        const executed = await capture(['start', '--attach', '--interactive', name], { signal, payload: JSON.stringify(payload), timeoutMs });
        if (executed.reason === 'aborted') cancelled = true;
        else {
          const outcome = executed.reason === 'timeout' ? 'timeout' : executed.reason === 'output_limit' ? 'failed' : executed.reason || executed.code === null || [125, 126, 127].includes(executed.code) ? 'infrastructure_error' : executed.code === 0 ? 'passed' : 'failed';
          result = { status: outcome, exitCode: executed.code, output: executed.output + (executed.reason === 'output_limit' ? '\n[Output limit exceeded.]' : executed.reason === 'timeout' ? '\n[Test deadline exceeded.]' : '') };
        }
      }
    } finally {
      if (!await cleanup(name)) {
        result = { status: 'infrastructure_error', exitCode: result?.exitCode ?? null, output: `${result?.output || ''}\nContainer removal could not be confirmed: ${name}.`, ...(result ? { executionStatus: result.status } : {}) };
        cancelled = false;
      }
    }
    if (cancelled) throw abortError();
    return { ...result, durationMs: Math.round(performance.now() - started), sandbox };
  }
  return { status, run };
}
