import React, { useCallback, useEffect, useRef, useState } from "react";
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
  Info,
  Link2,
  Loader2,
  LockKeyhole,
  RefreshCw,
  Server,
  ShieldCheck,
  Terminal,
} from "lucide-react";
import "./hybrid-connection.css";

function hostLabel(value) {
  if (!value || typeof value !== "string") return "";
  try {
    return new URL(value.includes("://") ? value : `https://${value}`).host;
  } catch {
    return "";
  }
}
function checkedTime(value) {
  return value
    ? new Date(value).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      })
    : "";
}
async function readStatus({ test = false, signal } = {}) {
  const response = await fetch(
    test ? "/api/hybrid/test" : "/api/hybrid/status",
    {
      ...(test
        ? {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
          }
        : {}),
      signal,
    },
  );
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error(
      `The server returned an unreadable connection response (${response.status}).`,
    );
  }
  if (!response.ok)
    throw new Error(
      data.message ||
        data.error?.message ||
        (typeof data.error === "string" ? data.error : "") ||
        `Connection check failed (${response.status}).`,
    );
  return data;
}
function SetupCode({ label, children }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(children);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {}
  }
  return (
    <div className="hc-code">
      <div>
        <span>{label}</span>
        <button aria-label={`Copy ${label}`} onClick={copy}>
          {copied ? <Check size={12} /> : <Copy size={12} />}{" "}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre tabIndex={0}>{children}</pre>
    </div>
  );
}

export default function HybridConnection({
  compact = false,
  onConnectionChange,
}) {
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [checkedAt, setCheckedAt] = useState(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const mounted = useRef(false);
  const controllerRef = useRef(null);
  const callbackRef = useRef(onConnectionChange);
  const previousState = useRef(null);
  const lastVerified = useRef(false);
  callbackRef.current = onConnectionChange;
  const check = useCallback(async (test = false) => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setBusy(true);
    setError("");
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const next = await readStatus({ test, signal: controller.signal });
      if (!mounted.current || controllerRef.current !== controller) return;
      setStatus(next);
      setCheckedAt(new Date().toISOString());
      const stateKey = `${next.mode}:${next.configured === true}:${next.connected === true}`;
      lastVerified.current = next.connected === true;
      if (test || previousState.current !== stateKey) {
        previousState.current = stateKey;
        callbackRef.current?.(next);
      }
    } catch (error) {
      if (mounted.current && controllerRef.current === controller) {
        setError(
          error.name === "AbortError"
            ? "The connection check timed out. The companion has not been verified by this check."
            : error.message,
        );
        if (lastVerified.current) {
          lastVerified.current = false;
          callbackRef.current?.({ connected: false });
        }
      }
    } finally {
      clearTimeout(timeout);
      if (mounted.current && controllerRef.current === controller)
        setBusy(false);
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    check();
    return () => {
      mounted.current = false;
      controllerRef.current?.abort();
    };
  }, [check]);

  const local =
    status?.mode === "local" ||
    (status?.runtime === "local" && status?.mode !== "hybrid");
  const connected = status?.connected === true && !error;
  const configured =
    status?.configured === true || status?.companion?.configured === true;
  const host = hostLabel(
    status?.companion?.host || status?.companion?.endpoint,
  );
  const state = error
    ? "Connection check failed"
    : !status
      ? "Checking connection"
      : local
        ? "Local workspace"
        : connected
          ? "Companion verified"
          : configured
            ? "Configured · not verified"
            : "Companion setup required";
  const reason =
    error ||
    status?.companion?.reason ||
    status?.reason ||
    (busy
      ? "Reading the server’s current hybrid connection status…"
      : "Configure a companion on the application server to connect a real repository.");
  const tone = error ? "error" : connected ? "ready" : "waiting";
  if (compact && local && !error) return null;

  return (
    <section
      className={`hybrid-connection ${compact ? "hc-compact" : ""} ${tone}`}
      aria-label="Cloud and companion connection"
    >
      <div className="hc-header">
        <span className="hc-connection-icon">
          {connected ? <ShieldCheck size={21} /> : <Link2 size={21} />}
        </span>
        <div className="hc-heading">
          <span className="hc-eyebrow">EASY AGENT AI / HYBRID WORKSPACE</span>
          <h2>
            {compact
              ? connected
                ? "Cloud workspace. Connected companion."
                : "Cloud workspace. Companion connection."
              : "Cloud intelligence. Your code, on your machine."}
          </h2>
        </div>
        <span className={`hc-state ${tone}`}>
          {busy ? (
            <Loader2 className="spin" size={12} />
          ) : connected ? (
            <CheckCircle2 size={12} />
          ) : error ? (
            <AlertCircle size={12} />
          ) : (
            <Info size={12} />
          )}{" "}
          {state}
        </span>
        <button
          className="hc-check-button"
          onClick={() => check(true)}
          disabled={busy}
        >
          {busy ? (
            <Loader2 className="spin" size={14} />
          ) : (
            <RefreshCw size={14} />
          )}
          <span>{busy ? "Checking" : "Check connection"}</span>
        </button>
      </div>
      <div className="hc-current-status" role={error ? "alert" : undefined}>
        <span aria-live="polite">{reason}</span>
        {checkedAt && <time>Last response {checkedTime(checkedAt)}</time>}
        {host && <code>{host}</code>}
      </div>
      {!compact && (
        <>
          <div className="hc-responsibilities">
            <div>
              <span className="hc-role-icon">
                <Cloud size={21} />
              </span>
              <section>
                <span className="hc-role-eyebrow">CLOUD WORKSPACE</span>
                <h3>Your interface and cloud AI.</h3>
                <p>
                  Use the online workspace and configured Vertex AI models. The
                  server authenticates requests to your companion.
                </p>
                <span
                  className={`hc-provider-state ${status?.providers?.vertex?.configured ? "configured" : ""}`}
                >
                  <span />
                  {!status
                    ? "Checking provider configuration"
                    : status.providers?.vertex?.configured
                      ? "Vertex AI configured"
                      : "Vertex AI setup required"}
                </span>
              </section>
            </div>
            <span className="hc-flow-arrow" aria-hidden="true">
              <ArrowRight size={18} />
              <LockKeyhole size={12} />
            </span>
            <div>
              <span className="hc-role-icon">
                <FolderGit2 size={21} />
              </span>
              <section>
                <span className="hc-role-eyebrow">YOUR COMPANION</span>
                <h3>Your repository and execution.</h3>
                <p>
                  Read and edit files, manage Git, and run isolated tests on the
                  machine hosting the companion. Review every AI edit first.
                </p>
                <span
                  className={`hc-provider-state ${status?.providers?.local?.configured ? "configured" : ""}`}
                >
                  <span />
                  {!status
                    ? "Checking local model configuration"
                    : status.providers?.local?.configured
                      ? "Local AI configured"
                      : "Local AI optional · setup required"}
                </span>
              </section>
            </div>
          </div>
          <div className="hc-security-note">
            <LockKeyhole size={13} />
            <span>
              Connection secrets stay on the two servers. This browser never
              collects them. A connection check does not run an AI model or
              provider tool.
            </span>
          </div>
          <div className="hc-setup">
            <button
              className="hc-setup-toggle"
              aria-expanded={setupOpen}
              aria-controls="hc-setup-instructions"
              onClick={() => setSetupOpen((current) => !current)}
            >
              <Terminal size={16} />
              <span>
                {configured
                  ? "Review companion setup"
                  : "Set up a secure companion"}
              </span>
              <ChevronDown size={15} className={setupOpen ? "open" : ""} />
            </button>
            {setupOpen && (
              <div id="hc-setup-instructions" className="hc-setup-instructions">
                <div className="hc-setup-step">
                  <span>01</span>
                  <section>
                    <h3>Run the companion where your code lives.</h3>
                    <p>
                      Download the source, install its dependencies, and
                      configure the local server’s environment. Generate a
                      secret containing 32 random bytes encoded as base64url (43
                      characters), then use that same generated value on both
                      servers.
                    </p>
                    <SetupCode label="TRUSTED TERMINAL · GENERATE SECRET">
                      {
                        "node --input-type=commonjs -e \"console.log(require('node:crypto').randomBytes(32).toString('base64url'))\""
                      }
                    </SetupCode>
                    <SetupCode label="LOCAL SERVER · .env">
                      {
                        "FORGE_WORKSPACE=/absolute/path/to/your/repository\nFORGE_COMPANION_SECRET=<generated-43-character-secret>"
                      }
                    </SetupCode>
                    <SetupCode label="LOCAL TERMINAL">
                      {"npm ci\nnpm run companion"}
                    </SetupCode>
                  </section>
                </div>
                <div className="hc-setup-step">
                  <span>02</span>
                  <section>
                    <h3>Give the cloud server a secure route.</h3>
                    <p>
                      Expose the companion’s printed local address over HTTPS
                      using Cloudflare Tunnel or your trusted reverse proxy. Set
                      that HTTPS URL and the same secret on the cloud
                      application server.
                    </p>
                    <SetupCode label="CLOUD SERVER · ENVIRONMENT">
                      {
                        "FORGE_COMPANION_URL=https://your-companion.example.com\nFORGE_COMPANION_SECRET=<generated-43-character-secret>"
                      }
                    </SetupCode>
                    <p className="hc-small-note">
                      Use a stable HTTPS origin without a path or query.
                      Repository access belongs to the machine running the
                      companion.
                    </p>
                  </section>
                </div>
                <div className="hc-setup-step">
                  <span>03</span>
                  <section>
                    <h3>Verify the route, then work here.</h3>
                    <p>
                      Restart the companion and redeploy the cloud server after
                      configuring their environments. Use Check connection
                      above. When the server verifies the companion and
                      repository, the code workspace opens here.
                    </p>
                    <a
                      href="/download/source.zip"
                      className="hc-source-link"
                      download
                    >
                      <ArrowDownToLine size={14} />
                      Download companion & setup guide
                      <ArrowRight size={13} />
                    </a>
                    <p className="hc-small-note">
                      Model credentials and the isolated test runner require
                      their own setup. See README.md in the source download.
                    </p>
                  </section>
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
}
