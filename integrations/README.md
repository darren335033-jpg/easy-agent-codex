# Integration status

The project `.codex/config.toml` configures the official OmniRoute gateway profile,
its read-only MCP tools, Hugging Face MCP, and NVIDIA CUDA documentation MCP.
Entries are configuration, not proof of a successful connection. OAuth and local
runtime checks remain necessary. Default Codex provider settings are unchanged.

Confirmed repositories:
- https://github.com/diegosouzapw/OmniRoute — selected local gateway
- https://github.com/stablyai/orca — selected Codex orchestration and phone companion
- https://github.com/use-agent-os/agent-os — selected AgentOS (separate integration)
- https://github.com/huggingface/hf-mcp-server — official hosted Hugging Face MCP

## Verification

Run `node integrations/scripts/check-mcp.mjs` after OmniRoute is running and its
streamable HTTP MCP is enabled. The checker initializes the protocol and lists
tools only. It never submits a completion or changes gateway state. Set a scoped
OMNIROUTE_MCP_TOKEN if authentication is needed; keep it separate from the gateway
OMNIROUTE_API_KEY used by the Codex model profile.

Inspect the installed Codex CLI's `mcp --help`, then authenticate the configured
OAuth endpoints. NVIDIA requires an NVIDIA Developer sign-in. Hugging Face needs
its own login. These are separate from GitHub access and provider API access.

Orca integration uses its documented Codex launcher and Settings → Integrations → MCP.
Open this checkout as the workspace, select the existing Codex account, and load
version-matched CLI guides before installing or changing Orca skills. Pair the
phone using Orca's one-time desktop pairing flow; do not send pairing tokens here.
The official iOS app is https://apps.apple.com/us/app/orca-ide/id6766130217.

Current PC execution has timed out. No runtime, OAuth, or device pairing success
has been observed. The cloud workspace cannot establish a PC-local loopback
connection. It has also blocked direct outbound traffic to several MCP hosts.

Sources: OmniRoute docs/frameworks/MCP-SERVER.md; https://www.onorca.dev/docs/agents/codex;
https://www.onorca.dev/docs/cli/skills; https://www.onorca.dev/docs/mobile;
https://huggingface.co/mcp; https://developer.nvidia.com/nsight-ai;
https://developers.openai.com/codex/mcp and config-reference.

Sandcastle is the confirmed Matt Pocock project, mattpocock/sandcastle. See SANDCASTLE.md and the gated .sandcastle/main.mts scaffold. The optional Easy Agent status bridge is configured for metadata discovery only; it does not start workers or provide native upstream MCP capabilities.
