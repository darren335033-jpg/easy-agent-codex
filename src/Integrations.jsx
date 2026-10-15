import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  AlertCircle,
  ArrowDownToLine,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronDown,
  Cloud,
  Code2,
  Copy,
  ExternalLink,
  FolderGit2,
  Github,
  Info,
  Link2,
  Loader2,
  LockKeyhole,
  LayoutGrid,
  RefreshCw,
  Search,
  Server,
  ShieldCheck,
  Square,
  Terminal,
  X,
} from "lucide-react";
import "./integrations.css";

const TABS = [
  {
    id: "mcp",
    label: "GitHub MCP",
    icon: Link2,
    title: "GitHub, through your MCP server.",
    description:
      "Read your profile, repositories, pull requests, issues, and workflow runs through the configured GitHub MCP connection.",
  },
  {
    id: "github",
    label: "GitHub CLI",
    icon: Github,
    title: "Your GitHub account. Your local CLI.",
    description:
      "Use authenticated, read-only gh profiles from the local companion. Every request runs on the machine hosting that companion.",
  },
  {
    id: "google",
    label: "Google Cloud CLI",
    icon: Cloud,
    title: "Your cloud infrastructure, in view.",
    description:
      "Inspect projects, enabled services, Cloud Run services, and Vertex models through authenticated gcloud profiles.",
  },
];
TABS.push(
  {
    id: "huggingface",
    label: "Hugging Face CLI",
    icon: Terminal,
    title: "Your model catalog. A direct view.",
    description:
      "Read public Hugging Face models and Spaces through the local hf CLI. Account identity requires a CLI sign-in.",
  },
  { id: "catalog", label: "Connections", icon: LayoutGrid },
);
const PROFILES = {
  huggingface: [
    {
      id: "huggingface.models",
      label: "Public models",
      description:
        "List popular public models from the Hugging Face Hub. Sign-in is optional.",
    },
    {
      id: "huggingface.spaces",
      label: "Public Spaces",
      description:
        "List popular public Spaces from the Hugging Face Hub. Sign-in is optional.",
    },
    {
      id: "huggingface.whoami",
      label: "Account identity",
      description:
        "Read the identity and organizations associated with this machine’s hf CLI sign-in.",
    },
  ],
  mcp: [
    {
      id: "profile",
      label: "Your GitHub profile",
      description:
        "Read the account associated with the server’s GitHub credential.",
    },
    {
      id: "repositories",
      label: "Repositories",
      description: "List repositories available to the authenticated account.",
    },
    {
      id: "pulls",
      label: "Pull requests",
      description: "Read pull requests for a repository.",
      repository: true,
    },
    {
      id: "issues",
      label: "Issues",
      description: "Read issues for a repository.",
      repository: true,
    },
    {
      id: "runs",
      label: "Workflow runs",
      description: "Inspect recent GitHub Actions workflow runs.",
      repository: true,
    },
  ],
  github: [
    {
      id: "github.repos",
      label: "Repositories",
      description: "List repositories using the authenticated GitHub CLI.",
    },
    {
      id: "github.pulls",
      label: "Pull requests",
      description: "List pull requests for a selected repository.",
      repository: true,
    },
    {
      id: "github.issues",
      label: "Issues",
      description: "List issues for a selected repository.",
      repository: true,
    },
    {
      id: "github.runs",
      label: "Workflow runs",
      description: "Inspect recent GitHub Actions runs.",
      repository: true,
    },
  ],
  google: [
    {
      id: "google.projects",
      label: "Projects",
      description: "List projects visible to your Google Cloud CLI account.",
    },
    {
      id: "google.services",
      label: "Enabled APIs & services",
      description: "List enabled services in a specific project.",
      project: true,
    },
    {
      id: "google.runServices",
      label: "Cloud Run services",
      description: "List deployed Cloud Run services in a project and region.",
      project: true,
      region: true,
    },
    {
      id: "google.vertexModels",
      label: "Vertex AI models",
      description:
        "List your project’s registered Vertex AI models in a region.",
      project: true,
      region: true,
    },
  ],
};
const stringify = (value) =>
  typeof value === "string" ? value : JSON.stringify(value, null, 2);
const readableDate = (value) =>
  value && Number.isFinite(new Date(value).getTime())
    ? new Date(value).toLocaleString([], {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "";
function safeLink(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) &&
      !url.username &&
      !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}
async function request(path, { body, signal } = {}) {
  const response = await fetch(path, {
    ...(body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
    signal,
  });
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error(
      `The integration server returned an unreadable response (${response.status}).`,
    );
  }
  if (!response.ok)
    throw new Error(
      data.message ||
        data.error?.message ||
        (typeof data.error === "string" ? data.error : "") ||
        `Request failed (${response.status}).`,
    );
  return data;
}
function Badge({ tone = "neutral", children }) {
  return (
    <span className={`ig-badge ${tone}`}>
      <span />
      {children}
    </span>
  );
}
function ErrorMessage({ children, onDismiss }) {
  return (
    <div className="ig-error" role="alert">
      <AlertCircle size={17} />
      <span>{children}</span>
      {onDismiss && (
        <button aria-label="Dismiss integration error" onClick={onDismiss}>
          <X size={15} />
        </button>
      )}
    </div>
  );
}
function Command({ children }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(children);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {}
  }
  return (
    <div className="ig-command">
      <code>{children}</code>
      <button aria-label={`Copy ${children}`} onClick={copy}>
        {copied ? <Check size={14} /> : <Copy size={14} />}
      </button>
    </div>
  );
}

export default function Integrations({ notify = () => {} }) {
  const [tab, setTab] = useState(() =>
    new URLSearchParams(window.location.search).has("integration")
      ? "catalog"
      : "mcp",
  );
  const [status, setStatus] = useState(null);
  const [checking, setChecking] = useState(true);
  const [statusError, setStatusError] = useState("");
  const [checkedAt, setCheckedAt] = useState(null);
  const [profiles, setProfiles] = useState({
    mcp: "repositories",
    github: "github.repos",
    google: "google.projects",
    huggingface: "huggingface.models",
  });
  const [repository, setRepository] = useState("");
  const [projectId, setProjectId] = useState("");
  const [region, setRegion] = useState("us-central1");
  const [results, setResults] = useState({});
  const [errors, setErrors] = useState({});
  const [pending, setPending] = useState(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const requestController = useRef(null);
  const statusController = useRef(null);
  const mounted = useRef(false);
  const cancelled = useRef(false);
  const currentTab = TABS.find((item) => item.id === tab);
  const profile =
    (PROFILES[tab] || []).find((item) => item.id === profiles[tab]) ||
    (PROFILES[tab] || PROFILES.mcp)[0];
  const local = ["local", "hybrid"].includes(status?.runtime);
  const mcp = status?.github?.mcp;
  const githubCli = status?.github?.cli;
  const googleCli = status?.google?.cli;
  const huggingfaceCli = status?.huggingface?.cli;
  const selectedCli =
    tab === "github"
      ? githubCli
      : tab === "huggingface"
        ? huggingfaceCli
        : googleCli;
  const available =
    tab === "mcp"
      ? mcp?.configured === true
      : local &&
        selectedCli?.installed &&
        (selectedCli.authenticated ||
          (tab === "huggingface" && profile.id !== "huggingface.whoami"));
  const unavailableReason = !status
    ? "Check server status before running a request."
    : tab !== "mcp" && !local
      ? "CLI profiles run in the local companion. Download it, sign in on that machine when required, and open its localhost workspace."
      : tab === "mcp"
        ? mcp?.reason ||
          "Configure the GitHub MCP credential on the application server first."
        : selectedCli?.reason ||
          "Install the CLI and authenticate on the machine running the companion.";
  const result = results[tab];
  const requestBusy = pending?.tab === tab;

  const refresh = useCallback(async () => {
    statusController.current?.abort();
    const controller = new AbortController();
    statusController.current = controller;
    setChecking(true);
    setStatusError("");
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const value = await request("/api/integrations/status", {
        signal: controller.signal,
      });
      if (!mounted.current) return;
      setStatus(value);
      setCheckedAt(new Date().toISOString());
      setProjectId((current) => current || value.google?.cli?.projectId || "");
    } catch (error) {
      if (mounted.current && statusController.current === controller)
        setStatusError(
          error.name === "AbortError"
            ? "The server status check timed out. Try refreshing again."
            : error.message,
        );
    } finally {
      clearTimeout(timeout);
      if (mounted.current && statusController.current === controller)
        setChecking(false);
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    refresh();
    return () => {
      mounted.current = false;
      requestController.current?.abort();
      statusController.current?.abort();
    };
  }, [refresh]);

  async function execute(event) {
    event.preventDefault();
    if (pending || !available) return;
    const input = {
      profile: profile.id,
      ...(profile.repository ? { repository: repository.trim() } : {}),
      ...(profile.project ? { projectId: projectId.trim() } : {}),
      ...(profile.region ? { region: region.trim() } : {}),
    };
    let validation;
    if (
      profile.repository &&
      !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(input.repository)
    )
      validation =
        "Enter a repository as owner/repository, such as easy-agent/workspace.";
    if (
      profile.project &&
      !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(input.projectId)
    )
      validation =
        "Enter a Google Cloud project ID, such as easy-agent-development.";
    if (profile.region && !/^[a-z][a-z0-9-]{1,49}$/.test(input.region))
      validation = "Enter a valid region, such as us-central1.";
    if (validation) {
      setErrors((current) => ({ ...current, [tab]: validation }));
      return;
    }
    const selectedTab = tab;
    const controller = new AbortController();
    cancelled.current = false;
    requestController.current = controller;
    setPending({ tab: selectedTab, profile: profile.label });
    setErrors((current) => ({ ...current, [selectedTab]: "" }));
    const started = Date.now();
    const timeout = setTimeout(() => controller.abort(), 60000);
    try {
      const data = await request(
        selectedTab === "mcp"
          ? "/api/integrations/github/read"
          : "/api/integrations/cli/run",
        { body: input, signal: controller.signal },
      );
      if (!mounted.current) return;
      const next = {
        ...data,
        input,
        channel: selectedTab,
        label: profile.label,
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - started,
      };
      setResults((current) => ({ ...current, [selectedTab]: next }));
      if (typeof data.exitCode === "number" && data.exitCode !== 0)
        setErrors((current) => ({
          ...current,
          [selectedTab]: `The CLI profile returned exit code ${data.exitCode}. Its output is shown below.`,
        }));
      else
        notify(
          `${profile.label} returned from ${TABS.find((item) => item.id === selectedTab).label}`,
        );
    } catch (error) {
      if (mounted.current)
        setErrors((current) => ({
          ...current,
          [selectedTab]:
            error.name === "AbortError"
              ? cancelled.current
                ? "Request cancelled. A server-side read may still be finishing."
                : "This request timed out. The previous result has been kept."
              : error.message,
        }));
    } finally {
      clearTimeout(timeout);
      if (mounted.current) setPending(null);
      if (requestController.current === controller)
        requestController.current = null;
    }
  }
  function cancel() {
    cancelled.current = true;
    requestController.current?.abort();
  }

  return (
    <div className="integrations-page">
      <header className="ig-page-heading">
        <div>
          <span className="ig-eyebrow">EASY AGENT AI / CONNECTIONS</span>
          <h1>
            Your stack. <span>Within reach.</span>
          </h1>
          <p>
            Inspect GitHub and Google Cloud through the tools you configure.
          </p>
        </div>
        <button className="ig-button" onClick={refresh} disabled={checking}>
          <RefreshCw size={15} className={checking ? "spin" : ""} />
          {checking ? "Checking status" : "Refresh status"}
        </button>
      </header>
      {statusError && (
        <ErrorMessage onDismiss={() => setStatusError("")}>
          {statusError}
          {status && " Previous server status is still displayed."}
        </ErrorMessage>
      )}
      <div className="ig-runtime-note">
        <Server size={16} />
        <span>
          {checking && !status
            ? "Checking which integrations are available on this server…"
            : local
              ? "Companion CLI · Reads use tools and logins on the companion machine."
              : "Hosted workspace · GitHub MCP uses server configuration. CLI reads require the local companion."}
        </span>
        <small>
          {checkedAt ? `Checked ${readableDate(checkedAt)}` : "Not checked"}
        </small>
      </div>
      <div className="ig-status-grid">
        <StatusCard
          icon={Link2}
          title="GitHub MCP"
          badge={
            !status
              ? "Not checked"
              : mcp?.connected
                ? "Connected"
                : mcp?.configured && mcp?.error
                  ? "Connection failed"
                  : mcp?.configured
                    ? "Credential configured"
                    : "Setup required"
          }
          tone={mcp?.connected ? "success" : mcp?.configured && mcp?.error ? "danger" : "neutral"}
          description={
            mcp?.reason ||
            (mcp?.configured
              ? "Ready for an authenticated read request."
              : "A GitHub credential belongs on the server.")
          }
          detail={mcp?.endpoint}
          onClick={() => setTab("mcp")}
        />
        <StatusCard
          icon={Github}
          title="GitHub CLI"
          badge={
            !status
              ? "Not checked"
              : !local
                ? "Local app required"
                : githubCli?.authenticated
                  ? "Authenticated"
                  : githubCli?.installed
                    ? "Sign-in required"
                    : "CLI unavailable"
          }
          tone={local && githubCli?.authenticated ? "success" : "neutral"}
          description={
            githubCli?.reason ||
            (!local
              ? "Run gh on the machine hosting the local companion."
              : githubCli?.authenticated
                ? "Read repository activity with your signed-in account."
                : "Install gh and sign in locally.")
          }
          detail={
            githubCli?.login
              ? `Account · ${githubCli.login}`
              : local
                ? `CLI ${githubCli?.installed ? "installed" : "not installed"}`
                : ""
          }
          onClick={() => setTab("github")}
        />
        <StatusCard
          icon={Cloud}
          title="Google Cloud CLI"
          badge={
            !status
              ? "Not checked"
              : !local
                ? "Local app required"
                : googleCli?.authenticated
                  ? "Authenticated"
                  : googleCli?.installed
                    ? "Sign-in required"
                    : "CLI unavailable"
          }
          tone={local && googleCli?.authenticated ? "success" : "neutral"}
          description={
            googleCli?.reason ||
            (!local
              ? "Use gcloud through the local companion."
              : googleCli?.authenticated
                ? "Inspect the projects and services available to your account."
                : "Install gcloud and authenticate locally.")
          }
          detail={
            googleCli?.projectId
              ? `Project · ${googleCli.projectId}`
              : status?.google?.vertex?.configured
                ? "Vertex provider configured separately"
                : ""
          }
          onClick={() => setTab("google")}
        />
        <StatusCard
          icon={Terminal}
          title="Hugging Face CLI"
          badge={
            !status
              ? "Not checked"
              : !local
                ? "Local app required"
                : huggingfaceCli?.authenticated
                  ? "Authenticated"
                  : huggingfaceCli?.installed
                    ? "Public reads available"
                    : "CLI unavailable"
          }
          tone={local && huggingfaceCli?.installed ? "success" : "neutral"}
          description={
            huggingfaceCli?.reason ||
            (!local
              ? "Run the hf CLI through the local companion."
              : "Install hf for public model and Space listings. Sign in for account identity.")
          }
          detail={
            huggingfaceCli?.login
              ? `Account · ${huggingfaceCli.login}`
              : local && huggingfaceCli?.installed
                ? "Public catalog · no login required"
                : ""
          }
          onClick={() => setTab("huggingface")}
        />
      </div>
      <section className="ig-tools-panel" aria-label="Integration tools">
        <div
          className="ig-tabs"
          role="tablist"
          aria-label="Integration channels"
        >
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              id={`ig-tab-${id}`}
              key={id}
              role="tab"
              aria-selected={tab === id}
              aria-controls={`ig-panel-${id}`}
              tabIndex={tab === id ? 0 : -1}
              className={tab === id ? "active" : ""}
              onClick={() => setTab(id)}
              onKeyDown={(event) => {
                if (
                  ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
                ) {
                  event.preventDefault();
                  const current = TABS.findIndex((item) => item.id === tab);
                  const index =
                    event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? TABS.length - 1
                        : (current +
                            (event.key === "ArrowRight" ? 1 : -1) +
                            TABS.length) %
                          TABS.length;
                  setTab(TABS[index].id);
                  requestAnimationFrame(() =>
                    document
                      .getElementById(`ig-tab-${TABS[index].id}`)
                      ?.focus(),
                  );
                }
              }}
            >
              <Icon size={16} />
              {label}
              {pending?.tab === id && <Loader2 size={12} className="spin" />}
            </button>
          ))}
        </div>
        <div
          id={`ig-panel-${tab}`}
          role="tabpanel"
          aria-labelledby={`ig-tab-${tab}`}
          className="ig-tool-content"
        >
          {tab === "catalog" ? (
            <ConnectionCatalog notify={notify} />
          ) : (
            <>
              <div className="ig-tool-heading">
                <div>
                  <h2>{currentTab.title}</h2>
                  <p>{currentTab.description}</p>
                </div>
                <span className="ig-read-only">
                  <ShieldCheck size={13} />
                  Read only
                </span>
              </div>
              <form className="ig-request-form" onSubmit={execute}>
                <label className="ig-field ig-profile-field">
                  <span>Read profile</span>
                  <select
                    value={profile.id}
                    disabled={requestBusy}
                    onChange={(event) =>
                      setProfiles((current) => ({
                        ...current,
                        [tab]: event.target.value,
                      }))
                    }
                  >
                    {PROFILES[tab].map((item) => (
                      <option value={item.id} key={item.id}>
                        {item.label}
                      </option>
                    ))}
                  </select>
                </label>
                {profile.repository && (
                  <label className="ig-field">
                    <span>
                      Repository <small>required</small>
                    </span>
                    <input
                      value={repository}
                      onChange={(event) => setRepository(event.target.value)}
                      placeholder="owner/repository"
                      autoComplete="off"
                      spellCheck="false"
                      required
                      disabled={requestBusy}
                    />
                  </label>
                )}
                {profile.project && (
                  <label className="ig-field">
                    <span>
                      Google Cloud project ID <small>required</small>
                    </span>
                    <input
                      value={projectId}
                      onChange={(event) => setProjectId(event.target.value)}
                      placeholder="easy-agent-development"
                      autoComplete="off"
                      spellCheck="false"
                      required
                      disabled={requestBusy}
                    />
                  </label>
                )}
                {profile.region && (
                  <label className="ig-field ig-region-field">
                    <span>
                      Region <small>required</small>
                    </span>
                    <input
                      value={region}
                      onChange={(event) => setRegion(event.target.value)}
                      placeholder="us-central1"
                      autoComplete="off"
                      spellCheck="false"
                      required
                      disabled={requestBusy}
                    />
                  </label>
                )}
                <div className="ig-submit-actions">
                  <button
                    className="ig-button primary"
                    type="submit"
                    disabled={!available || !!pending || checking}
                  >
                    {requestBusy ? (
                      <Loader2 size={15} className="spin" />
                    ) : (
                      <ArrowRight size={15} />
                    )}{" "}
                    {requestBusy ? "Reading…" : "Run read request"}
                  </button>
                  {requestBusy && (
                    <button
                      className="ig-button"
                      type="button"
                      onClick={cancel}
                    >
                      <Square size={11} />
                      Cancel
                    </button>
                  )}
                </div>
                <p className="ig-profile-description">{profile.description}</p>
              </form>
              {!available && !checking && (
                <div className="ig-unavailable">
                  <Info size={17} />
                  <div>
                    <strong>
                      {tab === "mcp"
                        ? "Configure the server connection first"
                        : !local
                          ? "Open your local workspace for CLI access"
                          : "Finish CLI setup on this machine"}
                    </strong>
                    <p>{unavailableReason}</p>
                    <button onClick={() => setSetupOpen(true)}>
                      View setup instructions <ArrowRight size={12} />
                    </button>
                  </div>
                  {tab !== "mcp" && !local && (
                    <a
                      className="ig-button"
                      href="/download/source.zip"
                      download
                    >
                      <ArrowDownToLine size={14} />
                      Download companion
                    </a>
                  )}
                </div>
              )}
              {errors[tab] && (
                <ErrorMessage
                  onDismiss={() =>
                    setErrors((current) => ({ ...current, [tab]: "" }))
                  }
                >
                  {errors[tab]}
                </ErrorMessage>
              )}
              <div className="ig-request-announcement" aria-live="polite">
                {requestBusy
                  ? `${pending.profile} request is running.`
                  : result
                    ? `${result.label} result from ${readableDate(result.completedAt)}. ${typeof result.exitCode === "number" ? `Exit code ${result.exitCode}.` : ""}`
                    : ""}
              </div>
              {result ? (
                <ResultView result={result} stale={!!errors[tab]} />
              ) : (
                <div className="ig-empty-results">
                  <span>
                    <FolderGit2 size={28} />
                  </span>
                  <h3>
                    {requestBusy
                      ? "Reading from your configured tools…"
                      : "A clearer view of your stack."}
                  </h3>
                  <p>
                    {requestBusy
                      ? "The response will appear here. You can cancel while waiting."
                      : "Choose a read profile and run a request. Results come directly from the configured server or authenticated CLI."}
                  </p>
                  <div>
                    <ShieldCheck size={13} />
                    No repository or cloud changes are made by these profiles.
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </section>
      <section className={`ig-setup ${setupOpen ? "open" : ""}`}>
        <button
          className="ig-setup-toggle"
          onClick={() => setSetupOpen((current) => !current)}
          aria-expanded={setupOpen}
          aria-controls="ig-setup-body"
        >
          <span className="ig-setup-icon">
            <LockKeyhole size={17} />
          </span>
          <span>
            <strong>Your credentials stay on your server.</strong>
            <small>
              CLI sign-in, GitHub MCP, and Vertex authentication setup.
            </small>
          </span>
          <ChevronDown size={17} />
        </button>
        {setupOpen && (
          <div id="ig-setup-body" className="ig-setup-body">
            <section>
              <span className="ig-eyebrow">GITHUB CLI</span>
              <h3>Sign in on the companion machine.</h3>
              <p>
                Install GitHub CLI, then run this in a terminal on the same
                machine as the companion. Return here and refresh status.
              </p>
              <Command>gh auth login</Command>
              <p className="ig-small-note">
                The browser never collects your GitHub token.
              </p>
            </section>
            <section>
              <span className="ig-eyebrow">GOOGLE CLOUD</span>
              <h3>CLI access and model access are separate.</h3>
              <p>
                Use gcloud sign-in for these read profiles. Configure
                Application Default Credentials separately when using Vertex AI
                inference.
              </p>
              <Command>gcloud auth login</Command>
              <Command>gcloud auth application-default login</Command>
              <p className="ig-small-note">
                CLI authentication does not confirm Vertex billing, model
                availability, or permissions.
              </p>
            </section>
            <section>
              <span className="ig-eyebrow">GITHUB MCP</span>
              <h3>Configure the application server.</h3>
              <p>
                Set the GitHub MCP credential in the server’s environment using
                the source download’s README and environment example. Refresh
                status, then run a read to verify access.
              </p>
              <a className="ig-text-link" href="/download/source.zip" download>
                <Code2 size={14} />
                Download source & setup guide <ArrowRight size={13} />
              </a>
              <p className="ig-small-note">
                A configured credential may still lack access to a specific
                repository.
              </p>
            </section>
            <section>
              <span className="ig-eyebrow">HUGGING FACE CLI</span>
              <h3>Browse public models. Sign in when needed.</h3>
              <p>
                Install the hf CLI on the companion machine. Public models and
                Spaces can be listed without an account sign-in. Authenticate
                locally to read your account identity.
              </p>
              <Command>hf auth login</Command>
              <p className="ig-small-note">
                The browser never collects your Hugging Face token.
              </p>
            </section>
          </div>
        )}
      </section>
      <footer className="ig-footer">
        <span>
          <span>EA</span> EASY AGENT AI <i />
          Your tools. Your infrastructure.
        </span>
        <span>
          <ShieldCheck size={12} />
          Fixed read profiles · No arbitrary shell commands
        </span>
      </footer>
    </div>
  );
}

function StatusCard({
  icon: Icon,
  title,
  badge,
  tone,
  description,
  detail,
  onClick,
}) {
  return (
    <button className="ig-status-card" onClick={onClick}>
      <div>
        <span className="ig-status-icon">
          <Icon size={20} />
        </span>
        <Badge tone={tone}>{badge}</Badge>
      </div>
      <h2>
        {title}
        <ArrowRight size={14} />
      </h2>
      <p>{description}</p>
      {detail && <code>{detail}</code>}
    </button>
  );
}
function unwrap(value) {
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  if (value && typeof value === "object") {
    if (value.structuredContent) return unwrap(value.structuredContent);
    if (Array.isArray(value.content)) {
      const texts = value.content
        .filter((item) => item.type === "text" && typeof item.text === "string")
        .map((item) => item.text);
      if (texts.length) return unwrap(texts.join("\n"));
    }
  }
  return value;
}
function rowsFrom(value, depth = 0) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object" || depth > 3) return null;
  for (const key of [
    "repositories",
    "pull_requests",
    "pullRequests",
    "issues",
    "workflow_runs",
    "workflowRuns",
    "runs",
    "projects",
    "services",
    "models",
    "items",
    "nodes",
    "results",
  ])
    if (Array.isArray(value[key])) return value[key];
  for (const key of [
    "data",
    "result",
    "viewer",
    "search",
    "repository",
    "repositories",
    "pullRequests",
    "issues",
    "runs",
  ])
    if (value[key] && typeof value[key] === "object") {
      const found = rowsFrom(value[key], depth + 1);
      if (found) return found;
    }
  return null;
}
function cell(value, fallback = "—") {
  return value == null || value === ""
    ? fallback
    : typeof value === "object"
      ? stringify(value)
      : String(value);
}
function getColumns(profile) {
  if (profile.endsWith("repos") || profile === "repositories")
    return [
      {
        label: "Repository",
        get: (row) =>
          row.fullName || row.full_name || row.nameWithOwner || row.name,
        link: (row) => row.html_url || row.url,
      },
      {
        label: "Visibility",
        get: (row) =>
          row.visibility ||
          (row.private === true || row.isPrivate === true
            ? "Private"
            : row.private === false || row.isPrivate === false
              ? "Public"
              : null),
      },
      {
        label: "Default branch",
        get: (row) =>
          row.defaultBranch || row.default_branch || row.defaultBranchRef?.name,
      },
      {
        label: "Updated",
        get: (row) => readableDate(row.updated_at || row.updatedAt),
      },
    ];
  if (profile.endsWith("pulls") || profile.endsWith("issues"))
    return [
      { label: "#", get: (row) => row.number },
      {
        label: "Title",
        get: (row) => row.title,
        link: (row) => row.html_url || row.url,
      },
      { label: "State", get: (row) => row.state },
      {
        label: "Author",
        get: (row) =>
          row.user?.login ||
          row.author?.login ||
          (typeof row.author === "string" ? row.author : null),
      },
      {
        label: "Updated",
        get: (row) =>
          readableDate(
            row.updated_at || row.updatedAt || row.created_at || row.createdAt,
          ),
      },
    ];
  if (profile.endsWith("runs"))
    return [
      {
        label: "Workflow",
        get: (row) =>
          row.workflowName || row.name || row.display_title || row.displayTitle,
        link: (row) => row.html_url || row.url,
      },
      { label: "Status", get: (row) => row.conclusion || row.status },
      {
        label: "Branch",
        get: (row) => row.branch || row.head_branch || row.headBranch,
      },
      {
        label: "Updated",
        get: (row) =>
          readableDate(
            row.updated_at || row.updatedAt || row.created_at || row.createdAt,
          ),
      },
    ];
  if (profile === "huggingface.models")
    return [
      {
        label: "Model",
        get: (row) => row.id || row.modelId || row.name,
        link: (row) => row.url,
      },
      { label: "Author", get: (row) => row.author },
      { label: "Task", get: (row) => row.pipeline_tag || row.pipelineTag },
      { label: "Downloads", get: (row) => row.downloads },
      { label: "Likes", get: (row) => row.likes },
    ];
  if (profile === "huggingface.spaces")
    return [
      {
        label: "Space",
        get: (row) => row.id || row.name,
        link: (row) => row.url,
      },
      { label: "Author", get: (row) => row.author },
      { label: "SDK", get: (row) => row.sdk },
      { label: "Likes", get: (row) => row.likes },
    ];
  if (profile === "google.projects")
    return [
      {
        label: "Project ID",
        get: (row) => row.projectId || row.project_id || row.id,
      },
      { label: "Name", get: (row) => row.name || row.displayName },
      { label: "State", get: (row) => row.lifecycleState || row.state },
    ];
  if (profile === "google.services")
    return [
      { label: "Service", get: (row) => row.config?.name || row.name },
      { label: "Description", get: (row) => row.config?.title || row.title },
      { label: "State", get: (row) => row.state },
    ];
  if (profile === "google.runServices")
    return [
      { label: "Service", get: (row) => row.metadata?.name || row.name },
      {
        label: "Region",
        get: (row) =>
          row.metadata?.labels?.["cloud.googleapis.com/location"] ||
          row.location,
      },
      {
        label: "URL",
        get: (row) => row.status?.url || row.uri || row.url,
        link: (row) => row.status?.url || row.uri || row.url,
      },
    ];
  if (profile === "google.vertexModels")
    return [
      {
        label: "Model",
        get: (row) => row.displayName || row.display_name || row.name,
      },
      { label: "Resource", get: (row) => row.name },
      {
        label: "Updated",
        get: (row) => readableDate(row.updateTime || row.createTime),
      },
    ];
  return [];
}
function ResultView({ result, stale }) {
  const [filter, setFilter] = useState("");
  useEffect(() => {
    setFilter("");
  }, [result]);
  const payload = useMemo(
    () =>
      unwrap(
        result.data !== undefined
          ? result.data
          : result.output !== undefined
            ? result.output
            : result.account || result,
      ),
    [result],
  );
  const rows = useMemo(() => {
    const list = rowsFrom(payload);
    return list &&
      list.every(
        (item) => item && typeof item === "object" && !Array.isArray(item),
      )
      ? list
      : null;
  }, [payload]);
  const columns = getColumns(result.input.profile);
  const visibleRows = useMemo(
    () =>
      rows
        ?.filter(
          (row) =>
            !filter ||
            stringify(row).toLowerCase().includes(filter.toLowerCase()),
        )
        .slice(0, 100) || [],
    [rows, filter],
  );
  const profileData =
    (result.input.profile === "profile" ||
      result.input.profile === "huggingface.whoami") &&
    payload &&
    typeof payload === "object" &&
    !Array.isArray(payload)
      ? payload
      : null;
  const failure = typeof result.exitCode === "number" && result.exitCode !== 0;
  return (
    <section className="ig-results" aria-label="Integration response">
      <div className="ig-result-header">
        <div>
          <span className="ig-eyebrow">
            {stale ? "LAST RETURNED RESPONSE" : "SERVER RESPONSE"}
          </span>
          <h3>{result.label}</h3>
          <p>
            {[
              result.input.repository,
              result.input.projectId,
              result.input.region,
            ]
              .filter(Boolean)
              .join(" / ") ||
              TABS.find((item) => item.id === result.channel)?.label}
            <span>·</span>
            {readableDate(result.completedAt)}
          </p>
        </div>
        <Badge tone={failure ? "danger" : "success"}>
          {typeof result.exitCode === "number"
            ? `Exit ${result.exitCode}`
            : "Read returned"}
        </Badge>
      </div>
      <div className="ig-result-provenance">
        <span>
          <Server size={12} />
          {result.channel === "mcp" ? "GitHub MCP" : "Local companion"}
        </span>
        <code>{result.input.profile}</code>
        {result.tool && (
          <code>
            {typeof result.tool === "string"
              ? result.tool
              : result.tool.name || "MCP read tool"}
          </code>
        )}
        <span>{(result.durationMs / 1000).toFixed(1)} s</span>
      </div>
      {result.command && (
        <div className="ig-executed-command">
          <Terminal size={13} />
          <code>
            {Array.isArray(result.command)
              ? result.command.join(" ")
              : result.command}
          </code>
        </div>
      )}
      {profileData && (
        <div className="ig-profile-result">
          <span className="ig-profile-avatar">
            {result.channel === "huggingface" ? (
              <Terminal size={27} />
            ) : (
              <Github size={27} />
            )}
          </span>
          <div>
            <h4>
              {cell(
                profileData.name || profileData.login || profileData.username,
                "GitHub account",
              )}
            </h4>
            {(profileData.login || profileData.username) && (
              <p>@{profileData.login || profileData.username}</p>
            )}
            {(profileData.bio || profileData.description) && (
              <p>{profileData.bio || profileData.description}</p>
            )}
            {safeLink(profileData.html_url || profileData.url) && (
              <a
                href={safeLink(profileData.html_url || profileData.url)}
                target="_blank"
                rel="noopener noreferrer"
              >
                View GitHub profile <ExternalLink size={12} />
              </a>
            )}
          </div>
        </div>
      )}
      {rows && columns.length > 0 ? (
        <>
          <div className="ig-result-table-tools">
            <span>
              {filter
                ? `${visibleRows.length} matching`
                : `${rows.length} returned`}{" "}
              {rows.length === 1 ? "record" : "records"}
              {rows.length > 100 && !filter ? " · first 100 shown" : ""}
            </span>
            <label>
              <Search size={13} />
              <input
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                aria-label="Filter returned records"
                placeholder="Filter these results"
              />
            </label>
          </div>
          <div
            className="ig-table-scroll"
            role="region"
            aria-label={`${result.label} results table`}
            tabIndex={0}
          >
            <table>
              <caption>
                {result.label} returned by{" "}
                {result.channel === "mcp"
                  ? "GitHub MCP"
                  : "the authenticated local CLI"}
              </caption>
              <thead>
                <tr>
                  {columns.map((column) => (
                    <th key={column.label} scope="col">
                      {column.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((row, index) => (
                  <tr key={row.id || row.nameWithOwner || row.number || index}>
                    {columns.map((column) => {
                      const href = column.link && safeLink(column.link(row));
                      return (
                        <td key={column.label}>
                          {href ? (
                            <a
                              href={href}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              {cell(column.get(row))}
                              <ExternalLink size={11} />
                            </a>
                          ) : (
                            cell(column.get(row))
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
            {visibleRows.length === 0 && (
              <div className="ig-no-records">
                {rows.length
                  ? "No returned records match your filter."
                  : "No records were returned for this request."}
              </div>
            )}
          </div>
        </>
      ) : (
        !profileData && (
          <div className="ig-output-preview">
            <pre tabIndex={0}>
              {payload == null || payload === ""
                ? "The server returned no output."
                : stringify(payload)}
            </pre>
          </div>
        )
      )}
      <details className="ig-raw-response">
        <summary>
          Raw response <ChevronDown size={13} />
        </summary>
        <pre tabIndex={0}>
          {stringify(
            Object.fromEntries(
              Object.entries(result).filter(
                ([key]) =>
                  ![
                    "input",
                    "label",
                    "channel",
                    "completedAt",
                    "durationMs",
                  ].includes(key),
              ),
            ),
          )}
        </pre>
      </details>
    </section>
  );
}

const CONNECTION_STATES = {
  configured: "Server configured",
  connected: "Connected in this browser",
  unconfigured: "Setup required",
  needs_endpoint: "Endpoint required",
  oauth_setup_required: "OAuth setup required",
};
function ConnectionCatalog({ notify }) {
  const [providers, setProviders] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(null);
  const [responses, setResponses] = useState({});
  const [providerErrors, setProviderErrors] = useState({});
  const mounted = useRef(false);
  const fetchController = useRef(null);
  const actionController = useRef(null);
  const notifyRef = useRef(notify);
  const returned = useRef(false);
  notifyRef.current = notify;
  const refreshCatalog = useCallback(async () => {
    fetchController.current?.abort();
    const controller = new AbortController();
    fetchController.current = controller;
    setLoading(true);
    setError("");
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const data = await request("/api/integrations/catalog", {
        signal: controller.signal,
      });
      if (!mounted.current) return;
      const list = Array.isArray(data.providers) ? data.providers : [];
      setProviders(list);
      const params = new URLSearchParams(window.location.search);
      const returnedProvider = params.get("integration");
      if (!returned.current && returnedProvider && params.has("oauth")) {
        returned.current = true;
        const provider = list.find((item) => item.id === returnedProvider);
        if (provider?.connected)
          notifyRef.current(`${provider.name} connected in this browser`);
        else
          setError(
            params.get("oauth") === "connected"
              ? "Authorization returned, but the server has not confirmed an active connection. Check the provider setup below."
              : "Authorization did not finish. Review the provider setup and try again.",
          );
        params.delete("integration");
        params.delete("oauth");
        const query = params.toString();
        window.history.replaceState(
          null,
          "",
          `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`,
        );
      }
    } catch (error) {
      if (mounted.current && fetchController.current === controller)
        setError(
          error.name === "AbortError"
            ? "The connection directory check timed out. Try refreshing."
            : error.message,
        );
    } finally {
      clearTimeout(timeout);
      if (mounted.current && fetchController.current === controller)
        setLoading(false);
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    refreshCatalog();
    return () => {
      mounted.current = false;
      fetchController.current?.abort();
      actionController.current?.abort();
    };
  }, [refreshCatalog]);
  async function providerAction(provider, action) {
    if (busy) return;
    setBusy({ id: provider.id, action });
    setProviderErrors((current) => ({ ...current, [provider.id]: "" }));
    const controller = new AbortController();
    actionController.current = controller;
    const timeout = setTimeout(() => controller.abort(), 45000);
    try {
      const endpoint =
        action === "discover"
          ? "/api/integrations/mcp/test"
          : `/api/integrations/oauth/${action === "authorize" ? "start" : "disconnect"}`;
      const data = await request(endpoint, {
        body: { providerId: provider.id },
        signal: controller.signal,
      });
      if (!mounted.current) return;
      if (
        data.error ||
        data.isError ||
        data.success === false ||
        data.connected === false
      )
        throw new Error(
          data.message ||
            data.reason ||
            data.error?.message ||
            (typeof data.error === "string" ? data.error : "") ||
            "The provider request was not successful.",
        );
      if (action === "authorize") {
        if (
          !safeLink(data.authorizationUrl) ||
          new URL(data.authorizationUrl).protocol !== "https:"
        )
          throw new Error(
            "The server did not return a valid HTTPS authorization URL.",
          );
        window.location.assign(data.authorizationUrl);
      } else if (action === "disconnect") {
        notifyRef.current(`${provider.name} disconnected from this browser`);
        await refreshCatalog();
      } else {
        setResponses((current) => ({
          ...current,
          [provider.id]: { ...data, completedAt: new Date().toISOString() },
        }));
      }
    } catch (error) {
      if (mounted.current)
        setProviderErrors((current) => ({
          ...current,
          [provider.id]:
            error.name === "AbortError"
              ? "The discovery or authorization request timed out. No connection has been confirmed."
              : error.message,
        }));
    } finally {
      clearTimeout(timeout);
      if (mounted.current) setBusy(null);
      if (actionController.current === controller)
        actionController.current = null;
    }
  }
  const visible = (providers || []).filter((provider) =>
    `${provider.name} ${provider.id} ${provider.kind} ${provider.reason || ""}`
      .toLowerCase()
      .includes(filter.toLowerCase()),
  );
  return (
    <div className="ig-catalog">
      <div className="ig-tool-heading">
        <div>
          <h2>Bring your tools into the workspace.</h2>
          <p>
            Each provider shows its actual server configuration. Authorize
            supported accounts on the provider’s own consent page, or follow its
            setup instructions.
          </p>
        </div>
        <button
          className="ig-button"
          onClick={refreshCatalog}
          disabled={loading}
        >
          <RefreshCw size={14} className={loading ? "spin" : ""} />
          {loading ? "Checking" : "Refresh directory"}
        </button>
      </div>
      <div className="ig-catalog-note">
        <ShieldCheck size={16} />
        <p>
          Tool discovery lists capabilities. It does not execute provider tools.
          Credentials are configured on the server; supported OAuth accounts are
          connected for this browser.
        </p>
      </div>
      {error && (
        <ErrorMessage onDismiss={() => setError("")}>
          {error}
          {providers && " Previous provider metadata is still displayed."}
        </ErrorMessage>
      )}
      <div className="ig-catalog-toolbar">
        <span>
          {providers
            ? `${visible.length} ${visible.length === 1 ? "provider" : "providers"}`
            : "Checking provider directory"}
        </span>
        <label>
          <Search size={14} />
          <input
            aria-label="Filter connection providers"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Find a provider"
          />
        </label>
      </div>
      {loading && !providers ? (
        <div className="ig-catalog-loading">
          <Loader2 size={21} className="spin" />
          <p>Loading server connection metadata…</p>
        </div>
      ) : (
        <div className="ig-provider-grid">
          {visible.map((provider) => {
            const response = responses[provider.id];
            const tools =
              response &&
              (Array.isArray(response.tools)
                ? response.tools
                : Array.isArray(response.result?.tools)
                  ? response.result.tools
                  : Array.isArray(response.data?.tools)
                    ? response.data.tools
                    : null);
            const connected = provider.connected === true;
            const configured = connected || provider.status === "configured";
            const canDiscover =
              provider.verified === true &&
              !!provider.endpoint &&
              (configured ||
                (provider.kind === "mcp" &&
                  !provider.tokenEnv &&
                  !["needs_endpoint", "oauth_setup_required"].includes(
                    provider.status,
                  )));
            const docs = safeLink(provider.docsUrl);
            const active = busy?.id === provider.id;
            return (
              <section className="ig-provider-card" key={provider.id}>
                <div className="ig-provider-card-top">
                  <span className={`ig-provider-icon ${provider.kind}`}>
                    <Link2 size={19} />
                  </span>
                  <Badge tone={configured ? "success" : "neutral"}>
                    {connected
                      ? "Connected in this browser"
                      : CONNECTION_STATES[provider.status] || "Setup required"}
                  </Badge>
                </div>
                <div className="ig-provider-name">
                  <h3>{provider.name}</h3>
                  <span>
                    {provider.kind === "oauth"
                      ? "OAuth"
                      : provider.kind === "mcp"
                        ? "MCP"
                        : "Custom connection"}
                  </span>
                </div>
                <p>
                  {provider.reason ||
                    (configured
                      ? "Server configuration is available. Discover tools to check access."
                      : "Complete server setup before using this provider.")}
                </p>
                {provider.endpoint && (
                  <div className="ig-provider-metadata">
                    <span>SERVER ENDPOINT</span>
                    <code>{provider.endpoint}</code>
                  </div>
                )}
                {provider.tokenEnv && !connected && (
                  <div className="ig-provider-metadata">
                    <span>SERVER VARIABLE</span>
                    <code>
                      {Array.isArray(provider.tokenEnv)
                        ? provider.tokenEnv.join(" / ")
                        : provider.tokenEnv}
                    </code>
                  </div>
                )}
                <div className="ig-provider-actions">
                  {provider.canAuthorize && !connected && (
                    <button
                      className="ig-button primary"
                      onClick={() => providerAction(provider, "authorize")}
                      disabled={!!busy}
                    >
                      {active && busy.action === "authorize" ? (
                        <Loader2 size={13} className="spin" />
                      ) : (
                        <LockKeyhole size={13} />
                      )}
                      Connect with OAuth
                    </button>
                  )}
                  {connected && (
                    <button
                      className="ig-button"
                      onClick={() => providerAction(provider, "disconnect")}
                      disabled={!!busy}
                    >
                      {active && busy.action === "disconnect" ? (
                        <Loader2 size={13} className="spin" />
                      ) : (
                        <X size={13} />
                      )}
                      Disconnect
                    </button>
                  )}
                  {canDiscover && (
                    <button
                      className="ig-button"
                      onClick={() => providerAction(provider, "discover")}
                      disabled={!!busy}
                    >
                      {active && busy.action === "discover" ? (
                        <Loader2 size={13} className="spin" />
                      ) : (
                        <Search size={13} />
                      )}
                      Discover tools
                    </button>
                  )}
                  {docs && (
                    <a
                      href={docs}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="ig-provider-docs"
                    >
                      {provider.verified
                        ? "Setup documentation"
                        : "Setup reference"}
                      <ExternalLink size={12} />
                    </a>
                  )}
                </div>
                {providerErrors[provider.id] && (
                  <ErrorMessage
                    onDismiss={() =>
                      setProviderErrors((current) => ({
                        ...current,
                        [provider.id]: "",
                      }))
                    }
                  >
                    {providerErrors[provider.id]}
                  </ErrorMessage>
                )}
                {response && (
                  <div className="ig-discovery-result">
                    <div>
                      <CheckCircle2 size={13} />
                      <strong>
                        {tools
                          ? `${tools.length} ${tools.length === 1 ? "tool" : "tools"} returned`
                          : "Discovery response returned"}
                      </strong>
                      <time>{readableDate(response.completedAt)}</time>
                    </div>
                    {tools && (
                      <details>
                        <summary>
                          View discovered tools <ChevronDown size={12} />
                        </summary>
                        <ul>
                          {tools.slice(0, 20).map((tool, index) => (
                            <li key={tool.name || index}>
                              <code>{tool.name || "Unnamed tool"}</code>
                              {tool.description && <p>{tool.description}</p>}
                            </li>
                          ))}
                        </ul>
                        {tools.length > 20 && (
                          <p className="ig-small-note">
                            First 20 shown. All returned tool metadata is
                            available in the raw response.
                          </p>
                        )}
                      </details>
                    )}
                    <details className="ig-raw-response">
                      <summary>
                        Raw discovery response
                        <ChevronDown size={12} />
                      </summary>
                      <pre tabIndex={0}>{stringify(response)}</pre>
                    </details>
                  </div>
                )}
              </section>
            );
          })}
          {providers && visible.length === 0 && (
            <div className="ig-no-records">
              {providers.length
                ? "No providers match your filter."
                : "No provider metadata was returned by this server."}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
