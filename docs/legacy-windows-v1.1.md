# Easy Agent Codex AI 1.1

An independent, local coding workspace by Darren Smith / Easy Agent. This is not
an OpenAI product, a copy of Codex Cloud's infrastructure, or a trained frontier
model. It provides a browser workspace, a local agent loop, persistent sessions,
project inspection, reviewed file edits, reviewed commands, CLI access and a
read-only MCP status connection.

## Start on Windows

1. Install Node.js 24 or newer from https://nodejs.org/ and Ollama from
   https://ollama.com/download/windows. No npm packages are required by this app.
2. In a terminal run `ollama pull qwen3:1.7b` if the model is not already installed.
3. Extract the entire ZIP and keep its folder. Open `Install-Easy-Agent.cmd` to
   create shortcuts and enable startup at Windows login. This does not need an
   administrator account or a subscription.
4. Open `Start-Easy-Agent.cmd`. The app is http://127.0.0.1:18805.
5. Choose a project folder, model and Project tools, then create a session.
   Explain the work you want. Review proposed contents or commands before approval.

The included `demo-workspace` contains a small JavaScript function and test. It is
an example project, not evidence of an AI-completed task. Start with an explanation
or a small change. Small local models can make mistakes and miss instructions.

## Supabase sign-in and protected routes

Version 1.1 includes Supabase email/password sign-in, password recovery, logout,
and server checks before anyone can open the coding workspace or its APIs.
Authentication is optional until you configure an existing Supabase project.
The app labels the unconfigured mode **Local access**. A configured installation
requires an approved account, including for CLI and MCP requests.

### Configure your project

1. In your Supabase project, enable email/password authentication. Keep public
   signup disabled for this owner-operated application. Create or invite your own
   user account and complete email verification before trying to sign in.
2. Set the Auth Site URL to `http://127.0.0.1:18805`. Add the exact redirect URL
   `http://127.0.0.1:18805/auth/callback` for password recovery. Use the same
   configured port in both URLs if you change `EASY_CODEX_PORT`.
3. Obtain the project's HTTPS URL and **publishable** API key from its dashboard.
   The configuration helper accepts publishable keys. A legacy `anon` key can be
   supplied manually in `.env` for compatibility. Secret and `service_role` keys
   are rejected. Do not use a database password or a model-provider key.
4. In the extracted app folder, run `Configure-Supabase.cmd` on Windows or
   `node scripts/configure-auth.mjs`. Enter the project URL, publishable key, and
   the specific owner email or Auth user UUID to allow. The helper writes the
   local `.env`, preserves unrelated settings, and backs up an existing config.
   It does not create a Supabase project, change billing, or create a user.
5. Stop and start Easy Agent. Open `http://127.0.0.1:18805` and sign in with the
   approved, verified account. The workspace shows **Supabase sign-in active**.

`auth.env.example` documents the five configuration names without real account
details. All launcher paths load the app's `.env`; existing process environment
values take precedence. Any incomplete Supabase configuration stops startup
instead of falling back to local access. An explicit `EASY_CODEX_AUTH_MODE=local`
is an operator-selected local mode, not a recovery mechanism for failed logins.

### Access behavior

- The workspace at `/`, `/index.html`, `/app.js`, and all operational `/api/*`
  routes require an approved account when Supabase mode is enabled. Anonymous
  page visits redirect to `/login`; API requests return `401` without workspace
  data. Signing up or possessing an unrelated Supabase account does not grant
  access. Every configured owner shares this computer's existing workspace and
  sessions; this is not a multi-tenant hosting service.
- Supabase verifies identity through its `/user` endpoint before protected
  requests. Access decisions use that verified user ID or verified email and the
  local owner allowlist. User-editable profile metadata is never an authority.
- The browser receives an opaque, HttpOnly, SameSite cookie and a separate
  session-specific CSRF token. Supabase access and refresh tokens stay in server
  memory. Local sessions last at most 12 hours and end when the app restarts.
  Server-side refresh handles expiring provider tokens. Verification outages
  return `503` and do not expose project data.
- Signing out immediately deletes the local session, even if Supabase is
  unavailable. Provider sign-out is attempted for that session. Revocation
  elsewhere remains subject to Supabase's access-token lifetime and behavior.
- **Forgot your password?** sends a generic response. Recovery uses a one-use
  PKCE flow that expires after 15 minutes. Open the email link in the original
  browser on the same computer, keep the local app running, and choose a new
  password of at least 12 characters. A recovery session can change its password
  but cannot access workspace APIs until that change succeeds.
- The health endpoint and `/api/auth/config` expose only basic service metadata.
  No Supabase key, user list, project path, prompt, or model token is returned.

Supabase is used for identity only. Project files and coding sessions remain on
this computer; no database tables or Row Level Security policies are needed for
this release. Adding cloud data later requires its own ownership policies.
Sign-in involves outbound HTTPS to your configured Supabase project. Inference
continues through the configured local Ollama provider.

The local server remains bound to `127.0.0.1`, with Host, Origin, CSRF, and
fetch-metadata checks. Its HTTP-only loopback transport is why the local cookie
does not use the HTTPS `Secure` flag. Do not expose this filesystem/command
service through a tunnel or public interface.

### CLI and MCP sign-in

Run `easy-agent.cmd login` from an interactive terminal after configuring Auth.
The password is entered without echo. The CLI stores its opaque local session
cookie and local CSRF token in `.data/cli-auth.json`; it does not save the
password or a Supabase access/refresh token. Run `easy-agent.cmd logout` to remove
that session, including while Supabase is temporarily unavailable.
CLI and read-only MCP requests use this same authenticated local connection.
After a server restart, sign in again. Direct browser sign-in and CLI sign-in are
separate local sessions.

### Validation status and service setup

The included tests exercise Auth with fake Supabase responses and disposable
workspaces. They do not prove that a particular Supabase project, email delivery
service, or user account is configured. Test a real owner login, a rejected user,
logout, and the recovery email after connecting your project. Supabase's default
email service has limited test delivery; configure supported email delivery for
the level of reliability your account needs.

Official references:

- https://supabase.com/docs/guides/auth/passwords
- https://supabase.com/docs/guides/auth/redirect-urls
- https://supabase.com/docs/guides/auth/sessions/pkce-flow
- https://github.com/supabase/auth/blob/master/openapi.yaml

## Cost and availability

There is no software subscription or monthly request allowance in this local
edition. Downloaded model inference does not use a paid provider API. Models and
Node are separate downloads. Hardware, memory, storage and electricity still
cost money. Ollama must be running, Windows must be awake and the account must
be logged in. The app cannot guarantee 24/7 uptime or remove another provider's
quotas. No paid fallback, remote Ollama alias or provider key is accepted.

One task runs at a time. Each run has at most 16 model steps, an 8K context window,
bounded files and output, and five minutes per model response. Approved commands
have a 30-second timeout. These limits prevent runaway jobs; they are not a
weekly or monthly subscription quota.

## Review, privacy and recovery

All writes and commands pause for review. File writes reject source changes since
the proposal and create backups in the project's `.local-coder-backups` folder.
Read tools reject traversal, links, common secret names and binary files. Commands
run with your Windows account permissions: the working directory is not an OS
sandbox. Only approve commands you understand. Never use this application as a
public server, remove loopback protection or forward its port through a tunnel.

Sessions and prompts are saved as plaintext in `.data/sessions`, with atomic
checkpoints and prior `.bak` files. Protect that folder and back it up separately.
Export session downloads a Markdown record that may contain project source and
prompt text. Do not share exports without reviewing them.

The supervisor tries bounded recovery after an unexpected server exit: at most
three failures within ten minutes, with backoff. Interrupted work stays paused;
commands are never automatically replayed. `Stop-Easy-Agent.cmd` also writes a
persistent disabled marker respected at login. Manual Start re-enables the app.
Stopping an in-flight command can leave partial changes; inspect before resuming.

## CLI and Codex connection

Run `easy-agent.cmd help`. Available commands include `status`, `models`, `sessions`,
`ask <project-folder> <model> <prompt>`, `login`, `logout`, `start`, `stop`, and `install`.

`easy-agent.cmd codex qwen3:1.7b` launches the separately installed official Codex
CLI with its supported `--oss --local-provider ollama` flags. It preserves Codex
approvals and sandboxing. Actual model compatibility depends on your installed
CLI and Ollama versions; this does not reroute an existing ChatGPT conversation.

To connect read-only status to a Codex installation, use its supported MCP command:

```text
codex mcp add easy-agent-codex -- node "C:\path\to\easy-agent-codex-ai\src\mcp.mjs"
```

The two MCP tools return availability and model names only. They do not expose
files, prompts, session contents, a shell or an approval endpoint. Restart the
Codex client to discover a newly added server.

## Validate and package

`node --test tests/*.test.mjs` tests approvals, stale writes, recovery, command
cancellation, protected paths, provider restrictions and HTTP isolation using
temporary projects and a fake provider. Actual local inference is a separate check.
`node scripts/package.mjs` creates an allowlisted ZIP and SHA-256 file under
`release/`. Maintainers can pass `--site-directory <site-source>` to update the
download site's `dist` from its existing `index.template.html`. Runtime data,
credentials and model weights are excluded. The public website distributes the
application; the backend runs on the downloader's own machine.
