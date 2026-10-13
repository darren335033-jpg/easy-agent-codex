import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, symlinkSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BillingLedger } from '../lib/billing-ledger.mjs';
const options = { allowedPlanIds: ['creator', 'studio'] };
function fixture(t) {
 const dir = mkdtempSync(join(tmpdir(), 'billing-ledger-'));
 const filePath = join(dir, 'private', 'ledger.sqlite');
 const ledger = new BillingLedger({ filePath });
 t.after(() => { ledger.close(); rmSync(dir, { recursive: true, force: true }); });
 return { ledger, filePath, dir };
}
function event(id, created = 1, type = 'checkout.session.completed', fields = {}) {
 return { id, created, type, data: { object: { id: 'sub-1', subscription: 'sub-1', payment_status: 'paid', status: 'active', metadata: { user_id: 'user-1', plan_id: 'creator' }, ...fields } } };
}
test('paid checkout grants, duplicates are durable and file private', t => {
 const { ledger, filePath } = fixture(t);
 assert.equal(ledger.process(event('e1'), options).status, 'processed');
 assert.deepEqual(ledger.getEntitlement('user-1'), { active: true, planId: 'creator', status: 'active' });
 assert.equal(ledger.process(event('e1'), options).status, 'duplicate');
 const reopened = new BillingLedger({ filePath });
 assert.equal(reopened.process(event('e1'), options).status, 'duplicate');
 reopened.close();
 if (process.platform !== 'win32') {
  assert.equal(statSync(filePath).mode & 0o777, 0o600);
  assert.equal(statSync(join(filePath, '..')).mode & 0o777, 0o700);
 }
});
test('unpaid and malformed ownership never grant but record retry IDs', t => {
 const { ledger } = fixture(t);
 for (const e of [event('unpaid', 1, undefined, { payment_status: 'unpaid' }), event('missing', 2, undefined, { metadata: {} }), event('plan', 3, undefined, { metadata: { user_id: 'user-1', plan_id: 'unknown' } }), event('object', 4, undefined, { subscription: { id: 'sub-1' } })]) {
  assert.equal(ledger.process(e, options).status, 'ignored');
  assert.equal(ledger.process(e, options).status, 'duplicate');
 }
 assert.equal(ledger.getEntitlement('user-1').active, false);
 assert.equal(ledger.process(event('async', 5, 'checkout.session.async_payment_succeeded'), options).active, true);
});
test('newer events win; cancellation wins a timestamp tie in either delivery order', t => {
 const { ledger } = fixture(t);
 ledger.process(event('start', 10), options);
 ledger.process(event('delete', 20, 'customer.subscription.deleted'), options);
 assert.equal(ledger.process(event('stale', 15), options).status, 'ignored');
 assert.equal(ledger.process(event('tie', 20), options).status, 'ignored');
 assert.equal(ledger.getEntitlement('user-1').status, 'canceled');
 ledger.process(event('renew', 21, 'customer.subscription.updated', { status: 'trialing' }), options);
 assert.equal(ledger.getEntitlement('user-1').active, true);
 ledger.process(event('cancel-tie', 21, 'customer.subscription.deleted'), options);
 assert.equal(ledger.getEntitlement('user-1').active, false);
});
test('subscription ownership cannot be moved between users and unknown types are ignored', t => {
 const { ledger } = fixture(t);
 ledger.process(event('start'), options);
 assert.equal(ledger.process(event('takeover', 2, 'customer.subscription.updated', { metadata: { user_id: 'user-2', plan_id: 'studio' } }), options).status, 'ignored');
 assert.equal(ledger.getEntitlement('user-2').active, false);
 assert.equal(ledger.getEntitlement('user-1').planId, 'creator');
 assert.equal(ledger.process(event('unknown', 3, 'invoice.created'), options).status, 'ignored');
});
test('transaction rollback allows a failed event to be retried', t => {
 const { ledger } = fixture(t);
 ledger.db.exec("CREATE TRIGGER fail_insert BEFORE INSERT ON subscriptions BEGIN SELECT RAISE(ABORT, 'test failure'); END;");
 assert.throws(() => ledger.process(event('retry'), options), /test failure/);
 assert.equal(ledger.db.prepare('SELECT COUNT(*) AS count FROM events').get().count, 0);
 ledger.db.exec('DROP TRIGGER fail_insert');
 assert.equal(ledger.process(event('retry'), options).status, 'processed');
 assert.throws(() => ledger.process({ id: 'invalid' }, options), /Invalid/);
});
test('symlink targets are rejected', t => {
 const { filePath, dir } = fixture(t);
 const linked = join(dir, 'alias.sqlite');
 symlinkSync(filePath, linked);
 assert.throws(() => new BillingLedger({ filePath: linked }), /regular file/);
});
test('existing database privacy is restored before reopen and journal links fail closed', t => {
 const { ledger, filePath, dir } = fixture(t);
 if (process.platform !== 'win32') {
  chmodSync(filePath, 0o666);
  const reopened = new BillingLedger({ filePath });
  assert.equal(statSync(filePath).mode & 0o777, 0o600);
  reopened.close();
 }
 const journal = filePath + '-journal';
 symlinkSync(join(dir, 'unrelated'), journal);
 assert.throws(() => new BillingLedger({ filePath }), /sidecar/);
 assert.throws(() => ledger.process(event('blocked'), options), /sidecar/);
 assert.equal(ledger.db.prepare('SELECT COUNT(*) AS count FROM events WHERE id = ?').get('blocked').count, 0);
});
