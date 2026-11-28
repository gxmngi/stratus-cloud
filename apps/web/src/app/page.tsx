"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { API_URL, apiFetch } from "@/lib/api";
import { useAuth } from "@/components/auth/AuthProvider";
import { ProtectedWorkspace } from "@/components/auth/ProtectedWorkspace";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  CheckCircle2,
  Search,
  GitBranch,
  Box,
  Globe2,
  BookOpen,
  Code2,
  LogOut,
  Play,
  AlertCircle,
  Loader2,
  ChevronDown,
  Plus,
  Trash2,
  RotateCw,
  RotateCcw,
  Cpu,
  HardDrive,
  Activity,
  Wifi,
  X,
} from "lucide-react";
import { Brand } from "@/components/Brand";
import { Cloudscape, CloudscapeCredit } from "@/components/Cloudscape";
import { ConfirmDialog } from "@/components/ConfirmDialog";

// โหลด Terminal แบบ dynamic ปิด SSR เพราะ xterm ต้องรันบน Client Browser
const Terminal = dynamic(() => import("@/components/Terminal"), { ssr: false });

interface ContainerMetrics {
  deploymentId: string;
  containerId?: string;
  runtimeType: "dynamic" | "static";
  status: "running" | "exited" | "static" | "notFound" | "unavailable";
  cpuPercent: number;
  memoryUsageBytes: number;
  memoryLimitBytes: number;
  memoryPercent: number;
  pidsCurrent: number;
  pidsLimit: number;
  networkRxBytes: number;
  networkTxBytes: number;
  startedAt?: string;
  uptimeSeconds?: number;
}

interface DeploymentItem {
  id: string;
  project_id?: string | null;
  project_slug?: string | null;
  is_production?: boolean;
  production_url?: string | null;
  can_rollback?: boolean;
  previous_production_deployment_id?: string | null;
  git_url: string;
  status: "QUEUED" | "BUILDING" | "READY" | "FAILED" | "DELETING";
  live_url: string;
  runtime_type?: "static" | "dynamic";
  container_port?: number | null;
  duration_ms?: number | null;
  commit_message?: string | null;
  created_at: number;
  completed_at?: number | null;
}

interface RepositoryFinding {
  framework: string;
  buildCommand: string | null;
  outputDirectory: string | null;
  message?: string;
}

type RepositoryCheck = { key: string } & (
  | { finding: RepositoryFinding; error?: never; blocked?: never }
  | { error: string; blocked: boolean; finding?: never }
);

export default function Home() {
  const { user } = useAuth();
  return (
    <ProtectedWorkspace>
      {user && <Dashboard key={user.id} />}
    </ProtectedWorkspace>
  );
}

function Dashboard() {
  const { user, signOut } = useAuth();
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState("");
  async function handleSignOut() {
    if (signingOut) return;
    setSigningOut(true);
    setSignOutError("");
    try {
      await signOut();
    } catch {
      setSignOutError(
        "Couldn’t sign out. Check your connection and try again.",
      );
    } finally {
      setSigningOut(false);
    }
  }
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("All deployments");
  const [deployNotice, setDeployNotice] = useState("");
  const [actionFeedback, setActionFeedback] = useState<{
    kind: "success" | "error";
    text: string;
  } | null>(null);
  const projectFolderRef = useRef<HTMLInputElement>(null);
  const detailRef = useRef<HTMLElement>(null);
  const deploymentListRef = useRef<HTMLDivElement>(null);
  const sourceRef = useRef<HTMLInputElement>(null);
  const [loadError, setLoadError] = useState("");
  const [confirmation, setConfirmation] = useState<
    { action: "delete" | "rollback"; deploymentId: string } |
    { action: "delete-project"; projectId: string; projectName: string } | null
  >(null);
  const [gitUrl, setGitUrl] = useState("");
  const [showBuildSettings, setShowBuildSettings] = useState(false);
  const [rootDirectory, setRootDirectory] = useState("");
  const [buildCommand, setBuildCommand] = useState("");
  const [outputDirectory, setOutputDirectory] = useState("");
  const [repositoryCheck, setRepositoryCheck] = useState<RepositoryCheck | null>(null);
  const [checkAttempt, setCheckAttempt] = useState(0);
  const source = gitUrl.trim();
  const projectRoot = rootDirectory.trim();
  const isGitHub = /^https:\/\/github\.com\/[\w-]+\/[\w.-]+\/?$/i.test(source);
  const checkKey = JSON.stringify([source, projectRoot, checkAttempt]);
  const currentCheck = repositoryCheck?.key === checkKey ? repositoryCheck : null;
  const finding = currentCheck?.finding;
  const needsCheck = isGitHub && !currentCheck;
  const cannotDeploy = needsCheck || currentCheck?.blocked ||
    Boolean(finding?.message && (finding.framework !== "Unknown" || !buildCommand.trim()));
  const [isDeploying, setIsDeploying] = useState(false);
  const [isPromoting, setIsPromoting] = useState(false);
  const [isRollingBack, setIsRollingBack] = useState(false);
  const [activeDeploymentId, setActiveDeploymentId] = useState<string | null>(
    null,
  );
  const [storedMetrics, setMetrics] = useState<ContainerMetrics | null>(null);
  const [deployments, setDeployments] = useState<DeploymentItem[]>([]);
  const [isLoadingHistory, setIsLoadingHistory] = useState(true);
  const [showEnv, setShowEnv] = useState(false);
  const [envVars, setEnvVars] = useState<Array<{ key: string; value: string }>>(
    [{ key: "", value: "" }],
  );

  useEffect(() => {
    if (!isGitHub) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const response = await apiFetch(`${API_URL}/api/deploy/preflight`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ gitUrl: source, rootDirectory: projectRoot }),
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12000)]),
        });
        const data = await response.json();
        if (controller.signal.aborted) return;
        setRepositoryCheck(response.ok ? { key: checkKey, finding: data } : {
          key: checkKey,
          error: data.error || "Could not check this repository.",
          blocked: response.status === 400 || response.status === 404,
        });
      } catch {
        if (!controller.signal.aborted) {
          setRepositoryCheck({ key: checkKey, error: "Could not check this repository.", blocked: false });
        }
      }
    }, 450);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [isGitHub, checkKey, source, projectRoot]);

  function changeSource(value: string) {
    setGitUrl(value);
    if (value.trim() !== source) {
      setRootDirectory("");
      setBuildCommand("");
      setOutputDirectory("");
    }
  }

  function showProjectFolder() {
    setShowBuildSettings(true);
    requestAnimationFrame(() => projectFolderRef.current?.focus());
  }

  function showDeploymentDetails() {
    requestAnimationFrame(() => {
      detailRef.current?.focus({ preventScroll: true });
      detailRef.current?.scrollIntoView({ block: "start" });
    });
  }

  function selectDeployment(deploymentId: string) {
    setActiveDeploymentId(deploymentId);
    setActionFeedback(null);
    if (window.matchMedia("(max-width: 760px)").matches) {
      showDeploymentDetails();
    }
  }

  const handlePromote = async (deploymentId: string) => {
    setIsPromoting(true);
    setActionFeedback(null);
    try {
      const res = await apiFetch(
        `${API_URL}/api/deployments/${deploymentId}/promote`,
        {
          method: "POST",
          credentials: "include",
        },
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Failed to promote deployment");
      }
      await fetchDeployments();
      setActionFeedback({ kind: "success", text: "Production updated to " + deploymentId });
    } catch (err) {
      setActionFeedback({
        kind: "error",
        text: err instanceof Error ? err.message : "Could not promote " + deploymentId,
      });
    } finally {
      setIsPromoting(false);
    }
  };

  const [isDeleting, setIsDeleting] = useState(false);

  const handleDelete = async (resource: "projects" | "deployments", id: string) => {
    setIsDeleting(true);
    setActionFeedback(null);
    const label = resource === "projects" ? "project" : "deployment";
    try {
      const res = await apiFetch(`${API_URL}/api/${resource}/${encodeURIComponent(id)}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Failed to delete ${label}`);
      }
      await fetchDeployments();
      setActionFeedback({
        kind: "success",
        text: res.status === 202 ? "Deletion queued. Cleanup is in progress." : resource === "projects" ? "Project deleted" : "Deployment deleted",
      });
    } catch (err) {
      setActionFeedback({
        kind: "error",
        text: err instanceof Error ? err.message : "Could not delete " + label,
      });
    } finally {
      setIsDeleting(false);
    }
  };

  const handleRollback = async (deploymentId: string) => {
    setIsRollingBack(true);
    setActionFeedback(null);
    try {
      const res = await apiFetch(
        `${API_URL}/api/deployments/${deploymentId}/rollback`,
        {
          method: "POST",
          credentials: "include",
        },
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Failed to rollback deployment");
      }
      await fetchDeployments();
      setActionFeedback({ kind: "success", text: "Production restored to the previous release" });
    } catch (err) {
      setActionFeedback({
        kind: "error",
        text: err instanceof Error ? err.message : "Could not roll back production",
      });
    } finally {
      setIsRollingBack(false);
    }
  };

  const fetchDeployments = useCallback(async () => {
    try {
      const res = await apiFetch(`${API_URL}/api/deployments?limit=20`, {
        credentials: "include",
      });
      if (res.ok) {
        const data = await res.json();
        setLoadError("");
        const list: DeploymentItem[] = data.deployments || [];
        setDeployments(list);

        // Auto-select latest deployment on first load if none selected
        setActiveDeploymentId((current) => {
          if (!current && list.length > 0) {
            return list[0].id;
          }
          return list.some((d) => d.id === current)
            ? current
            : (list[0]?.id ?? null);
        });
      } else {
        setLoadError("Couldn’t load deployments. Please refresh to try again.");
      }
    } catch (err) {
      setLoadError(
        "Couldn’t load deployments. Check your connection and refresh.",
      );
      console.error("Failed to load deployment history:", err);
    } finally {
      setIsLoadingHistory(false);
    }
  }, []);

  useEffect(() => {
    fetchDeployments();
  }, [fetchDeployments]);

  const visibleDeployments = deployments.filter(
    (d) =>
      (filter === "All deployments" ||
        (filter === "Production" ? d.is_production : d.status === "FAILED")) &&
      (d.id + d.git_url + (d.project_slug || ""))
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const activeDeployment =
    visibleDeployments.find((deployment) => deployment.id === activeDeploymentId) ??
    visibleDeployments[0] ??
    null;
  const visibleDeploymentId = activeDeployment?.id;
  const metrics =
    storedMetrics?.deploymentId === visibleDeploymentId ? storedMetrics : null;
  const activeProjectId = activeDeployment?.project_id;
  const activeProjectSlug = activeDeployment?.project_slug;

  const hasPendingWork = deployments.some(({ status }) =>
    status === "QUEUED" || status === "BUILDING" || status === "DELETING",
  );
  useEffect(() => {
    if (!hasPendingWork) {
      return;
    }

    const interval = setInterval(() => {
      fetchDeployments();
    }, 2000);

    return () => clearInterval(interval);
  }, [hasPendingWork, fetchDeployments]);

  const handleAddEnv = () => {
    setEnvVars((prev) => [...prev, { key: "", value: "" }]);
  };

  const handleRemoveEnv = (index: number) => {
    setEnvVars((prev) => prev.filter((_, i) => i !== index));
  };

  const handleUpdateEnv = (
    index: number,
    field: "key" | "value",
    val: string,
  ) => {
    setEnvVars((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], [field]: val };
      return next;
    });
  };

  const handleDeploy = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!source || cannotDeploy || isDeploying) return;

    setIsDeploying(true);
    setDeployNotice("");
    setActionFeedback(null);

    const envPayload: Record<string, string> = {};
    for (const item of envVars) {
      const trimmedKey = item.key.trim();
      if (trimmedKey) {
        envPayload[trimmedKey] = item.value;
      }
    }

    try {
      const response = await apiFetch(`${API_URL}/api/deploy`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          gitUrl: source,
          rootDirectory: projectRoot || undefined,
          buildCommand: buildCommand.trim() || undefined,
          outputDirectory: outputDirectory.trim() || undefined,
          env: Object.keys(envPayload).length > 0 ? envPayload : undefined,
        }),
      });

      if (!response.ok) {
        const errJson = await response.json().catch(() => ({}));
        throw new Error(
          errJson.error ||
            errJson.details ||
            `Deployment failed with status ${response.status}`,
        );
      }

      const data = await response.json();
      setFilter("All deployments");
      setSearch("");
      setActiveDeploymentId(data.deploymentId);
      await fetchDeployments();
      setActionFeedback({ kind: "success", text: "Deployment queued. Follow its progress in Build logs." });
      showDeploymentDetails();
    } catch (err) {
      console.error(err);
      setDeployNotice(err instanceof Error ? err.message : "Could not reach the deployment service");
    } finally {
      setIsDeploying(false);
    }
  };

  useEffect(() => {
    if (!visibleDeploymentId) {
      return;
    }

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fetchMetrics = async () => {
      try {
        const res = await apiFetch(
          `${API_URL}/api/deployments/${visibleDeploymentId}/stats`,
          { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]) },
        );
        const sample = res.ok ? (await res.json()).metrics : null;
        if (!controller.signal.aborted) setMetrics(sample);
      } catch {
        if (!controller.signal.aborted) setMetrics(null);
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(fetchMetrics, 3000);
      }
    };

    fetchMetrics();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [visibleDeploymentId]);

  const formatBytes = (bytes?: number) => {
    if (!bytes || bytes <= 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
  };

  const formatUptime = (sec?: number) => {
    if (!sec || sec <= 0) return "0s";
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    const h = Math.floor(m / 60);
    if (h > 0) return `${h}h ${m % 60}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  };

  const formatDuration = (ms?: number | null) => {
    if (!ms) return null;
    return `${(ms / 1000).toFixed(1)}s`;
  };

  const formatTime = (ts: number) => {
    const d = new Date(ts);
    return d.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  };

  const projectName = (d: DeploymentItem) =>
    d.project_slug ||
    d.git_url
      .split("/")
      .filter(Boolean)
      .pop()
      ?.replace(/\.git$/, "") ||
    d.id;
  const ready = deployments.filter((d) => d.status === "READY").length;
  const inProgress = deployments.filter(
    (d) => d.status === "BUILDING" || d.status === "QUEUED",
  ).length;
  const badge = (d: DeploymentItem) => (
    <span className={"status-badge " + d.status.toLowerCase()}>
      <span />
      {d.status.charAt(0) + d.status.slice(1).toLowerCase()}
    </span>
  );
  return (
    <div className="workspace">
      <a href="#workspace-main" className="skip-link">
        Skip to workspace
      </a>
      <header className="workspace-header">
        <div className="workspace-topbar">
          <Link href="/" className="brand-link" aria-label="Stratus home">
            <Brand />
          </Link>
          <span className="workspace-identity">Personal workspace</span>
          <nav className="workspace-links" aria-label="Resources">
            <a
              href="https://github.com/gxmngi/stratus-cloud/tree/main/docs"
              target="_blank"
              rel="noreferrer"
              aria-label="Documentation"
            >
              <BookOpen size={17} />
              <span>Docs</span>
            </a>
            <a
              href="https://github.com/gxmngi/stratus-cloud"
              target="_blank"
              rel="noreferrer"
              aria-label="Source code on GitHub"
            >
              <Code2 size={18} />
              <span>Source code</span>
            </a>
          </nav>
          <div className="account">
            <span className="avatar" aria-hidden="true">
              {user?.email[0].toUpperCase()}
            </span>
            <span className="account-email" title={user?.email}>
              {user?.email}
            </span>
            <button
              className="icon-button"
              onClick={handleSignOut}
              disabled={signingOut}
              aria-label="Sign out"
              title="Sign out"
            >
              {signingOut ? (
                <Loader2 size={17} className="auth-spin" />
              ) : (
                <LogOut size={17} />
              )}
            </button>
          </div>
        </div>
      </header>
      <main id="workspace-main" className="workspace-main" tabIndex={-1}>
        {signOutError && (
          <div role="alert" className="workspace-alert">
            <AlertCircle size={17} />
            <span>{signOutError}</span>
            <button
              className="icon-button"
              aria-label="Dismiss message"
              onClick={() => setSignOutError("")}
            >
              <X size={16} />
            </button>
          </div>
        )}
        <header className="workspace-heading">
          <h1>Deployments</h1>
          <a className="workspace-jump" href="#deployments">
            Recent activity <ArrowDown size={16} aria-hidden="true" />
          </a>
        </header>
        <section
          className="deploy-composer"
          id="new-deployment"
          aria-labelledby="composer-title"
        >
          <div className="composer-art">
            <Cloudscape />
            <CloudscapeCredit />
          </div>
          <div className="composer-intro">
            <h2 id="composer-title">Deploy a project</h2>
            <p>Build a Git repository or a local project, then open its preview</p>
          </div>
          <form onSubmit={handleDeploy}>
            <label className="repository-label" htmlFor="git-repository">
              Git repository or local project path
            </label>
            <div className="repository-field">
              <GitBranch size={19} aria-hidden="true" />
              <input
                id="git-repository"
                ref={sourceRef}
                value={gitUrl}
                aria-describedby={isGitHub ? "repository-check" : undefined}
                onChange={(e) => changeSource(e.target.value)}
                required
                autoCapitalize="none"
                spellCheck={false}
                placeholder="https://github.com/you/project"
              />
              <button
                className="button primary"
                type="submit"
                disabled={isDeploying || !source || Boolean(cannotDeploy)}
              >
                {isDeploying ? (
                  <Loader2 size={15} className="auth-spin" />
                ) : (
                  <Play size={14} />
                )}
                {isDeploying ? "Queuing…" : "Deploy project"}
              </button>
            </div>
            {deployNotice && (
              <p className="composer-error" role="alert">
                <AlertCircle size={16} aria-hidden="true" /> {deployNotice}
              </p>
            )}
            {isGitHub && (
              <div className="repository-check" id="repository-check">
                <div role="status">
                  {needsCheck ? (
                    <p><Loader2 size={16} className="auth-spin" aria-hidden="true" /> Checking repository…</p>
                  ) : finding ? (
                    <>
                      <p>
                        {finding.message
                          ? <AlertCircle size={16} aria-hidden="true" />
                          : <CheckCircle2 size={16} aria-hidden="true" />}
                        <strong>{finding.framework === "Unknown" ? "Project folder needs attention" : finding.framework}</strong>
                      </p>
                      {finding.message ? (
                        <p className="check-description">{finding.message}</p>
                      ) : (
                        <dl>
                          <div><dt>Build command</dt><dd>{buildCommand.trim() || finding.buildCommand || "Auto-detected"}</dd></div>
                          <div><dt>Output folder</dt><dd>{outputDirectory.trim() || finding.outputDirectory || "Auto-detected"}</dd></div>
                        </dl>
                      )}
                    </>
                  ) : (
                    <p><AlertCircle size={16} aria-hidden="true" /> {currentCheck?.error}</p>
                  )}
                </div>
                {!needsCheck && (
                  <div className="check-actions">
                    {finding?.framework === "Unknown" && (
                      <button type="button" onClick={showProjectFolder}>Choose project folder <ArrowDown size={14} aria-hidden="true" /></button>
                    )}
                    {currentCheck?.error && (
                      <>
                        <button type="button" onClick={() => setCheckAttempt(value => value + 1)}>Retry check</button>
                        {projectRoot && <button type="button" onClick={showProjectFolder}>Change project folder</button>}
                      </>
                    )}
                  </div>
                )}
              </div>
            )}
            <div className="composer-options">
              <div>
                <span>Examples</span>
                <button
                  type="button"
                  onClick={() => changeSource("fixtures/demo-app")}
                >
                  <Globe2 size={13} /> Static site
                </button>
                <button
                  type="button"
                  onClick={() => changeSource("fixtures/demo-server")}
                >
                  <Box size={13} /> Node.js server
                </button>
              </div>
              <button
                type="button"
                className="env-toggle"
                aria-expanded={showBuildSettings}
                aria-controls="build-settings"
                onClick={() => setShowBuildSettings(!showBuildSettings)}
              >
                Build settings <ChevronDown size={14} />
              </button>
              <button
                type="button"
                className="env-toggle"
                aria-expanded={showEnv}
                aria-controls="environment-fields"
                onClick={() => setShowEnv(!showEnv)}
              >
                Environment variables <ChevronDown size={14} />
              </button>
            </div>
            {showBuildSettings && (
              <div id="build-settings" className="environment-fields build-settings">
                <p>These settings apply to this deployment.</p>
                <label>
                  Project folder
                  <input ref={projectFolderRef} value={rootDirectory} onChange={e => setRootDirectory(e.target.value)} placeholder=". (repository root)" />
                </label>
                <label>
                  Build command
                  <input value={buildCommand} onChange={e => setBuildCommand(e.target.value)} placeholder={finding?.buildCommand || "Auto-detected"} />
                </label>
                <label>
                  Output folder
                  <input value={outputDirectory} onChange={e => setOutputDirectory(e.target.value)} placeholder={finding?.outputDirectory || "Auto-detected"} />
                </label>
              </div>
            )}
            {showEnv && (
              <div id="environment-fields" className="environment-fields">
                <p>
                  Variables are passed to your build and application. Values
                  are hidden as you type.
                </p>
                {envVars.map((item, idx) => (
                  <div className="environment-row" key={idx}>
                    <input
                      aria-label={"Variable name " + (idx + 1)}
                      placeholder="VARIABLE_NAME"
                      value={item.key}
                      onChange={(e) =>
                        handleUpdateEnv(idx, "key", e.target.value)
                      }
                    />
                    <input
                      aria-label={"Variable value " + (idx + 1)}
                      type="password"
                      placeholder="Value"
                      value={item.value}
                      onChange={(e) =>
                        handleUpdateEnv(idx, "value", e.target.value)
                      }
                      autoComplete="off"
                    />
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={"Remove variable " + (idx + 1)}
                      onClick={() => handleRemoveEnv(idx)}
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                ))}
                <button
                  className="button subtle"
                  type="button"
                  onClick={handleAddEnv}
                >
                  <Plus size={14} /> Add variable
                </button>
              </div>
            )}
          </form>
        </section>
        <section
          id="deployments"
          className="deployment-section"
          tabIndex={-1}
          aria-labelledby="deployment-heading"
        >
          <div className="section-title">
            <div>
              <h2 id="deployment-heading">Recent activity</h2>
              {!isLoadingHistory && !loadError && deployments.length > 0 && (
                <ul className="activity-counts" aria-label="Recent deployment totals">
                  <li><strong>{deployments.length}</strong> recent</li>
                  <li><strong>{ready}</strong> ready</li>
                  <li><strong>{inProgress}</strong> in progress</li>
                </ul>
              )}
            </div>
            <button
              className="button subtle"
              onClick={() => void fetchDeployments()}
              aria-label="Refresh deployments"
            >
              <RotateCw size={14} /> Refresh
            </button>
          </div>
          <div className="deployment-toolbar">
            <div
              className="filter-tabs"
              role="group"
              aria-label="Filter deployments"
            >
              {["All deployments", "Production", "Failed"].map((tab) => (
                <button
                  key={tab}
                  aria-pressed={filter === tab}
                  onClick={() => setFilter(tab)}
                >
                  {tab}
                </button>
              ))}
            </div>
            <label className="search-field">
              <Search size={15} />
              <input
                aria-label="Search deployments"
                placeholder="Search deployments"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </label>
          </div>
          {loadError && (
            <div className="workspace-alert" role="alert">
              <AlertCircle size={16} />
              {loadError}
            </div>
          )}
          <div className={activeDeployment ? "deployment-grid" : "deployment-grid empty"}>
            <div className="deployment-list" ref={deploymentListRef} role="region" aria-label="Deployment history">
              {isLoadingHistory ? (
                <div className="empty-state" role="status">
                  <Loader2 className="auth-spin" size={24} />
                  <p>Loading your deployments…</p>
                </div>
              ) : visibleDeployments.length === 0 ? (
                <div className="empty-state">
                  <Box size={24} aria-hidden="true" />
                  <h3>{loadError ? "Deployment history unavailable" : deployments.length ? "No matching deployments" : "No deployments yet"}</h3>
                  {!loadError && (
                    <>
                      <p>{deployments.length ? "Change your search or clear the filters" : "Enter a repository URL or try a built-in example"}</p>
                      {deployments.length ? (
                        <button className="button" onClick={() => { setFilter("All deployments"); setSearch(""); }}>
                          Clear filters
                        </button>
                      ) : (
                        <button className="button" onClick={() => sourceRef.current?.focus()}>
                          Add a repository
                        </button>
                      )}
                    </>
                  )}
                </div>
              ) : (
                visibleDeployments.map((dep) => (
                  <button
                    key={dep.id}
                    aria-pressed={visibleDeploymentId === dep.id}
                    className={
                      "deployment-row " +
                      (visibleDeploymentId === dep.id ? "selected" : "")
                    }
                    onClick={() => selectDeployment(dep.id)}
                  >
                    <span
                      className={
                        "deployment-mark " + dep.status.toLowerCase()
                      }
                    >
                      {dep.runtime_type === "dynamic" ? (
                        <Box size={18} />
                      ) : (
                        <Globe2 size={18} />
                      )}
                    </span>
                    <span className="deployment-row-content">
                      <span className="deployment-row-title">
                        <strong>{projectName(dep)}</strong>
                        {badge(dep)}
                      </span>
                      <span className="deployment-id">{dep.id}</span>
                      <span className="deployment-row-meta">
                        <span>
                          {dep.is_production ? "Production" : "Preview"}
                        </span>
                        <span>
                          {formatTime(dep.created_at)}
                          {dep.duration_ms
                            ? " · " + formatDuration(dep.duration_ms)
                            : ""}
                        </span>
                      </span>
                    </span>
                  </button>
                ))
              )}
            </div>
            {!activeDeployment && actionFeedback && (
              <p className={"deployment-feedback " + actionFeedback.kind} role={actionFeedback.kind === "error" ? "alert" : "status"}>
                {actionFeedback.text}
              </p>
            )}
            {activeDeployment && (
              <section className="deployment-detail" ref={detailRef} tabIndex={-1} aria-labelledby="selected-deployment">
                <button type="button" className="deployment-back" onClick={() => deploymentListRef.current?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]')?.focus()}>
                  <ArrowUp size={16} aria-hidden="true" /> Back to deployments
                </button>
                <div className="detail-header">
                  <span className="detail-label">Deployment details</span>
                  {badge(activeDeployment)}
                </div>
                <div className="detail-title">
                  <h3 id="selected-deployment">{projectName(activeDeployment)}</h3>
                  <span>{activeDeployment.id}</span>
                </div>
                {activeDeployment.status === "FAILED" && (
                  <p className="deployment-feedback error">The build failed. Review the build logs for the cause.</p>
                )}
                <dl className="detail-facts">
                  <div>
                    <dt>Environment</dt>
                    <dd>
                      <span className="environment-dot" />
                      {activeDeployment.is_production
                        ? "Production"
                        : "Preview"}
                    </dd>
                  </div>
                  <div>
                    <dt>Source</dt>
                    <dd title={activeDeployment.git_url}>
                      <GitBranch size={13} />
                      {activeDeployment.git_url}
                    </dd>
                  </div>
                  <div>
                    <dt>Runtime</dt>
                    <dd>
                      {activeDeployment.runtime_type === "dynamic"
                        ? "Node.js container"
                        : "Static site"}
                    </dd>
                  </div>
                  <div>
                    <dt>Created</dt>
                    <dd>
                      {new Date(activeDeployment.created_at).toLocaleString(
                        [],
                        {
                          month: "short",
                          day: "numeric",
                          hour: "2-digit",
                          minute: "2-digit",
                        },
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>Build duration</dt>
                    <dd>
                      {formatDuration(activeDeployment.duration_ms) || "—"}
                    </dd>
                  </div>
                </dl>
                {activeDeployment.status === "READY" && (
                  <div className="deployment-domains">
                    <a href={activeDeployment.live_url} target="_blank" rel="noreferrer" aria-label="Visit preview">
                      <span><strong>Preview</strong><small>{activeDeployment.live_url.replace(/^https?:\/\//, "")}</small></span>
                      <ArrowUpRight size={16} aria-hidden="true" />
                    </a>
                    {activeDeployment.production_url && (
                      <a href={activeDeployment.production_url} target="_blank" rel="noreferrer" aria-label="Visit production">
                        <span><strong>Production</strong><small>{activeDeployment.production_url.replace(/^https?:\/\//, "")}</small></span>
                        <ArrowUpRight size={16} aria-hidden="true" />
                      </a>
                    )}
                  </div>
                )}
                <div className="detail-actions">
                  {activeDeployment.status === "READY" && !activeDeployment.is_production && (
                    <button
                      className="button primary"
                      disabled={isPromoting}
                      onClick={() => handlePromote(activeDeployment.id)}
                    >
                      {isPromoting ? (
                        <Loader2 size={16} className="auth-spin" aria-hidden="true" />
                      ) : (
                        <ArrowUpRight size={16} aria-hidden="true" />
                      )}
                      Promote to production
                    </button>
                  )}
                  {activeDeployment.is_production &&
                    activeDeployment.can_rollback && (
                      <button
                        className="button"
                        disabled={isRollingBack}
                        onClick={() =>
                          setConfirmation({
                            action: "rollback",
                            deploymentId: activeDeployment.id,
                          })
                        }
                      >
                        <RotateCcw size={16} aria-hidden="true" /> Roll back
                      </button>
                    )}
                </div>
                {(activeDeployment.status === "READY" || activeDeployment.status === "FAILED") &&
                  (!activeDeployment.is_production || (activeProjectId && activeProjectSlug)) && (
                  <div className="deployment-management">
                    {!activeDeployment.is_production && (
                      <button
                        className="button subtle delete-button"
                        disabled={isDeleting}
                        onClick={() =>
                          setConfirmation({
                            action: "delete",
                            deploymentId: activeDeployment.id,
                          })
                        }
                      >
                        <Trash2 size={16} aria-hidden="true" /> Delete deployment
                      </button>
                    )}
                    {activeProjectId && activeProjectSlug && (
                      <button
                        className="button subtle project-delete"
                        disabled={isDeleting}
                        onClick={() => setConfirmation({
                          action: "delete-project",
                          projectId: activeProjectId,
                          projectName: activeProjectSlug,
                        })}
                      >
                        <Trash2 size={16} aria-hidden="true" /> Delete project
                      </button>
                    )}
                  </div>
                )}
                {actionFeedback && (
                  <p className={"deployment-feedback " + actionFeedback.kind} role={actionFeedback.kind === "error" ? "alert" : "status"}>
                    {actionFeedback.text}
                  </p>
                )}
                {metrics?.status === "running" && (
                  <div className="runtime-metrics">
                    <div>
                      <Cpu size={14} />
                      <span>
                        CPU<strong>{metrics.cpuPercent}%</strong>
                      </span>
                    </div>
                    <div>
                      <HardDrive size={14} />
                      <span>
                        Memory
                        <strong>
                          {formatBytes(metrics.memoryUsageBytes)}
                        </strong>
                      </span>
                    </div>
                    <div>
                      <Activity size={14} />
                      <span>
                        Processes
                        <strong>
                          {metrics.pidsCurrent} / {metrics.pidsLimit}
                        </strong>
                      </span>
                    </div>
                    <div>
                      <Wifi size={14} />
                      <span>
                        Uptime
                        <strong>
                          {formatUptime(metrics.uptimeSeconds)}
                        </strong>
                      </span>
                    </div>
                  </div>
                )}
                {activeDeployment.runtime_type === "dynamic" && activeDeployment.status === "READY" && metrics?.status !== "running" && (
                  <p className="runtime-note">
                    <Activity size={14} />
                    {metrics?.status === "notFound" ? "Runtime container not found." :
                      metrics?.status === "exited" ? "Runtime container stopped." : "Runtime metrics unavailable. Retrying…"}
                  </p>
                )}
                <Terminal
                  key={activeDeployment.id}
                  deploymentId={activeDeployment.id}
                  building={activeDeployment.status === "QUEUED" || activeDeployment.status === "BUILDING"}
                  onStatusChange={() => void fetchDeployments()}
                />
              </section>
            )}
          </div>
        </section>
      </main>
      <ConfirmDialog
        open={confirmation !== null}
        title={
          confirmation?.action === "delete-project"
            ? `Delete ${confirmation.projectName}?`
            : confirmation?.action === "delete"
            ? "Delete this deployment?"
            : "Roll back production?"
        }
        description={
          confirmation?.action === "delete-project"
            ? "This removes all deployments, build files and logs for this project and takes its Preview and Production URLs offline. This action cannot be undone."
            : confirmation?.action === "delete"
            ? "This stops the application and removes its files and logs. This action cannot be undone."
            : "Production traffic will switch to the previous deployment. Your current deployment will remain available."
        }
        confirmLabel={
          confirmation?.action === "delete-project"
            ? "Delete project"
            : confirmation?.action === "delete"
            ? "Delete deployment"
            : "Roll back production"
        }
        destructive={confirmation?.action === "delete" || confirmation?.action === "delete-project"}
        onCancel={() => setConfirmation(null)}
        onConfirm={() => {
          if (!confirmation) return;
          setConfirmation(null);
          if (confirmation.action === "delete-project")
            void handleDelete("projects", confirmation.projectId);
          else if (confirmation.action === "delete")
            void handleDelete("deployments", confirmation.deploymentId);
          else void handleRollback(confirmation.deploymentId);
        }}
      />
    </div>
  );
}
