# Codex, OmniRoute and Orca integration

Confirmed upstreams:
- OmniRoute: https://github.com/diegosouzapw/OmniRoute
- Orca: https://github.com/stablyai/orca

OmniRoute's official README documents a local OpenAI-compatible API at
http://localhost:20128/v1. Its MCP-SERVER.md documents stdio `omniroute --mcp`
and streamable HTTP at http://localhost:20128/api/mcp/stream. HTTP MCP must be
enabled on the running gateway; this repository does not pretend it is running.
Use scoped keys and inspect the installed CLI's help before changing its settings.
Keep credentials in the gateway or environment, never a source-controlled TOML file.

Orca's official README documents desktop builds for Windows, Codex CLI support,
and an iOS companion paired with the desktop app:
https://apps.apple.com/us/app/orca-ide/id6766130217
https://www.onorca.dev/docs/mobile

The video app remains a separate local workspace. Orca can orchestrate coding
worktrees and its companion can monitor agents; that does not publish the video
app, sync its media, or turn role definitions into running agents.

PC observation: Desktop Commander reported DESKTOP-R43JS9N online, but command
execution timed out. No PC installation or Codex configuration was verified.
The iPhone must install the official companion and complete device pairing.
No physical iPhone is remotely attached to this session.

Engineering MCP configuration is supplied as a project-scoped template. Entries
remain disabled until their OAuth/token authentication, tool discovery and a
read-only smoke test succeed. Cloudflare, Sentry and Hugging Face have documented
remote endpoints. NVIDIA's documented CUDA-docs MCP is documentation access,
not provisioned GPU inference. Google service choice, Discord integration,
and Sandcastles identity must be resolved before configuration.
