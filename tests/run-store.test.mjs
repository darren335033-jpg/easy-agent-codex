import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRunStore } from '../server/run-store.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-store-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'private-state');
  return { root, directory, store: createRunStore(directory) };
}
const record = (overrides = {}) => ({ id: randomUUID(), status: 'queued', task: 'Repair the implementation', createdAt: new Date().toISOString(), events: [], proposals: [], ...overrides });

test('disk history is private, survives a new store instance, and leaves no temporary files', async t => {
  const { directory, store } = await fixture(t);
  const original = record();
  await store.save(original);
  assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(path.join(directory, original.id + '.json'))).mode & 0o777, 0o600);
  await store.update(original.id, { status: 'running', events: [{ sequence: 1, type: 'task_started' }] });
  await store.update(original.id, existing => ({ ...existing, status: 'completed', events: [...existing.events, { sequence: 2, type: 'task_finished' }], proposals: [{ path: 'main.js', content: 'replacement' }] }));
  const reloaded = await createRunStore(directory).get(original.id);
  assert.equal(reloaded.status, 'completed');
  assert.equal(reloaded.proposals[0].content, 'replacement');
  assert.deepEqual(reloaded.events.map(event => event.sequence), [1, 2]);
  assert.ok(!Number.isNaN(Date.parse(reloaded.updatedAt)));
  assert.deepEqual(await fs.readdir(directory), [original.id + '.json']);
});

test('concurrent event persistence serializes updates and retains every event', async t => {
  const { store } = await fixture(t);
  const original = record();
  await store.save(original);
  await Promise.all(Array.from({ length: 24 }, (_, sequence) => store.update(original.id, existing => ({ ...existing, events: [...existing.events, { sequence }] }))));
  assert.deepEqual((await store.get(original.id)).events.map(event => event.sequence), Array.from({ length: 24 }, (_, sequence) => sequence));
});

test('invalid IDs cannot read or write outside the configured state directory', async t => {
  const { root, directory, store } = await fixture(t);
  const outside = path.join(root, 'outside.json');
  await fs.writeFile(outside, 'PRIVATE_OUTSIDE_FILE');
  for (const id of ['../outside', '/tmp/outside', 'a/../../outside', 'a\\outside', 'x'.repeat(36) + '/..', '', null]) {
    await assert.rejects(store.get(id), error => error.status === 400);
    await assert.rejects(store.save(record({ id })), error => error.status === 400);
  }
  assert.equal(await fs.readFile(outside, 'utf8'), 'PRIVATE_OUTSIDE_FILE');
  assert.deepEqual(await fs.readdir(directory), []);
  await assert.rejects(store.get(randomUUID()), error => error.status === 404);
});

test('symlink roots and ancestors fail before creating or changing outside directories', async t => {
  const { root } = await fixture(t);
  const outside = path.join(root, 'outside');
  await fs.mkdir(outside, { mode: 0o755 });
  await fs.chmod(outside, 0o755);
  const linked = path.join(root, 'linked');
  await fs.symlink(outside, linked);
  for (const directory of [linked, path.join(linked, 'must-not-be-created')]) {
    await assert.rejects(createRunStore(directory).save(record()), error => error.code === 'STORE_UNAVAILABLE');
  }
  assert.deepEqual(await fs.readdir(outside), []);
  assert.equal((await fs.stat(outside)).mode & 0o777, 0o755);
});

test('symlink and multiply linked run files cannot expose JSON from outside state storage', async t => {
  const { root, directory, store } = await fixture(t);
  await store.list();
  const sensitive = path.join(root, 'sensitive.json');
  const id = randomUUID();
  await fs.writeFile(sensitive, JSON.stringify(record({ id, task: 'OUTSIDE_PRIVATE_DATA' })));
  const destination = path.join(directory, id + '.json');
  await fs.symlink(sensitive, destination);
  await assert.rejects(store.get(id));
  assert.deepEqual(await store.list(), []);
  await fs.unlink(destination);
  await fs.link(sensitive, destination);
  await assert.rejects(store.get(id), error => error.code === 'STORE_UNAVAILABLE');
  assert.deepEqual(await store.list(), []);
  assert.ok((await fs.readFile(sensitive, 'utf8')).includes('OUTSIDE_PRIVATE_DATA'));
  const directoryId = randomUUID();
  await fs.mkdir(path.join(directory, directoryId + '.json'));
  await assert.rejects(store.get(directoryId), error => error.code === 'STORE_UNAVAILABLE');
});

test('readers retain consistent old or new records while atomic saves replace the same path', async t => {
  const { store } = await fixture(t);
  const original = record();
  await store.save(original);
  for (let version = 0; version < 12; version++) {
    const results = await Promise.all([
      store.update(original.id, { version }),
      ...Array.from({ length: 12 }, () => store.get(original.id)),
    ]);
    for (const current of results) assert.equal(current.id, original.id);
  }
  assert.equal((await store.get(original.id)).version, 11);
});

test('oversized history is rejected for writes and reads without replacing valid history', async t => {
  const { directory, store } = await fixture(t);
  const original = record();
  await store.save(original);
  await assert.rejects(store.save({ ...original, output: 'x'.repeat(8 * 1024 * 1024) }), error => error.code === 'STORE_LIMIT');
  assert.equal((await store.get(original.id)).status, 'queued');
  const large = record();
  await fs.writeFile(path.join(directory, large.id + '.json'), 'x'.repeat(8 * 1024 * 1024 + 1));
  await assert.rejects(store.get(large.id), error => error.code === 'STORE_UNAVAILABLE');
  assert.equal((await store.list()).length, 1);
  assert.ok((await fs.readdir(directory)).every(name => name.endsWith('.json')));
});

test('malformed records and mismatched IDs are skipped rather than breaking history or recovery', async t => {
  const { directory, store } = await fixture(t);
  const good = record({ status: 'completed' });
  await store.save(good);
  for (const content of ['null', '[]', '123', '{invalid', JSON.stringify(record({ id: randomUUID() }))]) {
    const id = randomUUID();
    await fs.writeFile(path.join(directory, id + '.json'), content);
    await assert.rejects(store.get(id));
  }
  assert.deepEqual((await store.list()).map(item => item.id), [good.id]);
  await store.recover();
  assert.equal((await store.get(good.id)).status, 'completed');
});

test('restart marks every interrupted run failed, including records older than the 100-item history view', async t => {
  const { directory, store } = await fixture(t);
  const interrupted = record({ status: 'running', createdAt: '2020-01-01T00:00:00.000Z' });
  await store.save(interrupted);
  const queued = record({ createdAt: '2020-01-02T00:00:00.000Z' });
  await store.save(queued);
  for (let index = 0; index < 101; index++) await store.save(record({ status: 'completed', createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString() }));
  assert.equal((await store.list()).length, 100);
  const restarted = createRunStore(directory);
  await restarted.recover();
  for (const id of [interrupted.id, queued.id]) {
    const recovered = await restarted.get(id);
    assert.equal(recovered.status, 'failed');
    assert.equal(recovered.error.code, 'SERVER_RESTARTED');
    assert.ok(recovered.error.message.includes('No changes were applied automatically'));
    assert.ok(!Number.isNaN(Date.parse(recovered.finishedAt)));
  }
});
