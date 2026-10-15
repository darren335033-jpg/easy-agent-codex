import { appError } from './auth.mjs';

// Browser input never selects a destination or supplies credentials.
const ORIGIN = 'https://api.openai.com';
const MAX_BYTES = 2097152;
const MAX_MODELS = 500;
const integer = value => Number.isSafeInteger(value) && value >= 0;
const validModel = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,149}$/.test(value) && !value.startsWith('sk-');
export function hasOpenAIKey(env = {}) {
  return typeof env.OPENAI_API_KEY === 'string' && env.OPENAI_API_KEY.length > 0 && env.OPENAI_API_KEY.length <= 4096 && !/\s/.test(env.OPENAI_API_KEY);
}
function signalFor(options, timeout) {
  return options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout);
}
function httpError(status) {
  const reason = { 400: 'request was rejected; check the model and its supported Responses API settings', 401: 'authentication failed', 403: 'access denied; check project permissions and model access', 404: 'model or endpoint is unavailable', 429: 'rate limit or API quota exceeded; check API billing and project limits' }[status] || `request failed (HTTP ${status})`;
  return appError(`OpenAI ${reason}.`, status >= 400 && status < 500 ? status : 502, 'PROVIDER_ERROR');
}
async function readJson(response, signal) {
  if (!response.ok) { await response.body?.cancel().catch(() => {}); throw httpError(response.status); }
  const reader = response.body?.getReader();
  if (!reader) throw appError('OpenAI returned an empty response.', 502, 'PROVIDER_ERROR');
  const decoder = new TextDecoder(); let size = 0, text = '';
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => { reader.cancel().catch(() => {}); reject(signal.reason || new DOMException('Request cancelled.', 'AbortError')); };
    if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) { await reader.cancel(); throw appError('OpenAI response exceeded the size limit.', 502, 'PROVIDER_ERROR'); }
      text += decoder.decode(value, { stream: true });
    }
    try { return JSON.parse(text + decoder.decode()); }
    catch { throw appError('OpenAI returned an unreadable response.', 502, 'PROVIDER_ERROR'); }
  } finally { signal.removeEventListener('abort', onAbort); }
}
async function request(path, init, env, options, timeout) {
  if (!hasOpenAIKey(env)) throw appError('Set OPENAI_API_KEY on the application server or local companion.', 503, 'PROVIDER_NOT_CONFIGURED');
  const signal = signalFor(options, timeout);
  signal.throwIfAborted();
  try {
    const response = await (options.fetch || globalThis.fetch.bind(globalThis))(`${ORIGIN}${path}`, { ...init, headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, Accept: 'application/json', ...(init.body ? { 'Content-Type': 'application/json' } : {}) }, redirect: 'manual', signal });
    return await readJson(response, signal);
  } catch (error) {
    if (error?.status || signal.aborted || error?.name === 'AbortError' || error?.name === 'TimeoutError') throw error;
    throw appError('OpenAI could not be reached. Check server connectivity and try again.', 502, 'PROVIDER_ERROR');
  }
}
function reportedUsage(source) {
  if (!source || !integer(source.input_tokens) || !integer(source.output_tokens) || !integer(source.total_tokens)) return { usage: {}, usageReported: false };
  const usage = { promptTokenCount: source.input_tokens, candidatesTokenCount: source.output_tokens, totalTokenCount: source.total_tokens };
  if (integer(source.input_tokens_details?.cached_tokens)) usage.cachedInputTokenCount = source.input_tokens_details.cached_tokens;
  if (integer(source.output_tokens_details?.reasoning_tokens)) usage.reasoningTokenCount = source.output_tokens_details.reasoning_tokens;
  return { usage, usageReported: true };
}
export async function generateOpenAI({ model, system = '', prompt, messages, responseFormat }, env = {}, options = {}) {
  const modelId = model || env.OPENAI_MODEL;
  if (!validModel(modelId)) throw appError('Choose an OpenAI model ID or set OPENAI_MODEL on the server. Available models depend on your API project.', 400, 'INVALID_REQUEST');
  const conversation = Array.isArray(messages) ? messages : [{ role: 'user', content: prompt }];
  if (!conversation.length || conversation.length > 100 || conversation.some(message => !message || !['user', 'assistant'].includes(message.role) || typeof message.content !== 'string') || conversation.reduce((size, message) => size + message.content.length, 0) > 600000 || typeof system !== 'string' || system.length > 100000) throw appError('The model conversation exceeds its supported limits.');
  const instructions = responseFormat === 'json' ? `${system}\nReturn exactly one valid JSON object.` : system;
  const payload = await request('/v1/responses', { method: 'POST', body: JSON.stringify({ model: modelId, instructions, input: conversation.map(({ role, content }) => ({ role, content })), store: false, stream: false, max_output_tokens: 16384, ...(responseFormat === 'json' ? { text: { format: { type: 'json_object' } } } : {}) }) }, env, options, 180000);
  if (payload?.error || payload?.status !== 'completed' || payload?.incomplete_details) throw appError('OpenAI did not complete the response. Check model support, output limits, and provider policy; partial output was not accepted.', 502, 'PROVIDER_ERROR');
  const messagesOut = Array.isArray(payload.output) ? payload.output.filter(item => item?.type === 'message' && item.role === 'assistant') : [];
  if (messagesOut.some(item => item.status && item.status !== 'completed') || messagesOut.some(item => Array.isArray(item.content) && item.content.some(part => part?.type === 'refusal' || typeof part?.refusal === 'string'))) throw appError('OpenAI declined or did not complete the response. No generated changes were accepted.', 502, 'PROVIDER_ERROR');
  const output = messagesOut.flatMap(item => Array.isArray(item.content) ? item.content : []).filter(part => part?.type === 'output_text' && typeof part.text === 'string').map(part => part.text).join('\n');
  if (!output.trim()) throw appError('OpenAI returned no completed text output.', 502, 'EMPTY_OUTPUT');
  return { text: output, ...reportedUsage(payload.usage) };
}
export async function discoverOpenAIModels(env = {}, options = {}) {
  if (!hasOpenAIKey(env)) return { configured: false, verified: false, models: [], reason: 'Set OPENAI_API_KEY on the server or local companion to check your API model catalog.' };
  try {
    // The documented /v1/models list response has no pagination parameters.
    const payload = await request('/v1/models', { method: 'GET' }, env, options, 15000);
    if (payload?.object !== 'list' || !Array.isArray(payload.data) || payload.data.some(item => item?.object !== 'model' || !validModel(item.id))) throw appError('OpenAI returned an invalid model catalog.', 502, 'PROVIDER_ERROR');
    const models = [...new Set(payload.data.map(item => item.id))].sort().slice(0, MAX_MODELS);
    return { configured: true, verified: true, models, ...(payload.data.length > MAX_MODELS ? { truncated: true } : {}), reason: 'API model catalog verified. A listed model may not support Responses or JSON mode; access is checked when a task runs.' };
  } catch (error) {
    return { configured: true, verified: false, models: [], reason: error?.name === 'AbortError' || error?.name === 'TimeoutError' || options.signal?.aborted ? 'OpenAI model discovery was cancelled or timed out.' : error?.code === 'PROVIDER_ERROR' ? error.message : 'OpenAI model discovery could not complete. Check server credentials and connectivity.' };
  }
}
