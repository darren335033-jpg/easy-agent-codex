# Sandcastle coding sandbox scaffold

The user-selected Matt Pocock project is [mattpocock/sandcastle](https://github.com/mattpocock/sandcastle). Its official README and package manifest were read through GitHub; the package is `@ai-hero/sandcastle`, version `0.12.0`. It is a TypeScript coding-agent orchestration library, not an independently verified MCP server. This project provides a gated scaffold, not an installed or connected runtime.

The verified API exports `run` and `codex` from the package, plus `docker` from `@ai-hero/sandcastle/sandboxes/docker`. The README documents `codex(model, options)`, Docker `imageName` and `cpus`, `maxIterations`, absolute `promptFile`, and an explicit `{ type: "branch", branch: "..." }` strategy. The scaffold uses one iteration, two CPUs and an isolated named agent branch, with no automatic merge to HEAD. `approvalsReviewer: "auto_review"` is documented; upstream AFK Codex defaults otherwise bypass approvals, so review the provider behaviour and Docker permissions before enabling it. Container isolation is not a dollar spending cap or a complete network boundary.

## Operator prerequisites

- Install the pinned package `@ai-hero/sandcastle@0.12.0` in the selected integration package, and a verified TypeScript runner. Resolve imports from the scaffold's location; installation elsewhere does not automatically make them resolvable.
- Verify Docker and a reviewed image containing the Codex CLI, Git, required project runtimes and a non-root user compatible with the host UID/GID. The default README Dockerfile installs Claude Code; do not assume it contains Codex.
- Set `EASY_AGENT_CODEX_MODEL` to a model actually available to the operator's selected Codex profile, and `EASY_AGENT_SANDBOX_IMAGE` to the verified image. Neither has a guessed default.
- Verify the intended authentication/profile inside the container separately. The upstream API supports explicit readonly mounts and environment injection, but this scaffold copies or mounts no credentials. Do not mount an entire personal profile or persist plaintext keys in source. No existing account authentication is assumed to work in a fresh container.
- Inspect the prompt, source branch, clean worktree behaviour, tool permissions, spend controls and network policy. Only after these checks set `EASY_AGENT_SANDBOX_RUN=true` for the reviewed invocation of `.sandcastle/main.mts`.

The gate is checked before library import or invocation. Without it the file exits with an error and performs no agent work. With it, the run may use provider services through the configured Codex CLI; this is not a free or simulated invocation. No enabled run has been performed.

## OmniRoute and Orca relationship

OmniRoute remains the selected gateway product and Orca remains the selected ADE. Sandcastle offers a separate isolated coding-workflow layer. Configure the actual Codex profile against the reviewed OmniRoute gateway only using documented Codex and OmniRoute configuration; this scaffold invents no SDK fields, mounts or authentication headers. Host `localhost:20128` does not automatically refer to the host gateway from Docker: verify an authenticated, restricted container-accessible address before running, rather than silently replacing it. Orca integration likewise needs its documented tool path and a real scoped handshake; merely selecting its repository does not connect it.

Keep trading, wallet operations, training, external messages and bulk generation outside this assignment. The 1,050 registry roles are inactive and are not launched by this one-iteration scaffold.

Sources: [README API and branch strategies](https://github.com/mattpocock/sandcastle/blob/main/README.md), [package version](https://github.com/mattpocock/sandcastle/blob/main/package.json). Runtime import compatibility and actual container execution remain unverified until the pinned package and reviewed image are available.
