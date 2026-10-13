# Integration inventory and verification

The inventory distinguishes tools visible in this session from services connected to the application runtime. Availability of an MCP tool is not proof of installed application dependencies, valid application credentials or a functioning production integration. This manifest activates no connections and contains no secrets.

## Observed state

| Integration | Session evidence | Application state |
| --- | --- | --- |
| Stripe | Live EASY AGENT AI account observed through MCP | Billing credentials absent; live use must follow sandbox tests and readiness review |
| Supabase | Read-only project listing succeeded with an empty result | No project provisioned |
| Firecrawl | Plugin installed; no callable Firecrawl tool exposed in session ALL_TOOLS | Not configured |
| Remote Desktop Commander | DESKTOP-R43JS9N online; device identifier begins c652 | Device availability does not establish app installation |
| GitHub | Tools available; origin github.com/darren335033-jpg/easy-agent-codex.git | Source origin present; deployed runtime not inferred |
| OpenAI Platform | Credential target selected; local-save approval unresolved | Key not created |
| Cloudflare, NVIDIA, Sentry, Discord | No callable tools available | Not configured |
| Hugging Face | Plugin search AVAILABLE, installed false | Not installed or configured |
| Google | Veo selected; Drive and Gmail plugins available but not installed | Exact MCP service unresolved; video API credentials absent |
| OmniRoute | User selected diegosouzapw/OmniRoute; local MCP stream or stdio documented | Disabled; running endpoint unverified |
| Orca ADE | User selected stablyai/orca | Installation and runtime unverified |
| Sandcastle | Matt Pocock repository mattpocock/sandcastle; @ai-hero/sandcastle 0.12.0 API verified | Gated one-iteration scaffold; no run or connection verified |
| AgentOS | use-agent-os/agent-os official docs read through GitHub | Windows installation and MCP bridge not verified |
| Codex Windows PC | DESKTOP-R43JS9N online; remote commands timed out | No installation verified |
| iPhone 13 Pro | Responsive UI QA at 390px passed | Physical-device Safari testing and device sync unverified |

The application must show unavailable capabilities honestly. Tool registration, connection, authentication, deployment and end-to-end success are separate milestones. The agent registry offers scoped engineering, operations, security and testing roles for these milestones; it does not grant any integration tools automatically.

## Read-only smoke checklist

1. Confirm product identity, official documentation, supported transport and exact endpoint. Do not infer endpoints from names. Pin the package/version or record the remote server identity.
2. Confirm transport reachability and protocol handshake; document local stdio command or remote HTTP transport without credentials. Inspect certificate/hostname handling for remote connections.
3. Verify authentication using the intended scoped identity. Record only pass/fail, account/project identifiers where safe and credential variable names. Never record tokens, headers, full secret values or raw authenticated transcripts.
4. Fetch the server tool list; compare names and schemas against intended capabilities. An installed plugin with no callable tools remains unavailable.
5. Run a minimal read-only probe, such as listing named-project metadata. Avoid broad account exports, charges, resource creation, messages or deployment. Record timestamp, tool name, scope, redacted result and error category.
6. Review least-privilege permissions before granting any agent a tool. Restrict repository, project, device and environment. Separate sandbox from live billing, provider spend and production administration.
7. Verify application adapters separately with redacted configuration and mocked failure tests, then perform an approved bounded end-to-end check. A session MCP probe does not prove application runtime connectivity.
8. Capture safe operational metadata: provider name, environment, transport, tool inventory version, scope, probe outcome, reviewer and verification date. Keep secrets in approved server-side storage and out of browser bundles, logs and Git.

## Device and release checks

Windows installation needs explicit evidence of installed dependencies, application launch, local health response, repository identity and credential isolation. Do not treat an online remote device as proof of successful installation. Scope desktop operations to the selected device and avoid unrelated personal files.

The 390px browser result verifies a responsive layout only. A real iPhone 13 Pro check must cover Safari, touch targets, keyboard/form behaviour, file uploads, media playback, orientation, authentication persistence and interrupted network recovery. Record physical-device results separately from emulation. No synchronisation claim is supported by responsive QA.

Before live Stripe use, verify signed webhook processing, durable deduplication, ownership, payment gating, cancellation, entitlement reconciliation, refund handling and actual plan economics in a test environment. Before provider generation, verify region, account access, model identifier, costs and spending limits. Before any email or Discord message, obtain the explicitly required sending authority and validate recipient consent where applicable. No external service actions are performed by these documents.

## Confirmed local tool identities

AgentOS refers to [use-agent-os/agent-os](https://github.com/use-agent-os/agent-os), with installation guidance in [AGENTOS.md](AGENTOS.md). OmniRoute refers to [diegosouzapw/OmniRoute](https://github.com/diegosouzapw/OmniRoute): its documented MCP HTTP endpoint is `http://localhost:20128/api/mcp/stream`, with `--mcp` as the stdio option and `http://localhost:20128/v1` as the API base. The MCP gateway is disabled by default until toggled; documentation of these addresses is not a live connectivity result. Orca ADE refers to [stablyai/orca](https://github.com/stablyai/orca); no installation is asserted. Trading, wallet and external messaging capabilities remain outside this video-project scope.

Sandcastle setup and limits are documented in [integrations/SANDCASTLE.md](../integrations/SANDCASTLE.md). This coding library is not asserted to be an MCP server.
