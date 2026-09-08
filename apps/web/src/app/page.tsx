"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import { 
  ExternalLink, 
  Play, 
  CheckCircle2, 
  AlertCircle, 
  Loader2, 
  Layers 
} from "lucide-react";

// โหลด Terminal แบบ dynamic ปิด SSR เพราะ xterm ต้องรันบน Client Browser
const Terminal = dynamic(() => import("@/components/Terminal"), { ssr: false });

interface DeploymentState {
  deploymentId: string;
  status: "QUEUED" | "BUILDING" | "READY" | "FAILED";
  liveUrl: string;
}

export default function Home() {
  const [gitUrl, setGitUrl] = useState("fixtures/demo-app");
  const [isDeploying, setIsDeploying] = useState(false);
  const [deployment, setDeployment] = useState<DeploymentState | null>(null);

  const handleDeploy = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!gitUrl.trim() || isDeploying) return;

    setIsDeploying(true);
    setDeployment(null);

    try {
      const response = await fetch("http://localhost:4000/api/deploy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gitUrl }),
      });

      if (!response.ok) {
        throw new Error(`Deployment failed with status: ${response.status}`);
      }

      const data = await response.json();
      setDeployment({
        deploymentId: data.deploymentId,
        status: "QUEUED",
        liveUrl: data.liveUrl,
      });
    } catch (err) {
      console.error(err);
      alert("Failed to connect to API server at http://localhost:4000");
    } finally {
      setIsDeploying(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-[#ededed] font-sans antialiased">
      {/* Header Bar */}
      <header className="border-b border-zinc-800 bg-[#0d0d0d]">
        <div className="max-w-5xl mx-auto px-6 h-16 flex items-center justify-between">
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
      <main className="max-w-5xl mx-auto px-6 py-12">
        <div className="max-w-2xl mb-10">
          <h1 className="text-3xl font-semibold tracking-tight text-white mb-2">
            Deploy your web application
          </h1>
          <p className="text-sm text-zinc-400 leading-relaxed">
            Stratus provisions isolated Docker sandboxes, streams real-time compilation logs via Redis Pub/Sub, and assigns instant custom subdomain routing on the Go edge proxy.
          </p>
        </div>

        {/* Input Form Card */}
        <div className="border border-zinc-800 bg-zinc-900/40 rounded-xl p-6 shadow-xl mb-8">
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
                className="text-zinc-400 hover:text-white underline decoration-zinc-700 underline-offset-2"
              >
                Local Demo App (fixtures/demo-app)
              </button>
            </div>
          </form>
        </div>

        {/* Active Deployment Card */}
        {deployment && (
          <div className="space-y-6">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-5 rounded-xl border border-zinc-800 bg-zinc-900/60">
              <div className="flex items-center gap-4">
                <div className="w-10 h-10 rounded-lg border border-zinc-700 bg-black flex items-center justify-center">
                  <Layers className="w-5 h-5 text-zinc-300" />
                </div>
                <div>
                  <div className="flex items-center gap-2.5">
                    <h3 className="font-mono text-sm font-semibold text-white">
                      {deployment.deploymentId}
                    </h3>
                    {deployment.status === "QUEUED" && (
                      <span className="px-2 py-0.5 rounded text-[11px] font-mono bg-yellow-500/10 text-yellow-400 border border-yellow-500/20">
                        QUEUED
                      </span>
                    )}
                    {deployment.status === "BUILDING" && (
                      <span className="px-2 py-0.5 rounded text-[11px] font-mono bg-blue-500/10 text-blue-400 border border-blue-500/20 animate-pulse">
                        BUILDING
                      </span>
                    )}
                    {deployment.status === "READY" && (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-mono bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                        <CheckCircle2 className="w-3 h-3" /> READY
                      </span>
                    )}
                    {deployment.status === "FAILED" && (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-mono bg-red-500/10 text-red-400 border border-red-500/20">
                        <AlertCircle className="w-3 h-3" /> FAILED
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-zinc-400 mt-1 font-mono">
                    Subdomain: {deployment.deploymentId}.localhost:8000
                  </p>
                </div>
              </div>

              <div>
                {deployment.status === "READY" ? (
                  <a
                    href={deployment.liveUrl}
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

            {/* xterm.js Terminal */}
            <Terminal
              deploymentId={deployment.deploymentId}
              onStatusChange={(status) => {
                setDeployment((prev) => (prev ? { ...prev, status } : null));
              }}
            />
          </div>
        )}
      </main>
    </div>
  );
}