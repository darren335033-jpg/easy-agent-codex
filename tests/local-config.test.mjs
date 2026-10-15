import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ensureOAuthSecret } from '../server/local-config.mjs';

const exec = promisify(execFile);
const secret = () => randomBytes(32).toString('base64url');
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'easy-agent-local-config-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, state: path.join(root, '.forge'), key: path.join(root, '.forge', 'oauth-session.key') };
}
const rejected = promise => assert.rejects(promise, error => error.status === 503 && /^OAUTH_SECRET_/.test(error.code));

test('bootstrap persists one canonical secret with private file and directory modes and no return value', async t => {
  const { root, state, key } = await fixture(t);
  const env = {};
  assert.equal(await ensureOAuthSecret({ env, appRoot: root }), undefined);
  assert.match(env.OAUTH_SESSION_SECRET, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(Buffer.from(env.OAUTH_SESSION_SECRET, 'base64url').length, 32);
  assert.equal(Buffer.from(env.OAUTH_SESSION_SECRET, 'base64url').toString('base64url'), env.OAUTH_SESSION_SECRET);
  assert.equal(await fs.readFile(key, 'utf8'), env.OAUTH_SESSION_SECRET);
  assert.equal((await fs.stat(state)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(key)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(key)).nlink, 1);
  const again = {};
  await ensureOAuthSecret({ env: again, appRoot: root });
  assert.equal(again.OAUTH_SESSION_SECRET, env.OAUTH_SESSION_SECRET);
  assert.deepEqual(await fs.readdir(state), ['oauth-session.key']);
});

test('explicit valid configuration is retained and does not access or create application state', async t => {
  const { root, state } = await fixture(t);
  const configured = secret();
  const env = { OAUTH_SESSION_SECRET: configured };
  await ensureOAuthSecret({ env, appRoot: '/a/nonexistent/location' });
  assert.equal(env.OAUTH_SESSION_SECRET, configured);
  await ensureOAuthSecret({ env, appRoot: root });
  await assert.rejects(fs.stat(state), { code: 'ENOENT' });
});

test('invalid explicit values fail without echoing them or touching disk', async t => {
  const { root, state } = await fixture(t);
  for (const value of ['super-private-invalid-value', 'a'.repeat(43), `${secret()}=`, `${secret()}\n`, ' '.repeat(43), 'A'.repeat(42), null, 123]) {
    const env = { OAUTH_SESSION_SECRET: value };
    await assert.rejects(ensureOAuthSecret({ env, appRoot: root }), error => {
      assert.equal(error.code, 'OAUTH_SECRET_INVALID');
      if (typeof value === 'string' && value.trim()) assert.ok(!error.message.includes(value));
      return true;
    });
    assert.equal(env.OAUTH_SESSION_SECRET, value);
  }
  await assert.rejects(fs.stat(state), { code: 'ENOENT' });
});

test('empty configured values bootstrap normally and existing valid files are tightened to private modes', async t => {
  const { root, state, key } = await fixture(t);
  const configured = secret();
  await fs.mkdir(state);
  await fs.writeFile(key, configured);
  await fs.chmod(state, 0o755);
  await fs.chmod(key, 0o644);
  const env = { OAUTH_SESSION_SECRET: '' };
  await ensureOAuthSecret({ env, appRoot: root });
  assert.equal(env.OAUTH_SESSION_SECRET, configured);
  assert.equal((await fs.stat(key)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(state)).mode & 0o777, 0o700);
});

test('existing malformed, empty, padded, noncanonical, and oversized keys are never overwritten', async t => {
  const { root, state, key } = await fixture(t);
  await fs.mkdir(state);
  for (const value of ['retained-invalid-secret', '', `${secret()}=`, 'a'.repeat(43), 'x'.repeat(100_000)]) {
    await fs.writeFile(key, value);
    const env = {};
    await assert.rejects(ensureOAuthSecret({ env, appRoot: root }), error => error.code === 'OAUTH_SECRET_INVALID');
    assert.equal(await fs.readFile(key, 'utf8'), value);
    assert.equal(env.OAUTH_SESSION_SECRET, undefined);
  }
});

test('symlink application roots, state directories, keys, and hardlinked keys are refused without altering targets', async t => {
  const { root, state, key } = await fixture(t);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'easy-agent-key-outside-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  const outsideKey = path.join(outside, 'retained.key');
  const original = secret();
  await fs.writeFile(outsideKey, original, { mode: 0o644 });
  await fs.chmod(outsideKey, 0o644);
  await fs.symlink(outside, state);
  await rejected(ensureOAuthSecret({ env: {}, appRoot: root }));
  await fs.unlink(state);
  await fs.mkdir(state);
  await fs.symlink(outsideKey, key);
  await rejected(ensureOAuthSecret({ env: {}, appRoot: root }));
  await fs.unlink(key);
  await fs.link(outsideKey, key);
  await rejected(ensureOAuthSecret({ env: {}, appRoot: root }));
  assert.equal(await fs.readFile(outsideKey, 'utf8'), original);
  assert.equal((await fs.stat(outsideKey)).mode & 0o777, 0o644);
  const link = `${root}-link`;
  await fs.symlink(root, link);
  t.after(() => fs.unlink(link));
  await rejected(ensureOAuthSecret({ env: {}, appRoot: link }));
});

test('nonregular key paths and unsafe state paths are refused without hanging', async t => {
  const { root, state, key } = await fixture(t);
  await fs.writeFile(state, 'ordinary file');
  await rejected(ensureOAuthSecret({ env: {}, appRoot: root }));
  assert.equal(await fs.readFile(state, 'utf8'), 'ordinary file');
  await fs.unlink(state);
  await fs.mkdir(state);
  await fs.mkdir(key);
  await rejected(ensureOAuthSecret({ env: {}, appRoot: root }));
  await fs.rmdir(key);
  await exec('mkfifo', [key]);
  await rejected(ensureOAuthSecret({ env: {}, appRoot: root }));
  assert.equal((await fs.lstat(key)).isFIFO(), true);
});

test('concurrent initializers converge on one persisted key without replacing it', async t => {
  const { root, key } = await fixture(t);
  const environments = Array.from({ length: 12 }, () => ({}));
  const results = await Promise.allSettled(environments.map(env => ensureOAuthSecret({ env, appRoot: root })));
  const value = await fs.readFile(key, 'utf8');
  assert.match(value, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(results.some(result => result.status === 'fulfilled'));
  for (let index = 0; index < results.length; index++) {
    const result = results[index];
    if (result.status === 'fulfilled') assert.equal(environments[index].OAUTH_SESSION_SECRET, value);
    else {
      assert.match(result.reason.code, /^OAUTH_SECRET_/);
      assert.equal(environments[index].OAUTH_SESSION_SECRET, undefined);
    }
  }
  const subsequent = {};
  await ensureOAuthSecret({ env: subsequent, appRoot: root });
  assert.equal(subsequent.OAUTH_SESSION_SECRET, value);
  assert.equal((await fs.stat(key)).nlink, 1);
});

test('missing or relative application directories are rejected without creating them', async t => {
  const { root } = await fixture(t);
  for (const appRoot of [undefined, '', '../relative', '/', path.join(root, 'missing')]) await rejected(ensureOAuthSecret({ env: {}, appRoot }));
  await assert.rejects(fs.stat(path.join(root, 'missing')), { code: 'ENOENT' });
});
