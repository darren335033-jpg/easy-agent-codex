// The usage view is a record of reported metrics, not a provider invoice.
// Keep this module browser-safe so both histories use the same accounting rules.
const LIMIT = 100;
const MAX = Number.MAX_SAFE_INTEGER;
const FIELDS = ['promptTokenCount', 'candidatesTokenCount', 'totalTokenCount', 'cachedInputTokenCount', 'reasoningTokenCount'];
const STATUSES = new Set(['completed', 'failed', 'cancelled', 'queued', 'running', 'interrupted', 'incomplete']);
const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const add = (a, b) => a > MAX - b ? MAX : a + b;
const date = value => typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;

function safeId(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value) && !secretLike(value) ? value : null;
}
function secretLike(value) {
  return /(?:sk-(?:proj-|svcacct-|[a-zA-Z0-9_-]{16})|AIza[a-zA-Z0-9_-]{20}|eyJ[a-zA-Z0-9_-]{12})/.test(value);
}
function modelName(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/@-]{0,119}$/.test(value) && !secretLike(value) ? value : 'Unspecified model';
}
function providerName(value) {
  return ['openai', 'vertex', 'local'].includes(value) ? value : 'unknown';
}
function normalizedUsage(value) {
  if (!isObject(value)) return null;
  const usage = {};
  for (const field of FIELDS) {
    const valid = count(value[field]);
    if (valid !== null) usage[field] = valid;
  }
  return Object.keys(usage).length ? usage : null;
}
function mergeTokens(target, usage) {
  if (!usage) return;
  for (const field of FIELDS) {
    if (usage[field] !== undefined) target[field] = target[field] === null ? usage[field] : add(target[field], usage[field]);
  }
}
function emptyTokens() { return Object.fromEntries(FIELDS.map(field => [field, null])); }
function emptyBucket() {
  return { runs: 0, runsWithUsage: 0, runsWithoutUsage: 0, zeroUsageRuns: 0, inferenceCalls: null, tokens: emptyTokens() };
}
function applyBucket(bucket, record) {
  bucket.runs++;
  bucket[record.usage ? 'runsWithUsage' : 'runsWithoutUsage']++;
  if (record.usageStatus === 'zero') bucket.zeroUsageRuns++;
  if (record.inferenceCalls !== null) bucket.inferenceCalls = bucket.inferenceCalls === null ? record.inferenceCalls : add(bucket.inferenceCalls, record.inferenceCalls);
  mergeTokens(bucket.tokens, record.usage);
}

function readRecord(record) {
  const events = Array.isArray(record.events) ? record.events.slice(-250).filter(event => isObject(event) && event.type === 'model_completed') : [];
  const eventTokens = emptyTokens();
  let eventsWithUsage = 0;
  for (const event of events) {
    let usage = event.usageReported === false ? null : normalizedUsage(event.usage);
    if (usage && Object.values(usage).every(value => value === 0) && event.usageReported !== true) usage = null;
    if (usage) { eventsWithUsage++; mergeTokens(eventTokens, usage); }
  }
  const reportedCalls = count(record.usageCoverage?.reportedCalls);
  const unreportedCalls = count(record.usageCoverage?.unreportedCalls);
  const coverage = reportedCalls !== null && unreportedCalls !== null ? { reportedCalls, unreportedCalls } : null;
  let usage = normalizedUsage(record.usage);
  // Older coding records initialized all aggregate fields to zero even when the
  // provider returned no usage. The completed-call trace can disambiguate them.
  const explicitZero = coverage?.reportedCalls > 0 || record.usageReported === true || events.some(event => event.usageReported === true && normalizedUsage(event.usage));
  if (coverage?.reportedCalls === 0 || (usage && Object.values(usage).every(value => value === 0) && !explicitZero)) usage = null;
  if (!usage && eventsWithUsage && coverage?.reportedCalls !== 0) usage = Object.fromEntries(FIELDS.filter(field => eventTokens[field] !== null).map(field => [field, eventTokens[field]]));
  else if (usage && eventsWithUsage) {
    for (const field of FIELDS) if (usage[field] === undefined && eventTokens[field] !== null) usage[field] = eventTokens[field];
  }
  const inferenceCalls = count(record.inferenceCalls);
  return {
    id: safeId(record.id),
    provider: providerName(record.provider),
    model: modelName(record.model),
    status: STATUSES.has(record.status) ? record.status : 'unknown',
    createdAt: date(record.createdAt),
    inferenceCalls,
    usage,
    usageCoverage: coverage,
    usageStatus: !usage ? 'missing' : usage.totalTokenCount === 0 && Object.values(usage).every(value => value === 0) ? 'zero' : 'reported',
    completedCallsWithUsage: coverage ? coverage.reportedCalls : events.length ? eventsWithUsage : null,
    completedCallsWithoutUsage: coverage ? coverage.unreportedCalls : events.length ? events.length - eventsWithUsage : null,
  };
}

/** Summarize at most the latest 100 records without copying prompts or outputs. */
export function summarizeUsage(records, { scope = 'repository', now = Date.now() } = {}) {
  const safeScope = scope === 'browser' ? 'browser' : 'repository';
  const source = Array.isArray(records) ? records : [];
  const latest = [];
  let validRecords = 0;
  for (const record of source) {
    if (!isObject(record)) continue;
    validRecords++;
    const safe = readRecord(record);
    latest.push(safe);
    latest.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    if (latest.length > LIMIT) latest.pop();
  }
  const tokens = emptyTokens();
  const runs = { total: latest.length, completed: 0, failed: 0, cancelled: 0, active: 0, other: 0, withUsage: 0, withoutUsage: 0, zeroUsage: 0 };
  const calls = { reported: null, runsWithReportedCalls: 0, runsWithoutReportedCalls: 0, completedWithUsage: null, completedWithoutUsage: null };
  const providers = new Map(), models = new Map();
  for (const record of latest) {
    const status = ['completed', 'failed', 'cancelled'].includes(record.status) ? record.status : ['queued', 'running'].includes(record.status) ? 'active' : 'other';
    runs[status]++;
    runs[record.usage ? 'withUsage' : 'withoutUsage']++;
    if (record.usageStatus === 'zero') runs.zeroUsage++;
    if (record.inferenceCalls === null) calls.runsWithoutReportedCalls++;
    else { calls.runsWithReportedCalls++; calls.reported = calls.reported === null ? record.inferenceCalls : add(calls.reported, record.inferenceCalls); }
    for (const [field, value] of [['completedWithUsage', record.completedCallsWithUsage], ['completedWithoutUsage', record.completedCallsWithoutUsage]]) {
      if (value !== null) calls[field] = calls[field] === null ? value : add(calls[field], value);
    }
    mergeTokens(tokens, record.usage);
    if (!providers.has(record.provider)) providers.set(record.provider, { provider: record.provider, ...emptyBucket() });
    applyBucket(providers.get(record.provider), record);
    const modelKey = `${record.provider}\n${record.model}`;
    if (!models.has(modelKey)) models.set(modelKey, { provider: record.provider, model: record.model, ...emptyBucket() });
    applyBucket(models.get(modelKey), record);
  }
  const dates = latest.map(record => record.createdAt).filter(Boolean);
  const asOf = new Date(typeof now === 'number' && Number.isFinite(now) && Math.abs(now) <= 8640000000000000 ? now : Date.now()).toISOString();
  return {
    scope: safeScope,
    window: { limit: LIMIT, records: latest.length, limited: validRecords >= LIMIT, from: dates.at(-1) || null, to: dates[0] || null, asOf },
    runs,
    calls,
    tokens,
    byProvider: [...providers.values()].sort((a, b) => b.runs - a.runs || a.provider.localeCompare(b.provider)),
    byModel: [...models.values()].sort((a, b) => b.runs - a.runs || a.model.localeCompare(b.model)),
    recent: latest.slice(0, 20),
    notes: [
      safeScope === 'browser' ? 'At most the last 100 quick-task records stored in this browser.' : 'At most the last 100 saved coding-run records returned by the companion.',
      'Token totals include only valid usage metrics returned by providers; missing usage is separate from a reported zero.',
      'Provider invoices can include calls whose usage was not returned, including failed, interrupted, or cancelled tasks.',
      'Cached input and reasoning tokens are details of provider-reported usage. They are not added again to total tokens.',
      'This is recorded activity, not an account balance, invoice, rate-limit measurement, or subscription allowance.',
    ],
  };
}
