import { appError } from './auth.mjs';

export const GITHUB_MCP_ENDPOINT = 'https://api.githubcopilot.com/mcp/';
const PROTOCOL = '2025-03-26';
const MAX_BYTES = 1024 * 1024;
const DEFINITIONS = Object.freeze([
  { id: 'profile', label: 'GitHub profile', tool: 'get_me' },
  { id: 'repositories', label: 'Your repositories', tool: 'search_repositories' },
  { id: 'pulls', label: 'Open pull requests', tool: 'list_pull_requests' },
  { id: 'issues', label: 'Open issues', tool: 'list_issues' },
  { id: 'runs', label: 'Workflow runs', tool: 'actions_list' },
]);
const TOOL_NAMES = DEFINITIONS.map(profile => profile.tool);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (message, status = 502, code = 'GITHUB_PROTOCOL_ERROR') => appError(message, status, code);
const invalid = message => fail(message, 400, 'GITHUB_INVALID_REQUEST');
// Enterprise Managed Users append an enterprise shortcode with an underscore.
const ownerPattern = /^[a-zA-Z0-9](?:[a-zA-Z0-9_-]{0,98}[a-zA-Z0-9])?$/;

function validateInput(input) {
  if (!object(input) || Object.keys(input).some(key => !['profile', 'repository', 'owner', 'repo', 'query', 'limit'].includes(key))) throw invalid('Use a named GitHub read profile and its documented scope fields. Credentials, URLs and arbitrary tools are not accepted.');
  if (input.repository !== undefined) {
    if (input.owner !== undefined || input.repo !== undefined || typeof input.repository !== 'string' || input.repository.split('/').length !== 2) throw invalid('Use repository as owner/repo, or supply owner and repo separately.');
    const [owner, repo] = input.repository.split('/'); input = { ...input, owner, repo }; delete input.repository;
  }
  const profile = DEFINITIONS.find(profile => profile.id === input.profile);
  if (!profile) throw invalid('Choose profile, repositories, pulls, issues, or runs.');
  const limit = input.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw invalid('Choose a GitHub result limit from 1 to 50.');
  if (['pulls', 'issues', 'runs'].includes(profile.id)) {
    if (typeof input.owner !== 'string' || !ownerPattern.test(input.owner) || typeof input.repo !== 'string' || !/^[a-zA-Z0-9._-]{1,100}$/.test(input.repo) || ['.', '..'].includes(input.repo)) throw invalid('Provide a GitHub owner and repository name, without URL components or search operators.');
    if (input.query !== undefined) throw invalid('These repository profiles list current results; query text is supported only for repository searches.');
  } else if (input.owner !== undefined || input.repo !== undefined) throw invalid('Profile and repository discovery use the authenticated GitHub identity.');
  if (input.query !== undefined && (profile.id !== 'repositories' || typeof input.query !== 'string' || input.query.length > 160 || !/^[\p{L}\p{N} _.,/#@()+-]*$/u.test(input.query))) throw invalid('Repository query must be at most 160 characters of literal search text, without search operators.');
  return { ...input, profile: profile.id, limit, query: input.query?.trim() || '' };
}

function redactor(token) {
  return (value, maximum = 1000) => {
    if (typeof value !== 'string') return undefined;
    const redacted = value.split(token).join('[redacted]').replace(/\b(?:github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9]+)\b/g, '[redacted]').replace(/Bearer\s+\S+/gi, 'Bearer [redacted]');
    return redacted.slice(0, maximum);
  };
}
function safeUrl(value, clean, avatar = false) {
  if (typeof value !== 'string' || value.length > 2048) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !(avatar ? ['avatars.githubusercontent.com', 'github.com'] : ['github.com']).includes(url.hostname)) return undefined;
    const cleaned = clean(url.href, 2048);
    return cleaned.includes('[redacted]') ? undefined : cleaned;
  } catch { return undefined; }
}
const compact = value => Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined && field !== null && field !== ''));
const number = value => Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const identifier = (value, clean) => typeof value === 'number' ? number(value) : typeof value === 'string' ? clean(value, 128) : undefined;
const author = (item, clean) => clean(typeof item === 'string' ? item : item?.login, 100);

function profileItem(item, clean) {
  if (!object(item) || typeof item.login !== 'string' || !ownerPattern.test(item.login)) throw fail('GitHub returned an unreadable account profile.');
  return compact({ id: identifier(item.id, clean), login: clean(item.login, 100), name: clean(item.name, 200), description: clean(item.bio, 1000), url: safeUrl(item.html_url || item.htmlUrl || item.url, clean), avatarUrl: safeUrl(item.avatar_url || item.avatarUrl, clean, true), company: clean(item.company, 200), location: clean(item.location, 200), publicRepos: number(item.public_repos) });
}
function normalizedItem(profile, item, clean) {
  if (!object(item)) return null;
  if (profile === 'repositories') {
    const name = clean(item.name, 100), fullName = clean(item.full_name || item.nameWithOwner, 240);
    if (!name && !fullName) return null;
    return compact({ id: identifier(item.id, clean), name, fullName, description: clean(item.description, 1000), url: safeUrl(item.html_url || item.htmlUrl || item.url, clean), private: typeof (item.private ?? item.isPrivate) === 'boolean' ? (item.private ?? item.isPrivate) : undefined, archived: typeof (item.archived ?? item.isArchived) === 'boolean' ? (item.archived ?? item.isArchived) : undefined, language: clean(item.language || item.primaryLanguage?.name, 100), defaultBranch: clean(item.default_branch || item.defaultBranchRef?.name, 200), updatedAt: clean(item.updated_at || item.updatedAt, 40) });
  }
  if (profile === 'pulls' || profile === 'issues') {
    if (!number(item.number) || typeof item.title !== 'string') return null;
    return compact({ id: identifier(item.id, clean), number: item.number, title: clean(item.title, 300), state: clean(item.state, 40), url: safeUrl(item.html_url || item.htmlUrl || item.url, clean), author: author(item.user || item.author, clean), createdAt: clean(item.created_at || item.createdAt, 40), updatedAt: clean(item.updated_at || item.updatedAt, 40), ...(profile === 'pulls' ? { head: clean(item.head?.ref || item.headRefName, 200), base: clean(item.base?.ref || item.baseRefName, 200), draft: typeof (item.draft ?? item.isDraft) === 'boolean' ? (item.draft ?? item.isDraft) : undefined } : {}) });
  }
  if (profile === 'runs') {
    const id = identifier(item.id, clean);
    if (id === undefined) return null;
    return compact({ id, number: number(item.run_number || item.runNumber), name: clean(item.name || item.display_title, 300), title: clean(item.display_title, 300), status: clean(item.status, 80), conclusion: clean(item.conclusion, 80), event: clean(item.event, 100), branch: clean(item.head_branch || item.headBranch, 200), url: safeUrl(item.html_url || item.htmlUrl || item.url, clean), createdAt: clean(item.created_at || item.createdAt, 40), updatedAt: clean(item.updated_at || item.updatedAt, 40) });
  }
  return null;
}

function toolPayload(result) {
  if (result.isError) throw fail('GitHub rejected this read operation. Check token permissions and repository access.', 502, 'GITHUB_TOOL_ERROR');
  if (object(result.structuredContent) || Array.isArray(result.structuredContent)) return result.structuredContent;
  if (Array.isArray(result.content)) for (const part of result.content) {
    if (part?.type !== 'text' || typeof part.text !== 'string') continue;
    try { const value = JSON.parse(part.text); if (object(value) || Array.isArray(value)) return value; } catch { /* No provider text is exposed on parsing errors. */ }
  }
  throw fail('GitHub returned an unreadable tool result.');
}
function unwrapped(payload) {
  if (object(payload) && (object(payload.data) || Array.isArray(payload.data))) return payload.data;
  return payload;
}
function collection(profile, payload) {
  let value = unwrapped(payload);
  if (profile === 'runs' && object(value) && value.method === 'list_workflow_runs' && object(value.workflow_runs)) value = value.workflow_runs;
  if (Array.isArray(value)) return { list: value, total: undefined, more: false };
  if (!object(value)) throw fail('GitHub returned an unreadable result list.');
  const field = profile === 'runs' ? 'workflow_runs' : profile === 'pulls' ? 'pull_requests' : profile === 'issues' ? 'issues' : 'items';
  const candidate = value[field] ?? value.items ?? value.nodes;
  const list = Array.isArray(candidate) ? candidate : candidate?.nodes;
  if (!Array.isArray(list)) throw fail('GitHub returned an unreadable result list.');
  return { list, total: number(value.total_count ?? value.totalCount ?? candidate?.totalCount), more: value.incomplete_results === true || value.pageInfo?.hasNextPage === true || candidate?.pageInfo?.hasNextPage === true };
}

function parseRpc(value, id) {
  if (!object(value) || value.jsonrpc !== '2.0' || value.id !== id || !Object.hasOwn(value, 'result') && !Object.hasOwn(value, 'error')) throw fail('GitHub returned an invalid MCP response.');
  if (value.error) throw fail('GitHub rejected the MCP request.', 502, 'GITHUB_PROTOCOL_ERROR');
  if (!object(value.result)) throw fail('GitHub returned an invalid MCP result.');
  return value.result;
}
function sseValue(frame) {
  const data = frame.replace(/\r\n?/g, '\n').split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
  if (!data) return undefined;
  try { return JSON.parse(data); } catch { throw fail('GitHub returned an invalid MCP stream.'); }
}
async function responseResult(response, id) {
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    const errors = { 401: ['GitHub remote MCP authentication failed. Check the server token type and access.', 'GITHUB_AUTH_FAILED'], 403: ['GitHub remote MCP access denied. Check token permissions and organization policy.', 'GITHUB_ACCESS_DENIED'], 429: ['GitHub rate limit reached. Try again later.', 'GITHUB_RATE_LIMITED'] };
    const [message, code] = errors[response.status] || ['GitHub remote MCP request failed.', 'GITHUB_HTTP_ERROR'];
    throw fail(message, [401, 403, 429].includes(response.status) ? response.status : 502, code);
  }
  if (Number(response.headers.get('content-length')) > MAX_BYTES) { await response.body?.cancel().catch(() => {}); throw fail('GitHub response exceeds the size limit.', 502, 'GITHUB_RESPONSE_TOO_LARGE'); }
  if (!response.body) throw fail('GitHub returned an empty MCP response.');
  const reader = response.body.getReader(), decoder = new TextDecoder();
  const streaming = (response.headers.get('content-type') || '').toLowerCase().includes('text/event-stream');
  let size = 0, text = '', pending = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) { await reader.cancel().catch(() => {}); throw fail('GitHub response exceeds the size limit.', 502, 'GITHUB_RESPONSE_TOO_LARGE'); }
      const chunk = decoder.decode(value, { stream: true }); text += chunk;
      if (!streaming) continue;
      pending += chunk;
      for (;;) {
        const boundary = /\r\n\r\n|\n\n|\r\r/.exec(pending);
        if (!boundary) break;
        const value = sseValue(pending.slice(0, boundary.index));
        pending = pending.slice(boundary.index + boundary[0].length);
        if (value?.jsonrpc === '2.0' && value.id === id) { await reader.cancel().catch(() => {}); return parseRpc(value, id); }
      }
    }
    text += decoder.decode();
    if (streaming) {
      const frames = text.replace(/\r\n?/g, '\n').split('\n\n');
      for (const frame of frames) { const value = sseValue(frame); if (value?.jsonrpc === '2.0' && value.id === id) return parseRpc(value, id); }
      throw fail('GitHub did not return the requested MCP result.');
    }
    let value; try { value = JSON.parse(text); } catch { throw fail('GitHub returned an unreadable MCP response.'); }
    return parseRpc(value, id);
  } finally { reader.releaseLock(); }
}

function validateArguments(tool, args) {
  const schema = tool.inputSchema;
  if (!object(schema) || schema.type !== 'object' || schema.properties !== undefined && !object(schema.properties) || schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some(key => typeof key !== 'string'))) throw fail('GitHub advertised an unsupported tool schema.', 503, 'GITHUB_TOOL_UNAVAILABLE');
  if ((schema.required || []).some(key => !Object.hasOwn(args, key))) throw fail('The GitHub tool requires unsupported additional arguments.', 503, 'GITHUB_TOOL_UNAVAILABLE');
  for (const [key, value] of Object.entries(args)) {
    const field = schema.properties?.[key];
    if (!object(field)) throw fail('The GitHub tool schema has changed. Refresh or update the adapter.', 503, 'GITHUB_TOOL_UNAVAILABLE');
    const types = Array.isArray(field.type) ? field.type : [field.type];
    if (!types.some(type => type === 'string' && typeof value === 'string' || type === 'integer' && Number.isInteger(value) || type === 'number' && typeof value === 'number' && Number.isFinite(value) || type === 'boolean' && typeof value === 'boolean')) throw fail('The GitHub tool schema is incompatible with this read profile.', 503, 'GITHUB_TOOL_UNAVAILABLE');
    if (Array.isArray(field.enum) && !field.enum.includes(value) || typeof value === 'number' && (value < (field.minimum ?? -Infinity) || value > (field.maximum ?? Infinity)) || typeof value === 'string' && (value.length < (field.minLength ?? 0) || value.length > (field.maxLength ?? Infinity))) throw fail('The GitHub tool schema does not support this read request.', 503, 'GITHUB_TOOL_UNAVAILABLE');
  }
}

async function withClient(env, options, operation) {
  const controller = new AbortController();
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? Math.min(options.timeoutMs, 30000) : 15000;
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  let timeout, onAbort;
  const aborted = new Promise((resolve, reject) => {
    onAbort = () => reject(fail('GitHub request was cancelled.', 408, 'GITHUB_CANCELLED'));
    if (options.signal?.aborted) onAbort(); else options.signal?.addEventListener('abort', onAbort, { once: true });
  });
  const deadline = new Promise((resolve, reject) => { timeout = setTimeout(() => { controller.abort(); reject(fail('GitHub remote MCP timed out.', 504, 'GITHUB_TIMEOUT')); }, timeoutMs); });
  try {
    return await Promise.race([(async () => {
      let token = env.GITHUB_TOKEN || env.GH_TOKEN;
      if (!token && options.tokenProvider) token = await options.tokenProvider();
      if (typeof token !== 'string' || !token.trim()) throw fail('Configure GITHUB_TOKEN or GH_TOKEN on the server to use GitHub remote MCP.', 503, 'GITHUB_NOT_CONFIGURED');
      if (token.length > 16384 || /[\x00-\x20\x7f]/.test(token)) throw fail('The server GitHub token configuration is invalid.', 503, 'GITHUB_NOT_CONFIGURED');
      const clean = redactor(token);
      const fetcher = options.fetch || (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : undefined);
      let session, protocol = PROTOCOL, sequence = 1;
      async function rpc(method, params, notification = false) {
        if (signal.aborted) throw fail('GitHub request was cancelled.', 408, 'GITHUB_CANCELLED');
        const id = notification ? undefined : sequence++;
        const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}`, 'MCP-Protocol-Version': protocol, 'X-MCP-Readonly': 'true', 'X-MCP-Toolsets': 'context,repos,pull_requests,issues,actions', 'X-MCP-Tools': TOOL_NAMES.join(',') };
        if (session) headers['Mcp-Session-Id'] = session;
        const response = await fetcher(GITHUB_MCP_ENDPOINT, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id }), method, ...(params === undefined ? {} : { params }) }), redirect: 'manual', signal });
        if (method === 'initialize') {
          const value = response.headers.get('mcp-session-id');
          if (value) { if (value.length > 2048 || /[^\x21-\x7e]/.test(value)) throw fail('GitHub returned an invalid MCP session.'); session = value; }
        }
        if (notification && response.ok) { await response.body?.cancel().catch(() => {}); return undefined; }
        return responseResult(response, id);
      }
      const initialized = await rpc('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'Dazza Forge GitHub Read Adapter', version: '1.0.0' } });
      if (typeof initialized.protocolVersion !== 'string' || !/^20\d\d-\d\d-\d\d$/.test(initialized.protocolVersion) || initialized.protocolVersion < PROTOCOL || !object(initialized.serverInfo) || typeof initialized.serverInfo.name !== 'string' || !initialized.serverInfo.name.trim() || typeof initialized.serverInfo.version !== 'string') throw fail('GitHub returned an unsupported MCP initialization response.');
      protocol = initialized.protocolVersion;
      await rpc('notifications/initialized', undefined, true);
      const tools = new Map(), cursors = new Set(); let cursor;
      for (let page = 0; page < 10; page++) {
        const result = await rpc('tools/list', cursor ? { cursor } : {});
        if (!Array.isArray(result.tools) || result.tools.length > 1000) throw fail('GitHub returned an invalid MCP tool list.');
        for (const tool of result.tools) {
          if (!object(tool) || typeof tool.name !== 'string') throw fail('GitHub returned invalid tool metadata.');
          if (TOOL_NAMES.includes(tool.name) && tool.annotations?.readOnlyHint !== false) tools.set(tool.name, tool);
        }
        if (result.nextCursor == null) break;
        if (page === 9 || typeof result.nextCursor !== 'string' || !result.nextCursor || result.nextCursor.length > 4096 || cursors.has(result.nextCursor)) throw fail('GitHub returned invalid tool pagination.');
        cursor = result.nextCursor; cursors.add(cursor);
      }
      const metadata = name => { const tool = tools.get(name); if (!tool) throw fail('This read profile is unavailable on the connected GitHub MCP server.', 503, 'GITHUB_TOOL_UNAVAILABLE'); return { name, description: clean(tool.description, 800) || 'GitHub read operation' }; };
      const call = async (name, args) => {
        metadata(name); const tool = tools.get(name); validateArguments(tool, args);
        return unwrapped(toolPayload(await rpc('tools/call', { name, arguments: args })));
      };
      return operation({ tools, clean, metadata, call, server: { name: clean(initialized.serverInfo.name, 200), version: clean(initialized.serverInfo.version, 100), protocol } });
    })(), deadline, aborted]);
  } catch (error) {
    controller.abort();
    if (typeof error?.code === 'string' && error.code.startsWith('GITHUB_')) throw error;
    throw fail('Unable to reach GitHub remote MCP. Check the server token and connectivity.', 502, 'GITHUB_NETWORK_ERROR');
  } finally { clearTimeout(timeout); options.signal?.removeEventListener('abort', onAbort); }
}

/** Authentication and MCP discovery are checked independently of any local gh CLI session. */
export async function getGithubStatus(env = {}, options = {}) {
  const base = { configured: !!(env.GITHUB_TOKEN || env.GH_TOKEN || options.tokenProvider), connected: false, readonly: true, endpoint: GITHUB_MCP_ENDPOINT };
  try {
    return await withClient(env, options, async ({ tools, metadata, server }) => ({ ...base, configured: true, connected: true, server, profiles: DEFINITIONS.map(profile => ({ ...profile, available: tools.has(profile.tool) && (profile.id !== 'repositories' || tools.has('get_me')) })), tools: [...tools.keys()].map(metadata), reason: 'GitHub remote MCP authentication and read-tool discovery succeeded.' }));
  } catch (error) {
    return { ...base, profiles: DEFINITIONS.map(profile => ({ ...profile, available: false })), tools: [], error: error.code, code: error.code, httpStatus: error.status, reason: error.message };
  }
}

/** Execute only the documented, discovery-confirmed read profiles; no arbitrary MCP calls. */
export async function executeGithubRead(raw, env = {}, options = {}) {
  const input = validateInput(raw);
  return withClient(env, options, async ({ clean, metadata, call }) => {
    const definition = DEFINITIONS.find(profile => profile.id === input.profile);
    let payload; const used = [];
    if (input.profile === 'profile' || input.profile === 'repositories') {
      const account = profileItem(await call('get_me', {}), clean); used.push('get_me');
      if (input.profile === 'profile') return { profile: input.profile, readonly: true, endpoint: GITHUB_MCP_ENDPOINT, tool: metadata('get_me'), toolsUsed: used, account, items: [account], count: 1, totalCount: 1, truncated: false, fetchedAt: new Date().toISOString() };
      payload = await call('search_repositories', { query: `user:${account.login}${input.query ? ` "${input.query}"` : ''}`, perPage: input.limit, page: 1, minimal_output: true }); used.push('search_repositories');
    } else {
      const args = { owner: input.owner, repo: input.repo, perPage: input.limit };
      if (input.profile === 'pulls') args.state = 'open';
      if (input.profile === 'issues') args.state = 'OPEN';
      if (input.profile === 'runs') args.method = 'list_workflow_runs';
      if (input.profile !== 'issues') args.page = 1;
      payload = await call(definition.tool, args); used.push(definition.tool);
    }
    const result = collection(input.profile, payload);
    const items = result.list.slice(0, input.limit).map(item => normalizedItem(input.profile, item, clean)).filter(Boolean);
    if (result.list.length && !items.length) throw fail('GitHub returned an unsupported result format.');
    return { profile: input.profile, readonly: true, endpoint: GITHUB_MCP_ENDPOINT, tool: metadata(definition.tool), toolsUsed: used, ...(input.owner ? { owner: input.owner, repo: input.repo } : {}), items, count: items.length, totalCount: result.total ?? null, truncated: result.more || result.list.length > input.limit || (result.total !== undefined && result.total > items.length), fetchedAt: new Date().toISOString() };
  });
}
