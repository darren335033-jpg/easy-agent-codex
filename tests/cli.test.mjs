import test from 'node:test';
import assert from 'node:assert/strict';
import { createCliService } from '../server/cli.mjs';

function fake(handler = () => '[]') {
  const calls = [];
  return {
    calls,
    execFile(binary, args, options, callback) {
      calls.push({ binary, args, options });
      queueMicrotask(() => {
        try {
          const result = handler(binary, args, options);
          if (result instanceof Error) callback(result, result.stdout || '', result.stderr || '');
          else callback(null, typeof result === 'string' ? result : JSON.stringify(result), '');
        } catch (error) { callback(error, '', ''); }
      });
      return {};
    },
  };
}
const cliFailure = (code, text = 'secret provider diagnostic') => Object.assign(new Error(text), { code, stdout: text, stderr: text });
const rejectsInvalid = promise => assert.rejects(promise, error => error.status === 400 && error.code === 'INVALID_CLI_REQUEST');

test('fixed GitHub profiles use argument arrays, explicit repositories, bounded fields, and read-only verbs', async () => {
  const process = fake();
  const service = createCliService({ env: {}, workspace: '/tmp', execFile: process.execFile });
  for (const profile of ['github.repos', 'github.pulls', 'github.issues', 'github.runs']) {
    const result = await service.run({ profile, repository: 'Dazza/project' });
    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.data, []);
    assert.match(result.command, /^gh /);
    assert.ok(Number.isInteger(result.durationMs) && result.durationMs >= 0);
  }
  assert.deepEqual(process.calls[0].args.slice(0, 5), ['repo', 'list', 'Dazza', '--limit', '50']);
  for (const call of process.calls.slice(1)) {
    assert.equal(call.args[1], 'list');
    assert.equal(call.args[call.args.indexOf('--repo') + 1], 'Dazza/project');
    assert.equal(call.args[call.args.indexOf('--limit') + 1], '50');
    assert.ok(call.args.includes('--json'));
  }
  for (const call of process.calls) {
    assert.equal(call.binary, 'gh');
    assert.equal(call.options.cwd, '/tmp');
    assert.equal(call.options.shell, false);
    assert.equal(call.options.timeout, 20_000);
    assert.equal(call.options.maxBuffer, 256 * 1024);
    assert.equal(call.options.killSignal, 'SIGKILL');
  }
});

test('Google profiles always project JSON fields and scope regional queries explicitly', async () => {
  const process = fake();
  const service = createCliService({ env: {}, execFile: process.execFile });
  for (const profile of ['google.projects', 'google.services', 'google.runServices', 'google.vertexModels']) {
    assert.equal((await service.run({ profile, projectId: 'dazza-project', region: 'us-central1' })).exitCode, 0);
  }
  assert.deepEqual(process.calls[0].args.slice(0, 2), ['projects', 'list']);
  assert.ok(process.calls[1].args.includes('--enabled'));
  for (const call of process.calls.slice(1)) {
    assert.ok(call.args.includes('--project=dazza-project'));
    assert.ok(call.args.includes('--limit=100'));
  }
  for (const call of process.calls.slice(2)) assert.ok(call.args.includes('--region=us-central1'));
  assert.ok(process.calls[2].args.includes('--platform=managed'));
  for (const call of process.calls) {
    assert.equal(call.binary, 'gcloud');
    assert.ok(call.args.some(arg => arg.startsWith('--format=json(')));
    assert.ok(!call.args.some(arg => /revision\.env|spec\.template|config\.env/.test(arg)));
  }
  assert.deepEqual(process.calls[3].args.slice(0, 3), ['ai', 'models', 'list']);
});

test('Hugging Face profiles use verified hf2 CLI JSON commands and minimal catalog expansion', async () => {
  const process = fake((_binary, args) => args[0] === 'auth' ? { name: 'dazza', email: 'private@example.invalid', orgs: [{ name: 'EasyAgent' }], auth: { accessToken: 'hf_secret-token', role: 'read' } } : [{ id: 'org/model', likes: 4 }]);
  const service = createCliService({ env: {}, execFile: process.execFile });
  const whoami = await service.run({ profile: 'huggingface.whoami' });
  assert.deepEqual(whoami.data, { login: 'dazza', organizations: ['EasyAgent'] });
  assert.doesNotMatch(whoami.output, /private@example|accessToken|secret-token/);
  await service.run({ profile: 'huggingface.models' });
  await service.run({ profile: 'huggingface.spaces' });
  assert.deepEqual(process.calls[0].args, ['auth', 'whoami', '--format', 'json']);
  assert.deepEqual(process.calls[1].args, ['models', 'ls', '--limit', '50', '--sort', 'downloads', '--expand=author,downloads,likes,pipeline_tag', '--format', 'json']);
  assert.deepEqual(process.calls[2].args, ['spaces', 'ls', '--limit', '50', '--sort', 'likes', '--expand=author,likes,sdk,private', '--format', 'json']);
  assert.ok(process.calls.every(call => call.binary === 'hf'));
});

test('profiles reject command injection, malformed identifiers, unknown fields, and arbitrary operations before spawning', async () => {
  const process = fake();
  const service = createCliService({ env: {}, execFile: process.execFile });
  for (const input of [
    null, [], {}, { profile: 'github.clone' }, { profile: 'google.deploy' }, { profile: 'huggingface.download' },
    { profile: 'github.repos', command: 'sh' }, { profile: 'github.repos', args: ['--help'] },
    { profile: 'github.repos', cwd: '/' }, { profile: 'github.repos', env: {} },
    { profile: 'github.pulls', repository: '--help' }, { profile: 'github.pulls', repository: 'owner/repo;touch' },
    { profile: 'github.pulls', repository: 'owner/repo\n--help' }, { profile: 'github.pulls', repository: 'owner/../escape' },
    { profile: 'github.pulls', repository: 'owner/..' }, { profile: 'github.pulls', repository: 'https://github.com/owner/repo' },
    { profile: 'google.services', projectId: 'project;touch marker' }, { profile: 'google.services', projectId: '--help' },
    { profile: 'google.services', projectId: 'PROJECT' }, { profile: 'google.services', projectId: 'tiny' },
    { profile: 'google.vertexModels', projectId: 'valid-project', region: 'global' },
    { profile: 'google.runServices', projectId: 'valid-project', region: 'us-central1;touch marker' },
    { profile: 'google.projects', projectId: 4 }, { profile: 'github.repos', repository: {} }, { profile: 'huggingface.models', region: [] },
  ]) await rejectsInvalid(service.run(input));
  assert.equal(process.calls.length, 0);
});

test('repository/project defaults come only from server configuration and required selectors fail clearly', async () => {
  const process = fake();
  const unconfigured = createCliService({ env: {}, execFile: process.execFile });
  await rejectsInvalid(unconfigured.run({ profile: 'github.pulls' }));
  await rejectsInvalid(unconfigured.run({ profile: 'google.services' }));
  await unconfigured.run({ profile: 'github.repos' });
  await unconfigured.run({ profile: 'google.projects' });
  const configured = createCliService({ env: { GH_REPO: 'owner/default', GOOGLE_CLOUD_PROJECT: 'configured-project', GOOGLE_CLOUD_REGION: 'europe-west1' }, execFile: process.execFile });
  await configured.run({ profile: 'github.pulls' });
  await configured.run({ profile: 'google.vertexModels' });
  assert.ok(process.calls[2].args.includes('owner/default'));
  assert.ok(process.calls[3].args.includes('--project=configured-project'));
  assert.ok(process.calls[3].args.includes('--region=europe-west1'));
  await configured.run({ profile: 'google.vertexModels', projectId: 'override-project', region: 'asia-northeast1' });
  assert.ok(process.calls[4].args.includes('--project=override-project'));
  assert.ok(process.calls[4].args.includes('--region=asia-northeast1'));
  const bad = createCliService({ env: { GH_REPO: 'bad/repo;touch', GOOGLE_CLOUD_PROJECT: '--invalid' }, execFile: process.execFile });
  await rejectsInvalid(bad.run({ profile: 'github.pulls' }));
  await rejectsInvalid(bad.run({ profile: 'google.services' }));
});

test('CLI-specific credentials stay within their own process and provider secrets, shell settings, and debug flags are removed', async () => {
  const process = fake();
  const env = {
    PATH: '/usr/bin', HOME: '/home/dazza', HTTPS_PROXY: 'http://proxy.invalid:8080', SSL_CERT_FILE: '/trusted/cert.pem',
    GH_TOKEN: 'github-only-token', GITHUB_TOKEN: 'legacy-gh-token', GH_CONFIG_DIR: '/private/gh', GH_DEBUG: 'api',
    CLOUDSDK_CONFIG: '/private/gcloud', CLOUDSDK_AUTH_ACCESS_TOKEN: 'google-only-token', CLOUDSDK_CORE_LOG_HTTP: 'true', CLOUDSDK_CORE_VERBOSITY: 'debug',
    HF_TOKEN: 'hf-only-token', HF_HOME: '/private/hf',
    OPENAI_API_KEY: 'provider-secret', GOOGLE_ACCESS_TOKEN: 'vertex-secret', GOOGLE_SERVICE_ACCOUNT_JSON: '{"private_key":"private-value"}',
    OLLAMA_BASE_URL: 'http://provider.invalid', BASH_ENV: '/malicious.sh', NODE_OPTIONS: '--require=malicious', PYTHONPATH: '/malicious', GIT_CONFIG_COUNT: '50', HF_DEBUG: '1',
  };
  const service = createCliService({ env, execFile: process.execFile });
  await service.run({ profile: 'github.repos' });
  await service.run({ profile: 'google.projects' });
  await service.run({ profile: 'huggingface.models' });
  for (const call of process.calls) {
    for (const name of ['OPENAI_API_KEY', 'GOOGLE_ACCESS_TOKEN', 'GOOGLE_SERVICE_ACCOUNT_JSON', 'OLLAMA_BASE_URL', 'BASH_ENV', 'NODE_OPTIONS', 'PYTHONPATH', 'GIT_CONFIG_COUNT', 'HF_DEBUG']) assert.equal(call.options.env[name], undefined, name);
    assert.equal(call.options.env.HOME, '/home/dazza');
    assert.equal(call.options.env.HTTPS_PROXY, 'http://proxy.invalid:8080');
    assert.equal(call.options.env.SSL_CERT_FILE, '/trusted/cert.pem');
  }
  assert.equal(process.calls[0].options.env.GH_TOKEN, env.GH_TOKEN);
  assert.equal(process.calls[0].options.env.GH_DEBUG, '');
  assert.equal(process.calls[0].options.env.CLOUDSDK_AUTH_ACCESS_TOKEN, undefined);
  assert.equal(process.calls[0].options.env.HF_TOKEN, undefined);
  assert.equal(process.calls[1].options.env.CLOUDSDK_AUTH_ACCESS_TOKEN, env.CLOUDSDK_AUTH_ACCESS_TOKEN);
  assert.equal(process.calls[1].options.env.CLOUDSDK_CORE_LOG_HTTP, 'false');
  assert.equal(process.calls[1].options.env.CLOUDSDK_CORE_VERBOSITY, 'error');
  assert.equal(process.calls[1].options.env.CLOUDSDK_CORE_DISABLE_FILE_LOGGING, 'true');
  assert.equal(process.calls[1].options.env.GH_TOKEN, undefined);
  assert.equal(process.calls[1].options.env.HF_TOKEN, undefined);
  assert.equal(process.calls[2].options.env.HF_TOKEN, env.HF_TOKEN);
  assert.equal(process.calls[2].options.env.GH_TOKEN, undefined);
  assert.equal(process.calls[2].options.env.CLOUDSDK_AUTH_ACCESS_TOKEN, undefined);
});

test('owner configured executable paths are supported without treating them as shell commands', async () => {
  const process = fake();
  const service = createCliService({ env: { GH_BIN: '/trusted tools/gh', GCLOUD_BIN: '/trusted/google-cloud-sdk/bin/gcloud', HF_BIN: '/trusted/hf/bin/hf' }, execFile: process.execFile });
  await service.run({ profile: 'github.repos' });
  await service.run({ profile: 'google.projects' });
  await service.run({ profile: 'huggingface.models' });
  assert.deepEqual(process.calls.map(call => call.binary), ['/trusted tools/gh', '/trusted/google-cloud-sdk/bin/gcloud', '/trusted/hf/bin/hf']);
  assert.ok(process.calls.every(call => call.options.shell === false));
  assert.throws(() => createCliService({ workspace: '../outside' }), error => error.status === 400);
  assert.throws(() => createCliService({ env: { GH_BIN: 'gh\0bad' } }), error => error.status === 400);
});

test('status projects minimal identities from actual CLI responses and never returns tokens or raw account configuration', async () => {
  const process = fake((binary, args) => {
    if (binary === 'gh') return args[0] === '--version' ? 'gh version 2.80.0 (2026-01-01)\nhttps://github.com/cli/cli' : 'Dazza\n';
    if (binary === 'gcloud') {
      if (args[0] === 'version') return { 'Google Cloud SDK': '589.0.0', core: 'ignored' };
      if (args[0] === 'auth') return [{ status: 'ACTIVE', account: 'private@example.invalid', access_token: 'DO_NOT_EXPOSE' }];
      return 'dazza-project\n';
    }
    if (args[0] === 'version') return { version: '2.2.0' };
    return { name: 'Dazza', email: 'private@example.invalid', auth: { accessToken: 'DO_NOT_EXPOSE' } };
  });
  const service = createCliService({ env: {}, execFile: process.execFile });
  const status = await service.status();
  assert.deepEqual(status.github, { installed: true, authenticated: true, version: '2.80.0', login: 'Dazza', reason: 'Authenticated GitHub API access verified for this server identity.' });
  assert.equal(status.google.authenticated, true);
  assert.equal(status.google.projectId, 'dazza-project');
  assert.equal(status.google.version, '589.0.0');
  assert.equal(status.huggingface.authenticated, true);
  assert.equal(status.huggingface.version, '2.2.0');
  assert.equal(status.huggingface.login, 'Dazza');
  assert.doesNotMatch(JSON.stringify(status), /DO_NOT_EXPOSE|private@example|accessToken|access_token/);
  assert.ok(process.calls.some(call => call.binary === 'gh' && JSON.stringify(call.args) === JSON.stringify(['api', 'user', '--jq', '.login'])));
  assert.ok(process.calls.some(call => call.binary === 'gcloud' && call.args.includes('--format=json(status)')));
  assert.ok(!process.calls.some(call => call.args.includes('login') || call.args.includes('print-access-token')));
});

test('GitHub Enterprise Managed User identities and repository owners retain bounded underscore support', async () => {
  const process = fake((binary, args) => {
    if (binary === 'gh') {
      if (args[0] === '--version') return 'gh version 2.80.0';
      if (args[0] === 'api') return 'Dazza_enterprise';
      return [];
    }
    return cliFailure('ENOENT');
  });
  const service = createCliService({ env: {}, execFile: process.execFile });
  const status = await service.status();
  assert.equal(status.github.login, 'Dazza_enterprise');
  assert.equal(status.github.authenticated, true);
  assert.equal((await service.run({ profile: 'github.pulls', repository: 'Dazza_enterprise/project' })).exitCode, 0);
  assert.ok(process.calls.at(-1).args.includes('Dazza_enterprise/project'));
});

test('missing CLIs and unauthenticated installations are reported honestly without leaking diagnostics', async () => {
  const missing = fake(() => cliFailure('ENOENT', 'secret token in error'));
  const absent = await createCliService({ env: {}, execFile: missing.execFile }).status();
  for (const item of Object.values(absent)) { assert.equal(item.installed, false); assert.equal(item.authenticated, false); assert.equal(item.version, null); }
  assert.doesNotMatch(JSON.stringify(absent), /secret token/);
  const noAuth = fake((binary, args) => {
    if (binary === 'gh' && args[0] === '--version') return 'gh version 2.80.0';
    if (binary === 'gcloud' && args[0] === 'version') return { 'Google Cloud SDK': '589.0.0' };
    if (binary === 'gcloud' && args[0] === 'config') return '(unset)';
    if (binary === 'hf' && args[0] === 'version') return 'version=2.2.0';
    return cliFailure(1, 'TOKEN=secret-token');
  });
  const installed = await createCliService({ env: {}, execFile: noAuth.execFile }).status();
  for (const item of Object.values(installed)) { assert.equal(item.installed, true); assert.equal(item.authenticated, false); assert.equal(item.login, undefined); }
  assert.equal(installed.google.projectId, undefined);
  assert.doesNotMatch(JSON.stringify(installed), /secret-token/);
});

test('successful JSON output strips secret keys, known environment values, and common provider token formats', async () => {
  const token = 'ghp_abcdefghijklmnopqrstuv1234567890';
  const process = fake(() => [{ name: 'project', accessToken: token, credentials: 'private', nested: { private_key: 'private', title: `hello provider-secret-value ${token} hf_abcdefghijklmnopqrstuvwxyz1234567` }, description: 'Bearer abcdefghijklmnop' }]);
  const result = await createCliService({ env: { OPENAI_API_KEY: 'provider-secret-value' }, execFile: process.execFile }).run({ profile: 'github.repos' });
  assert.equal(result.exitCode, 0);
  assert.equal(result.data[0].accessToken, undefined);
  assert.equal(result.data[0].credentials, undefined);
  assert.equal(result.data[0].nested.private_key, undefined);
  assert.doesNotMatch(result.output, /provider-secret-value|ghp_|hf_abcdefghijklmnopqrstuvwxyz|Bearer abcdef/);
  assert.match(result.output, /REDACTED/);
});

test('failed, oversized, timed-out, and malformed CLI responses expose fixed safe messages', async () => {
  for (const [failure, expectedExit, message] of [
    [cliFailure('ENOENT'), 127, /unavailable/],
    [cliFailure('EACCES'), 127, /unavailable/],
    [cliFailure(2), 2, /could not complete/],
    [Object.assign(cliFailure(null), { killed: true, signal: 'SIGKILL' }), 124, /20-second/],
    [cliFailure('ERR_CHILD_PROCESS_STDIO_MAXBUFFER'), 124, /256 KiB/],
  ]) {
    const process = fake(() => failure);
    const result = await createCliService({ env: {}, execFile: process.execFile }).run({ profile: 'google.projects' });
    assert.equal(result.exitCode, expectedExit);
    assert.match(result.output, message);
    assert.doesNotMatch(result.output, /secret provider diagnostic/);
    assert.equal(result.data, undefined);
  }
  const malformed = fake(() => 'RAW_SECRET not valid json');
  const result = await createCliService({ env: {}, execFile: malformed.execFile }).run({ profile: 'github.repos' });
  assert.equal(result.exitCode, 1);
  assert.doesNotMatch(result.output, /RAW_SECRET/);
  const oversized = fake(() => 'x'.repeat(256 * 1024 + 1));
  const limited = await createCliService({ env: {}, execFile: oversized.execFile }).run({ profile: 'github.repos' });
  assert.equal(limited.exitCode, 124);
  assert.match(limited.output, /256 KiB/);
});

test('at most two CLI processes run concurrently and rejected work does not consume a slot', async () => {
  const pending = [];
  let calls = 0;
  const service = createCliService({ env: {}, execFile: (_binary, _args, _options, callback) => { calls++; pending.push(callback); } });
  const first = service.run({ profile: 'github.repos' });
  const second = service.run({ profile: 'google.projects' });
  await assert.rejects(service.run({ profile: 'huggingface.models' }), error => error.status === 429 && error.code === 'CLI_BUSY');
  assert.equal(calls, 2);
  pending.shift()(null, '[]', '');
  await first;
  const third = service.run({ profile: 'huggingface.models' });
  assert.equal(calls, 3);
  pending.shift()(null, '[]', '');
  pending.shift()(null, '[]', '');
  await Promise.all([second, third]);
});

test('status observes the same two-process limit across all three providers', async () => {
  let inFlight = 0;
  let maximum = 0;
  const service = createCliService({ env: { GOOGLE_CLOUD_PROJECT: 'dazza-project' }, execFile: (binary, args, _options, callback) => {
    inFlight++;
    maximum = Math.max(maximum, inFlight);
    setTimeout(() => {
      inFlight--;
      if (binary === 'gh') callback(null, args[0] === '--version' ? 'gh version 2.80.0' : 'Dazza', '');
      else if (binary === 'gcloud') callback(null, JSON.stringify(args[0] === 'version' ? { 'Google Cloud SDK': '589.0.0' } : [{ status: 'ACTIVE' }]), '');
      else callback(null, args[0] === 'version' ? 'version=2.2.0' : '{"name":"Dazza"}', '');
    }, 5);
  } });
  const status = await service.status();
  assert.equal(maximum, 2);
  assert.equal(status.huggingface.authenticated, true);
  assert.equal(inFlight, 0);
});
