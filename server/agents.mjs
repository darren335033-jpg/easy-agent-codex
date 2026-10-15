/** The built-in specialist roster. All 50 agents are available by default. */
export const AGENTS = [
  { id: 'atlas', name: 'Atlas', role: 'Lead architect', team: 'Architecture', description: 'Coordinates the team, defines system boundaries, and integrates specialist recommendations.', enabled: true },
  { id: 'nova', name: 'Nova', role: 'Product strategist', team: 'Architecture', description: 'Turns founder goals into focused product requirements and measurable acceptance criteria.', enabled: true },
  { id: 'orion', name: 'Orion', role: 'Systems designer', team: 'Architecture', description: 'Designs resilient services, component boundaries, and distributed system workflows.', enabled: true },
  { id: 'lyra', name: 'Lyra', role: 'Domain modeler', team: 'Architecture', description: 'Models business entities, domain rules, and clear application contracts.', enabled: true },
  { id: 'echo', name: 'Echo', role: 'API architect', team: 'Architecture', description: 'Designs REST and GraphQL interfaces, versioning, and integration contracts.', enabled: true },
  { id: 'vega', name: 'Vega', role: 'Data architect', team: 'Architecture', description: 'Plans relational schemas, data ownership, migrations, and consistency guarantees.', enabled: true },
  { id: 'sol', name: 'Sol', role: 'Security architect', team: 'Architecture', description: 'Defines trust boundaries, threat models, and secure application architecture.', enabled: true },
  { id: 'sage', name: 'Sage', role: 'Code reviewer', team: 'Architecture', description: 'Reviews proposed changes for correctness, maintainability, risks, and missing verification.', enabled: true },
  { id: 'pax', name: 'Pax', role: 'Technical planner', team: 'Architecture', description: 'Breaks complex work into practical milestones, dependencies, and delivery steps.', enabled: true },
  { id: 'cleo', name: 'Cleo', role: 'Technical writer', team: 'Architecture', description: 'Writes clear developer documentation, architecture decisions, and onboarding guides.', enabled: true },

  { id: 'aria', name: 'Aria', role: 'Frontend engineer', team: 'Frontend', description: 'Builds reliable React components and maintainable browser application features.', enabled: true },
  { id: 'iris', name: 'Iris', role: 'Interface designer', team: 'Frontend', description: 'Shapes visual hierarchy, interaction patterns, typography, and cohesive layouts.', enabled: true },
  { id: 'luna', name: 'Luna', role: 'Accessibility engineer', team: 'Frontend', description: 'Improves keyboard navigation, screen reader support, semantics, and contrast.', enabled: true },
  { id: 'finn', name: 'Finn', role: 'Design systems engineer', team: 'Frontend', description: 'Creates reusable components, design tokens, and consistent interface primitives.', enabled: true },
  { id: 'milo', name: 'Milo', role: 'State management engineer', team: 'Frontend', description: 'Designs predictable client state, caching, forms, and data synchronization.', enabled: true },
  { id: 'ruby', name: 'Ruby', role: 'CSS specialist', team: 'Frontend', description: 'Builds responsive layouts, polished styling, and reliable cross-browser presentation.', enabled: true },
  { id: 'kai', name: 'Kai', role: 'Frontend performance engineer', team: 'Frontend', description: 'Reduces bundle size, rendering costs, loading latency, and layout shifts.', enabled: true },
  { id: 'juno', name: 'Juno', role: 'Interaction engineer', team: 'Frontend', description: 'Implements intuitive motion, drag and drop, editor interactions, and feedback states.', enabled: true },
  { id: 'nico', name: 'Nico', role: 'Mobile web engineer', team: 'Frontend', description: 'Adapts web experiences for touch input, small screens, and progressive web apps.', enabled: true },
  { id: 'tess', name: 'Tess', role: 'Frontend integration engineer', team: 'Frontend', description: 'Connects interfaces to APIs with robust loading, streaming, and error handling.', enabled: true },

  { id: 'axel', name: 'Axel', role: 'Backend engineer', team: 'Backend', description: 'Implements server endpoints, application logic, validation, and reliable responses.', enabled: true },
  { id: 'rhea', name: 'Rhea', role: 'Database engineer', team: 'Backend', description: 'Writes efficient SQL, indexes, transactions, and safe database migrations.', enabled: true },
  { id: 'theo', name: 'Theo', role: 'Authentication engineer', team: 'Backend', description: 'Implements sessions, identity, access control, and account security.', enabled: true },
  { id: 'eden', name: 'Eden', role: 'Integration engineer', team: 'Backend', description: 'Connects third-party APIs, webhooks, and external services with reliable retries.', enabled: true },
  { id: 'omar', name: 'Omar', role: 'Realtime engineer', team: 'Backend', description: 'Builds WebSocket, event streaming, presence, and collaborative synchronization features.', enabled: true },
  { id: 'zara', name: 'Zara', role: 'Search engineer', team: 'Backend', description: 'Designs full-text search, retrieval, ranking, and vector search pipelines.', enabled: true },
  { id: 'leon', name: 'Leon', role: 'Background jobs engineer', team: 'Backend', description: 'Builds queues, workers, scheduled jobs, and idempotent asynchronous processing.', enabled: true },
  { id: 'nia', name: 'Nia', role: 'AI integration engineer', team: 'Backend', description: 'Connects model providers, tool calls, structured outputs, and streaming inference.', enabled: true },
  { id: 'hugo', name: 'Hugo', role: 'Storage engineer', team: 'Backend', description: 'Handles file uploads, object storage, document processing, and retention policies.', enabled: true },
  { id: 'ida', name: 'Ida', role: 'Backend performance engineer', team: 'Backend', description: 'Improves caching, query latency, throughput, and resource efficiency.', enabled: true },

  { id: 'reed', name: 'Reed', role: 'DevOps engineer', team: 'Platform', description: 'Automates builds, environment configuration, and reliable release pipelines.', enabled: true },
  { id: 'wren', name: 'Wren', role: 'Cloud engineer', team: 'Platform', description: 'Designs hosting, infrastructure configuration, networking, and cloud deployment.', enabled: true },
  { id: 'cole', name: 'Cole', role: 'Container engineer', team: 'Platform', description: 'Builds reproducible Docker images and practical container orchestration.', enabled: true },
  { id: 'skye', name: 'Skye', role: 'Site reliability engineer', team: 'Platform', description: 'Improves uptime, incident response, recovery, and operational reliability.', enabled: true },
  { id: 'dane', name: 'Dane', role: 'Observability engineer', team: 'Platform', description: 'Adds useful logs, metrics, traces, health checks, and actionable alerts.', enabled: true },
  { id: 'vera', name: 'Vera', role: 'Build engineer', team: 'Platform', description: 'Maintains package tooling, dependency resolution, bundling, and build reproducibility.', enabled: true },
  { id: 'remy', name: 'Remy', role: 'Developer tools engineer', team: 'Platform', description: 'Creates CLI workflows, editor integrations, and productive local development tools.', enabled: true },
  { id: 'blair', name: 'Blair', role: 'Release engineer', team: 'Platform', description: 'Plans versioning, deployment checks, rollbacks, and controlled releases.', enabled: true },
  { id: 'neve', name: 'Neve', role: 'Infrastructure security engineer', team: 'Platform', description: 'Hardens secrets, network access, runtime isolation, and deployment permissions.', enabled: true },
  { id: 'arlo', name: 'Arlo', role: 'Cost optimization engineer', team: 'Platform', description: 'Reduces infrastructure costs and model usage through practical resource budgets.', enabled: true },

  { id: 'quinn', name: 'Quinn', role: 'Test strategist', team: 'Quality', description: 'Defines useful test coverage, acceptance checks, and risk-based verification.', enabled: true },
  { id: 'ava', name: 'Ava', role: 'Unit test engineer', team: 'Quality', description: 'Tests business logic, edge cases, and isolated module behavior.', enabled: true },
  { id: 'ben', name: 'Ben', role: 'Integration test engineer', team: 'Quality', description: 'Verifies service boundaries, API contracts, and database interactions.', enabled: true },
  { id: 'esme', name: 'Esme', role: 'Browser test engineer', team: 'Quality', description: 'Validates real user flows, responsive pages, and browser behavior.', enabled: true },
  { id: 'otto', name: 'Otto', role: 'Debugging specialist', team: 'Quality', description: 'Reproduces failures, traces root causes, and verifies focused fixes.', enabled: true },
  { id: 'mina', name: 'Mina', role: 'Application security tester', team: 'Quality', description: 'Checks injection risks, authorization failures, and unsafe input handling.', enabled: true },
  { id: 'ezra', name: 'Ezra', role: 'Performance tester', team: 'Quality', description: 'Profiles bottlenecks and tests load, latency, concurrency, and memory behavior.', enabled: true },
  { id: 'luca', name: 'Luca', role: 'Compatibility tester', team: 'Quality', description: 'Checks browser compatibility, platform assumptions, and supported runtime versions.', enabled: true },
  { id: 'maya', name: 'Maya', role: 'Data quality engineer', team: 'Quality', description: 'Verifies data validation, migration integrity, and consistent stored records.', enabled: true },
  { id: 'felix', name: 'Felix', role: 'Reliability tester', team: 'Quality', description: 'Exercises retries, cancellation, error recovery, and failure conditions.', enabled: true },
];

// Transparent, local routing keeps team selection fast and independent of model access.
const SPECIALTIES = {
  atlas: ['architecture', 'architect', 'system', 'design', 'plan'],
  nova: ['product', 'requirements', 'founder', 'feature', 'acceptance', 'roadmap'],
  orion: ['distributed', 'microservices', 'scalable', 'resilient', 'system design'],
  lyra: ['domain', 'entities', 'business rules', 'modeling'],
  echo: ['api', 'rest', 'graphql', 'endpoint', 'contract', 'versioning'],
  vega: ['schema', 'data model', 'database design', 'consistency', 'migration'],
  sol: ['security', 'threat', 'secure', 'trust', 'authorization'],
  sage: ['review', 'correctness', 'maintainability', 'audit'],
  pax: ['plan', 'milestone', 'delivery', 'task breakdown', 'estimate'],
  cleo: ['documentation', 'docs', 'readme', 'onboarding', 'guide'],
  aria: ['frontend', 'react', 'component', 'typescript', 'javascript', 'ui'],
  iris: ['design', 'interface', 'visual', 'typography', 'layout', 'ux'],
  luna: ['accessibility', 'a11y', 'keyboard', 'screen reader', 'aria', 'contrast'],
  finn: ['design system', 'tokens', 'component library', 'reusable'],
  milo: ['state', 'cache', 'forms', 'redux', 'zustand', 'synchronization'],
  ruby: ['css', 'responsive', 'styles', 'styling', 'layout', 'tailwind'],
  kai: ['bundle', 'rendering', 'web vitals', 'layout shift', 'frontend performance'],
  juno: ['animation', 'motion', 'drag', 'interaction', 'editor'],
  nico: ['mobile', 'touch', 'pwa', 'small screen', 'offline'],
  tess: ['fetch', 'loading', 'streaming', 'client api', 'error handling'],
  axel: ['backend', 'server', 'endpoint', 'node', 'validation', 'http'],
  rhea: ['database', 'sql', 'postgres', 'sqlite', 'index', 'transaction', 'migration'],
  theo: ['auth', 'authentication', 'login', 'session', 'identity', 'permissions', 'oauth'],
  eden: ['integration', 'webhook', 'third party', 'external api', 'retry'],
  omar: ['realtime', 'websocket', 'sse', 'events', 'presence', 'collaboration'],
  zara: ['search', 'retrieval', 'ranking', 'vector', 'embeddings', 'rag'],
  leon: ['queue', 'worker', 'cron', 'scheduled', 'background', 'idempotent'],
  nia: ['ai', 'llm', 'model', 'inference', 'prompt', 'agent', 'tools', 'openai', 'ollama'],
  hugo: ['file', 'upload', 'storage', 'document', 'bucket', 'retention'],
  ida: ['caching', 'throughput', 'backend performance', 'latency', 'redis'],
  reed: ['devops', 'pipeline', 'ci', 'cd', 'automation', 'environment'],
  wren: ['cloud', 'hosting', 'infrastructure', 'network', 'deploy'],
  cole: ['docker', 'container', 'kubernetes', 'compose', 'image'],
  skye: ['uptime', 'incident', 'recovery', 'sre', 'reliability'],
  dane: ['logs', 'logging', 'metrics', 'tracing', 'observability', 'alert', 'monitoring'],
  vera: ['build', 'package', 'dependency', 'dependencies', 'bundle', 'npm', 'vite', 'esbuild'],
  remy: ['cli', 'terminal', 'developer tools', 'editor', 'local development', 'git'],
  blair: ['release', 'version', 'rollback', 'deployment', 'rollout'],
  neve: ['secrets', 'sandbox', 'isolation', 'network security', 'hardening'],
  arlo: ['cost', 'budget', 'free', 'usage', 'tokens', 'optimization'],
  quinn: ['test', 'tests', 'testing', 'coverage', 'acceptance', 'verification'],
  ava: ['unit', 'edge case', 'module', 'business logic'],
  ben: ['integration test', 'api test', 'database test', 'contract test'],
  esme: ['browser', 'playwright', 'e2e', 'end to end', 'user flow'],
  otto: ['debug', 'bug', 'failure', 'fix', 'broken', 'error', 'root cause'],
  mina: ['injection', 'xss', 'csrf', 'vulnerability', 'security test', 'input handling'],
  ezra: ['performance', 'load', 'concurrency', 'memory', 'benchmark', 'profiling'],
  luca: ['compatibility', 'browser support', 'runtime', 'cross platform'],
  maya: ['data quality', 'integrity', 'records', 'data validation'],
  felix: ['retry', 'cancellation', 'abort', 'failure', 'timeout', 'recovery'],
};

function boundedInteger(value, fallback, maximum) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(1, Math.min(maximum, Math.floor(number))) : fallback;
}

function includesTerm(text, term) {
  // Match whole terms, so short keywords such as "ai" do not match "maintain".
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])`, 'i').test(text);
}

/** Select an enabled lead, relevant specialists, and a final independent reviewer. */
export function selectAgents({ task = '', mode = '', maxAgents = 5, enabledAgentIds } = {}) {
  const limit = boundedInteger(maxAgents, 5, 50);
  const allowed = enabledAgentIds === undefined ? null : new Set(enabledAgentIds ?? []);
  const available = AGENTS.filter(agent => agent.enabled && (!allowed || allowed.has(agent.id)));
  const text = `${String(task)} ${String(mode)}`.toLowerCase().replace(/[-_]/g, ' ');
  const lead = available.find(agent => agent.id === 'atlas');
  const reviewer = available.find(agent => agent.id === 'sage');
  const selected = lead ? [lead] : [];
  if (selected.length === limit) return selected;

  const reserveReviewer = reviewer && reviewer !== lead ? 1 : 0;
  const ranked = available
    .filter(agent => agent !== lead && agent !== reviewer)
    .map((agent, index) => ({ agent, index, score: SPECIALTIES[agent.id].reduce((score, term) => score + (includesTerm(text, term) ? 1 : 0), 0) }))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  for (const { agent } of ranked) {
    if (selected.length >= limit - reserveReviewer) break;
    selected.push(agent);
  }
  if (reviewer && selected.length < limit) selected.push(reviewer);
  return selected;
}

function abortReason(signal) {
  return signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
}

/** Run an ordered batch with at most eight simultaneous operations. */
export async function mapConcurrent(items, limit, fn, signal) {
  if (!Array.isArray(items)) throw new TypeError('items must be an array');
  if (typeof fn !== 'function') throw new TypeError('fn must be a function');
  if (signal?.aborted) throw abortReason(signal);
  if (items.length === 0) return [];

  const concurrency = Math.min(items.length, boundedInteger(limit, 1, 8));
  const results = new Array(items.length);
  let cursor = 0;
  let stopped = false;
  let onAbort;
  const aborted = signal && new Promise((resolve, reject) => {
    onAbort = () => {
      stopped = true;
      reject(abortReason(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });

  async function worker() {
    while (!stopped) {
      if (signal?.aborted) throw abortReason(signal);
      const index = cursor++;
      if (index >= items.length) return;
      try {
        results[index] = await fn(items[index], index, signal);
        if (signal?.aborted) throw abortReason(signal);
      } catch (error) {
        stopped = true;
        throw error;
      }
    }
  }

  try {
    const work = Promise.all(Array.from({ length: concurrency }, () => worker()));
    await (aborted ? Promise.race([work, aborted]) : work);
    return results;
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}
