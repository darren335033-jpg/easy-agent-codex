/** Easy Agent read-only status bridge, NOT a native Sandcastle MCP server.
 * Upstream documents its CLI/TUI; this bridge neither invokes it nor Docker.
 * Launch with an explicit project cwd. No configuration contents are read.
 */
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const TOOL = 'easy_agent_sandcastles_status';
const MAX_LINE = 64 * 1024;
const fail = (code, message) => ({ error: { code, message } });
async function realDirectory(p) {
  try { const stat = await lstat(p); return stat.isDirectory() && !stat.isSymbolicLink(); }
  catch { return false; }
}
export async function status(cwd = process.cwd()) {
  const root = path.join(cwd, '.sandcastle');
  let configured = false, worktrees = [];
  if (await realDirectory(root)) {
    for (const name of ['main.ts', 'main.mts']) {
      try { const stat = await lstat(path.join(root, name)); if (stat.isFile() && !stat.isSymbolicLink()) configured = true; }
      catch { /* Missing or inaccessible markers report unconfigured. */ }
    }
    const worktreeRoot = path.join(root, 'worktrees');
    if (await realDirectory(worktreeRoot)) {
      try { worktrees = (await readdir(worktreeRoot, { withFileTypes: true })).filter(entry => entry.isDirectory() && !entry.isSymbolicLink()).map(entry => entry.name).sort(); }
      catch { /* Inaccessible worktrees report an empty inventory. */ }
    }
  }
  return { bridge: 'easy-agent-read-only-status', upstream: 'https://github.com/mattpocock/sandcastle', configured, worktrees, runtimeStatus: 'unverified' };
}
export async function handle(request, cwd = process.cwd()) {
  if (!request || typeof request !== 'object' || Array.isArray(request) || request.jsonrpc !== '2.0' || typeof request.method !== 'string') return { jsonrpc: '2.0', id: null, ...fail(-32600, 'Invalid request') };
  const notification = !Object.hasOwn(request, 'id');
  if (notification) return undefined;
  if (!(request.id === null || typeof request.id === 'string' || (typeof request.id === 'number' && Number.isFinite(request.id)))) return { jsonrpc: '2.0', id: null, ...fail(-32600, 'Invalid request') };
  const response = { jsonrpc: '2.0', id: request.id };
  switch (request.method) {
    case 'initialize': return { ...response, result: { protocolVersion: '2025-03-26', capabilities: { tools: {}, resources: {} }, serverInfo: { name: 'easy-agent-sandcastles-read-only-status', version: '1.0.0' } } };
    case 'ping': return { ...response, result: {} };
    case 'resources/list': return { ...response, result: { resources: [] } };
    case 'tools/list': return { ...response, result: { tools: [{ name: TOOL, description: 'Easy Agent read-only filesystem inventory. Not an upstream native MCP integration; runtime remains unverified.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } }] } };
    case 'tools/call': {
      const params = request.params;
      if (!params || params.name !== TOOL || (params.arguments !== undefined && (!params.arguments || typeof params.arguments !== 'object' || Array.isArray(params.arguments) || Object.keys(params.arguments).length))) return { ...response, ...fail(-32602, 'Invalid tool or arguments') };
      return { ...response, result: { content: [{ type: 'text', text: JSON.stringify(await status(cwd)) }], isError: false } };
    }
    default: return { ...response, ...fail(-32601, 'Method not found') };
  }
}
export function serve(input = process.stdin, output = process.stdout, cwd = process.cwd()) {
  let pending = Buffer.alloc(0), oversized = false, chain = Promise.resolve();
  const emit = response => { if (response) output.write(`${JSON.stringify(response)}\n`); };
  const enqueue = line => { chain = chain.then(async () => { let request; try { request = JSON.parse(line.toString('utf8')); } catch { emit({ jsonrpc: '2.0', id: null, ...fail(-32700, 'Parse error') }); return; } try { emit(await handle(request, cwd)); } catch { emit({ jsonrpc: '2.0', id: null, ...fail(-32603, 'Internal error') }); } }); };
  input.on('data', chunk => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let start = 0;
    for (let i = 0; i <= bytes.length; i++) {
      if (i !== bytes.length && bytes[i] !== 10) continue;
      const part = bytes.subarray(start, i);
      if (!oversized) {
        if (pending.length + part.length > MAX_LINE) { pending = Buffer.alloc(0); oversized = true; }
        else pending = Buffer.concat([pending, part]);
      }
      if (i < bytes.length) {
        if (oversized) chain = chain.then(() => emit({ jsonrpc: '2.0', id: null, ...fail(-32700, 'Parse error') }));
        else enqueue(pending);
        pending = Buffer.alloc(0); oversized = false;
      }
      start = i + 1;
    }
  });
  input.on('end', () => { if (oversized) chain = chain.then(() => emit({ jsonrpc: '2.0', id: null, ...fail(-32700, 'Parse error') })); else if (pending.length) enqueue(pending); });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) serve();
