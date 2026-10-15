import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeUsage } from '../server/usage.mjs';

const now = Date.parse('2026-10-15T12:00:00Z');
const record = (extra = {}) => ({ id: 'run-a', createdAt: '2026-10-15T10:00:00Z', provider: 'openai', model: 'gpt-example', status: 'completed', inferenceCalls: 1, ...extra });

test('an empty history has no invented usage, balance, rates, plan, or call count', () => {
  const summary = summarizeUsage([], { now });
  assert.equal(summary.runs.total, 0);
  assert.equal(summary.calls.reported, null);
  assert.equal(summary.tokens.totalTokenCount, null);
  assert.equal(summary.window.asOf, '2026-10-15T12:00:00.000Z');
  assert.deepEqual(summary.byModel, []);
  for (const field of ['balance', 'cost', 'subscription', 'rates', 'rateLimit']) assert.equal(field in summary, false);
  assert.match(summary.notes.join(' '), /invoices can include calls whose usage was not returned/);
});

test('aggregate tokens are counted once while cached and reasoning details stay separate', () => {
  const summary = summarizeUsage([
    record({ inferenceCalls: 2, usageCoverage: { reportedCalls: 2, unreportedCalls: 0 }, usage: { promptTokenCount: 100, candidatesTokenCount: 50, totalTokenCount: 150, cachedInputTokenCount: 40, reasoningTokenCount: 20 }, events: [{ type: 'model_completed', usageReported: true, usage: { promptTokenCount: 40, candidatesTokenCount: 20, totalTokenCount: 60 } }, { type: 'model_completed', usageReported: true, usage: { promptTokenCount: 60, candidatesTokenCount: 30, totalTokenCount: 90 } }] }),
  ], { now });
  assert.deepEqual(summary.tokens, { promptTokenCount: 100, candidatesTokenCount: 50, totalTokenCount: 150, cachedInputTokenCount: 40, reasoningTokenCount: 20 });
  assert.equal(summary.calls.reported, 2);
  assert.equal(summary.calls.completedWithUsage, 2);
  assert.equal(summary.runs.withUsage, 1);
  assert.equal(summary.byModel[0].tokens.totalTokenCount, 150);
});

test('explicit zero responses, absent usage, and legacy initialized zero have different accounting', () => {
  const summary = summarizeUsage([
    record({ id: 'zero', usage: { totalTokenCount: 0 }, usageCoverage: { reportedCalls: 1, unreportedCalls: 0 } }),
    record({ id: 'missing', usage: {}, usageCoverage: { reportedCalls: 0, unreportedCalls: 1 } }),
    record({ id: 'legacy', usage: { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 } }),
  ]);
  assert.equal(summary.runs.withUsage, 1);
  assert.equal(summary.runs.zeroUsage, 1);
  assert.equal(summary.runs.withoutUsage, 2);
  assert.equal(summary.tokens.totalTokenCount, 0);
  assert.equal(summary.calls.completedWithUsage, 1);
  assert.equal(summary.calls.completedWithoutUsage, 1);
  assert.equal(summary.recent.find(item => item.id === 'legacy').usageStatus, 'missing');
  assert.equal(summary.recent.find(item => item.id === 'missing').usage, null);
});

test('event fallback recovers partial runs and does not treat the aggregate placeholder as returned zero', () => {
  const summary = summarizeUsage([
    record({ usage: { totalTokenCount: 0 }, events: [{ type: 'model_completed', usageReported: false, usage: { totalTokenCount: 0 } }] }),
    record({ id: 'partial', status: 'failed', inferenceCalls: 3, events: [{ type: 'model_completed', usageReported: true, usage: { promptTokenCount: 14, totalTokenCount: 19, reasoningTokenCount: 2 } }, { type: 'model_completed', usageReported: false, usage: { totalTokenCount: 0 } }, { type: 'tool_completed', usage: { totalTokenCount: 9000 } }] }),
  ]);
  assert.equal(summary.tokens.totalTokenCount, 19);
  assert.equal(summary.tokens.reasoningTokenCount, 2);
  assert.equal(summary.runs.failed, 1);
  assert.equal(summary.runs.withoutUsage, 1);
  assert.equal(summary.calls.completedWithoutUsage, 2);
  assert.equal(summary.recent.find(item => item.id === 'partial').usageStatus, 'reported');
});

test('details omitted by older aggregate records are recovered without adding the total twice', () => {
  const summary = summarizeUsage([record({ usage: { promptTokenCount: 20, candidatesTokenCount: 8, totalTokenCount: 28 }, events: [{ type: 'model_completed', usage: { totalTokenCount: 28, cachedInputTokenCount: 12, reasoningTokenCount: 3 } }] })]);
  assert.equal(summary.tokens.totalTokenCount, 28);
  assert.equal(summary.tokens.cachedInputTokenCount, 12);
  assert.equal(summary.tokens.reasoningTokenCount, 3);
});

test('unreported total and call count stay unavailable instead of being inferred from agents or components', () => {
  const summary = summarizeUsage([record({ inferenceCalls: undefined, agents: [{}, {}, {}], usage: { promptTokenCount: 12, candidatesTokenCount: 7 } })]);
  assert.equal(summary.tokens.totalTokenCount, null);
  assert.equal(summary.calls.reported, null);
  assert.equal(summary.calls.runsWithoutReportedCalls, 1);
  assert.equal(summary.runs.withUsage, 1);
  assert.equal(summary.recent[0].inferenceCalls, null);
  assert.equal(summary.byModel[0].inferenceCalls, null);
});

test('unsafe, coerced, negative, and nonfinite counts are excluded while valid metrics remain', () => {
  const summary = summarizeUsage([record({ inferenceCalls: '2', usage: { promptTokenCount: '100', candidatesTokenCount: -1, totalTokenCount: Infinity, cachedInputTokenCount: Number.MAX_SAFE_INTEGER + 1, reasoningTokenCount: 4 }, usageCoverage: { reportedCalls: 1, unreportedCalls: 0 } }), record({ id: 'fractional', inferenceCalls: 1.1, usage: { totalTokenCount: 2.5 } })]);
  assert.equal(summary.tokens.reasoningTokenCount, 4);
  assert.equal(summary.tokens.promptTokenCount, null);
  assert.equal(summary.tokens.totalTokenCount, null);
  assert.equal(summary.tokens.cachedInputTokenCount, null);
  assert.equal(summary.runs.withoutUsage, 1);
  assert.equal(summary.calls.reported, null);
});

test('sums stay within safe integer bounds even for corrupted oversized saved metrics', () => {
  const summary = summarizeUsage([record({ inferenceCalls: Number.MAX_SAFE_INTEGER, usage: { totalTokenCount: Number.MAX_SAFE_INTEGER } }), record({ id: 'b', inferenceCalls: 1, usage: { totalTokenCount: 1 } })]);
  assert.equal(summary.tokens.totalTokenCount, Number.MAX_SAFE_INTEGER);
  assert.equal(summary.calls.reported, Number.MAX_SAFE_INTEGER);
  assert.ok(Number.isSafeInteger(summary.byModel[0].tokens.totalTokenCount));
});

test('only the newest 100 saved records and at most 20 recent metadata rows are returned', () => {
  const records = Array.from({ length: 135 }, (_, index) => record({ id: `run-${index}`, createdAt: new Date(Date.UTC(2026, 0, 1, index)).toISOString(), usage: { totalTokenCount: index } }));
  const summary = summarizeUsage(records, { scope: 'browser', now });
  assert.equal(summary.runs.total, 100);
  assert.equal(summary.recent.length, 20);
  assert.equal(summary.recent[0].id, 'run-134');
  assert.equal(summary.window.from, records[35].createdAt);
  assert.equal(summary.window.to, records[134].createdAt);
  assert.equal(summary.window.limited, true);
  assert.equal(summary.scope, 'browser');
  assert.equal(summary.tokens.totalTokenCount, records.slice(35).reduce((sum, item) => sum + item.usage.totalTokenCount, 0));
});

test('provider and model grouping keeps separate accounts and models separate', () => {
  const summary = summarizeUsage([
    record({ usage: { totalTokenCount: 9 } }),
    record({ id: 'b', provider: 'vertex', model: 'gemini-example', usage: { totalTokenCount: 11 }, status: 'cancelled' }),
    record({ id: 'c', provider: 'local', model: 'qwen:7b', usage: { totalTokenCount: 20 }, status: 'running' }),
    record({ id: 'd', provider: 'openai', model: 'other-model', usage: { totalTokenCount: 4 }, status: 'interrupted' }),
  ]);
  assert.equal(summary.byProvider.find(item => item.provider === 'openai').tokens.totalTokenCount, 13);
  assert.equal(summary.byModel.length, 4);
  assert.equal(summary.runs.cancelled, 1);
  assert.equal(summary.runs.active, 1);
  assert.equal(summary.runs.other, 1);
  assert.equal(summary.tokens.totalTokenCount, 44);
});

test('source, prompts, filesystem paths, task text, errors and secret-looking metadata are not copied', () => {
  const summary = summarizeUsage([record({ id: 'sk-proj-do-not-copy-this', model: 'sk-proj-secret-model-value', task: 'PRIVATE TASK', output: 'PRIVATE OUTPUT', repository: { root: '/private/root' }, events: [{ type: 'tool_completed', result: { source: 'PRIVATE SOURCE' } }], usage: { totalTokenCount: 3, secret: 'PRIVATE SECRET' }, error: 'PRIVATE ERROR' })]);
  const serialized = JSON.stringify(summary);
  for (const secret of ['PRIVATE', 'sk-proj-', '/private/root']) assert.equal(serialized.includes(secret), false);
  assert.equal(summary.recent[0].id, null);
  assert.equal(summary.recent[0].model, 'Unspecified model');
  assert.deepEqual(Object.keys(summary.recent[0]).sort(), ['completedCallsWithUsage', 'completedCallsWithoutUsage', 'createdAt', 'id', 'inferenceCalls', 'model', 'provider', 'status', 'usage', 'usageCoverage', 'usageStatus'].sort());
});

test('malformed records are skipped and invalid metadata gets bounded neutral labels', () => {
  const summary = summarizeUsage([null, [], 'text', record({ provider: '../../provider', model: 'x'.repeat(1000), createdAt: 'invalid', status: '<script>' })], { scope: 'unrecognized', now });
  assert.equal(summary.runs.total, 1);
  assert.equal(summary.scope, 'repository');
  assert.equal(summary.window.from, null);
  assert.equal(summary.recent[0].provider, 'unknown');
  assert.equal(summary.recent[0].model, 'Unspecified model');
  assert.equal(summary.recent[0].status, 'unknown');
  assert.equal(summary.recent[0].createdAt, null);
});
