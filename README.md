# Easy Agent AI 1.4.1

An independent coding workspace for Darren “Dazza” Smith. The local app connects a real repository to an AI tool loop, stages proposed edits for review, runs tests in disposable gVisor containers, and supports actual Git branches and commits. Models come from your authenticated OpenAI API project, Google Vertex AI project, or local Ollama installation.

**Easy Agent AI business address:** Stirling Walk, Redwood Park SA 5097, Australia. Also available in Settings → Setup guide.

The hosted interface also includes a browser project editor, 50 configurable specialist roles, MCP discovery, founder media, and a Model lab. Optional hybrid mode connects the private hosted app to your own Linux companion for repository work, local models, CLI reads, and isolated tests. These are original application features. The project does not include proprietary OpenAI models or promise equivalent model quality.

## Repository versions and deployment provenance

This tree contains the tested Easy Agent AI 1.4 source. The original repository README is preserved byte-for-byte in [the v1.1 Windows guide](docs/legacy-windows-v1.1.md). Its Windows launcher, local port, and Supabase instructions describe that earlier distribution; they are not installation steps for this source tree.

The application files originate from source commit `eac462cbebf21873be44e4dbe0abfdbcacbe9501`. The included `.openai/hosting.json` records the existing private Sites project's nonsecret identity. It is deployment provenance for the current project, not a credential or a generic hosting template. Local development needs no Sites login. A separate hosted deployment needs its own hosting configuration and authorization; this repository does not deploy automatically.

No API keys, OAuth sessions, companion signing secret, local `.env`, private datasets, or task state are included. OpenAI inference, provider accounts, and the live hybrid connection require the owner's configured credentials and endpoint; test fixtures do not establish account access.

## Start with the demo

Requires Node.js 22.13 or later, npm, and Git. From the downloaded source directory:

```sh
npm ci
cp .env.example .env
npm run demo
```

Open `http://127.0.0.1:3000`. The demo creates a small Git repository at `.forge/demo` with an intentionally incorrect Python addition function and standard-library regression tests, builds the interface, and starts the local companion against that repository. Repeated launches preserve your edits and Git history. `npm run demo -- --prepare-only` prepares the fixture without building or starting the app.

The demo does not install a model, make an AI request, build runner images, or run generated Python on your computer. Set up inference and the isolated test runner below to complete a real fix. The interface reports unavailable services instead of simulated results.

Suggested task:

> Fix the calculator's add function without weakening the tests. Inspect the files, run python:unittest in the sandbox, propose the smallest fix, and run the tests again.

Inspect the tool trace and test output, review the proposed diff, then apply the selected change. Run the Python test profile against disk, create a branch, and commit the reviewed files. Your Git history records the actual commit.

## Connect local inference

Start Ollama on the same computer as the local companion, then install a coding model:

```sh
ollama pull qwen2.5-coder:7b
```

Select Local and an installed model in the app. A 7B coding model is a starting point; a stronger model can produce better tool decisions if your hardware supports it. Model quality and hardware affect how reliably the task loop finishes. Smaller models can repeat inspections, emit invalid requests, or exhaust their step budget; the trace reports those outcomes.

`OLLAMA_BASE_URL`, `OLLAMA_MODEL`, and `OLLAMA_CONTEXT_WINDOW` belong in the server's `.env`. The example uses a 16,384-token context; larger windows require more memory. The provider health check queries the actual Ollama installation. Local inference has no per-request API charge, but uses your own hardware and electricity. Online repository tasks can reach your configured Ollama installation through hybrid mode; the browser does not connect directly to visitors' local model servers.

## Set up isolated testing

The runner requires a Linux Docker daemon at `/var/run/docker.sock` with the gVisor runtime registered as `runsc`. Docker alone is insufficient. If `runsc`, the daemon, or the required image is unavailable, the app returns an infrastructure error; it does not execute project source on the host.

After installing and configuring Docker and gVisor, build the trusted runner images:

```sh
docker --host=unix:///var/run/docker.sock build -t easy-agent-runner:local -f devkit/runner/Dockerfile .
docker --host=unix:///var/run/docker.sock build -t dazza-forge-eval:local -f devkit/evaluation/Dockerfile .
```

The Dockerfiles pin base images. You can supply an independently verified digest through `--build-arg BASE_IMAGE=...`. `FORGE_NODE_IMAGE` and `FORGE_PYTHON_IMAGE` select already-built local images. Execution resolves each image to its inspected immutable ID and never pulls an image.

Each test receives a source snapshot through stdin into a disposable container. It has no network, no host repository mount, no provider credentials, a read-only root filesystem, an unprivileged user, bounded tmpfs storage, one CPU, 512 MiB memory, 64 processes, a 30-second execution deadline, and bounded output. Removal is checked after execution. A cleanup failure is an infrastructure error.

The coding loop can request `node:test` and `python:unittest`. Manual profiles also include `node:check`, `npm:test`, and `npm:build`. npm profiles run offline. The supplied Node image contains no project dependencies; projects needing packages require a separately prepared trusted image with those dependencies already available. Containers run on your Linux companion, including when the private online app invokes them through hybrid mode. The hosted Worker itself provides no container runner.

## Use your own repository

Set `FORGE_WORKSPACE` to an existing absolute project directory in `.env`, then run:

```sh
npm run build
npm start
```

The companion binds to loopback and checks request Host and Origin. Restart after changing configuration. Prefer a dedicated project checkout. Repository operations reject traversal, symlinks, hard-linked files, common credential paths, Git internals, dependency directories, caches, binary files, and text files larger than 1 MB. Git metadata must remain inside the configured root; linked Git worktrees are currently excluded.

The local workbench reads actual disk files. Searches are literal and bounded. Reviewed writes use content hashes to reject stale edits, validate the full batch before writing, stage replacements, and roll back when a transaction fails. The process serializes its repository mutations. Concurrent external editors can still change files, so refresh after a conflict.

Git operations create real branches and commits. Commits include only the selected safe paths and preserve unrelated staged changes. They return the actual commit SHA. Hooks, clean filters, text conversions, external diff commands, automatic maintenance, and network protocols are disabled for these operations. Configure your Git author identity in your own repository before committing. The demo sets a local identity only inside its fixture. There is no push, fetch, pull-request, or remote deployment action.

## Connect the private hosted app to your companion

Hybrid mode keeps the interface online while repository files, task records, Ollama, CLI installations, Docker, and gVisor stay on a Linux machine you control. Use a dedicated checkout and complete the local inference and runner setup above on that machine. It must remain running for online repository work to be available.

Keep the hosted interface **and its API** restricted to your own account before enabling this connection. Request signatures authenticate the hosted gateway to the companion; they do not identify individual website visitors. A public gateway would give its visitors access to the connected workspace through that gateway.

Generate a dedicated 32-byte random secret using your secret manager, encoded as base64url. Set the same value as `FORGE_COMPANION_SECRET` in the companion's ignored `.env` and the hosted app's server secrets. Keep it separate from `OAUTH_SESSION_SECRET`. Leave `FORGE_COMPANION_URL` unset on the companion; that setting belongs to the hosted gateway. No real secret belongs in source control, a browser form, a URL, or a shared screenshot.

On the Linux machine, configure the repository and companion port in `.env`:

```dotenv
FORGE_WORKSPACE=/absolute/path/to/your/project
COMPANION_PORT=3001
# Set FORGE_COMPANION_SECRET securely to the same secret as the hosted gateway.
```

Install dependencies, build the app, and start the companion:

```sh
npm ci
npm run build
npm run companion
```

The companion listens on `127.0.0.1:3001` by default. Keep that listener on loopback and route a stable HTTPS hostname to it with a tunnel or an equivalent authenticated deployment. Run the companion under an operating-system service or process supervisor on your own host for continued availability. The host account needs access to the configured checkout, its provider credentials, and the Docker daemon with `runsc` and the prepared images.

### Publish a stable companion hostname with Cloudflare Tunnel

Use a named Cloudflare Tunnel with a domain you control. Follow Cloudflare's [installation and named-tunnel guide](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/local-management/create-local-tunnel/) and [Linux service guide](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/local-management/as-a-service/linux/). These setup steps are performed by you outside the app and require your own Cloudflare account authorization and DNS control. The following commands create a tunnel and DNS route; the app does not run them automatically:

```sh
cloudflared tunnel login
cloudflared tunnel create easy-agent-companion
cloudflared tunnel route dns easy-agent-companion companion.example.com
```

Replace `companion.example.com` with your hostname. Record the tunnel UUID and generated credentials-file path, then create a private `cloudflared` configuration outside the project using those values:

```yaml
tunnel: YOUR_TUNNEL_UUID
credentials-file: /absolute/path/to/.cloudflared/YOUR_TUNNEL_UUID.json
ingress:
  - hostname: companion.example.com
    service: http://127.0.0.1:3001
  - service: http_status:404
```

The catch-all rule rejects other hostnames. Keep the tunnel credential file private to the operating-system account running `cloudflared`. Validate the configuration and check the tunnel interactively:

```sh
cloudflared tunnel --config /absolute/path/to/.cloudflared/config.yml ingress validate
cloudflared tunnel --config /absolute/path/to/.cloudflared/config.yml run easy-agent-companion
```

After checking the connection, install it as a Linux service using the explicit configuration path:

```sh
sudo cloudflared --config /absolute/path/to/.cloudflared/config.yml service install
sudo systemctl enable --now cloudflared
sudo systemctl status cloudflared
```

The tunnel process only needs its own tunnel configuration and credentials; keep repository files, Docker access, and model-provider credentials with the companion's account. Use Cloudflare's current service instructions to match your host configuration. A named tunnel and service preserve the hostname across terminal sessions; availability still depends on your machine, processes, and network.

[Quick Tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/) are suitable for temporary QA only. Their generated hostname changes, their URL ends when the process stops, and they do not support Server-Sent Events. Use the stable named-tunnel hostname for the configured hybrid connection.

### Activate the hosted gateway

In the private hosted app's server configuration, set `FORGE_COMPANION_URL` to the HTTPS origin, such as `https://companion.example.com`, and set `FORGE_COMPANION_SECRET` to the matching server secret. Use an origin without credentials, extra paths, query parameters, or fragments. Apply that configuration through your hosting provider, then check the actual companion connection, repository status, model availability, and runner status in the online workbench. An endpoint appearing in configuration does not establish a working connection. Activation requires your real reachable HTTPS endpoint; a placeholder URL cannot connect a repository.

The gateway forwards only the allowed repository, coding-task, status, model-discovery, and fixed CLI-read operations. Requests carry an HMAC signature, timestamp, and nonce; the companion rejects invalid signatures, expired requests, and nonce replays. The browser receives operation results without receiving the signing secret. With the gateway and companion on 1.4.1 or later, `POST /api/coding/start` accepts an optional `Idempotency-Key` of 1–100 letters, digits, or hyphens. The key is included in the signature and preserved by the companion. Matching retries reuse a saved run in the companion’s latest 100-record history window; a different request with that key is rejected while it remains in that window. The key is scoped to coding-task admission, not arbitrary writes. Requests without this header retain the original signature format. There is no arbitrary shell, terminal, OAuth-route forwarding, or general-purpose proxy in this bridge.

Provider configuration remains specific to each runtime. A repository coding task runs on the companion and uses **the companion's** Ollama or Vertex credentials and model settings. Hosted quick tasks and specialist model calls use **the hosted app's** provider configuration. Google credentials placed in one runtime are not transferred to the other. CLI reads use the companion's existing CLI logins. OAuth integrations in the hosted interface keep their separate hosted sessions.

## How coding tasks work

A local task snapshots the configured repository, sends a bounded context to the selected model, and accepts structured tool requests for file inspection, literal search, Git observations, proposed edits, isolated tests, and completion. Proposed changes live in an overlay until you apply selected files. Evaluations run against that exact proposed snapshot; a later edit invalidates earlier passing verification. A model's claim that tests passed does not count as recorded verification.

Tasks have a model-step budget, a deadline, cancellation, persisted traces, and explicit failed or incomplete outcomes. The app allows two active local tasks. A repository snapshot is limited to 100 files and 500,000 bytes; the coding loop additionally requires each source file to be at most 100,000 bytes. Select a smaller workspace when those limits are exceeded. Excluded credential filenames do not make arbitrary source safe to share: inspect your project for embedded secrets before using a cloud model.

The 50 specialist roles are configurable prompts and routing profiles using your selected model. In the repository tool loop, one coordinator executes the tool calls; the app shows which selected roles were actually invoked. The browser fleet workflow can run specialist model calls with bounded concurrency. These roles are not 50 separately trained models, and selecting a role does not prove that it ran. Cloud calls incur provider charges, including work completed before cancellation.

Local task records, traces, proposals, and outcomes persist in `FORGE_STATE_DIR`, defaulting to `.forge/coding-runs`; the demo defaults to `.forge/demo-runs`. Protect that directory because it contains source-derived material. Active tasks interrupted by a server restart are marked failed with a restart reason, rather than silently restarted. Browser projects, fleet settings, and browser task history use local storage and should be exported regularly. The browser project and the disk repository are separate workspaces.

## Connect OpenAI models

OpenAI is available for both quick tasks and the repository coding loop through the official Responses API. Supply your existing `OPENAI_API_KEY` as a server secret on the runtime that will make the request. Keys are never entered into browser settings, saved in browser storage, or included in source downloads. A key stored on your PC remains inaccessible to this hosted app until you explicitly configure it on the appropriate server.

`OPENAI_MODEL` can supply a server default for API clients. In the interface, select OpenAI and enter a model ID in Settings. There is no assumed OpenAI model entitlement or fabricated default. **Check model catalog** requests the authenticated account's actual model list; listing a model does not prove that it supports the Responses API, JSON mode, or the chosen task. A successful real generation request establishes usable inference access.

The Settings catalog follows the task environment: Quick tasks checks the hosted server, while Code workspace checks the companion when hybrid mode is configured. The key stays on the selected runtime. Models available to one runtime's API project can differ from the other.

Requests use `https://api.openai.com/v1/responses`, server-side Bearer authentication, `store:false`, bounded output, deadlines, and no redirect following. The coding coordinator uses JSON decisions with the same repository restrictions, sandbox requirements, and explicit review as the other providers. An incomplete or refused response cannot become an automatically applied edit.

[OpenAI API pricing](https://developers.openai.com/api/docs/pricing) and [rate limits](https://developers.openai.com/api/docs/guides/rate-limits) depend on the model, API project, organization, service tier, and features. API usage is [billed separately from ChatGPT and Codex subscriptions](https://help.openai.com/en/articles/9039756-managing-billing-for-chatgpt-and-the-api-platform). This independent application does not grant ChatGPT plan credits, private model access, or OpenAI-hosted Codex environments.

## Usage and provider billing

The Usage & billing view summarizes recorded token usage and model calls for browser quick-task history and the latest 100 saved repository task records. Those scopes remain separate: browser history is stored on the current browser, while repository records persist on the companion. Refresh reads current saved repository records through the signed bridge in hybrid mode.

Counts come from returned provider usage or saved task events. Missing usage is identified; initialized zero counters are not proof that a request was free. Cancelled requests, network failures after an upstream call, other applications using the same key, and calls whose usage was not returned can still appear on a provider invoice. Cached input and reasoning tokens are subsets of input and output respectively and must not be added to the total again.

There is no fabricated credit balance, subscription entitlement, or invoice total. Use the linked provider billing dashboards for account charges and the current pricing and limits documentation for applicable rates. This owner-private build uses your provider accounts directly; it does not sell an app subscription or transfer an OpenAI subscription into this application.

## Connect Google Vertex AI

Use your billing-enabled Google Cloud project, enable the AI Platform API, and configure an identity with Vertex AI access and the permissions required by Google's remote MCP service. Set `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION`, and a `VERTEX_MODEL` available to your project and location. Model availability, quotas, and pricing depend on Google; the app does not provision a project, billing account, model endpoint, or tuning job.

For local Application Default Credentials:

```sh
gcloud auth application-default login
gcloud auth application-default set-quota-project YOUR_PROJECT_ID
```

The local companion obtains access tokens on the server. A server-side `GOOGLE_SERVICE_ACCOUNT_JSON` secret or temporary `GOOGLE_ACCESS_TOKEN` is also supported; access tokens expire. Keep credentials out of browser settings, source files, and exported archives. Opening the app or discovering a tool does not verify authenticated inference. A successful real model request is required to establish model access.

The adapter calls `generate_content` at `https://aiplatform.googleapis.com/mcp/generate`. Existing ChatGPT connector credentials do not transfer into this application. The repository loop can use Vertex for model inference while tests remain on the companion's gVisor runner. The hosted Worker can forward authorized operations through the optional hybrid gateway; repository storage and container execution remain on your own companion. Keep hosted deployments private and configure server secrets there only when you intend to enable billable cloud requests.

## Connect GitHub and local CLIs

The Integrations panel checks remote MCP access separately from CLI installation and login. Credentials configured in ChatGPT do not transfer into this app. Authenticate the CLIs on the same machine and under the same account as the companion. The private hosted app can request the fixed CLI-read profiles through a configured hybrid connection; the CLI processes run on the companion.

The GitHub MCP connection uses the [official remote server](https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md) at `https://api.githubcopilot.com/mcp/`, read-only headers, and a fixed set of account, repository, pull-request, issue, and workflow-run tools. Configure `GITHUB_TOKEN` or the fallback `GH_TOKEN` as a server secret with the necessary repository access. A successful `gh` login does not establish remote MCP authorization: the app reports those results independently. Discovery and read operations do not create pull requests, trigger workflows, or change repositories.

Install [GitHub CLI](https://cli.github.com/), the [Google Cloud CLI](https://docs.cloud.google.com/sdk/docs/install-sdk), and [Hugging Face CLI](https://huggingface.co/docs/huggingface_hub/en/guides/cli) through their official instructions. The HF profiles were checked with `huggingface_hub` 2.2.0; an isolated installation is:

```sh
python3 -m venv ../easy-agent-hf-cli
../easy-agent-hf-cli/bin/python -m pip install "huggingface_hub==2.2.0"
```

`GH_BIN`, `GCLOUD_BIN`, and `HF_BIN` default to `gh`, `gcloud`, and `hf` on the server's `PATH`. Set an absolute executable path when you install elsewhere, such as `../easy-agent-hf-cli/bin/hf` resolved to its absolute path. The example keeps the CLI environment outside the project. These settings select an executable, not a shell command. The app never installs software, edits shell startup files, or starts a login flow from a CLI read profile.

Complete the login you need from your own terminal:

```sh
gh auth login
gcloud auth login
hf auth login
```

Google CLI login and Application Default Credentials are separate. Use the ADC setup in the Vertex section for model inference. `GOOGLE_CLOUD_PROJECT` selects a project for relevant CLI reads; Cloud Run and model-registry reads also need a regional location such as `us-central1`. The Vertex inference location `global` is not a regional CLI location. GitHub repository reads accept `owner/repository`, with `GH_REPO` as an optional server default. `HF_TOKEN` can supply an existing Hugging Face server credential; public model and Space catalog reads can work without login.

The available profiles are fixed:

| Provider | Profiles | Scope |
| --- | --- | --- |
| GitHub CLI | `github.repos`, `github.pulls`, `github.issues`, `github.runs` | Repositories, open pull requests, open issues, recent workflow runs |
| Google Cloud CLI | `google.projects`, `google.services`, `google.runServices`, `google.vertexModels` | Accessible projects, enabled APIs, Cloud Run service summaries, registered Vertex models |
| Hugging Face CLI | `huggingface.whoami`, `huggingface.models`, `huggingface.spaces` | Account identity, public model and Space catalog summaries |

These profiles use bounded argument arrays, output limits, deadlines, and filtered environments. They do not accept browser-supplied executables, arbitrary shell commands, or arbitrary CLI arguments. Model-registry listing is distinct from listing every Gemini model available for inference. Individual reads still depend on your identity's access to the selected project or repository.

## Provider hub and MCP configuration

MCP discovery supports approved Streamable HTTP endpoints, initialization, sessions, SSE, and pagination. The hub distinguishes a documented endpoint, server configuration, and a successful connection test. A provider appearing in the catalog does not mean its account is connected or its tools have run.

The documented shared endpoints are:

| Provider | Official MCP endpoint | App credential or connection method |
| --- | --- | --- |
| [GitHub](https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md) | `https://api.githubcopilot.com/mcp/` | `GITHUB_TOKEN` or `GH_TOKEN`; independently tested from CLI login |
| [Google Vertex AI](https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/use-agent-platform-mcp) | `https://aiplatform.googleapis.com/mcp/generate` | Google server credentials, project, and model access |
| [Cloudflare](https://github.com/cloudflare/mcp) | `https://mcp.cloudflare.com/mcp` | `CLOUDFLARE_MCP_TOKEN` containing an accepted API token or MCP OAuth access token |
| [Sentry](https://github.com/getsentry/sentry-mcp) | `https://mcp.sentry.dev/mcp` | `SENTRY_MCP_TOKEN` containing an MCP OAuth access token |
| [Hugging Face](https://huggingface.co/docs/hub/agents-mcp) | `https://huggingface.co/mcp` | Restricted public discovery, or `HF_TOKEN` for authenticated access |
| [AWeber](https://docs.aweber.com/api/api/connecting-and-using-the-aweber-mcp-server) | `https://mcp.aweber.com/mcp` | App OAuth connection followed by provider consent |
| [GetResponse](https://www.getresponse.com/help/how-to-connect-getresponse-mcp-to-your-ai-application.html) | `https://mcp.getresponse.com` | App OAuth connection followed by provider consent; MAX accounts have account-specific setup |
| [Sandcastles](https://help.sandcastles.ai/mcp) | `https://mcp.sandcastles.ai/` | App OAuth connection followed by provider consent and eligible account access |

Cloudflare's documentation server, `https://docs.mcp.cloudflare.com/mcp`, is a separate service from its API server. The current Sentry adapter uses Bearer authentication for MCP OAuth tokens: `SENTRY_ACCESS_TOKEN` is an upstream Sentry API token and is not interchangeable with `SENTRY_MCP_TOKEN`. Provider subscription requirements and tool availability remain governed by each provider's current documentation.

Built-in interactive OAuth is limited to AWeber, GetResponse, and Sandcastles. It uses OAuth 2.1 authorization-code flow with PKCE S256 and dynamic client registration. Select Connect, sign in on the external provider's page, and grant consent. Registering an OAuth client or opening the consent page does not connect the account. Other providers use the server credential mechanism documented above; the app does not silently reuse another MCP client's login.

`OAUTH_SESSION_SECRET` must be a base64url encoding of 32 cryptographically random bytes. If it is not configured, the local launcher creates and reuses a private key at the ignored `.forge/oauth-session.key`; configure a durable secret in the hosting environment for a cloud deployment. The app keeps provider tokens in encrypted HttpOnly, SameSite=Lax cookies, using Secure cookies on HTTPS. Connected sessions expire at the provider token expiry or within 24 hours, whichever comes first; a missing provider expiry defaults to one hour. Reconnect after expiry because automatic refresh is not implemented. Changing the encryption key invalidates existing sessions. Local and hosted OAuth sessions are separate. No provider secrets are entered into browser settings or exported project files.

Custom deployments need their actual HTTPS MCP URL and authentication contract:

| Entry | Required configuration |
| --- | --- |
| [NVIDIA NeMo Agent Toolkit](https://docs.nvidia.com/nemo/agent-toolkit/latest/run-workflows/mcp-server.html) | Deploy the toolkit's MCP server behind authenticated HTTPS, then set `NVIDIA_MCP_URL` and its deployment credential. `NVIDIA_API_KEY` authenticates NIM inference, not every MCP deployment. |
| [Reddit](https://developers.reddit.com/docs) | Supply a trusted custom or community server through `REDDIT_MCP_URL`. No canonical first-party Reddit MCP endpoint was verified. Reddit API OAuth and a third-party server's authentication are separate. |
| [OmniRoute](https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.52/docs/frameworks/MCP-SERVER.md) | Set `OMNIROUTE_MCP_URL` to your trusted deployment's documented `/api/mcp/stream` endpoint and configure its access token. No shared account endpoint is assumed. |
| Orca / Orcas | Identify the product and supply its own endpoint. [Orca Security](https://docs.orcasecurity.io/docs/orca-security-mcp-server), [Orca's coding environment](https://www.onorca.dev/), and [StreamNative Orca](https://docs.streamnative.io/agent-engine/agents-overview) are distinct products. |
| Agent OS | Identify [Agno AgentOS](https://docs.agno.com/agent-os/mcp/mcp) or [Builder Methods Agent OS](https://buildermethods.com/agent-os). Agno can expose `/mcp` on your authenticated deployment; there is no assumed shared endpoint. |
| Easy Agent AI MCP | Supply an endpoint and tool schema owned by your deployment through `EASY_AGENT_MCP_URL`; a similarly named third-party project is not an account connection. |

Override URLs and custom server hosts must be allowed in `MCP_ALLOWED_HOSTS`; private addresses, metadata endpoints, and unapproved destinations are blocked. Optional `MCP_SERVERS_JSON` entries reference a server-side token variable:

```json
[{"url":"https://your-server.example/mcp","tokenEnv":"YOUR_MCP_TOKEN"}]
```

A connection test discovers tools without authorizing arbitrary tool execution. Stdio servers need a separately operated authenticated HTTPS bridge. Keep all token values in server credentials, and configure only environment variable names and approved URLs in connection metadata.

## Model lab, validation, and deployment

The Model lab validates JSONL structure, duplicates, and held-out prompt overlap. The [Vertex development kit](devkit/README.md) includes infrastructure templates, tuning request preparation, and local evaluation utilities. Validation does not train a model, establish dataset licensing, or measure coding quality by itself. No cloud resource or training job is created by opening the lab.

Validate the application source with:

```sh
npm test
npm run build
```

Application tests verify trusted controller code; generated project source runs through the isolated test profiles. Source lives in `src/`, `server/`, `worker/`, and `devkit/`. The build produces the local interface, an allowlisted source download, and the hosted Worker artifact at `dist/server/index.js` with `dist/.openai/hosting.json`. Builds exclude `.env`, local task state, demo Git metadata, and dependency directories from the source archive.

Current limits include one configured companion repository, no collaborative database, container execution requiring your own Linux companion, no automatic remote Git actions, no arbitrary agent shell, and no automatic use of every discovered MCP server. Hybrid mode requires a private hosted gateway and your reachable authenticated HTTPS companion. Treat model changes as proposals and use the recorded evaluation results and reviewed diff to decide what to apply.
