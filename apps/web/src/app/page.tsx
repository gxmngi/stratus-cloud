"use client";

import { useState, useEffect, useCallback } from "react";
import dynamic from "next/dynamic";
import { 
  ExternalLink, 
  Play, 
  CheckCircle2, 
  AlertCircle, 
  Loader2, 
  Layers, 
  ChevronDown, 
  ChevronRight, 
  Plus, 
  Trash2,
  Clock,
  History,
  RotateCw,
  RotateCcw,
  Cpu,
  HardDrive,
  Activity,
  Wifi
} from "lucide-react";

// โหลด Terminal แบบ dynamic ปิด SSR เพราะ xterm ต้องรันบน Client Browser
const Terminal = dynamic(() => import("@/components/Terminal"), { ssr: false });

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

interface ContainerMetrics {
  deploymentId: string;
  containerId?: string;
  runtimeType: "dynamic" | "static";
  status: "running" | "exited" | "static" | "notFound";
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
  status: "QUEUED" | "BUILDING" | "READY" | "FAILED";
  live_url: string;
  runtime_type?: "static" | "dynamic";
  container_port?: number | null;
  duration_ms?: number | null;
  commit_message?: string | null;
  created_at: number;
  completed_at?: number | null;
}

export default function Home() {
  const [gitUrl, setGitUrl] = useState("fixtures/demo-app");
  const [isDeploying, setIsDeploying] = useState(false);
  const [isPromoting, setIsPromoting] = useState(false);
  const [isRollingBack, setIsRollingBack] = useState(false);
  const [activeDeploymentId, setActiveDeploymentId] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<ContainerMetrics | null>(null);
  const [deployments, setDeployments] = useState<DeploymentItem[]>([]);
  const [isLoadingHistory, setIsLoadingHistory] = useState(true);
  const [showEnv, setShowEnv] = useState(false);
  const [envVars, setEnvVars] = useState<Array<{ key: string; value: string }>>([
    { key: "", value: "" },
  ]);

  const handlePromote = async (deploymentId: string) => {
    setIsPromoting(true);
    try {
      const res = await fetch(`${API_URL}/api/deployments/${deploymentId}/promote`, {
        method: "POST",
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Failed to promote deployment");
      }
      await fetchDeployments();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Error promoting deployment");
    } finally {
      setIsPromoting(false);
    }
  };

  const handleRollback = async (deploymentId: string) => {
    if (!confirm("Are you sure you want to rollback production traffic to the previous deployment?")) {
      return;
    }
    setIsRollingBack(true);
    try {
      const res = await fetch(`${API_URL}/api/deployments/${deploymentId}/rollback`, {
        method: "POST",
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Failed to rollback deployment");
      }
      await fetchDeployments();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Error rolling back deployment");
    } finally {
      setIsRollingBack(false);
    }
  };

  const fetchDeployments = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/api/deployments?limit=20`);
      if (res.ok) {
        const data = await res.json();
        const list: DeploymentItem[] = data.deployments || [];
        setDeployments(list);

        // Auto-select latest deployment on first load if none selected
        setActiveDeploymentId((current) => {
          if (!current && list.length > 0) {
            return list[0].id;
          }
          return current;
        });
      }
    } catch (err) {
      console.error("Failed to load deployment history:", err);
    } finally {
      setIsLoadingHistory(false);
    }
  }, []);

  useEffect(() => {
    fetchDeployments();
  }, [fetchDeployments]);

  // Active deployment data derived from list or fallback
  const activeDeployment = deployments.find((d) => d.id === activeDeploymentId) || null;

  // Poll status while active deployment is pending
  useEffect(() => {
    if (!activeDeployment || activeDeployment.status === "READY" || activeDeployment.status === "FAILED") {
      return;
    }

    const interval = setInterval(() => {
      fetchDeployments();
    }, 2000);

    return () => clearInterval(interval);
  }, [activeDeployment, fetchDeployments]);

  const handleAddEnv = () => {
    setEnvVars((prev) => [...prev, { key: "", value: "" }]);
  };

  const handleRemoveEnv = (index: number) => {
    setEnvVars((prev) => prev.filter((_, i) => i !== index));
  };

  const handleUpdateEnv = (index: number, field: "key" | "value", val: string) => {
    setEnvVars((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], [field]: val };
      return next;
    });
  };

  const handleDeploy = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!gitUrl.trim() || isDeploying) return;

    setIsDeploying(true);

    const envPayload: Record<string, string> = {};
    for (const item of envVars) {
      const trimmedKey = item.key.trim();
      if (trimmedKey) {
        envPayload[trimmedKey] = item.value;
      }
    }

    try {
      const response = await fetch(`${API_URL}/api/deploy`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
          gitUrl,
          env: Object.keys(envPayload).length > 0 ? envPayload : undefined,
        }),
      });

      if (!response.ok) {
        const errJson = await response.json().catch(() => ({}));
        throw new Error(errJson.details || `Deployment failed with status ${response.status}`);
      }

      const data = await response.json();
      setActiveDeploymentId(data.deploymentId);
      await fetchDeployments();
    } catch (err) {
      console.error(err);
      alert(err instanceof Error ? err.message : `Failed to connect to API server at ${API_URL}`);
    } finally {
      setIsDeploying(false);
    }
  };

  // Poll container metrics when active deployment is selected
  useEffect(() => {
    if (!activeDeploymentId) {
      setMetrics(null);
      return;
    }

    let isMounted = true;
    const fetchMetrics = async () => {
      try {
        const res = await fetch(`${API_URL}/api/deployments/${activeDeploymentId}/stats`);
        if (res.ok && isMounted) {
          const data = await res.json();
          setMetrics(data.metrics);
        }
      } catch {}
    };

    fetchMetrics();
    const interval = setInterval(fetchMetrics, 3000);
    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, [activeDeploymentId]);

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
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-[#ededed] font-sans antialiased">
      {/* Header Bar */}
      <header className="border-b border-zinc-800 bg-[#0d0d0d] sticky top-0 z-50">
        <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-md bg-zinc-100 text-black flex items-center justify-center font-bold text-sm tracking-wider">
              S
            </div>
            <div className="flex items-baseline gap-2">
              <span className="font-semibold tracking-tight text-white">STRATUS</span>
              <span className="text-xs text-zinc-500 font-mono">PaaS Platform</span>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-mono bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
              SYSTEM ONLINE
            </span>
            <span className="text-xs text-zinc-500 font-mono border border-zinc-800 px-2 py-0.5 rounded">
              EDGE PORT 8000
            </span>
          </div>
        </div>
      </header>

      {/* Main Container */}
      <main className="max-w-6xl mx-auto px-6 py-10">
        <div className="max-w-2xl mb-8">
          <h1 className="text-3xl font-semibold tracking-tight text-white mb-2">
            Deploy your web application
          </h1>
          <p className="text-sm text-zinc-400 leading-relaxed">
            Stratus executes isolated Docker builds, persists deployment records in SQLite, streams live logs via Redis, and routes traffic on the Go edge proxy.
          </p>
        </div>

        {/* Input Form Card */}
        <div className="border border-zinc-800 bg-zinc-900/40 rounded-xl p-6 shadow-xl mb-10">
          <form onSubmit={handleDeploy} className="space-y-4">
            <div>
              <label className="block text-xs font-mono uppercase tracking-wider text-zinc-400 mb-2">
                Git Repository / Local Project Path
              </label>
              <div className="flex gap-3">
                <input
                  type="text"
                  value={gitUrl}
                  onChange={(e) => setGitUrl(e.target.value)}
                  placeholder="https://github.com/user/repo or local fixture path"
                  className="flex-1 bg-black border border-zinc-800 rounded-lg px-4 py-2.5 text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-zinc-500 font-mono"
                  required
                />
                <button
                  type="submit"
                  disabled={isDeploying}
                  className="inline-flex items-center gap-2 bg-white hover:bg-zinc-200 text-black px-5 py-2.5 rounded-lg text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                >
                  {isDeploying ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Queuing...
                    </>
                  ) : (
                    <>
                      <Play className="w-4 h-4 fill-current" />
                      Deploy
                    </>
                  )}
                </button>
              </div>
            </div>

            <div className="flex items-center gap-2 pt-1 text-xs text-zinc-500 font-mono">
              <span>Quick Select:</span>
              <button
                type="button"
                onClick={() => setGitUrl("fixtures/demo-app")}
                className="text-zinc-400 hover:text-white underline decoration-zinc-700 underline-offset-2 cursor-pointer"
              >
                Static App (fixtures/demo-app)
              </button>
              <span>•</span>
              <button
                type="button"
                onClick={() => setGitUrl("fixtures/demo-server")}
                className="text-purple-400 hover:text-purple-300 underline decoration-purple-800 underline-offset-2 cursor-pointer"
              >
                Dynamic Server (fixtures/demo-server)
              </button>
            </div>

            {/* Collapsible Environment Variables Section */}
            <div className="pt-3 border-t border-zinc-800/80">
              <button
                type="button"
                onClick={() => setShowEnv(!showEnv)}
                className="inline-flex items-center gap-2 text-xs font-mono text-zinc-400 hover:text-zinc-200 transition-colors cursor-pointer"
              >
                {showEnv ? (
                  <ChevronDown className="w-3.5 h-3.5" />
                ) : (
                  <ChevronRight className="w-3.5 h-3.5" />
                )}
                <span>Environment Variables (.env)</span>
                {envVars.filter((v) => v.key.trim()).length > 0 && (
                  <span className="px-1.5 py-0.5 text-[10px] rounded bg-zinc-800 text-emerald-400 border border-zinc-700 font-mono">
                    {envVars.filter((v) => v.key.trim()).length} configured
                  </span>
                )}
              </button>

              {showEnv && (
                <div className="mt-3 space-y-2.5 pl-3 border-l border-zinc-800">
                  <p className="text-[11px] text-zinc-500 font-mono">
                    Injected into Docker build sandbox during compilation.
                  </p>
                  {envVars.map((item, idx) => (
                    <div key={idx} className="flex gap-2 items-center">
                      <input
                        type="text"
                        placeholder="KEY (e.g. VITE_API_URL)"
                        value={item.key}
                        onChange={(e) => handleUpdateEnv(idx, "key", e.target.value)}
                        className="w-1/3 bg-black border border-zinc-800 rounded px-3 py-1.5 text-xs text-zinc-100 placeholder-zinc-600 font-mono focus:outline-none focus:border-zinc-500 uppercase"
                      />
                      <input
                        type="text"
                        placeholder="VALUE"
                        value={item.value}
                        onChange={(e) => handleUpdateEnv(idx, "value", e.target.value)}
                        className="flex-1 bg-black border border-zinc-800 rounded px-3 py-1.5 text-xs text-zinc-100 placeholder-zinc-600 font-mono focus:outline-none focus:border-zinc-500"
                      />
                      <button
                        type="button"
                        onClick={() => handleRemoveEnv(idx)}
                        disabled={envVars.length === 1 && !item.key && !item.value}
                        className="text-zinc-500 hover:text-red-400 p-1.5 rounded transition-colors disabled:opacity-20 disabled:cursor-not-allowed cursor-pointer"
                        title="Remove variable"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    onClick={handleAddEnv}
                    className="inline-flex items-center gap-1.5 text-xs font-mono text-zinc-400 hover:text-white pt-1 cursor-pointer"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>Add Variable</span>
                  </button>
                </div>
              )}
            </div>
          </form>
        </div>

        {/* 2-Column Grid: Left is History, Right is Active Deployment & Terminal */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
          {/* History Sidebar (4 Columns) */}
          <div className="lg:col-span-4 border border-zinc-800 bg-zinc-900/40 rounded-xl p-5 shadow-lg">
            <div className="flex items-center justify-between pb-3 border-b border-zinc-800 mb-3">
              <div className="flex items-center gap-2 text-xs font-mono font-semibold uppercase tracking-wider text-zinc-300">
                <History className="w-4 h-4 text-zinc-400" />
                <span>Deployment History</span>
              </div>
              <button
                type="button"
                onClick={fetchDeployments}
                className="text-zinc-500 hover:text-zinc-300 p-1 rounded transition-colors cursor-pointer"
                title="Refresh history"
              >
                <RotateCw className="w-3.5 h-3.5" />
              </button>
            </div>

            {isLoadingHistory ? (
              <div className="py-8 text-center text-xs text-zinc-500 font-mono flex items-center justify-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>Loading history...</span>
              </div>
            ) : deployments.length === 0 ? (
              <div className="py-8 text-center text-xs text-zinc-500 font-mono">
                No past deployments recorded.
              </div>
            ) : (
              <div className="space-y-2 max-h-[500px] overflow-y-auto pr-1">
                {deployments.map((dep) => {
                  const isSelected = dep.id === activeDeploymentId;
                  return (
                    <button
                      key={dep.id}
                      type="button"
                      onClick={() => setActiveDeploymentId(dep.id)}
                      className={`w-full text-left p-3 rounded-lg border transition-all cursor-pointer font-mono ${
                        isSelected 
                          ? "border-zinc-600 bg-zinc-800/80 shadow-md" 
                          : "border-zinc-800/60 bg-black/40 hover:bg-zinc-850 hover:border-zinc-700"
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2 mb-1.5">
                        <span className="text-xs font-semibold text-white truncate">
                          {dep.id}
                        </span>
                        <div className="flex items-center gap-1">
                          {dep.is_production && (
                            <span className="px-1.5 py-0.5 rounded text-[10px] bg-amber-500/10 text-amber-300 border border-amber-500/30">
                              ★ PROD
                            </span>
                          )}
                          {dep.runtime_type === "dynamic" && (
                            <span className="px-1.5 py-0.5 rounded text-[10px] bg-purple-500/10 text-purple-400 border border-purple-500/20">
                              ⚡ SERVER
                            </span>
                          )}
                          {dep.status === "READY" && (
                            <span className="px-1.5 py-0.5 rounded text-[10px] bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                              READY
                            </span>
                          )}
                          {dep.status === "BUILDING" && (
                            <span className="px-1.5 py-0.5 rounded text-[10px] bg-blue-500/10 text-blue-400 border border-blue-500/20 animate-pulse">
                              BUILDING
                            </span>
                          )}
                          {dep.status === "QUEUED" && (
                            <span className="px-1.5 py-0.5 rounded text-[10px] bg-yellow-500/10 text-yellow-400 border border-yellow-500/20">
                              QUEUED
                            </span>
                          )}
                          {dep.status === "FAILED" && (
                            <span className="px-1.5 py-0.5 rounded text-[10px] bg-red-500/10 text-red-400 border border-red-500/20">
                              FAILED
                            </span>
                          )}
                        </div>
                      </div>

                      <div className="text-[11px] text-zinc-400 truncate mb-1">
                        {dep.git_url}
                      </div>

                      <div className="flex items-center justify-between text-[10px] text-zinc-500 tabular-nums">
                        <span className="flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          {formatTime(dep.created_at)}
                        </span>
                        {dep.duration_ms && (
                          <span>{formatDuration(dep.duration_ms)}</span>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Active Deployment Details & Terminal (8 Columns) */}
          <div className="lg:col-span-8 space-y-6">
            {activeDeployment ? (
              <>
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-5 rounded-xl border border-zinc-800 bg-zinc-900/60">
                  <div className="flex items-center gap-4">
                    <div className="w-10 h-10 rounded-lg border border-zinc-700 bg-black flex items-center justify-center shrink-0">
                      <Layers className="w-5 h-5 text-zinc-300" />
                    </div>
                    <div>
                      <div className="flex flex-wrap items-center gap-2.5">
                        <h3 className="font-mono text-sm font-semibold text-white">
                          {activeDeployment.id}
                        </h3>
                        {activeDeployment.is_production && (
                          <span className="px-2 py-0.5 rounded text-[11px] font-mono bg-amber-500/10 text-amber-300 border border-amber-500/30">
                            ★ PRODUCTION
                          </span>
                        )}
                        {activeDeployment.runtime_type === "dynamic" && (
                          <span className="px-2 py-0.5 rounded text-[11px] font-mono bg-purple-500/10 text-purple-400 border border-purple-500/20">
                            ⚡ DYNAMIC CONTAINER
                          </span>
                        )}
                        {activeDeployment.status === "QUEUED" && (
                          <span className="px-2 py-0.5 rounded text-[11px] font-mono bg-yellow-500/10 text-yellow-400 border border-yellow-500/20">
                            QUEUED
                          </span>
                        )}
                        {activeDeployment.status === "BUILDING" && (
                          <span className="px-2 py-0.5 rounded text-[11px] font-mono bg-blue-500/10 text-blue-400 border border-blue-500/20 animate-pulse">
                            BUILDING
                          </span>
                        )}
                        {activeDeployment.status === "READY" && (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-mono bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                            <CheckCircle2 className="w-3 h-3" /> READY
                          </span>
                        )}
                        {activeDeployment.status === "FAILED" && (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-mono bg-red-500/10 text-red-400 border border-red-500/20">
                            <AlertCircle className="w-3 h-3" /> FAILED
                          </span>
                        )}
                      </div>
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-400 mt-1 font-mono">
                        <span>Preview: <code>{activeDeployment.id}.localhost:8000</code></span>
                        {activeDeployment.production_url && (
                          <span className="text-amber-300/90">
                            • Production: <a href={activeDeployment.production_url} target="_blank" rel="noreferrer" className="underline hover:text-amber-200">{activeDeployment.project_slug}.localhost:8000</a>
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2.5">
                    {activeDeployment.status === "READY" && !activeDeployment.is_production && (
                      <button
                        type="button"
                        onClick={() => handlePromote(activeDeployment.id)}
                        disabled={isPromoting}
                        className="inline-flex items-center gap-1.5 bg-zinc-800 hover:bg-zinc-700 text-amber-300 border border-amber-500/30 px-3 py-2 rounded-lg text-xs font-semibold tracking-wide transition-colors disabled:opacity-50 cursor-pointer"
                        title="Promote this deployment to the project's production domain"
                      >
                        {isPromoting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <span>★ PROMOTE TO PROD</span>}
                      </button>
                    )}
                    {activeDeployment.is_production && activeDeployment.can_rollback && (
                      <button
                        type="button"
                        onClick={() => handleRollback(activeDeployment.id)}
                        disabled={isRollingBack}
                        className="inline-flex items-center gap-1.5 bg-zinc-800 hover:bg-zinc-700 text-rose-300 border border-rose-500/30 px-3 py-2 rounded-lg text-xs font-semibold tracking-wide transition-colors disabled:opacity-50 cursor-pointer"
                        title={`Rollback production domain to previous deployment (${activeDeployment.previous_production_deployment_id})`}
                      >
                        {isRollingBack ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <>
                            <RotateCcw className="w-3.5 h-3.5" />
                            <span>ROLLBACK PROD</span>
                          </>
                        )}
                      </button>
                    )}
                    {activeDeployment.status === "READY" ? (
                      <a
                        href={activeDeployment.live_url}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-2 bg-emerald-500 hover:bg-emerald-400 text-black px-4 py-2 rounded-lg text-xs font-semibold tracking-wide transition-colors"
                      >
                        <span>VISIT PREVIEW</span>
                        <ExternalLink className="w-3.5 h-3.5" />
                      </a>
                    ) : (
                      <span className="text-xs text-zinc-500 font-mono">
                        Compiling in Docker Sandbox...
                      </span>
                    )}
                  </div>
                </div>

                {/* Real-time Container Telemetry Card */}
                {metrics && metrics.status === "running" && (
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 p-4 rounded-xl border border-zinc-800 bg-zinc-950/80 font-mono text-xs">
                    <div className="flex items-center gap-3 p-2.5 rounded-lg bg-zinc-900/60 border border-zinc-800/80">
                      <Cpu className="w-4 h-4 text-emerald-400 shrink-0" />
                      <div>
                        <div className="text-[10px] uppercase text-zinc-500">CPU Load</div>
                        <div className="font-semibold text-zinc-200 tabular-nums">{metrics.cpuPercent}%</div>
                      </div>
                    </div>
                    <div className="flex items-center gap-3 p-2.5 rounded-lg bg-zinc-900/60 border border-zinc-800/80">
                      <HardDrive className="w-4 h-4 text-purple-400 shrink-0" />
                      <div>
                        <div className="text-[10px] uppercase text-zinc-500">Memory ({metrics.memoryPercent}%)</div>
                        <div className="font-semibold text-zinc-200 tabular-nums">{formatBytes(metrics.memoryUsageBytes)}</div>
                      </div>
                    </div>
                    <div className="flex items-center gap-3 p-2.5 rounded-lg bg-zinc-900/60 border border-zinc-800/80">
                      <Activity className="w-4 h-4 text-blue-400 shrink-0" />
                      <div>
                        <div className="text-[10px] uppercase text-zinc-500">Processes</div>
                        <div className="font-semibold text-zinc-200 tabular-nums">{metrics.pidsCurrent} / {metrics.pidsLimit} PIDs</div>
                      </div>
                    </div>
                    <div className="flex items-center gap-3 p-2.5 rounded-lg bg-zinc-900/60 border border-zinc-800/80">
                      <Wifi className="w-4 h-4 text-amber-400 shrink-0" />
                      <div>
                        <div className="text-[10px] uppercase text-zinc-500">Uptime / Net I/O</div>
                        <div className="font-semibold text-zinc-200 tabular-nums">{formatUptime(metrics.uptimeSeconds)} • ↓{formatBytes(metrics.networkRxBytes)}</div>
                      </div>
                    </div>
                  </div>
                )}
                {metrics && metrics.status === "static" && (
                  <div className="flex items-center justify-between px-4 py-2.5 rounded-xl border border-zinc-800/80 bg-zinc-950/40 text-xs font-mono text-zinc-400">
                    <span className="flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full bg-emerald-400"></span>
                      Static Asset Edge Host
                    </span>
                    <span className="text-zinc-500">Zero Idle Memory & CPU Footprint</span>
                  </div>
                )}

                {/* xterm.js Terminal with Persisted History Replay */}
                <Terminal
                  deploymentId={activeDeployment.id}
                  onStatusChange={(status) => {
                    setDeployments((prev) =>
                      prev.map((d) => (d.id === activeDeployment.id ? { ...d, status } : d))
                    );
                  }}
                />
              </>
            ) : (
              <div className="border border-zinc-800/80 rounded-xl p-12 text-center text-zinc-500 font-mono text-sm bg-zinc-900/20">
                Select a deployment from the history or trigger a new build above.
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}