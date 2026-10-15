const encoder = new TextEncoder();
const unauthorized = () => Object.assign(new Error('Companion authentication failed.'), { status: 401, code: 'COMPANION_UNAUTHORIZED' });

function fromBase64url(value, bytes) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw unauthorized();
  let decoded;
  try { decoded = Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4)), character => character.charCodeAt(0)); }
  catch { throw unauthorized(); }
  const canonical = btoa(String.fromCharCode(...decoded)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  if (decoded.length !== bytes || canonical !== value) throw unauthorized();
  return decoded;
}

export function validateCompanionSecret(secret) {
  try {
    if (typeof secret !== 'string' || secret.length !== 43) throw unauthorized();
    return fromBase64url(secret, 32);
  } catch {
    throw Object.assign(new Error('FORGE_COMPANION_SECRET must be configured as a canonical base64url encoding of 32 bytes.'), { status: 503, code: 'COMPANION_SECRET_REQUIRED' });
  }
}

function header(headers, name) {
  const value = typeof headers?.get === 'function' ? headers.get(name) : headers?.[name.toLowerCase()];
  if (typeof value !== 'string') throw unauthorized();
  return value;
}

/** Only coding admission accepts this optional, signed retry identifier. */
export function companionIdempotencyKey(method, pathname, headers) {
  const value = typeof headers?.get === 'function' ? headers.get('idempotency-key') : headers?.['idempotency-key'];
  if (value === undefined || value === null) return null;
  if (method !== 'POST' || pathname !== '/api/coding/start' || typeof value !== 'string' || !/^[A-Za-z0-9-]{1,100}$/.test(value)) throw unauthorized();
  return value;
}

/** HMAC verifier shared across Node and WebCrypto runtimes. Nonces stay process-local. */
export function createCompanionVerifier(secret, { now = () => Date.now(), maxNonces = 10_000 } = {}) {
  if (typeof now !== 'function' || !Number.isInteger(maxNonces) || maxNonces < 1 || maxNonces > 100_000) throw new Error('Invalid companion verifier configuration.');
  const rawKey = validateCompanionSecret(secret);
  const key = crypto.subtle.importKey('raw', rawKey, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const nonces = new Map();
  return {
    async verify({ method, pathname, headers, body = new Uint8Array() }) {
      if (!['GET', 'POST'].includes(method) || typeof pathname !== 'string' || !pathname.startsWith('/') || pathname.includes('?') || pathname.includes('#') || !(body instanceof Uint8Array)) throw unauthorized();
      const requestKey = companionIdempotencyKey(method, pathname, headers);
      const timestamp = header(headers, 'x-ea-timestamp');
      const nonce = header(headers, 'x-ea-nonce');
      const signature = header(headers, 'x-ea-signature');
      if (!/^(?:0|[1-9][0-9]{0,12})$/.test(timestamp) || nonce.length !== 22 || signature.length !== 43) throw unauthorized();
      const seconds = Number(timestamp);
      const current = now();
      if (!Number.isFinite(current) || !Number.isSafeInteger(seconds) || Math.abs(Math.floor(current / 1000) - seconds) > 60) throw unauthorized();
      fromBase64url(nonce, 16);
      const signatureBytes = fromBase64url(signature, 32);
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', body));
      const hex = Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
      // Preserve the original protocol bytes when no retry identifier is present.
      const canonical = encoder.encode(`${timestamp}\n${nonce}\n${method}\n${pathname}\n${hex}${requestKey === null ? '' : `\n${requestKey}`}`);
      if (!await crypto.subtle.verify('HMAC', await key, signatureBytes, canonical)) throw unauthorized();
      const claimedAt = now();
      if (!Number.isFinite(claimedAt) || Math.abs(Math.floor(claimedAt / 1000) - seconds) > 60) throw unauthorized();
      for (const [seen, expires] of nonces) if (expires <= claimedAt) nonces.delete(seen);
      // Claim after asynchronous verification, so concurrent copies cannot both pass.
      if (nonces.has(nonce)) throw Object.assign(new Error('Companion request was already used.'), { status: 409, code: 'COMPANION_REPLAY' });
      if (nonces.size >= maxNonces) throw Object.assign(new Error('Companion replay protection is at capacity. Retry later.'), { status: 503, code: 'COMPANION_BUSY' });
      nonces.set(nonce, claimedAt + 120_000);
      return true;
    },
  };
}
