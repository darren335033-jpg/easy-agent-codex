import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// No container, agent or provider call is made unless an operator enables this gate.
if (process.env.EASY_AGENT_SANDBOX_RUN !== 'true') {
  throw new Error('Sandbox execution disabled. Review integrations/SANDCASTLE.md before setting EASY_AGENT_SANDBOX_RUN=true.');
}
const model = process.env.EASY_AGENT_CODEX_MODEL?.trim();
const imageName = process.env.EASY_AGENT_SANDBOX_IMAGE?.trim();
if (!model || !imageName) {
  throw new Error('Specify verified EASY_AGENT_CODEX_MODEL and EASY_AGENT_SANDBOX_IMAGE; no model or image is assumed.');
}
const here = dirname(fileURLToPath(import.meta.url));
const cwd = resolve(here, '..');
const promptFile = resolve(here, 'prompt.md');
const { run, codex } = await import('@ai-hero/sandcastle');
const { docker } = await import('@ai-hero/sandcastle/sandboxes/docker');
await run({
  agent: codex(model, { approvalsReviewer: 'auto_review' }),
  sandbox: docker({ imageName, cpus: 2 }),
  cwd,
  branchStrategy: { type: 'branch', branch: `agent/video-review-${Date.now()}` },
  promptFile,
  maxIterations: 1,
  name: 'easy-agent-video-review',
});
