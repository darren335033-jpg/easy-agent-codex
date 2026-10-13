import { DatabaseSync } from 'node:sqlite';
import { lstatSync, chmodSync } from 'node:fs';
import { protectDirectorySync } from './storage-security.mjs';
import { dirname, resolve } from 'node:path';

const supported = new Set(['checkout.session.completed', 'checkout.session.async_payment_succeeded', 'customer.subscription.updated', 'customer.subscription.deleted']);
const grants = new Set(['active', 'trialing']);
const validText = value => typeof value === 'string' && value.length > 0 && value.length <= 256;

// Local single-host entitlement state. Signature verification belongs upstream.
export class BillingLedger {
  constructor({ filePath }) {
    if (!validText(filePath)) throw new Error('Ledger file path required');
    const target = resolve(filePath);
    const directory = dirname(target);
    protectDirectorySync(directory);
    try {
      const stat = lstatSync(target);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('Ledger target must be a regular file');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    this.db = new DatabaseSync(target);
    if (process.platform !== 'win32') chmodSync(target, 0o600);
    this.db.exec(`CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, type TEXT NOT NULL, timestamp INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS subscriptions (id TEXT PRIMARY KEY, userId TEXT NOT NULL, planId TEXT NOT NULL, status TEXT NOT NULL, eventCreated INTEGER NOT NULL);`);
  }

  process(event, { allowedPlanIds = [] } = {}) {
    if (!event || !validText(event.id) || !validText(event.type) || !Number.isSafeInteger(event.created) || event.created < 0) throw new Error('Invalid billing event envelope');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (this.db.prepare('SELECT id FROM events WHERE id = ?').get(event.id)) {
        this.db.exec('COMMIT');
        return { status: 'duplicate' };
      }
      this.db.prepare('INSERT INTO events(id,type,timestamp) VALUES (?,?,?)').run(event.id, event.type, event.created);
      const ignore = () => { this.db.exec('COMMIT'); return { status: 'ignored' }; };
      if (!supported.has(event.type)) return ignore();
      const obj = event.data?.object;
      const userId = obj?.metadata?.user_id;
      const planId = obj?.metadata?.plan_id;
      if (!validText(userId) || !validText(planId) || !allowedPlanIds.includes(planId)) return ignore();
      const checkout = event.type.startsWith('checkout.');
      if (checkout && obj.payment_status !== 'paid') return ignore();
      const id = checkout ? obj.subscription : obj.id;
      const status = checkout ? 'active' : event.type.endsWith('.deleted') ? 'canceled' : obj.status;
      if (!validText(id) || !validText(status)) return ignore();
      const previous = this.db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(id);
      if (previous && previous.userId !== userId) return ignore();
      if (previous && (previous.eventCreated > event.created || (previous.eventCreated === event.created && (previous.status === 'canceled' || status !== 'canceled')))) return ignore();
      this.db.prepare(`INSERT INTO subscriptions(id,userId,planId,status,eventCreated) VALUES (?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET planId=excluded.planId,status=excluded.status,eventCreated=excluded.eventCreated`).run(id, userId, planId, status, event.created);
      this.db.exec('COMMIT');
      return { status: 'processed', active: grants.has(status) };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  getEntitlement(userId) {
    const rows = this.db.prepare('SELECT planId,status FROM subscriptions WHERE userId = ? ORDER BY eventCreated DESC, id ASC').all(userId);
    const row = rows.find(row => grants.has(row.status)) || rows[0];
    return row ? { active: grants.has(row.status), planId: row.planId, status: row.status } : { active: false, planId: null, status: null };
  }

  close() { this.db.close(); }
}
