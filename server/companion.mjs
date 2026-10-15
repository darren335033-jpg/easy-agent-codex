import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { handleApi, json } from './api.mjs';
import { createLocalServices } from './local-service.mjs';
import { createCompanionVerifier } from './bridge-auth.mjs';

const exec = promisify(execFile);
const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_BODY = 500_000;
const MAX_RESPONSE = 8 * 1024 * 1024;
const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const record = new RegExp(`^/api/coding/runs/${uuid}$`);
const action = new RegExp(`^/api/coding/runs/${uuid}/(?:cancel|apply)$`);
const getPaths = new Set(['/api/status', '/api/repository/status', '/api/provider/models', '/api/coding/runs', '/api/companion/cli/status', '/api/usage']);
const postPaths = new Set(['/api/repository/tree', '/api/repository/read', '/api/repository/search', '/api/repository/apply', '/api/repository/test', '/api/repository/git/status', '/api/repository/git/diff', '/api/repository/git/branch', '/api/repository/git/commit', '/api/coding/start', '/api/integrations/cli/run']);
const fail = (message, status = 400, code = 'COMPANION_REQUEST_INVALID') => Object.assign(new Error(message), { status, code });

export function companionRouteAllowed(method, pathname) {
  return method === 'GET' ? getPaths.has(pathname) || record.test(pathname) : method === 'POST' && (postPaths.has(pathname) || action.test(pathname));
}

async function requestBody(request) {
  const declared = request.headers['content-length'];
  if (declared !== undefined && (!/^[0-9]+$/.test(declared) || Number(declared) > MAX_BODY)) throw fail('Request exceeds the 500,000-byte limit.', 413, 'COMPANION_BODY_TOO_LARGE');
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let finished = false;
    const done = (error, value) => {
      if (finished) return;
      finished = true;
      request.removeListener('data', receive);
      request.removeListener('end', end);
      request.removeListener('error', abort);
      request.removeListener('aborted', abort);
      if (error) { request.resume(); reject(error); } else resolve(value);
    };
    const receive = chunk => {
      bytes += chunk.length;
      if (bytes > MAX_BODY) { done(fail('Request exceeds the 500,000-byte limit.', 413, 'COMPANION_BODY_TOO_LARGE')); return; }
      chunks.push(chunk);
    };
    const end = () => done(null, Buffer.concat(chunks, bytes));
    const abort = () => done(fail('Request was interrupted.', 408, 'COMPANION_REQUEST_INTERRUPTED'));
    request.on('data', receive);
    request.on('end', end);
    request.on('error', abort);
    request.on('aborted', abort);
  });
}

async function boundedResponse(response) {
  const chunks = [];
  let bytes = 0;
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    bytes += value.length;
    if (bytes > MAX_RESPONSE) { await reader.cancel(); throw fail('Companion response exceeded its size limit.', 502, 'COMPANION_RESPONSE_TOO_LARGE'); }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, bytes);
}

/** Dedicated signed API listener. HTTPS belongs at the authenticated tunnel/proxy. */
export async function createCompanionServer({ env = process.env, appRoot = defaultRoot, services } = {}) {
  const verifier = createCompanionVerifier(env.FORGE_COMPANION_SECRET);
  const port = Number(env.COMPANION_PORT === undefined || env.COMPANION_PORT === '' ? 3001 : env.COMPANION_PORT);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw fail('COMPANION_PORT must be between 1024 and 65535.', 503, 'COMPANION_PORT_INVALID');
  if (typeof appRoot !== 'string' || !path.isAbsolute(appRoot)) throw fail('Configure an absolute application directory.', 503);
  let hasADC = false;
  try { await access(env.GOOGLE_APPLICATION_CREDENTIALS || path.join(env.HOME || os.homedir(), '.config/gcloud/application_default_credentials.json'), constants.R_OK); hasADC = true; } catch {}
  async function tokenProvider() {
    try {
      const { stdout } = await exec(env.GCLOUD_BIN || 'gcloud', ['auth', 'application-default', 'print-access-token'], { timeout: 15_000, maxBuffer: 16_384, env });
      const token = stdout.trim();
      if (!token || token.length > 16_000 || /\s/.test(token)) throw new Error();
      return token;
    } catch { throw fail('Google Application Default Credentials are unavailable on the companion.', 503, 'PROVIDER_NOT_CONFIGURED'); }
  }
  const localServices = services || await createLocalServices({ env, appRoot, ...(hasADC ? { tokenProvider } : {}) });
  if (!localServices || typeof localServices.route !== 'function' || typeof localServices.stop !== 'function') throw fail('Companion services are unavailable.', 503);
  const controllers = new Set();
  let shutdown;
  const server = http.createServer({ maxHeaderSize: 8192, requestTimeout: 30_000, headersTimeout: 10_000 }, async (req, res) => {
    const controller = new AbortController();
    controllers.add(controller);
    req.on('aborted', () => controller.abort());
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });
    try {
      if (req.headers.origin || req.headers['sec-fetch-site']) throw fail('Browser requests cannot access the signed companion API.', 403, 'COMPANION_BROWSER_BLOCKED');
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.url !== url.pathname || !req.url.startsWith('/') || req.url.startsWith('//')) throw fail('Companion routes do not accept queries or alternate paths.', 404, 'NOT_FOUND');
      if (req.method === 'GET' && url.pathname === '/health') {
        if (req.headers['transfer-encoding'] || (req.headers['content-length'] && req.headers['content-length'] !== '0')) throw fail('Health requests must not contain a body.');
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        res.end('{"ready":true}');
        return;
      }
      if (!companionRouteAllowed(req.method, url.pathname)) throw fail('Companion route not found.', 404, 'NOT_FOUND');
      const raw = await requestBody(req);
      if (req.method === 'GET' && raw.length) throw fail('GET requests must not contain a body.');
      if (req.method === 'POST' && !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] || '')) throw fail('Companion actions require JSON.', 415, 'COMPANION_CONTENT_TYPE');
      await verifier.verify({ method: req.method, pathname: url.pathname, headers: req.headers, body: raw });
      const actualPort = server.address()?.port || port;
      const request = new Request(`http://127.0.0.1:${actualPort}${url.pathname}`, { method: req.method, headers: { Accept: 'application/json', ...(req.method === 'POST' ? { 'Content-Type': 'application/json' } : {}) }, ...(req.method === 'POST' ? { body: raw } : {}), signal: controller.signal });
      const response = await handleApi(request, env, { runtime: 'local', hasADC, ...(hasADC ? { tokenProvider } : {}), providerHealth: localServices.health, cliRun: localServices.cliRun, localHandler: async (endpoint, input, trustedRequest) => {
        if (endpoint === '/api/companion/cli/status') {
          if (typeof localServices.cliStatus !== 'function') throw fail('Companion CLI services are unavailable.', 503);
          return json(await localServices.cliStatus());
        }
        const result = await localServices.route(endpoint, input, trustedRequest);
        return json(result.data, result.statusCode || 200);
      } });
      const payload = await boundedResponse(response);
      res.writeHead(response.status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(payload);
    } catch (error) {
      if (!res.destroyed && !res.headersSent) {
        const status = Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : 500;
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', Connection: 'close' });
        res.end(JSON.stringify({ error: error.status ? error.code || 'COMPANION_REQUEST_FAILED' : 'COMPANION_REQUEST_FAILED', message: error.status ? error.message : 'Companion request could not complete.' }));
      }
    } finally { controllers.delete(controller); }
  });
  server.keepAliveTimeout = 5000;
  async function stop() {
    if (!shutdown) shutdown = (async () => {
      const closed = new Promise(resolve => server.close(() => resolve()));
      for (const controller of controllers) controller.abort();
      server.closeIdleConnections();
      try { await localServices.stop(); }
      finally { server.closeAllConnections(); await closed; }
    })();
    return shutdown;
  }
  async function listen() {
    if (server.listening) return server.address();
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
    });
    return server.address();
  }
  return { server, services: localServices, listen, stop };
}

async function main() {
  try { process.loadEnvFile(path.join(defaultRoot, '.env')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const companion = await createCompanionServer({ env: process.env, appRoot: defaultRoot });
  const address = await companion.listen();
  console.log(`Easy Agent AI signed companion: http://127.0.0.1:${address.port}`);
  console.log('Expose this listener only through your configured HTTPS tunnel or reverse proxy.');
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    try { await companion.stop(); process.exit(0); }
    catch { console.error('Companion shutdown did not complete.'); process.exit(1); }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.status ? error.message : 'Companion startup failed. Check local configuration.'); process.exitCode = 1; });
}
