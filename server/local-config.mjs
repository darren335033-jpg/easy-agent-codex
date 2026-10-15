import path from 'node:path';
import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const keyName = 'oauth-session.key';
function fail(code, message) { return Object.assign(new Error(message), { status: 503, code }); }
function canonicalSecret(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value) && Buffer.from(value, 'base64url').length === 32 && Buffer.from(value, 'base64url').toString('base64url') === value;
}
const invalidKey = () => fail('OAUTH_SECRET_INVALID', 'The existing OAuth session key is invalid. It was left unchanged.');
const unsafeState = () => fail('OAUTH_SECRET_UNSAFE', 'OAuth session storage must use private regular files and real directories without links.');

async function checkDirectories(target) {
  let current = path.parse(target).root;
  for (const part of target.slice(current.length).split(path.sep)) {
    current = path.join(current, part);
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw unsafeState();
  }
  if (await fs.realpath(target) !== target) throw unsafeState();
}

async function readKey(target, { retryPartial = false } = {}) {
  for (let attempt = 0; ; attempt++) {
    let handle;
    try {
      // NONBLOCK prevents a malicious FIFO from hanging startup before fstat.
      handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1) throw unsafeState();
      if (stat.size < 43 && retryPartial && attempt < 20) {
        await handle.close(); handle = undefined;
        await delay(10);
        continue;
      }
      if (stat.size !== 43) throw invalidKey();
      const buffer = Buffer.alloc(44);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const value = buffer.subarray(0, bytesRead).toString('utf8');
      if (bytesRead !== 43 || !canonicalSecret(value)) throw invalidKey();
      await handle.chmod(0o600);
      return value;
    } catch (error) {
      if (error.code === 'ELOOP' || error.code === 'EISDIR' || error.code === 'ENXIO') throw unsafeState();
      throw error;
    } finally { await handle?.close(); }
  }
}

/** Configure a persistent local OAuth encryption key without exposing its value. */
export async function ensureOAuthSecret({ env = process.env, appRoot } = {}) {
  if (!env || typeof env !== 'object' || Array.isArray(env)) throw fail('OAUTH_SECRET_INVALID', 'OAuth environment configuration is invalid.');
  if (env.OAUTH_SESSION_SECRET !== undefined && env.OAUTH_SESSION_SECRET !== '') {
    if (!canonicalSecret(env.OAUTH_SESSION_SECRET)) throw fail('OAUTH_SECRET_INVALID', 'OAUTH_SESSION_SECRET must be a canonical base64url encoding of 32 bytes.');
    return;
  }
  if (typeof appRoot !== 'string' || !path.isAbsolute(appRoot) || appRoot.includes('\0') || path.resolve(appRoot) === path.parse(appRoot).root) throw fail('OAUTH_SECRET_UNSAFE', 'Use an existing absolute application directory for OAuth session storage.');
  const root = path.resolve(appRoot);
  const directory = path.join(root, '.forge');
  const target = path.join(directory, keyName);
  try {
    await checkDirectories(root);
    try { await fs.mkdir(directory, { mode: 0o700 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    await checkDirectories(directory);
    const directoryHandle = await fs.open(directory, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
    try { await directoryHandle.chmod(0o700); }
    finally { await directoryHandle.close(); }
    let value;
    try { value = await readKey(target, { retryPartial: true }); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      let created;
      try {
        created = await fs.open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      } catch (creationError) {
        if (creationError.code !== 'EEXIST') throw creationError;
        value = await readKey(target, { retryPartial: true });
      }
      if (created) {
        try {
          const createdStat = await created.stat();
          if (!createdStat.isFile() || createdStat.nlink !== 1) throw unsafeState();
          await created.chmod(0o600);
          await created.writeFile(randomBytes(32).toString('base64url'), 'utf8');
          await created.sync();
        } finally { await created.close(); }
        // Read the persisted file through the same validation as future startups.
        value = await readKey(target, { retryPartial: true });
      }
    }
    await checkDirectories(directory);
    env.OAUTH_SESSION_SECRET = value;
  } catch (error) {
    if (error?.code?.startsWith('OAUTH_SECRET_')) throw error;
    throw fail('OAUTH_SECRET_UNAVAILABLE', 'OAuth session key storage is unavailable. No existing key was overwritten.');
  }
}
