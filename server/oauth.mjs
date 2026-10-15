// Fixed OAuth metadata verified from the providers' official MCP authorization servers.
// No URL, issuer, resource, or scope can be selected by a browser request.
export const OAUTH_PROVIDERS = Object.freeze({
  aweber: Object.freeze({ id: 'aweber', label: 'AWeber', issuer: 'https://mcp.aweber.com', authorizationEndpoint: 'https://mcp.aweber.com/oauth/authorize', tokenEndpoint: 'https://mcp.aweber.com/oauth/token', registrationEndpoint: 'https://mcp.aweber.com/oauth/register', resource: 'https://mcp.aweber.com', scopes: Object.freeze(['account.read', 'list.read', 'subscriber.read', 'email.read']), authMethods: Object.freeze(['none']) }),
  getresponse: Object.freeze({ id: 'getresponse', label: 'GetResponse', issuer: 'https://mcp.getresponse.com', authorizationEndpoint: 'https://mcp.getresponse.com:443/oauth/authorize', tokenEndpoint: 'https://mcp.getresponse.com:443/oauth/token', registrationEndpoint: 'https://mcp.getresponse.com:443/oauth/register', resource: 'https://mcp.getresponse.com', scopes: Object.freeze(['mcp:tools']), authMethods: Object.freeze(['none']) }),
  sandcastles: Object.freeze({ id: 'sandcastles', label: 'Sandcastles', issuer: 'https://signin.sandcastles.ai', authorizationEndpoint: 'https://signin.sandcastles.ai/oauth2/authorize', tokenEndpoint: 'https://signin.sandcastles.ai/oauth2/token', registrationEndpoint: 'https://signin.sandcastles.ai/oauth2/register', resource: 'https://mcp.sandcastles.ai/', scopes: Object.freeze(['openid']), authMethods: Object.freeze(['none', 'client_secret_post', 'client_secret_basic']) }),
});

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const STATE_SECONDS = 600, MAX_SESSION_SECONDS = 86400;
const consumedStates = new Map(); // Best-effort replay protection within this isolate, not a distributed session store.
function problem(code, message, status = 400) { return Object.assign(new Error(message), { code, status }); }
function providerFor(id) { if (typeof id !== 'string' || !Object.hasOwn(OAUTH_PROVIDERS, id)) throw problem('OAUTH_PROVIDER_UNSUPPORTED', 'OAuth is not available for this provider.', 404); return OAUTH_PROVIDERS[id]; }
function base64url(value) {
  let binary = ''; for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function unbase64url(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(value)) throw problem('OAUTH_NOT_CONFIGURED', 'OAuth requires a valid server session secret.', 503);
  try { return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4)), character => character.charCodeAt(0)); }
  catch { throw problem('OAUTH_NOT_CONFIGURED', 'OAuth requires a valid server session secret.', 503); }
}
async function sessionKey(env) {
  const key = unbase64url(env?.OAUTH_SESSION_SECRET);
  if (key.length !== 32 || base64url(key) !== env.OAUTH_SESSION_SECRET) throw problem('OAUTH_NOT_CONFIGURED', 'OAuth requires a server session secret containing 32 random bytes.', 503);
  return crypto.subtle.importKey('raw', key, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
function requestOrigin(request) {
  let url; try { url = new URL(request.url); } catch { throw problem('OAUTH_ORIGIN_INVALID', 'Use the application HTTPS address for OAuth.'); }
  const localhost = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && localhost))) throw problem('OAUTH_ORIGIN_INVALID', 'OAuth requires HTTPS, or HTTP on localhost.');
  return url.origin;
}
function nowSeconds(options = {}) { return Math.floor((options.now ? options.now() : Date.now()) / 1000); }
function cookieName(id, purpose, origin) { return `${origin.startsWith('https:') ? '__Host-' : ''}ea_oauth_${purpose}_${id}`; }
function cookieHeader(name, value, age, origin) {
  const result = `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${origin.startsWith('https:') ? '; Secure' : ''}`;
  if (result.length > 4096) throw problem('OAUTH_SESSION_TOO_LARGE', 'The provider credential exceeds this application session limit. OAuth was not connected.', 502);
  return result;
}
function readCookie(request, name) {
  const values = (request.headers.get('cookie') || '').split(';').map(part => part.trim()).filter(part => part.startsWith(`${name}=`)).map(part => part.slice(name.length + 1));
  return values.length === 1 && values[0].length <= 4096 ? values[0] : undefined;
}
async function seal(payload, key, id, purpose, origin) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const additionalData = encoder.encode(`easy-agent-oauth:v1:${id}:${purpose}:${origin}`);
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData }, key, encoder.encode(JSON.stringify(payload)));
  return `v1.${base64url(iv)}.${base64url(new Uint8Array(encrypted))}`;
}
async function open(value, key, id, purpose, origin) {
  try {
    if (typeof value !== 'string' || value.length > 4096) return undefined;
    const parts = value.split('.'); if (parts.length !== 3 || parts[0] !== 'v1') return undefined;
    const iv = unbase64url(parts[1]); if (iv.length !== 12) return undefined;
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(`easy-agent-oauth:v1:${id}:${purpose}:${origin}`) }, key, unbase64url(parts[2]));
    const payload = JSON.parse(decoder.decode(plaintext));
    return payload && typeof payload === 'object' && !Array.isArray(payload) && payload.v === 1 ? payload : undefined;
  } catch { return undefined; }
}
function json(value, status = 200, cookies = []) {
  const headers = new Headers({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Pragma: 'no-cache', 'Referrer-Policy': 'no-referrer' });
  for (const cookie of cookies) headers.append('Set-Cookie', cookie);
  return new Response(JSON.stringify(value), { status, headers });
}
function errorJson(error) {
  const publicCodes = new Set(['OAUTH_PROVIDER_UNSUPPORTED', 'OAUTH_NOT_CONFIGURED', 'OAUTH_ORIGIN_INVALID', 'OAUTH_METHOD_NOT_ALLOWED', 'OAUTH_ORIGIN_BLOCKED', 'OAUTH_SESSION_TOO_LARGE', 'OAUTH_PROVIDER_FAILED']);
  return json(publicCodes.has(error?.code) ? { error: error.code, message: error.message } : { error: 'OAUTH_REQUEST_FAILED', message: 'OAuth could not be completed. Try connecting again.' }, publicCodes.has(error?.code) ? error.status : 502);
}
function checkPost(request, origin) {
  if (request.method !== 'POST') throw problem('OAUTH_METHOD_NOT_ALLOWED', 'Use POST to change an OAuth connection.', 405);
  if ((request.headers.get('origin') && request.headers.get('origin') !== origin) || request.headers.get('sec-fetch-site') === 'cross-site') throw problem('OAUTH_ORIGIN_BLOCKED', 'OAuth must be started from this application.', 403);
}
async function providerJson(response) {
  if (!response.ok) { await response.body?.cancel().catch(() => {}); throw problem('OAUTH_PROVIDER_FAILED', 'The provider rejected OAuth setup. Check account access and try again.', 502); }
  let text = '', size = 0;
  const reader = response.body?.getReader();
  if (!reader) throw problem('OAUTH_PROVIDER_FAILED', 'The provider returned an empty OAuth response.', 502);
  const textDecoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    size += value.byteLength;
    if (size > 65536) { await reader.cancel(); throw problem('OAUTH_PROVIDER_FAILED', 'The provider OAuth response exceeded the response limit.', 502); }
    text += textDecoder.decode(value, { stream: true });
  }
  text += textDecoder.decode();
  let parsed; try { parsed = JSON.parse(text); } catch { throw problem('OAUTH_PROVIDER_FAILED', 'The provider returned an unreadable OAuth response.', 502); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.error) throw problem('OAUTH_PROVIDER_FAILED', 'The provider could not complete OAuth setup.', 502);
  return parsed;
}
function credential(value, max) { return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x20\x7f]/.test(value); }
function constantEqual(left, right) { if (typeof left !== 'string' || typeof right !== 'string' || left.length !== right.length) return false; let difference = 0; for (let index = 0; index < left.length; index++) difference |= left.charCodeAt(index) ^ right.charCodeAt(index); return difference === 0; }
function callbackURL(origin, id) { return `${origin}/api/integrations/oauth/callback/${id}`; }
function consumeState(providerId, state, expiresAt, now) {
  for (const [key, expiry] of consumedStates) if (expiry <= now) consumedStates.delete(key);
  const key = `${providerId}:${state}`;
  if (consumedStates.has(key)) throw problem('OAUTH_STATE_INVALID', 'This authorization flow was already used. Start a new connection.');
  // Provider authorization codes must also be one-use; this bounded isolate-local cache is additional protection.
  if (consumedStates.size >= 1024) consumedStates.delete(consumedStates.keys().next().value);
  consumedStates.set(key, expiresAt);
}
function redirectResult(origin, id, connected, cookies) {
  const destination = new URL('/', origin); destination.searchParams.set('integration', id); destination.searchParams.set('oauth', connected ? 'connected' : 'error');
  if (!connected) destination.searchParams.set('reason', 'authorization_failed');
  const headers = new Headers({ Location: destination.href, 'Cache-Control': 'no-store', Pragma: 'no-cache', 'Referrer-Policy': 'no-referrer' });
  for (const cookie of cookies) headers.append('Set-Cookie', cookie);
  return new Response(null, { status: 303, headers });
}

/** Explicit user action registers a public PKCE client, then directs the browser to provider consent. */
export async function startOAuth(providerId, request, env = {}, options = {}) {
  try {
    const provider = providerFor(providerId), origin = requestOrigin(request); checkPost(request, origin);
    const key = await sessionKey(env), now = nowSeconds(options);
    const redirectUri = callbackURL(origin, providerId);
    const registration = await providerJson(await (options.fetch || globalThis.fetch.bind(globalThis))(provider.registrationEndpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ client_name: 'Easy Agent AI', client_uri: origin, redirect_uris: [redirectUri], grant_types: ['authorization_code'], response_types: ['code'], token_endpoint_auth_method: 'none', scope: provider.scopes.join(' ') }), redirect: 'manual', signal: AbortSignal.timeout(15000) }));
    const authMethod = registration.token_endpoint_auth_method || 'none';
    if (!credential(registration.client_id, 256) || !provider.authMethods.includes(authMethod) || (authMethod !== 'none' && !credential(registration.client_secret, 1024))) throw problem('OAUTH_PROVIDER_FAILED', 'The provider returned an unsupported OAuth client registration.', 502);
    if (registration.redirect_uris && (!Array.isArray(registration.redirect_uris) || !registration.redirect_uris.includes(redirectUri))) throw problem('OAUTH_PROVIDER_FAILED', 'The provider did not accept this application callback address.', 502);
    const state = base64url(crypto.getRandomValues(new Uint8Array(32))), verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
    const challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(verifier))));
    const payload = { v: 1, state, verifier, clientId: registration.client_id, authMethod, ...(authMethod !== 'none' ? { clientSecret: registration.client_secret } : {}), redirectUri, issuedAt: now, expiresAt: now + STATE_SECONDS };
    const cookie = cookieHeader(cookieName(providerId, 'state', origin), await seal(payload, key, providerId, 'state', origin), STATE_SECONDS, origin);
    const authorization = new URL(provider.authorizationEndpoint);
    for (const [name, value] of Object.entries({ response_type: 'code', client_id: registration.client_id, redirect_uri: redirectUri, scope: provider.scopes.join(' '), state, code_challenge: challenge, code_challenge_method: 'S256', resource: provider.resource })) authorization.searchParams.set(name, value);
    return json({ authorizationUrl: authorization.href }, 200, [cookie]);
  } catch (error) { return errorJson(error); }
}

/** The provider consent callback exchanges the one-use code entirely on the server. */
export async function callbackOAuth(providerId, request, env = {}, options = {}) {
  let origin, cleared;
  try {
    const provider = providerFor(providerId); origin = requestOrigin(request);
    cleared = cookieHeader(cookieName(providerId, 'state', origin), '', 0, origin);
    if (request.method !== 'GET') return redirectResult(origin, providerId, false, [cleared]);
    const key = await sessionKey(env), now = nowSeconds(options), query = new URL(request.url).searchParams;
    const flow = await open(readCookie(request, cookieName(providerId, 'state', origin)), key, providerId, 'state', origin);
    if (!flow || !Number.isInteger(flow.issuedAt) || !Number.isInteger(flow.expiresAt) || flow.issuedAt > now + 30 || flow.expiresAt <= now || flow.expiresAt - flow.issuedAt > STATE_SECONDS || !constantEqual(flow.state, query.get('state')) || flow.redirectUri !== callbackURL(origin, providerId) || !credential(flow.verifier, 128) || !credential(flow.clientId, 256) || !provider.authMethods.includes(flow.authMethod)) throw problem('OAUTH_STATE_INVALID', 'The authorization state is missing, expired or invalid.');
    consumeState(providerId, flow.state, flow.expiresAt, now);
    if (query.has('error') || !credential(query.get('code'), 4096)) throw problem('OAUTH_CODE_INVALID', 'Authorization was declined or no valid code was returned.');
    const body = new URLSearchParams({ grant_type: 'authorization_code', code: query.get('code'), redirect_uri: flow.redirectUri, client_id: flow.clientId, code_verifier: flow.verifier, resource: provider.resource });
    const headers = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
    if (flow.authMethod === 'client_secret_post') {
      if (!credential(flow.clientSecret, 1024)) throw problem('OAUTH_STATE_INVALID', 'OAuth client authentication is unavailable.');
      body.set('client_secret', flow.clientSecret);
    } else if (flow.authMethod === 'client_secret_basic') {
      if (!credential(flow.clientSecret, 1024)) throw problem('OAUTH_STATE_INVALID', 'OAuth client authentication is unavailable.');
      const encode = value => new URLSearchParams({ value }).toString().slice(6);
      headers.Authorization = `Basic ${btoa(`${encode(flow.clientId)}:${encode(flow.clientSecret)}`)}`;
    }
    const tokens = await providerJson(await (options.fetch || globalThis.fetch.bind(globalThis))(provider.tokenEndpoint, { method: 'POST', headers, body, redirect: 'manual', signal: AbortSignal.timeout(15000) }));
    const lifetime = tokens.expires_in === undefined ? 3600 : Number(tokens.expires_in);
    if (!credential(tokens.access_token, 4096) || String(tokens.token_type || 'Bearer').toLowerCase() !== 'bearer' || !Number.isFinite(lifetime) || lifetime < 1 || (tokens.scope !== undefined && (typeof tokens.scope !== 'string' || tokens.scope.length > 1000))) throw problem('OAUTH_PROVIDER_FAILED', 'The provider returned an invalid or unsupported OAuth token.', 502);
    const seconds = Math.min(Math.floor(lifetime), MAX_SESSION_SECONDS);
    const account = { v: 1, accessToken: tokens.access_token, issuedAt: now, expiresAt: now + seconds, scope: tokens.scope || provider.scopes.join(' ') };
    const cookie = cookieHeader(cookieName(providerId, 'account', origin), await seal(account, key, providerId, 'account', origin), seconds, origin);
    return redirectResult(origin, providerId, true, [cleared, cookie]);
  } catch (error) {
    return origin && cleared ? redirectResult(origin, providerId, false, [cleared]) : errorJson(error);
  }
}
async function accountSession(providerId, request, env, options = {}) {
  providerFor(providerId); const origin = requestOrigin(request), key = await sessionKey(env);
  const account = await open(readCookie(request, cookieName(providerId, 'account', origin)), key, providerId, 'account', origin);
  const now = nowSeconds(options);
  if (!account || !credential(account.accessToken, 4096) || !Number.isInteger(account.expiresAt) || !Number.isInteger(account.issuedAt) || account.issuedAt > now + 30 || account.expiresAt - account.issuedAt > MAX_SESSION_SECONDS) return undefined;
  return account;
}
/** Backend-only accessor. Its return value must never be included in a browser response or log. */
export async function getOAuthToken(providerId, request, env = {}, options = {}) {
  try { const account = await accountSession(providerId, request, env, options); return account && account.expiresAt > nowSeconds(options) ? account.accessToken : undefined; } catch { return undefined; }
}
export async function oauthStatus(providerId, request, env = {}, options = {}) {
  try {
    providerFor(providerId); await sessionKey(env);
    const account = await accountSession(providerId, request, env, options), connected = !!account && account.expiresAt > nowSeconds(options);
    return { supported: true, configured: true, connected, ...(account ? { expiresAt: new Date(account.expiresAt * 1000).toISOString(), scope: account.scope } : {}), reason: connected ? 'Authorized for this browser session.' : account ? 'Authorization expired. Connect again.' : 'Provider authorization required.' };
  } catch { return { supported: Object.hasOwn(OAUTH_PROVIDERS, providerId), configured: false, connected: false, reason: 'OAuth server configuration required.' }; }
}
/** Removes this browser's encrypted session; it does not revoke provider consent or change account data. */
export async function disconnectOAuth(providerId, request, env = {}, options = {}) {
  try {
    providerFor(providerId); const origin = requestOrigin(request); checkPost(request, origin);
    return json({ disconnected: true }, 200, ['state', 'account'].map(purpose => cookieHeader(cookieName(providerId, purpose, origin), '', 0, origin)));
  } catch (error) { return errorJson(error); }
}
