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
  Bot,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  Clock3,
  Code2,
  Copy,
  Download,
  FileCode2,
  FilePlus2,
  Folder,
  GitBranch,
  GitCommitHorizontal,
  GitCompareArrows,
  Loader2,
  Play,
  RefreshCw,
  Save,
  Search,
  Settings2,
  ShieldCheck,
  Square,
  Terminal,
  Trash2,
  X,
} from "lucide-react";
import "./repository-workbench.css";
import HybridConnection from "./HybridConnection.jsx";

const ACTIVE = new Set([
  "queued",
  "running",
  "planning",
  "working",
  "cancelling",
]);
async function api(path, body) {
  const response = await fetch(
    path,
    body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error(
      `The workspace server returned an unreadable response (${response.status}).`,
    );
  }
  if (!response.ok)
    throw new Error(
      data.message ||
        data.error?.message ||
        data.error ||
        `Request failed (${response.status})`,
    );
  return data;
}
function eventTitle(event) {
  const labels = {
    task_started: "Coding session started",
    repository_snapshot: "Repository snapshot captured",
    model_started: "Coordinator thinking",
    model_completed: "Model response received",
    tool_started: "Running repository tool",
    tool_completed: "Repository tool completed",
    tool_rejected: "Tool request rejected",
    task_failed: "Coding session failed",
    task_cancelled: "Coding session cancelled",
    task_finished: "Coding session finished",
  };
  const toolNames = {
    list_files: "List files",
    read_file: "Read file",
    search: "Search source",
    git_status: "Inspect Git status",
    git_diff: "Inspect Git diff",
    propose_changes: "Propose file changes",
    run_tests: "Run isolated tests",
    finish: "Write final response",
  };
  return (
    event.title ||
    event.message ||
    (event.tool
      ? `${toolNames[event.tool] || event.tool}${event.type === "tool_completed" ? " · complete" : event.type === "tool_rejected" ? " · rejected" : ""}`
      : labels[event.type] ||
        event.type?.replaceAll("_", " ") ||
        "Agent activity")
  );
}
function eventDetails(event) {
  const payload = {
    ...(event.arguments ? { arguments: event.arguments } : {}),
    ...(event.result ? { result: event.result } : {}),
    ...(event.error ? { error: event.error } : {}),
    ...(event.verification ? { verification: event.verification } : {}),
  };
  return Object.keys(payload).length ? payload : null;
}
function relativeDate(value) {
  if (!value) return "";
  return new Date(value).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
function stringify(value) {
  return typeof value === "string"
    ? value
    : value == null
      ? ""
      : JSON.stringify(value, null, 2);
}
function RunBadge({ status }) {
  return (
    <span
      className={`rw-badge ${ACTIVE.has(status) ? "busy" : status === "failed" ? "danger" : status === "completed" ? "good" : ""}`}
    >
      {ACTIVE.has(status) ? (
        <Loader2 size={11} className="spin" />
      ) : status === "completed" ? (
        <Check size={11} />
      ) : (
        <Circle size={9} />
      )}{" "}
      {status || "Ready"}
    </span>
  );
}
function ErrorNote({ message, onDismiss }) {
  return message ? (
    <div className="rw-error" role="alert">
      <AlertCircle size={16} />
      <span>{message}</span>
      {onDismiss && (
        <button aria-label="Dismiss error" onClick={onDismiss}>
          <X size={14} />
        </button>
      )}
    </div>
  ) : null;
}
function FileTree({ files, activePath, onOpen }) {
  const [collapsed, setCollapsed] = useState({});
  const tree = useMemo(() => {
    const root = { children: {} };
    files.forEach((file) => {
      let node = root;
      const parts = file.path.split("/");
      parts.forEach((part, index) => {
        node.children[part] ||= {
          children: {},
          path: parts.slice(0, index + 1).join("/"),
        };
        node = node.children[part];
        if (index === parts.length - 1) node.file = file;
      });
    });
    return root;
  }, [files]);
  function nodes(parent, depth = 0) {
    return Object.entries(parent.children)
      .sort(
        ([a, av], [b, bv]) =>
          Number(!!av.file) - Number(!!bv.file) || a.localeCompare(b),
      )
      .map(([name, node]) =>
        node.file ? (
          <button
            className={`rw-file ${activePath === node.path ? "active" : ""}`}
            key={node.path}
            title={node.path}
            style={{ paddingLeft: 14 + depth * 14 }}
            onClick={() => onOpen(node.path)}
          >
            <FileCode2 size={14} />
            <span>{name}</span>
          </button>
        ) : (
          <React.Fragment key={node.path}>
            <button
              className="rw-folder"
              style={{ paddingLeft: 9 + depth * 14 }}
              onClick={() =>
                setCollapsed((current) => ({
                  ...current,
                  [node.path]: !current[node.path],
                }))
              }
            >
              {collapsed[node.path] ? (
                <ChevronRight size={12} />
              ) : (
                <ChevronDown size={12} />
              )}
              <Folder size={13} />
              <span>{name}</span>
            </button>
            {!collapsed[node.path] && nodes(node, depth + 1)}
          </React.Fragment>
        ),
      );
  }
  return <div className="rw-file-tree">{nodes(tree)}</div>;
}

export default function RepositoryWorkbench({
  settings,
  agents = [],
  enabledAgents = {},
  onSettings,
  onQuickTask,
  notify = () => {},
}) {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [files, setFiles] = useState([]);
  const [treeTruncated, setTreeTruncated] = useState(false);
  const [file, setFile] = useState(null);
  const [content, setContent] = useState("");
  const [pending, setPending] = useState("");
  const [explorerTab, setExplorerTab] = useState("files");
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState(null);
  const [newPath, setNewPath] = useState("");
  const [creating, setCreating] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [git, setGit] = useState(null);
  const [diff, setDiff] = useState("");
  const [bottomTab, setBottomTab] = useState("tests");
  const [branchName, setBranchName] = useState("");
  const [commitMessage, setCommitMessage] = useState("");
  const [commitPaths, setCommitPaths] = useState([]);
  const [testCommand, setTestCommand] = useState("node:test");
  const [testResult, setTestResult] = useState(null);
  const [task, setTask] = useState("");
  const [runs, setRuns] = useState([]);
  const [selectedRunId, setSelectedRunId] = useState("");
  const [selectedRun, setSelectedRun] = useState(null);
  const [runTab, setRunTab] = useState("activity");
  const [proposalPaths, setProposalPaths] = useState([]);
  const [expandedProposal, setExpandedProposal] = useState("");
  const editorRef = useRef(null);
  const gutterRef = useRef(null);
  const taskRef = useRef(null);
  const loadingFile = useRef(0);
  const dirty = !!file && content !== file.content;
  const localReady =
    status?.configured === true &&
    ["local", "hybrid"].includes(status?.runtime);
  const activeRun = runs.find((run) => ACTIVE.has(run.status));
  const selectedIsActive = selectedRun && ACTIVE.has(selectedRun.status);
  const proposals = selectedRun?.proposals || selectedRun?.changes || [];
  const appliedPaths = selectedRun?.appliedPaths || [];
  const selectedAgents = agents.filter(
    (agent) => enabledAgents[agent.id] !== false && agent.enabled !== false,
  );
  const model = String(
    settings.provider === "openai"
      ? settings.openaiModel || ""
      : settings.provider === "vertex"
        ? settings.vertexModel || ""
        : settings.localModel || "",
  ).trim();
  const providerLabel =
    settings.provider === "openai"
      ? "OpenAI API"
      : settings.provider === "vertex"
        ? "Vertex AI"
        : "Ollama";
  const lineCount = content.split("\n").length;
  const testPassed =
    testResult?.status === "passed" && testResult?.exitCode === 0;

  const refreshFiles = useCallback(async () => {
    const result = await api("/api/repository/tree", {});
    setFiles(result.files || []);
    setTreeTruncated(!!result.truncated);
  }, []);
  const refreshGit = useCallback(async () => {
    const result = await api("/api/repository/git/status", {});
    setGit(result);
    setCommitPaths((current) =>
      current.filter((path) =>
        (result.files || []).some((file) => file.path === path),
      ),
    );
  }, []);
  const refreshRuns = useCallback(async () => {
    const result = await api("/api/coding/runs");
    setRuns(result.runs || []);
    return result.runs || [];
  }, []);
  const refreshStatus = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const result = await api("/api/repository/status");
      setStatus(result);
      if (result.configured && ["local", "hybrid"].includes(result.runtime)) {
        const results = await Promise.allSettled([
          refreshFiles(),
          refreshGit(),
          refreshRuns(),
        ]);
        const failed = results.find((result) => result.status === "rejected");
        if (failed) setError(failed.reason.message);
      }
    } catch (error) {
      setError(error.message);
    } finally {
      setLoading(false);
    }
  }, [refreshFiles, refreshGit, refreshRuns]);
  useEffect(() => {
    refreshStatus();
  }, [refreshStatus]);
  useEffect(() => {
    const handler = () => taskRef.current?.focus();
    window.addEventListener("forge:new-coding-task", handler);
    return () => window.removeEventListener("forge:new-coding-task", handler);
  }, []);
  useEffect(() => {
    if (!selectedRunId && runs[0]) setSelectedRunId(runs[0].id);
  }, [runs, selectedRunId]);
  useEffect(() => {
    if (!selectedRunId) return;
    let alive = true;
    api(`/api/coding/runs/${encodeURIComponent(selectedRunId)}`)
      .then((data) => {
        if (alive) setSelectedRun(data.run || data);
      })
      .catch((error) => {
        if (alive) setError(error.message);
      });
    return () => {
      alive = false;
    };
  }, [selectedRunId]);
  useEffect(() => {
    if (!localReady || (!activeRun && !selectedIsActive)) return;
    let alive = true;
    let timeout;
    async function poll() {
      try {
        const result = await refreshRuns();
        if (!alive) return;
        if (selectedRunId) {
          const next = await api(
            `/api/coding/runs/${encodeURIComponent(selectedRunId)}`,
          );
          if (alive) setSelectedRun(next.run || next);
        }
        if (alive && result.some((run) => ACTIVE.has(run.status)))
          timeout = setTimeout(poll, 1200);
      } catch (error) {
        if (alive) {
          setError(error.message);
          timeout = setTimeout(poll, 2500);
        }
      }
    }
    timeout = setTimeout(poll, 1200);
    return () => {
      alive = false;
      clearTimeout(timeout);
    };
  }, [localReady, activeRun?.id, selectedIsActive, selectedRunId, refreshRuns]);
  useEffect(() => {
    setProposalPaths([]);
    setExpandedProposal("");
  }, [selectedRunId]);
  useEffect(() => {
    const handler = (event) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === "s" &&
        localReady
      ) {
        event.preventDefault();
        if (dirty && !pending) saveFile();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  });
  useEffect(() => {
    if (!dirty) return;
    const handler = (event) => {
      event.preventDefault();
      event.returnValue = "";
    };
    const navigate = (event) => {
      if (!window.confirm(`Discard unsaved changes to ${file.path}?`))
        event.preventDefault();
    };
    window.addEventListener("beforeunload", handler);
    window.addEventListener("forge:before-navigation", navigate);
    return () => {
      window.removeEventListener("beforeunload", handler);
      window.removeEventListener("forge:before-navigation", navigate);
    };
  }, [dirty, file?.path]);

  async function operation(name, action) {
    setPending(name);
    setError("");
    try {
      return await action();
    } catch (error) {
      setError(error.message);
      return null;
    } finally {
      setPending("");
    }
  }
  async function openFile(path) {
    if (path === file?.path) return;
    if (dirty && !window.confirm(`Discard unsaved changes to ${file.path}?`))
      return;
    const request = ++loadingFile.current;
    setError("");
    try {
      const next = await api("/api/repository/read", { path });
      if (request === loadingFile.current) {
        setFile(next);
        setContent(next.content);
        setDeleteConfirm(false);
      }
    } catch (error) {
      if (request === loadingFile.current) setError(error.message);
    }
  }
  async function saveFile() {
    if (!dirty || !file) return;
    await operation("save", async () => {
      await api("/api/repository/apply", {
        changes: [{ path: file.path, content, baseHash: file.hash }],
      });
      const draft = content;
      const saved = await api("/api/repository/read", { path: file.path });
      setFile(saved);
      setContent((current) => (current === draft ? saved.content : current));
      await refreshGit();
      notify(`${file.path} saved to the repository`);
    });
  }
  async function createFile(event) {
    event.preventDefault();
    const path = newPath.trim();
    if (!path) return;
    await operation("create", async () => {
      await api("/api/repository/apply", {
        changes: [{ path, content: "", baseHash: null }],
      });
      await refreshFiles();
      await refreshGit();
      setNewPath("");
      setCreating(false);
      await openFile(path);
      notify(`${path} created`);
    });
  }
  async function deleteFile() {
    if (!file) return;
    await operation("delete", async () => {
      await api("/api/repository/apply", {
        changes: [{ path: file.path, baseHash: file.hash, delete: true }],
      });
      setFile(null);
      setContent("");
      setDeleteConfirm(false);
      await refreshFiles();
      await refreshGit();
      notify("File deleted from repository");
    });
  }
  async function search(event) {
    event.preventDefault();
    if (!query.trim()) return;
    await operation("search", async () =>
      setMatches(await api("/api/repository/search", { query: query.trim() })),
    );
  }
  async function showDiff() {
    setBottomTab("git");
    await operation("diff", async () => {
      const result = await api("/api/repository/git/diff", {});
      setDiff(result.diff || "");
      await refreshGit();
    });
  }
  async function createBranch(event) {
    event.preventDefault();
    if (!branchName.trim()) return;
    await operation("branch", async () => {
      await api("/api/repository/git/branch", { name: branchName.trim() });
      setBranchName("");
      await refreshGit();
      notify("Branch created and checked out");
    });
  }
  async function commit(event) {
    event.preventDefault();
    if (!commitPaths.length || !commitMessage.trim()) return;
    await operation("commit", async () => {
      const result = await api("/api/repository/git/commit", {
        message: commitMessage.trim(),
        paths: commitPaths,
      });
      setCommitMessage("");
      setCommitPaths([]);
      await refreshGit();
      const next = await api("/api/repository/git/diff", {});
      setDiff(next.diff || "");
      notify(
        `Committed ${String(result.commit || result.head || "").slice(0, 8)}`,
      );
    });
  }
  async function runTests() {
    setBottomTab("tests");
    await operation("test", async () => {
      const result = await api("/api/repository/test", {
        command: testCommand,
      });
      setTestResult(result);
    });
  }
  async function startRun(event) {
    event.preventDefault();
    if (!task.trim() || activeRun) return;
    if (settings.provider === "openai" && !model) {
      setError("Choose an OpenAI model in Settings before starting a coding task. Check the models available to the server-side key, or enter a model ID your project can use.");
      return;
    }
    await operation("start", async () => {
      const result = await api("/api/coding/start", {
        task: task.trim(),
        provider: settings.provider,
        model,
        projectId: settings.vertexProject,
        location: settings.location,
        concurrency: Number(settings.concurrency),
        maxAgents: Number(settings.maxAgents),
        enabledAgentIds: selectedAgents.map((agent) => agent.id),
      });
      const run = result.run || result;
      setRuns((current) => [
        run,
        ...current.filter((item) => item.id !== run.id),
      ]);
      setSelectedRunId(run.id);
      setSelectedRun(run);
      setTask("");
      setRunTab("activity");
      notify("Coding task started. Proposed changes require your review.");
    });
  }
  async function cancelRun() {
    if (!selectedRun) return;
    await operation("cancel", async () => {
      await api(
        `/api/coding/runs/${encodeURIComponent(selectedRun.id)}/cancel`,
        {},
      );
      const result = await api(
        `/api/coding/runs/${encodeURIComponent(selectedRun.id)}`,
      );
      setSelectedRun(result.run || result);
      await refreshRuns();
    });
  }
  async function applyProposals() {
    if (!selectedRun || !proposalPaths.length) return;
    if (dirty) {
      setError(
        "Save or discard your editor changes before applying an agent proposal.",
      );
      return;
    }
    await operation("apply", async () => {
      const result = await api(
        `/api/coding/runs/${encodeURIComponent(selectedRun.id)}/apply`,
        { paths: proposalPaths },
      );
      const refreshed = await api(
        `/api/coding/runs/${encodeURIComponent(selectedRun.id)}`,
      );
      setSelectedRun(refreshed.run || refreshed);
      setProposalPaths([]);
      await refreshFiles();
      await refreshGit();
      if (file) {
        const updated = proposals.find((change) => change.path === file.path);
        if (
          updated?.delete ||
          updated?.deleted ||
          updated?.action === "delete" ||
          updated?.operation === "delete"
        ) {
          setFile(null);
          setContent("");
        } else {
          const next = await api("/api/repository/read", { path: file.path });
          setFile(next);
          setContent(next.content);
        }
      }
      notify(result.message || "Selected changes applied to the repository");
    });
  }

  return (
    <div className="repository-workbench">
      <div className="rw-heading">
        <div>
          <span className="rw-eyebrow">
            EASY AGENT AI / ENGINEERING WORKSPACE
          </span>
          <h1>
            Your code. Your team. <span>Your next move.</span>
          </h1>
          <p>
            Work on a real repository with AI assistance, controlled execution,
            and a review before every agent edit.
          </p>
        </div>
        <button
          className="rw-button"
          onClick={refreshStatus}
          disabled={loading || !!pending}
        >
          <RefreshCw size={14} className={loading ? "spin" : ""} />
          <span>Refresh workspace</span>
        </button>
      </div>
      <ErrorNote message={error} onDismiss={() => setError("")} />
      <HybridConnection
        compact={localReady}
        onConnectionChange={refreshStatus}
      />
      {loading && !status ? (
        <div className="rw-loading">
          <Loader2 className="spin" size={22} />
          <p>Checking repository connection…</p>
        </div>
      ) : !localReady ? (
        <CloudSetup
          status={status}
          onSettings={onSettings}
          onQuickTask={onQuickTask}
          onRefresh={refreshStatus}
        />
      ) : (
        <>
          <div className="rw-repository-bar">
            <div className="rw-repo-name">
              <Folder size={17} />
              <strong>{status.repository?.name || "Repository"}</strong>
              <span className="rw-local-label">
                <span />
                {status.runtime === "hybrid"
                  ? "Hybrid companion"
                  : "Local companion"}
              </span>
            </div>
            <div className="rw-repo-details">
              <span>
                <GitBranch size={13} />
                {git?.branch || status.repository?.branch || "No branch"}
              </span>
              <code>
                {String(git?.head || status.repository?.head || "").slice(0, 8)}
              </code>
              <button onClick={showDiff}>
                <GitCompareArrows size={14} />
                {git?.files?.length || 0} changes
              </button>
              <span
                className={`rw-sandbox-status ${status.sandbox?.available ? "ready" : ""}`}
                title={
                  status.sandbox?.reason ||
                  "Repository tests require the isolated runner"
                }
              >
                <ShieldCheck size={13} />
                {status.sandbox?.available
                  ? "Sandbox available"
                  : "Tests need sandbox"}
              </span>
            </div>
          </div>
          <div className="rw-layout">
            <section className="rw-code-area" aria-label="Repository editor">
              <div className="rw-editor-grid">
                <aside className="rw-explorer">
                  <div className="rw-explorer-tabs">
                    <button
                      className={explorerTab === "files" ? "active" : ""}
                      onClick={() => setExplorerTab("files")}
                    >
                      Explorer
                    </button>
                    <button
                      className={explorerTab === "search" ? "active" : ""}
                      aria-label="Search repository"
                      onClick={() => setExplorerTab("search")}
                    >
                      <Search size={14} />
                    </button>
                    <button
                      aria-label="New repository file"
                      onClick={() => {
                        setExplorerTab("files");
                        setCreating(!creating);
                      }}
                    >
                      <FilePlus2 size={14} />
                    </button>
                  </div>
                  {explorerTab === "files" ? (
                    <>
                      {creating && (
                        <form className="rw-new-file" onSubmit={createFile}>
                          <label htmlFor="rw-new-path">New file path</label>
                          <input
                            id="rw-new-path"
                            autoFocus
                            placeholder="src/new-file.js"
                            value={newPath}
                            onChange={(e) => setNewPath(e.target.value)}
                            required
                          />
                          <div>
                            <button
                              type="button"
                              onClick={() => setCreating(false)}
                            >
                              Cancel
                            </button>
                            <button
                              className="rw-button accent"
                              disabled={!!pending}
                            >
                              Create
                            </button>
                          </div>
                        </form>
                      )}
                      <div className="rw-explorer-root">
                        <ChevronDown size={12} />
                        {status.repository?.name || "REPOSITORY"}
                        <span>{files.length}</span>
                      </div>
                      {files.length ? (
                        <FileTree
                          files={files}
                          activePath={file?.path}
                          onOpen={openFile}
                        />
                      ) : (
                        <p className="rw-explorer-note">
                          No readable source files yet. Create your first file.
                        </p>
                      )}
                      {treeTruncated && (
                        <p className="rw-explorer-note">
                          File listing limit reached. Use repository search for
                          other files.
                        </p>
                      )}
                    </>
                  ) : (
                    <div className="rw-search">
                      <form onSubmit={search}>
                        <label htmlFor="rw-search-query">
                          Find in repository
                        </label>
                        <div>
                          <input
                            id="rw-search-query"
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                            placeholder="Search source code"
                            required
                          />
                          <button aria-label="Run search" disabled={!!pending}>
                            <Search size={14} />
                          </button>
                        </div>
                      </form>
                      {matches && (
                        <>
                          <p>
                            {matches.matches?.length || 0} matches
                            {matches.truncated ? " · results limited" : ""}
                          </p>
                          <div className="rw-search-results">
                            {(matches.matches || []).map((match, index) => (
                              <button
                                key={`${match.path}:${match.line}:${index}`}
                                onClick={() => openFile(match.path)}
                              >
                                <strong>
                                  {match.path}:{match.line}
                                </strong>
                                <span>{match.text}</span>
                              </button>
                            ))}
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </aside>
                <div className="rw-editor">
                  <div className="rw-editor-toolbar">
                    <span>
                      <FileCode2 size={14} />
                      {file?.path || "Repository editor"}
                      {dirty && <i title="Unsaved changes" />}
                    </span>
                    {file && (
                      <div>
                        <button
                          className="rw-icon-button"
                          title="Delete file"
                          aria-label="Delete current repository file"
                          onClick={() => setDeleteConfirm(true)}
                          disabled={!!pending}
                        >
                          <Trash2 size={14} />
                        </button>
                        <button
                          className="rw-button small"
                          disabled={!dirty || !!pending}
                          onClick={saveFile}
                        >
                          {pending === "save" ? (
                            <Loader2 className="spin" size={13} />
                          ) : (
                            <Save size={13} />
                          )}
                          Save
                        </button>
                      </div>
                    )}
                  </div>
                  {deleteConfirm && (
                    <div className="rw-delete-confirm">
                      <span>
                        Delete <strong>{file?.path}</strong> from disk?
                      </span>
                      <button onClick={() => setDeleteConfirm(false)}>
                        Keep file
                      </button>
                      <button
                        className="rw-button danger"
                        disabled={!!pending}
                        onClick={deleteFile}
                      >
                        Delete file
                      </button>
                    </div>
                  )}
                  {file ? (
                    <>
                      <div className="rw-editor-content">
                        <pre
                          className="rw-line-numbers"
                          ref={gutterRef}
                          aria-hidden="true"
                        >
                          {Array.from(
                            { length: lineCount },
                            (_, index) => index + 1,
                          ).join("\n")}
                        </pre>
                        <textarea
                          ref={editorRef}
                          aria-label={`Edit ${file.path}`}
                          value={content}
                          onChange={(event) => setContent(event.target.value)}
                          spellCheck="false"
                          autoCapitalize="off"
                          autoCorrect="off"
                          wrap="off"
                          onScroll={(event) => {
                            if (gutterRef.current)
                              gutterRef.current.scrollTop =
                                event.target.scrollTop;
                          }}
                          onKeyDown={(event) => {
                            if (event.key === "Tab") {
                              event.preventDefault();
                              const start = event.currentTarget.selectionStart;
                              const end = event.currentTarget.selectionEnd;
                              setContent(
                                (current) =>
                                  current.slice(0, start) +
                                  "  " +
                                  current.slice(end),
                              );
                              requestAnimationFrame(() => {
                                editorRef.current.selectionStart =
                                  editorRef.current.selectionEnd = start + 2;
                              });
                            }
                          }}
                        />
                      </div>
                      <div className="rw-editor-footer">
                        <span>
                          {dirty ? "Unsaved changes" : "Saved to repository"}
                          <span>UTF-8</span>
                        </span>
                        <span>
                          {lineCount} lines<span>⌘ / Ctrl S to save</span>
                        </span>
                      </div>
                    </>
                  ) : (
                    <div className="rw-editor-empty">
                      <span className="rw-editor-symbol">
                        <Code2 size={31} />
                      </span>
                      <h2>Make your next move.</h2>
                      <p>
                        Open a file from the explorer, or describe a task to
                        your engineering team.
                      </p>
                      <div>
                        <span>
                          <FileCode2 size={13} />
                          Real files
                        </span>
                        <span>
                          <GitBranch size={13} />
                          Git aware
                        </span>
                        <span>
                          <ShieldCheck size={13} />
                          Reviewed changes
                        </span>
                      </div>
                      <button
                        className="rw-button"
                        onClick={() => {
                          setCreating(true);
                          setExplorerTab("files");
                        }}
                      >
                        <FilePlus2 size={14} />
                        Create a file
                      </button>
                    </div>
                  )}
                </div>
              </div>
              <div className="rw-bottom-panel">
                <div className="rw-bottom-tabs">
                  <button
                    className={bottomTab === "tests" ? "active" : ""}
                    onClick={() => setBottomTab("tests")}
                  >
                    <Terminal size={14} />
                    Tests
                    {testResult && (
                      <span className={testPassed ? "good" : "danger"}>
                        {testResult.status ||
                          (testPassed ? "passed" : "failed")}
                      </span>
                    )}
                  </button>
                  <button
                    className={bottomTab === "git" ? "active" : ""}
                    onClick={showDiff}
                  >
                    <GitCompareArrows size={14} />
                    Source control<span>{git?.files?.length || 0}</span>
                  </button>
                </div>
                {bottomTab === "tests" ? (
                  <div className="rw-test-panel">
                    <div className="rw-test-controls">
                      <div>
                        <ShieldCheck size={14} />
                        <span>Disposable execution sandbox</span>
                      </div>
                      <select
                        aria-label="Test runner"
                        value={testCommand}
                        onChange={(event) => setTestCommand(event.target.value)}
                      >
                        <option value="node:test">Node · node --test</option>
                        <option value="python:unittest">
                          Python · unittest
                        </option>
                      </select>
                      <button
                        className="rw-button small"
                        disabled={!!pending || !status.sandbox?.available}
                        onClick={runTests}
                      >
                        {pending === "test" ? (
                          <Loader2 size={13} className="spin" />
                        ) : (
                          <Play size={13} />
                        )}
                        Run tests
                      </button>
                    </div>
                    {!status.sandbox?.available && (
                      <p className="rw-panel-note">
                        {status.sandbox?.reason ||
                          "Install and configure the isolated sandbox runtime in your local companion before executing repository tests."}
                      </p>
                    )}
                    {testResult ? (
                      <>
                        <div className="rw-test-meta">
                          <span className={testPassed ? "good" : "danger"}>
                            Exit {testResult.exitCode ?? "unavailable"}
                          </span>
                          <span>
                            {testResult.durationMs != null
                              ? `${Math.round(testResult.durationMs)} ms`
                              : ""}
                          </span>
                          <span>
                            {stringify(
                              testResult.sandbox?.runtime ||
                                testResult.sandbox?.name ||
                                testResult.sandbox,
                            )}
                          </span>
                        </div>
                        <pre className="rw-console">
                          {testResult.output ||
                            testResult.stdout ||
                            testResult.error ||
                            "The test runner returned no output."}
                        </pre>
                      </>
                    ) : (
                      <div className="rw-terminal-empty">
                        <Terminal size={18} />
                        <p>
                          {pending === "test"
                            ? "Running your test suite in the isolated sandbox…"
                            : "Run the repository’s tests to see real results here."}
                        </p>
                        <small>
                          Network access is disabled. CPU, memory, output, and
                          execution time are limited.
                        </small>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="rw-git-panel">
                    {git?.isRepository === false && (
                      <p className="rw-panel-note">
                        This workspace has no Git repository. Initialize Git in
                        your project to enable branches, diffs, and commits.
                      </p>
                    )}
                    <div className="rw-git-forms">
                      <form onSubmit={createBranch}>
                        <label htmlFor="rw-branch">
                          <GitBranch size={13} />
                          Create branch
                        </label>
                        <div>
                          <input
                            id="rw-branch"
                            value={branchName}
                            onChange={(event) =>
                              setBranchName(event.target.value)
                            }
                            placeholder="feature/next-move"
                            required
                          />
                          <button
                            className="rw-button small"
                            disabled={
                              !!pending ||
                              !branchName.trim() ||
                              git?.isRepository === false
                            }
                          >
                            Create
                          </button>
                        </div>
                      </form>
                      <form onSubmit={commit}>
                        <label htmlFor="rw-commit">
                          <GitCommitHorizontal size={13} />
                          Commit selected files
                        </label>
                        <div>
                          <input
                            id="rw-commit"
                            value={commitMessage}
                            onChange={(event) =>
                              setCommitMessage(event.target.value)
                            }
                            placeholder="Describe the change"
                            required
                          />
                          <button
                            className="rw-button small"
                            disabled={
                              !!pending ||
                              !commitPaths.length ||
                              !commitMessage.trim() ||
                              git?.isRepository === false
                            }
                          >
                            Commit {commitPaths.length || ""}
                          </button>
                        </div>
                      </form>
                    </div>
                    {git?.files?.length ? (
                      <div className="rw-git-changes">
                        {git.files.map((item) => (
                          <label key={item.path}>
                            <input
                              type="checkbox"
                              checked={commitPaths.includes(item.path)}
                              onChange={(event) =>
                                setCommitPaths((current) =>
                                  event.target.checked
                                    ? [...current, item.path]
                                    : current.filter(
                                        (path) => path !== item.path,
                                      ),
                                )
                              }
                            />
                            <code>
                              {item.index || " "}
                              {item.worktree || " "}
                            </code>
                            <span>{item.path}</span>
                          </label>
                        ))}
                      </div>
                    ) : (
                      <div className="rw-clean-git">
                        <CheckCircle2 size={16} />
                        Working tree clean
                      </div>
                    )}
                    <pre className="rw-console rw-diff">
                      {diff ||
                        "No tracked diff to display. Untracked files appear in the change list above."}
                    </pre>
                  </div>
                )}
              </div>
            </section>
            <aside className="rw-agent-panel" aria-label="AI coding agent">
              <div className="rw-agent-heading">
                <span className="rw-agent-icon">
                  <Bot size={19} />
                </span>
                <div>
                  <h2>Your coding coordinator</h2>
                  <p>Inspect · propose · test · iterate</p>
                </div>
                <button
                  className="rw-icon-button"
                  aria-label="Configure coding agents"
                  onClick={onSettings}
                >
                  <Settings2 size={15} />
                </button>
              </div>
              <form className="rw-task-composer" onSubmit={startRun}>
                <label htmlFor="rw-task">What are we building, Dazza?</label>
                <textarea
                  id="rw-task"
                  ref={taskRef}
                  value={task}
                  onChange={(event) => setTask(event.target.value)}
                  placeholder="Describe a feature, a bug, or a change to this repository…"
                  disabled={!!activeRun || pending === "start"}
                  onKeyDown={(event) => {
                    if (
                      (event.metaKey || event.ctrlKey) &&
                      event.key === "Enter"
                    ) {
                      event.preventDefault();
                      startRun(event);
                    }
                  }}
                />
                <div className="rw-task-controls">
                  <button type="button" onClick={onSettings}>
                    <span className="rw-provider-dot" />
                    {providerLabel}
                    <ChevronDown size={11} />
                  </button>
                  <span title={model || "Choose a model in Settings"}>{model || "Choose a model"}</span>
                  <button
                    className="rw-task-send"
                    title="Start coding task"
                    aria-label="Start coding task"
                    disabled={!task.trim() || !!activeRun || !!pending}
                  >
                    {pending === "start" ? (
                      <Loader2 size={15} className="spin" />
                    ) : (
                      <ArrowRight size={17} />
                    )}
                  </button>
                </div>
                <div className="rw-task-limit">
                  12-step budget ·{" "}
                  {Math.min(
                    Number(settings.maxAgents) || 1,
                    selectedAgents.length || 1,
                  )}{" "}
                  role focus areas · one coordinator
                </div>
              </form>
              <p className="rw-task-disclosure">
                <ShieldCheck size={12} />
                Agents propose changes. You decide what gets written.
                {settings.provider === "openai" && " OpenAI API usage is billed separately from ChatGPT and Codex subscriptions."}
              </p>
              <div className="rw-run-selector">
                <span>CODING SESSIONS</span>
                <button
                  className="rw-icon-button"
                  aria-label="Refresh coding sessions"
                  onClick={() => operation("runs", refreshRuns)}
                  disabled={!!pending}
                >
                  <RefreshCw size={13} />
                </button>
              </div>
              {runs.length > 0 && (
                <select
                  className="rw-run-select"
                  aria-label="Coding session"
                  value={selectedRunId}
                  onChange={(event) => {
                    if (event.target.value !== selectedRunId) {
                      setSelectedRun(null);
                      setSelectedRunId(event.target.value);
                    }
                  }}
                >
                  {runs.map((run) => (
                    <option key={run.id} value={run.id}>
                      {run.task || run.id} · {run.status}
                    </option>
                  ))}
                </select>
              )}
              {selectedRun ? (
                <div className="rw-run-detail">
                  <div className="rw-run-title">
                    <RunBadge status={selectedRun.status} />
                    <small>{relativeDate(selectedRun.createdAt)}</small>
                    {selectedIsActive && (
                      <button
                        className="rw-stop"
                        onClick={cancelRun}
                        disabled={!!pending}
                      >
                        <Square size={10} />
                        Stop
                      </button>
                    )}
                  </div>
                  <h3>{selectedRun.task}</h3>
                  {selectedRun.verification && (
                    <div
                      className={`rw-verification ${selectedRun.verification.status === "passed" ? "good" : selectedRun.verification.status === "failed" ? "danger" : ""}`}
                    >
                      <ShieldCheck size={13} />
                      <span>
                        Verification:{" "}
                        <strong>
                          {selectedRun.verification.status === "passed"
                            ? "Recorded tests passed"
                            : selectedRun.verification.status === "failed"
                              ? "Recorded tests failed"
                              : "No passing evaluation recorded"}
                        </strong>
                      </span>
                    </div>
                  )}
                  <div className="rw-run-tabs">
                    <button
                      className={runTab === "activity" ? "active" : ""}
                      onClick={() => setRunTab("activity")}
                    >
                      Activity
                    </button>
                    <button
                      className={runTab === "changes" ? "active" : ""}
                      onClick={() => setRunTab("changes")}
                    >
                      Changes<span>{proposals.length}</span>
                    </button>
                    <button
                      className={runTab === "result" ? "active" : ""}
                      onClick={() => setRunTab("result")}
                    >
                      Result
                    </button>
                  </div>
                  {runTab === "activity" && (
                    <div className="rw-event-list">
                      {(selectedRun.events || []).map((event, index) => (
                        <div className="rw-event" key={event.id || index}>
                          <span
                            className={`rw-event-dot ${event.type === "error" || event.type === "tool_rejected" || event.type === "task_failed" ? "danger" : ""}`}
                          >
                            {event.type === "error" ||
                            event.type === "tool_rejected" ||
                            event.type === "task_failed" ? (
                              <AlertCircle size={11} />
                            ) : (
                              <Check size={10} />
                            )}
                          </span>
                          <div>
                            <strong>{eventTitle(event)}</strong>
                            {event.detail && <p>{stringify(event.detail)}</p>}
                            {event.agent && (
                              <small>{stringify(event.agent)}</small>
                            )}
                            {event.error?.message && (
                              <p className="danger">{event.error.message}</p>
                            )}
                            {(event.data || eventDetails(event)) && (
                              <details>
                                <summary>
                                  Tool details
                                  {event.step ? ` · step ${event.step}` : ""}
                                </summary>
                                <pre>
                                  {stringify(
                                    event.data || eventDetails(event),
                                  ).slice(0, 50000)}
                                </pre>
                              </details>
                            )}
                            <time>
                              {relativeDate(
                                event.at || event.createdAt || event.timestamp,
                              )}
                            </time>
                          </div>
                        </div>
                      ))}
                      {!selectedRun.events?.length && (
                        <p className="rw-muted">
                          {selectedIsActive
                            ? "Waiting for the first agent event…"
                            : "This session has no activity events."}
                        </p>
                      )}
                      {selectedIsActive && (
                        <div className="rw-live-state">
                          <Loader2 size={13} className="spin" />
                          Working on your repository…
                        </div>
                      )}
                    </div>
                  )}
                  {runTab === "changes" && (
                    <div className="rw-proposals">
                      {proposals.length ? (
                        <>
                          <p>
                            Review each proposal. Applying checks that files
                            haven’t changed since the run read them.
                          </p>
                          {proposals.map((change, index) => {
                            const applied =
                              appliedPaths.includes(change.path) ||
                              change.applied;
                            const deletion =
                              change.delete ||
                              change.deleted ||
                              change.action === "delete" ||
                              change.operation === "delete";
                            return (
                              <div
                                className={`rw-proposal ${applied ? "applied" : ""}`}
                                key={`${change.path}:${index}`}
                              >
                                <div className="rw-proposal-title">
                                  <input
                                    type="checkbox"
                                    aria-label={`Select proposal ${change.path}`}
                                    checked={proposalPaths.includes(
                                      change.path,
                                    )}
                                    disabled={
                                      applied || selectedIsActive || !!pending
                                    }
                                    onChange={(event) =>
                                      setProposalPaths((current) =>
                                        event.target.checked
                                          ? [...current, change.path]
                                          : current.filter(
                                              (path) => path !== change.path,
                                            ),
                                      )
                                    }
                                  />
                                  <button
                                    onClick={() =>
                                      setExpandedProposal((current) =>
                                        current === change.path
                                          ? ""
                                          : change.path,
                                      )
                                    }
                                  >
                                    <FileCode2 size={13} />
                                    <strong>{change.path}</strong>
                                    <ChevronDown size={12} />
                                  </button>
                                </div>
                                <div className="rw-proposal-meta">
                                  <span>
                                    {applied
                                      ? "Applied"
                                      : deletion
                                        ? "Delete file"
                                        : change.baseHash
                                          ? "Modify file"
                                          : "Proposed change"}
                                  </span>
                                  {change.reason && (
                                    <span>{change.reason}</span>
                                  )}
                                </div>
                                {expandedProposal === change.path && (
                                  <ProposalPreview change={change} />
                                )}
                              </div>
                            );
                          })}
                          <button
                            className="rw-button accent rw-apply-button"
                            onClick={applyProposals}
                            disabled={
                              !proposalPaths.length ||
                              selectedIsActive ||
                              !!pending
                            }
                          >
                            {pending === "apply" ? (
                              <Loader2 className="spin" size={13} />
                            ) : (
                              <Check size={14} />
                            )}
                            Apply {proposalPaths.length} selected{" "}
                            {proposalPaths.length === 1 ? "change" : "changes"}
                          </button>
                        </>
                      ) : (
                        <div className="rw-run-empty">
                          <FileCode2 size={22} />
                          <h4>
                            {selectedIsActive
                              ? "Changes will appear here"
                              : "No changes proposed"}
                          </h4>
                          <p>
                            {selectedIsActive
                              ? "The coordinator is inspecting your repository. You’ll review its proposals before they reach disk."
                              : "Read the result for this session’s analysis or explanation."}
                          </p>
                        </div>
                      )}
                    </div>
                  )}
                  {runTab === "result" && (
                    <div className="rw-run-result">
                      <ErrorNote message={stringify(selectedRun.error)} />
                      {selectedRun.output && (
                        <pre>{stringify(selectedRun.output)}</pre>
                      )}
                      {selectedRun.tests && (
                        <details open>
                          <summary>Agent verification</summary>
                          <pre>{stringify(selectedRun.tests)}</pre>
                        </details>
                      )}
                      {!selectedRun.output && !selectedRun.error && (
                        <p className="rw-muted">
                          {selectedIsActive
                            ? "The final response will appear when the session finishes."
                            : "No final output was returned."}
                        </p>
                      )}
                    </div>
                  )}
                </div>
              ) : (
                <div className="rw-first-task">
                  <div className="rw-orbit">
                    <Bot size={29} />
                    <span />
                    <span />
                    <span />
                  </div>
                  <h3>From task to reviewed code.</h3>
                  <p>
                    Your coordinator reads the repository, proposes edits, and
                    runs checks. Selected specialist roles guide its focus.
                    Follow every tool call here.
                  </p>
                  <button
                    onClick={() => {
                      setTask(
                        "Inspect this repository and propose a focused improvement with tests. Explain the issue and the changes before proposing edits.",
                      );
                      taskRef.current?.focus();
                    }}
                  >
                    Inspect this repository <ArrowRight size={13} />
                  </button>
                  <div className="rw-first-task-note">
                    <Clock3 size={13} />
                    Sessions persist on your local server.
                  </div>
                </div>
              )}
            </aside>
          </div>
        </>
      )}
      <footer className="rw-footer">
        <span>
          <span className="rw-footer-mark">EA</span> EASY AGENT AI <i />
          Built for Darren M. Smith
        </span>
        <span>Independent software · Your models, your infrastructure</span>
      </footer>
    </div>
  );
}

function CloudSetup({ status, onSettings, onQuickTask, onRefresh }) {
  const [copied, setCopied] = useState(false);
  const [setupMode, setSetupMode] = useState("demo");
  const command =
    setupMode === "demo"
      ? "npm ci\ncp .env.example .env\nnpm run demo"
      : "npm ci\nnpm run build\nFORGE_WORKSPACE=/absolute/path/to/your/repository npm start";
  async function copyCommand() {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  }
  return (
    <div className="rw-setup">
      <div className="rw-setup-hero">
        <div className="rw-setup-brand">
          <span>EA</span>
          <div>
            EASY AGENT <strong>AI</strong>
            <small>BUILD. AUTOMATE. INNOVATE.</small>
          </div>
        </div>
        <div className="rw-setup-kicker">
          <span />
          YOUR PRIVATE ENGINEERING DESK
        </div>
        <h2>
          A serious workspace.
          <br />
          <em>Connected to your code.</em>
        </h2>
        <p>
          Connect an authenticated companion to use your repository through this
          online workspace, or run the complete app on localhost. Edit real
          files, review Git changes, and keep control of every AI proposal.
        </p>
        <div className="rw-setup-actions">
          <a href="/download/source.zip" className="rw-button accent" download>
            <ArrowDownToLine size={15} />
            Download local companion
          </a>
          <button className="rw-button" onClick={onSettings}>
            <Settings2 size={14} />
            Configure AI models
          </button>
        </div>
        {onQuickTask && (
          <button className="rw-cloud-task-link" onClick={onQuickTask}>
            Open a cloud AI task <ArrowRight size={13} />
          </button>
        )}
        <div className="rw-setup-trust">
          <ShieldCheck size={14} />
          <span>
            AI writes require your review. Credentials stay on the server.
          </span>
        </div>
        <div className="rw-setup-visual" aria-hidden="true">
          <div className="rw-visual-grid" />
          <span className="rw-visual-code">&gt;_</span>
          <div className="rw-visual-chip one">
            <GitBranch size={15} />
            your repository
          </div>
          <div className="rw-visual-chip two">
            <Bot size={15} />
            your AI team
          </div>
          <div className="rw-visual-chip three">
            <ShieldCheck size={15} />
            your decisions
          </div>
          <span className="rw-visual-label">EASY AGENT AI ENGINEERING</span>
        </div>
      </div>
      <div className="rw-connection-state">
        <span className="rw-connection-icon">
          <Terminal size={20} />
        </span>
        <div>
          <strong>
            {status?.runtime === "cloud"
              ? "Connect a companion or open the standalone local app"
              : "Choose a repository for this local app"}
          </strong>
          <p>
            {status?.reason ||
              status?.message ||
              "Use the secure hybrid setup above to connect this workspace, or run the standalone app and open http://127.0.0.1:3000."}
          </p>
        </div>
        <span className="rw-badge">Setup required</span>
      </div>
      <div className="rw-setup-grid">
        <section className="rw-setup-instructions">
          <div className="rw-section-number">01 — RUN YOUR LOCAL WORKSPACE</div>
          <h3>Start locally. Open localhost.</h3>
          <p>
            Unzip the download and open a terminal in its folder. Use Node.js
            22.13 or newer, npm, and Git. Try the included demo or choose your
            own repository.
          </p>
          <div
            className="rw-run-tabs rw-setup-modes"
            role="tablist"
            aria-label="Local startup options"
          >
            <button
              role="tab"
              aria-selected={setupMode === "demo"}
              className={setupMode === "demo" ? "active" : ""}
              onClick={() => {
                setSetupMode("demo");
                setCopied(false);
              }}
            >
              Try the demo
            </button>
            <button
              role="tab"
              aria-selected={setupMode === "repository"}
              className={setupMode === "repository" ? "active" : ""}
              onClick={() => {
                setSetupMode("repository");
                setCopied(false);
              }}
            >
              Use my repository
            </button>
          </div>
          <div className="rw-command-header">
            <span>TERMINAL</span>
            <button onClick={copyCommand}>
              {copied ? <Check size={12} /> : <Copy size={12} />}{" "}
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <pre className="rw-setup-command">{command}</pre>
          <p className="rw-setup-caption">
            Then open http://127.0.0.1:3000 in your browser. Models and the
            isolated test runner need their own setup; the demo reports their
            availability.
          </p>
          <a
            className="rw-text-button"
            href="http://127.0.0.1:3000"
            target="_blank"
            rel="noopener noreferrer"
          >
            Open localhost workspace <ArrowRight size={13} />
          </a>
          <p className="rw-setup-caption">
            Model and sandbox instructions are in{" "}
            <a href="/download/source.zip" download>
              README.md in the source download
            </a>
            .
          </p>
          <button className="rw-text-button" onClick={onRefresh}>
            <RefreshCw size={13} />
            Refresh this server’s status
          </button>
        </section>
        <section className="rw-setup-features">
          <div className="rw-section-number">02 — BUILD WITH CONTROL</div>
          <h3>The tools that move work forward.</h3>
          <div>
            <span>
              <FileCode2 size={18} />
            </span>
            <section>
              <h4>A real repository editor</h4>
              <p>
                Read, search, create, and save files with conflict protection.
              </p>
            </section>
          </div>
          <div>
            <span>
              <GitBranch size={18} />
            </span>
            <section>
              <h4>Git, built into the workflow</h4>
              <p>
                Inspect changes, create a branch, and commit selected files.
              </p>
            </section>
          </div>
          <div>
            <span>
              <Bot size={18} />
            </span>
            <section>
              <h4>A visible AI coding loop</h4>
              <p>
                Follow repository inspection, model tool calls, and file
                proposals.
              </p>
            </section>
          </div>
          <div>
            <span>
              <ShieldCheck size={18} />
            </span>
            <section>
              <h4>Isolated test execution</h4>
              <p>Run Node and Python tests with network and resource limits.</p>
            </section>
          </div>
        </section>
      </div>
    </div>
  );
}

function ProposalPreview({ change }) {
  const [original, setOriginal] = useState(
    change.beforeContent != null
      ? { content: change.beforeContent, hash: change.baseHash }
      : null,
  );
  const [currentFile, setCurrentFile] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [loading, setLoading] = useState(!!change.baseHash);
  useEffect(() => {
    let alive = true;
    if (!change.baseHash) {
      setLoading(false);
      return;
    }
    api("/api/repository/read", { path: change.path })
      .then((value) => {
        if (alive) {
          setCurrentFile(value);
          if (change.beforeContent == null) setOriginal(value);
        }
      })
      .catch((error) => {
        if (alive) setLoadError(error.message);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [change.path, change.baseHash, change.beforeContent]);
  const deletion =
    change.delete ||
    change.deleted ||
    change.action === "delete" ||
    change.operation === "delete";
  return (
    <div className="rw-proposal-content">
      {change.diff ? (
        <pre>{change.diff}</pre>
      ) : (
        <>
          {loading && <p>Loading current file…</p>}
          {loadError && <p className="danger">{loadError}</p>}
          {original && (
            <>
              {currentFile && currentFile.hash !== change.baseHash && (
                <p className="danger">
                  This file has changed since the proposal was created. Applying
                  it will be rejected; start a fresh coding session.
                </p>
              )}
              <small>
                {change.beforeContent != null
                  ? "ORIGINAL AT SESSION START"
                  : "CURRENT FILE ON DISK"}
              </small>
              <pre className="before">{original.content}</pre>
            </>
          )}
          <small>
            {deletion
              ? "DELETION"
              : change.operation === "create"
                ? "NEW FILE CONTENT"
                : "PROPOSED CONTENT"}
          </small>
          <pre className="after">
            {deletion ? "This file will be deleted." : change.content}
          </pre>
        </>
      )}
    </div>
  );
}
