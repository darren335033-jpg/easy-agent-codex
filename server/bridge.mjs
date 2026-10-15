// Worker-compatible gateway for a server-configured, authenticated companion.
// Browser input cannot choose the destination, signing key, or forwarded headers.
const encoder = new TextEncoder();
const MAX_REQUEST = 500000;
const MAX_RESPONSE = 8 * 1024 * 1024;
const GET_PATHS = new Set(['/api/status', '/api/provider/models', '/api/repository/status', '/api/coding/runs', '/api/companion/cli/status', '/api/usage']);
const POST_PATHS = new Set(['/api/repository/tree', '/api/repository/read', '/api/repository/search', '/api/repository/apply', '/api/repository/test', '/api/repository/git/status', '/api/repository/git/diff', '/api/repository/git/branch', '/api/repository/git/commit', '/api/coding/start', '/api/integrations/cli/run']);
const RUN_PATH = /^\/api\/coding\/runs\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?:\/(apply|cancel))?$/;
function problem(code, message, status = 502) { return Object.assign(new Error(message), { code, status }); }
function base64url(bytes) { let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte); return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function signingBytes(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) return null;
  try { const bytes = Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='), value => value.charCodeAt(0)); return bytes.length === 32 && base64url(bytes) === value ? bytes : null; } catch { return null; }
}
function publicIpv4(host) {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(host)) return null;
  const [a, b, c] = host.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 100 && b >= 64 && b <= 127 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && (b === 168 || b === 0 || b === 88 && c === 99) || a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) || a === 203 && b === 0 && c === 113);
}
function publicIpv6(host) {
  const halves = host.slice(1, -1).split('::');
  const left = halves[0] ? halves[0].split(':') : [], right = halves[1] ? halves[1].split(':') : [];
  const gap = 8 - left.length - right.length;
  if (halves.length > 2 || halves.length === 1 && gap !== 0 || halves.length === 2 && gap < 1) return false;
  const words = [...left, ...Array(halves.length === 2 ? gap : 0).fill('0'), ...right];
  if (words.length !== 8 || words.some(word => !/^[a-f0-9]{1,4}$/.test(word))) return false;
  const [first, second] = words.map(word => parseInt(word, 16));
  return (first & 0xe000) === 0x2000 && first !== 0x2002 && !(first === 0x2001 && [0, 2, 0xdb8].includes(second));
}
function endpointFor(env, options = {}) {
  const configured = env?.FORGE_COMPANION_URL;
  if (typeof configured !== 'string' || configured !== configured.trim() || !configured) return null;
  let url; try { url = new URL(configured); } catch { return null; }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') return null;
  if (options.allowLocal === true && url.hostname === '127.0.0.1' && ['http:', 'https:'].includes(url.protocol)) return url;
  if (url.protocol !== 'https:' || url.port) return null;
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host === 'local' || host === 'internal') return null;
  const v4 = publicIpv4(host);
  if (v4 !== null) return v4 ? url : null;
  if (host.startsWith('[')) {
    // Permit global unicast only, excluding documentation, Teredo and 6to4.
    return publicIpv6(host) ? url : null;
  }
  return host.includes('.') ? url : null;
}
function response(data, status = 200, provenance = 'gateway') {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'X-EA-Bridge': provenance } });
}
function allowedMethod(pathname) {
  if (GET_PATHS.has(pathname)) return 'GET';
  if (POST_PATHS.has(pathname)) return 'POST';
  const run = RUN_PATH.exec(pathname);
  return run ? run[1] ? 'POST' : 'GET' : null;
}
export function isCompanionRequest(method, pathname) {
  return typeof method === 'string' && typeof pathname === 'string' && allowedMethod(pathname) === method;
}

/** Returns safe configuration metadata, never the signing key or a URL path/query. */
export function bridgeStatus(env = {}, options = {}) {
  const endpoint = endpointFor(env, options), secretConfigured = !!signingBytes(env?.FORGE_COMPANION_SECRET);
  const endpointConfigured = !!endpoint;
  return { configured: endpointConfigured && secretConfigured, endpointConfigured, secretConfigured, ...(endpoint ? { endpoint: endpoint.origin } : {}), reason: !endpointConfigured ? 'Configure a public HTTPS companion origin on the server; paths, credentials, queries and custom ports are not supported.' : !secretConfigured ? 'Configure the shared companion secret as canonical base64url for 32 random bytes on both servers.' : 'Companion routing is configured. Connectivity and authentication are verified by each request.' };
}

async function readBounded(body, maximum, signal, code, message) {
  if (!body) return new Uint8Array();
  const reader = body.getReader(); let abort;
  const cancelled = new Promise((resolve, reject) => { abort = () => reject(problem('BRIDGE_CANCELLED', 'Companion request was cancelled.', 408)); if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true }); });
  let size = 0; const chunks = [];
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), cancelled]);
      if (done) break;
      size += value.byteLength;
      if (size > maximum) throw problem(code, message, code === 'BRIDGE_REQUEST_TOO_LARGE' ? 413 : 502);
      chunks.push(value);
    }
    const joined = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
    return joined;
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { signal.removeEventListener('abort', abort); reader.releaseLock(); }
}
function parseJson(bytes, upstream = false) {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw problem(upstream ? 'BRIDGE_INVALID_RESPONSE' : 'BRIDGE_INVALID_REQUEST', upstream ? 'The companion returned an invalid JSON response.' : 'Send a valid JSON request body.', upstream ? 502 : 400); }
}
function upstreamError(status) {
  const descriptions = { 400: 'The companion rejected this request. Check the selected task and repository.', 401: 'Companion authentication failed. Check the shared server configuration.', 403: 'Companion access was denied. Check the shared server configuration.', 404: 'The requested companion resource was not found.', 405: 'This action is not supported by the companion.', 408: 'The companion request was cancelled or timed out.', 409: 'The repository or run changed. Refresh before retrying this action.', 413: 'The companion request exceeded its size limits.', 429: 'The companion is busy. Wait for active tasks to finish.' };
  return { error: status === 409 ? 'FILE_CONFLICT' : 'COMPANION_REQUEST_FAILED', message: descriptions[status] || 'The companion could not complete this request. Check the local server.' };
}

/** Proxy only approved JSON API routes, signed over their exact method/path/body. */
export async function proxyCompanion(request, env = {}, options = {}) {
  let timer, controller, onAbort;
  try {
    const config = bridgeStatus(env, options);
    if (!config.configured) throw problem('BRIDGE_NOT_CONFIGURED', config.reason, 503);
    const endpoint = endpointFor(env, options), input = new URL(request.url);
    if (input.origin === endpoint.origin) throw problem('BRIDGE_LOOP_BLOCKED', 'The companion origin must differ from this application origin.', 503);
    if (input.search || input.hash) throw problem('BRIDGE_INVALID_REQUEST', 'Companion API requests must not include query strings or fragments.', 400);
    const method = allowedMethod(input.pathname);
    if (!method) throw problem('BRIDGE_ROUTE_NOT_ALLOWED', 'This API route is not available through the companion bridge.', 404);
    if (request.method !== method) throw problem('BRIDGE_METHOD_NOT_ALLOWED', 'Use the documented method for this companion API route.', 405);
    if (method === 'POST' && (request.headers.get('origin') && request.headers.get('origin') !== input.origin || request.headers.get('sec-fetch-site') === 'cross-site')) throw problem('BRIDGE_ORIGIN_BLOCKED', 'Companion actions must originate from this application.', 403);
    if (method === 'POST' && request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw problem('BRIDGE_INVALID_REQUEST', 'Send application/json for companion actions.', 415);
    if (Number(request.headers.get('content-length')) > MAX_REQUEST) throw problem('BRIDGE_REQUEST_TOO_LARGE', 'Companion request exceeds the 500,000-byte limit.', 413);
    if (method === 'GET' && request.body) throw problem('BRIDGE_INVALID_REQUEST', 'Read-only companion requests must not contain a body.', 400);
    const budget = input.pathname === '/api/repository/test' ? 35000 : 15000;
    const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? Math.min(options.timeoutMs, budget) : budget;
    controller = new AbortController();
    const signal = request.signal ? AbortSignal.any([request.signal, controller.signal]) : controller.signal;
    const cancelled = new Promise((resolve, reject) => { onAbort = () => reject(problem('BRIDGE_CANCELLED', 'Companion request was cancelled.', 408)); if (request.signal?.aborted) onAbort(); else request.signal?.addEventListener('abort', onAbort, { once: true }); });
    const deadline = new Promise((resolve, reject) => { timer = setTimeout(() => { reject(problem('BRIDGE_TIMEOUT', 'The companion did not respond before the deadline. Check task status before retrying an action.', 504)); controller.abort(); }, timeoutMs); });
    return await Promise.race([(async () => {
      if (signal.aborted) throw problem('BRIDGE_CANCELLED', 'Companion request was cancelled.', 408);
      const body = method === 'POST' ? await readBounded(request.body, MAX_REQUEST, signal, 'BRIDGE_REQUEST_TOO_LARGE', 'Companion request exceeds the 500,000-byte limit.') : new Uint8Array();
      if (method === 'POST') parseJson(body);
      const timestamp = String(Math.floor(Date.now() / 1000)), nonce = base64url(crypto.getRandomValues(new Uint8Array(16)));
      const bodyHash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', body))].map(value => value.toString(16).padStart(2, '0')).join('');
      const key = await crypto.subtle.importKey('raw', signingBytes(env.FORGE_COMPANION_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      const canonical = `${timestamp}\n${nonce}\n${method}\n${input.pathname}\n${bodyHash}`;
      const signature = base64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(canonical))));
      if (signal.aborted) throw problem('BRIDGE_CANCELLED', 'Companion request was cancelled.', 408);
      const fetcher = options.fetch || (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : undefined);
      if (typeof fetcher !== 'function') throw problem('BRIDGE_UNAVAILABLE', 'Companion transport is unavailable.', 503);
      const upstream = await fetcher(new URL(input.pathname, endpoint).href, { method, headers: { Accept: 'application/json', ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}), 'X-EA-Timestamp': timestamp, 'X-EA-Nonce': nonce, 'X-EA-Signature': signature }, ...(method === 'POST' ? { body } : {}), redirect: 'manual', signal });
      if (upstream.status >= 300 && upstream.status < 400) { await upstream.body?.cancel().catch(() => {}); throw problem('BRIDGE_REDIRECT_BLOCKED', 'Companion redirects are not allowed. Configure its final HTTPS origin.', 502); }
      if (upstream.status < 200 || upstream.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') { await upstream.body?.cancel().catch(() => {}); throw problem('BRIDGE_INVALID_RESPONSE', 'The companion returned an unsupported response.', 502); }
      if (Number(upstream.headers.get('content-length')) > MAX_RESPONSE) { await upstream.body?.cancel().catch(() => {}); throw problem('BRIDGE_RESPONSE_TOO_LARGE', 'Companion response exceeds the 8 MiB limit.', 502); }
      const result = parseJson(await readBounded(upstream.body, MAX_RESPONSE, signal, 'BRIDGE_RESPONSE_TOO_LARGE', 'Companion response exceeds the 8 MiB limit.'), true);
      if (!upstream.ok) return response(upstreamError(upstream.status), upstream.status, 'companion');
      // The peer can return source data, but must never disclose the shared key.
      const safe = JSON.stringify(result).split(env.FORGE_COMPANION_SECRET).join('[redacted]');
      return new Response(safe, { status: upstream.status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'X-EA-Bridge': 'companion' } });
    })(), deadline, cancelled]);
  } catch (error) {
    controller?.abort();
    if (typeof error?.code === 'string' && error.code.startsWith('BRIDGE_')) return response({ error: error.code, message: error.message }, error.status);
    return response({ error: 'BRIDGE_NETWORK_ERROR', message: 'The companion could not be reached. Check its tunnel and local server.' }, 502);
  } finally { clearTimeout(timer); request.signal?.removeEventListener('abort', onAbort); }
}
