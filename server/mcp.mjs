const PROTOCOL = '2025-03-26';
const GOOGLE_PROTOCOL = '2026-07-28';
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_TOOLS = 1000;
const MAX_PAGES = 10;

function failure(message, status = 502, code = 'MCP_ERROR') {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function normalizedHost(value) {
  return String(value).toLowerCase().replace(/\.$/, '');
}

function ipv4Parts(host) {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(host)) return null;
  const parts = host.split('.').map(Number);
  return parts.every(part => part >= 0 && part <= 255) ? parts : null;
}

function publicIpv4(parts) {
  const [a, b, c] = parts;
  return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113));
}

function ipv6Words(host) {
  if (!host.startsWith('[') || !host.endsWith(']')) return null;
  const address = host.slice(1, -1);
  if (!/^[0-9a-f:]+$/i.test(address)) return null;
  const halves = address.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const gap = 8 - left.length - right.length;
  if ((halves.length === 1 && gap !== 0) || (halves.length === 2 && gap < 1)) return null;
  const words = [...left, ...Array(halves.length === 2 ? gap : 0).fill('0'), ...right];
  if (words.length !== 8 || words.some(word => !/^[0-9a-f]{1,4}$/i.test(word))) return null;
  return words.map(word => parseInt(word, 16));
}

function publicIpv6(words) {
  // Only global unicast is eligible. This also excludes IPv4-mapped addresses,
  // unique-local, link-local, site-local, unspecified and multicast addresses.
  if ((words[0] & 0xe000) !== 0x2000) return false;
  if (words[0] === 0x2001 && (words[1] === 0 || words[1] === 2 || words[1] === 0xdb8)) return false;
  // 6to4 can encode a private IPv4 destination.
  if (words[0] === 0x2002) return false;
  return true;
}

function checkedEndpoint(value, options) {
  let endpoint;
  try {
    if (typeof value !== 'string' || value.length > 4096) throw new Error();
    endpoint = new URL(value);
  } catch {
    throw failure('Enter a valid MCP endpoint URL.', 400, 'MCP_URL_INVALID');
  }
  if (endpoint.username || endpoint.password || endpoint.hash) {
    throw failure('MCP URLs must not contain credentials or a fragment.', 400, 'MCP_URL_INVALID');
  }
  const host = normalizedHost(endpoint.hostname);
  const v4 = ipv4Parts(host);
  const v6 = ipv6Words(host);
  const loopback = host === 'localhost' || (v4 && v4[0] === 127) ||
    (v6 && v6.slice(0, 7).every(word => word === 0) && v6[7] === 1);
  if (options.allowLocal === true && loopback) {
    if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') {
      throw failure('Local MCP endpoints must use HTTP or HTTPS.', 400, 'MCP_URL_INVALID');
    }
    return endpoint;
  }
  if (endpoint.protocol !== 'https:') {
    throw failure('MCP endpoints must use HTTPS.', 400, 'MCP_URL_INVALID');
  }
  if (loopback || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') ||
    host === 'local' || host === 'internal' || !host.includes('.') && !v6 ||
    (v4 && !publicIpv4(v4)) || (v6 && !publicIpv6(v6))) {
    throw failure('This MCP destination is not a public endpoint.', 403, 'MCP_DESTINATION_BLOCKED');
  }
  // This must come from server configuration, never from the connection request.
  // An explicit hostname allowlist is necessary in runtimes without DNS pinning.
  const configured = typeof options.allowedHosts === 'string'
    ? options.allowedHosts.split(',')
    : options.allowedHosts instanceof Set ? [...options.allowedHosts] : options.allowedHosts;
  const allowed = Array.isArray(configured) && configured.some(entry =>
    typeof entry === 'string' && normalizedHost(entry.trim()) === host);
  if (!allowed) {
    throw failure('MCP endpoint is not in the configured host allowlist.', 403, 'MCP_HOST_NOT_ALLOWED');
  }
  return endpoint;
}

function sseMessage(event) {
  const data = event.replace(/\r\n?/g, '\n').split('\n').filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).replace(/^ /, '')).join('\n');
  if (!data) return null;
  try {
    return JSON.parse(data);
  } catch {
    throw failure('MCP server returned an invalid JSON-RPC response.', 502, 'MCP_INVALID_RESPONSE');
  }
}

async function limitedText(response, id) {
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw failure('MCP response exceeds the size limit.', 502, 'MCP_RESPONSE_TOO_LARGE');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let result = '';
  let pending = '';
  const streaming = (response.headers.get('content-type') || '').toLowerCase().includes('text/event-stream');
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        throw failure('MCP response exceeds the size limit.', 502, 'MCP_RESPONSE_TOO_LARGE');
      }
      const chunk = decoder.decode(value, { stream: true });
      result += chunk;
      if (streaming) {
        pending += chunk;
        for (;;) {
          const boundary = /\r\n\r\n|\n\n|\r\r/.exec(pending);
          if (!boundary) break;
          const event = pending.slice(0, boundary.index);
          pending = pending.slice(boundary.index + boundary[0].length);
          const message = sseMessage(event);
          if (message?.jsonrpc === '2.0' && message.id === id) {
            // Some servers keep SSE connections open after the response. Once
            // the matching response arrives, close our stream rather than wait.
            await reader.cancel().catch(() => {});
            return `data: ${JSON.stringify(message)}\n\n`;
          }
        }
      }
    }
    return result + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

function rpcResult(text, response, id) {
  let messages;
  try {
    if ((response.headers.get('content-type') || '').toLowerCase().includes('text/event-stream')) {
      messages = text.replace(/\r\n?/g, '\n').split('\n\n').flatMap(event => {
        const message = sseMessage(event);
        return message ? [message] : [];
      });
    } else {
      messages = [JSON.parse(text)];
    }
  } catch {
    throw failure('MCP server returned an invalid JSON-RPC response.', 502, 'MCP_INVALID_RESPONSE');
  }
  const message = messages.find(value => value && value.jsonrpc === '2.0' && value.id === id);
  if (!message || (!Object.hasOwn(message, 'result') && !Object.hasOwn(message, 'error'))) {
    throw failure('MCP server returned an invalid JSON-RPC response.', 502, 'MCP_INVALID_RESPONSE');
  }
  if (message.error) throw failure('MCP server rejected the protocol request.', 502, 'MCP_RPC_ERROR');
  if (!message.result || typeof message.result !== 'object' || Array.isArray(message.result)) {
    throw failure('MCP server returned an invalid JSON-RPC result.', 502, 'MCP_INVALID_RESPONSE');
  }
  return message.result;
}

/**
 * Perform read-only MCP connection discovery. Public destinations require an
 * administrator-configured exact hostname in options.allowedHosts. allowLocal
 * is for a trusted local runtime only; it permits loopback, never LAN hosts.
 * Credentials are used for this request and are never returned or persisted.
 */
export async function testMcpConnection({ url, token } = {}, options = { allowLocal: false }) {
  const endpoint = checkedEndpoint(url, options);
  if (token != null && (typeof token !== 'string' || token.length > 16384 || /[\r\n\0]/.test(token))) {
    throw failure('The MCP credential format is invalid.', 400, 'MCP_CREDENTIAL_INVALID');
  }
  // Native Worker fetch implementations may require their global receiver.
  const fetcher = options.fetch || (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : undefined);
  if (typeof fetcher !== 'function') throw failure('MCP HTTP transport is unavailable.', 503, 'MCP_UNAVAILABLE');
  const controller = new AbortController();
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? Math.min(options.timeoutMs, 60000) : 12000;
  let timeout;
  const timedOut = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(failure('MCP connection timed out.', 504, 'MCP_TIMEOUT'));
    }, timeoutMs);
  });
  const google = endpoint.hostname === 'aiplatform.googleapis.com' && endpoint.pathname.startsWith('/mcp/');
  let protocol = google ? GOOGLE_PROTOCOL : PROTOCOL;
  let session;
  let nextId = 1;
  const perform = async (method, params, notification = false) => {
    const id = notification ? undefined : nextId++;
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': protocol,
    };
    if (token) headers.authorization = `Bearer ${token}`;
    if (session) headers['Mcp-Session-Id'] = session;
    const payload = { jsonrpc: '2.0', ...(notification ? {} : { id }), method, ...(params === undefined ? {} : { params }) };
    const response = await fetcher(endpoint.href, {
      method: 'POST', headers, body: JSON.stringify(payload),
      // POST does not use the HTTP response cache. Browser-only credentials/cache
      // options are omitted for Workers that reject unsupported RequestInit fields.
      // Workers support manual redirect handling; reject 3xx below without
      // forwarding server credentials to the redirect destination.
      redirect: 'manual', signal: controller.signal,
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      if (response.status === 401) throw failure('MCP authentication failed. Check the configured credential.', 401, 'MCP_AUTH_FAILED');
      if (response.status === 403) throw failure('MCP access was denied. Check the configured account permissions.', 403, 'MCP_ACCESS_DENIED');
      if (response.status === 429) throw failure('MCP server rate limit reached. Try again later.', 429, 'MCP_RATE_LIMITED');
      throw failure('MCP server returned an unsuccessful HTTP response.', 502, 'MCP_HTTP_ERROR');
    }
    const sessionHeader = response.headers.get('mcp-session-id');
    if (method === 'initialize' && sessionHeader) {
      if (sessionHeader.length > 2048 || /[^\x21-\x7e]/.test(sessionHeader)) {
        throw failure('MCP server returned an invalid session identifier.', 502, 'MCP_INVALID_RESPONSE');
      }
      session = sessionHeader;
    }
    if (notification) {
      await response.body?.cancel().catch(() => {});
      return undefined;
    }
    const body = await limitedText(response, id);
    return rpcResult(body, response, id);
  };
  const discover = async () => {
    let name = 'Google Vertex AI';
    let version = GOOGLE_PROTOCOL;
    if (!google) {
      const result = await perform('initialize', {
        protocolVersion: PROTOCOL,
        capabilities: {},
        clientInfo: { name: 'Dazza Forge', version: '1.0.0' },
      });
      if (typeof result.protocolVersion !== 'string' || !/^20\d\d-\d\d-\d\d$/.test(result.protocolVersion) ||
        !result.serverInfo || typeof result.serverInfo.name !== 'string' || !result.serverInfo.name.trim() ||
        typeof result.serverInfo.version !== 'string' || !result.serverInfo.version.trim()) {
        throw failure('MCP initialization response is incomplete.', 502, 'MCP_INVALID_RESPONSE');
      }
      // Streamable HTTP was introduced in 2025-03-26. Older negotiated versions
      // require a different transport and cannot be safely assumed compatible.
      if (result.protocolVersion < PROTOCOL) {
        throw failure('MCP server requires an unsupported transport version.', 502, 'MCP_PROTOCOL_UNSUPPORTED');
      }
      protocol = result.protocolVersion;
      name = result.serverInfo.name.slice(0, 200);
      version = result.serverInfo.version.slice(0, 100);
      await perform('notifications/initialized', undefined, true);
    }
    const tools = [];
    const seenCursors = new Set();
    let cursor;
    for (let page = 0; page < MAX_PAGES; page++) {
      const result = await perform('tools/list', cursor ? { cursor } : {});
      if (!Array.isArray(result.tools) || tools.length + result.tools.length > MAX_TOOLS) {
        throw failure('MCP tool discovery returned an invalid or excessive tool list.', 502, 'MCP_INVALID_RESPONSE');
      }
      for (const tool of result.tools) {
        if (!tool || typeof tool.name !== 'string' || !tool.name.trim() || tool.name.length > 256 ||
          (tool.description !== undefined && typeof tool.description !== 'string')) {
          throw failure('MCP tool discovery returned invalid tool metadata.', 502, 'MCP_INVALID_RESPONSE');
        }
        tools.push({ name: tool.name, description: (tool.description || '').slice(0, 8000) });
      }
      if (result.nextCursor == null) return { status: 'connected', name, version, tools };
      if (typeof result.nextCursor !== 'string' || !result.nextCursor || result.nextCursor.length > 4096 || seenCursors.has(result.nextCursor)) {
        throw failure('MCP tool discovery returned an invalid pagination cursor.', 502, 'MCP_INVALID_RESPONSE');
      }
      cursor = result.nextCursor;
      seenCursors.add(cursor);
    }
    throw failure('MCP tool discovery exceeded the page limit.', 502, 'MCP_INVALID_RESPONSE');
  };
  try {
    return await Promise.race([discover(), timedOut]);
  } catch (error) {
    controller.abort();
    if (error?.code?.startsWith('MCP_')) throw error;
    throw failure('Unable to reach the MCP server.', 502, 'MCP_NETWORK_ERROR');
  } finally {
    clearTimeout(timeout);
  }
}
