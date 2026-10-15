import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { AGENTS, mapConcurrent, selectAgents } from '../server/agents.mjs';

test('roster contains exactly 50 uniquely identified enabled specialists across five teams', () => {
  assert.equal(AGENTS.length, 50);
  for (const field of ['id', 'name', 'role']) assert.equal(new Set(AGENTS.map(agent => agent[field])).size, 50);
  const teams = new Map();
  for (const agent of AGENTS) {
    assert.equal(agent.enabled, true);
    assert.ok(agent.description.length > 30);
    teams.set(agent.team, (teams.get(agent.team) ?? 0) + 1);
  }
  assert.equal(teams.size, 5);
  assert.deepEqual([...teams.values()], [10, 10, 10, 10, 10]);
});

test('selection retains the lead and reviewer while routing specialist terms', () => {
  const selection = selectAgents({ task: 'Fix PostgreSQL SQL indexes and database transactions', maxAgents: 3 });
  assert.deepEqual(selection.map(agent => agent.id), ['atlas', 'rhea', 'sage']);
  assert.equal(selectAgents({}).length, 5);
  assert.deepEqual(selectAgents({ maxAgents: 1 }).map(agent => agent.id), ['atlas']);
});

test('selection honors all enabled exclusions, including lead and reviewer', () => {
  const only = ['luna', 'rhea', 'nia'];
  const selected = selectAgents({ task: 'AI model inference', maxAgents: 2, enabledAgentIds: only });
  assert.equal(selected[0].id, 'nia');
  assert.ok(selected.every(agent => only.includes(agent.id)));
  assert.deepEqual(selectAgents({ enabledAgentIds: [] }), []);
  assert.deepEqual(selectAgents({ enabledAgentIds: ['sage'] }).map(agent => agent.id), ['sage']);
  assert.deepEqual(selectAgents({ enabledAgentIds: ['atlas', 'rhea'], maxAgents: 50 }).map(agent => agent.id), ['atlas', 'rhea']);
});

test('selection enforces its 1 to 50 limit and never duplicates agents', () => {
  for (const cap of [50, 999, 50.9]) {
    const selected = selectAgents({ maxAgents: cap });
    assert.equal(selected.length, 50);
    assert.equal(new Set(selected.map(agent => agent.id)).size, 50);
    assert.equal(selected[0].id, 'atlas');
    assert.equal(selected.at(-1).id, 'sage');
  }
  assert.equal(selectAgents({ maxAgents: 0 }).length, 1);
  assert.equal(selectAgents({ maxAgents: -10 }).length, 1);
  assert.equal(selectAgents({ maxAgents: Number.NaN }).length, 5);
});

test('async pool respects requested parallelism and preserves input ordering', async () => {
  let active = 0;
  let peak = 0;
  const results = await mapConcurrent([30, 5, 20, 1, 10], 2, async (milliseconds, index) => {
    active++;
    peak = Math.max(peak, active);
    await delay(milliseconds);
    active--;
    return `result-${index}`;
  });
  assert.equal(peak, 2);
  assert.equal(active, 0);
  assert.deepEqual(results, ['result-0', 'result-1', 'result-2', 'result-3', 'result-4']);
});

test('async pool bounds concurrency between one and eight', async () => {
  for (const [requested, expected] of [[100, 8], [0, 1], [-2, 1]]) {
    let active = 0;
    let peak = 0;
    await mapConcurrent(Array.from({ length: 12 }), requested, async () => {
      active++;
      peak = Math.max(peak, active);
      await delay(2);
      active--;
    });
    assert.equal(peak, expected);
  }
  assert.deepEqual(await mapConcurrent([], 8, () => 1), []);
});

test('async pool propagates errors and stops scheduling further work', async () => {
  const failure = new Error('Provider failed');
  const started = [];
  await assert.rejects(mapConcurrent([0, 1, 2, 3], 1, async item => {
    started.push(item);
    if (item === 1) throw failure;
    return item;
  }), error => error === failure);
  assert.deepEqual(started, [0, 1]);
});

test('async pool aborts immediately and does not start work for pre-aborted signals', async () => {
  const before = new AbortController();
  before.abort();
  await assert.rejects(mapConcurrent([1], 2, () => assert.fail('must not run'), before.signal), { name: 'AbortError' });

  const during = new AbortController();
  const started = [];
  let finish;
  const pending = mapConcurrent([1, 2, 3], 1, item => {
    started.push(item);
    return new Promise(resolve => { finish = resolve; });
  }, during.signal);
  during.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.deepEqual(started, [1]);
  finish('finished after cancellation');
  await delay(0);
  assert.deepEqual(started, [1]);
});
