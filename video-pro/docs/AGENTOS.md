# AgentOS for the video project

The selected product is [use-agent-os/agent-os](https://github.com/use-agent-os/agent-os). Its official product guide, release README, documentation index, quickstart and MCP server guide were read through GitHub. AgentOS is an optional local engineering assistant; Easy Agent Video Pro remains the primary application. No AgentOS installer has been executed and no Windows installation is verified. The selected PC was online, but remote commands timed out.

## Verified Windows options

The official README documents a portable Windows release with bundled Python: [AgentOS-windows-x64-portable.zip](https://github.com/use-agent-os/agent-os/releases/latest/download/AgentOS-windows-x64-portable.zip). Extract to a writable project tools directory. The upstream instructions identify `Start AgentOS.cmd` as the launcher and request administrator mode for first-time setup; review its installation actions before launch. The launcher may install the Visual C++ runtime via winget. The native signed desktop app described elsewhere in the README is for macOS, not Windows.

Terminal installation is another documented option using Python 3.12+ and uv; use the current release README for its versioned install command. Source development additionally requires Git, Git LFS and Node.js 22+. Do not mix checkout-backed `uv run agentos` commands with a separately installed CLI. The upstream documentation says Windows lacks the process sandbox available on Linux/macOS; use workspace restrictions and tool permissions and do not treat those as equivalent OS containment.

## Setup sequence after an installation is verified

1. Confirm `agentos --help`, the executable path (`where.exe agentos` for a PATH installation), installed version and project identity.
2. Review workspace permissions. Keep optional channels, trading, wallets and scheduled unattended work unconfigured for this project.
3. Use `agentos onboard --minimal`, or, after secure credential setup, `agentos onboard --provider openai --api-key-env OPENAI_API_KEY`. Pass the environment variable name, never its secret value. OpenAI credential creation and local-save approval remain unresolved.
4. Run `agentos onboard status` and `agentos doctor`. Investigate failures before granting work.
5. Start `agentos gateway run`, or `agentos gateway start --json`; check `agentos gateway status`. The control UI defaults to `http://127.0.0.1:18791/control/`.
6. Begin with one bounded video-project review, using the actual verified Windows checkout path: `agentos agent --workspace <project-path> --workspace-strict -m "Review this video project and propose a test plan"`. Review cost and output before expanding work.

Configuration precedence is `AGENTOS_GATEWAY_CONFIG_PATH`, then project `agentos.toml`, then `~/.agentos/config.toml`, then defaults. This documentation does not create or alter those files.

## Codex / MCP bridge

The upstream guide documents a stdio bridge launched as `agentos mcp-server run`. Its MCP SDK is a core dependency. Start and verify the AgentOS gateway first; the bridge connects to `ws://localhost:18791/ws` by default, or the address passed with `--gateway`. An MCP-capable client can launch that command as its server process. After confirming the installed Codex client's supported MCP configuration format, register the executable path and arguments; verify handshake, tool list and one read-only workspace probe. No Codex configuration or successful handshake is claimed here.

Keep the gateway on loopback and do not expose it for iPhone access without a separately reviewed authenticated network path. No iPhone sync is established. Provider and channel secrets must not be placed in MCP client examples.

## Sources

- [Product guide](https://github.com/use-agent-os/agent-os/blob/main/README.product.md)
- [Installation README](https://github.com/use-agent-os/agent-os/blob/main/README.md)
- [Documentation index](https://github.com/use-agent-os/agent-os/blob/main/docs/README.md)
- [Quickstart](https://github.com/use-agent-os/agent-os/blob/main/docs/quickstart.md)
- [MCP bridge](https://github.com/use-agent-os/agent-os/blob/main/docs/mcp-server.md)

These commands are a setup plan, not execution evidence. Installer execution, credentials, provider requests and agent activation remain separate verification steps.
