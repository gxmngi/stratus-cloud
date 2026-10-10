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
  RotateCw
} from "lucide-react";

// โหลด Terminal แบบ dynamic ปิด SSR เพราะ xterm ต้องรันบน Client Browser
const Terminal = dynamic(() => import("@/components/Terminal"), { ssr: false });

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

interface DeploymentItem {
  id: string;
  project_id?: string | null;
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
  const [activeDeploymentId, setActiveDeploymentId] = useState<string | null>(null);
  const [deployments, setDeployments] = useState<DeploymentItem[]>([]);
  const [isLoadingHistory, setIsLoadingHistory] = useState(true);
  const [showEnv, setShowEnv] = useState(false);
  const [envVars, setEnvVars] = useState<Array<{ key: string; value: string }>>([
    { key: "", value: "" },
  ]);

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
                      <div className="flex items-center gap-2.5">
                        <h3 className="font-mono text-sm font-semibold text-white">
                          {activeDeployment.id}
                        </h3>
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
                      <p className="text-xs text-zinc-400 mt-1 font-mono">
                        Subdomain: {activeDeployment.id}.localhost:8000
                      </p>
                    </div>
                  </div>

                  <div>
                    {activeDeployment.status === "READY" ? (
                      <a
                        href={activeDeployment.live_url}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-2 bg-emerald-500 hover:bg-emerald-400 text-black px-4 py-2 rounded-lg text-xs font-semibold tracking-wide transition-colors"
                      >
                        <span>VISIT LIVE APP</span>
                        <ExternalLink className="w-3.5 h-3.5" />
                      </a>
                    ) : (
                      <span className="text-xs text-zinc-500 font-mono">
                        Compiling in Docker Sandbox...
                      </span>
                    )}
                  </div>
                </div>

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