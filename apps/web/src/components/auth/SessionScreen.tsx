"use client";

import { Loader2, RefreshCw } from "lucide-react";
import { useAuth } from "./AuthProvider";
import { useState } from "react";

export function SessionScreen() {
  const { status, refresh } = useAuth();
  const [retrying, setRetrying] = useState(false);
  async function retry() {
    if (retrying) return;
    setRetrying(true);
    try { await refresh(); } finally { setRetrying(false); }
  }
  return (
    <main className="session-screen">
      <div className="session-symbol" aria-hidden="true">S</div>
      {status === "error" ? <>
        <h1>We couldn’t connect.</h1>
        <p>Your workspace is taking a moment. Check your connection and try again.</p>
        <button type="button" onClick={() => void retry()} disabled={retrying}><RefreshCw size={16} aria-hidden="true" />{retrying ? "Connecting…" : "Try again"}</button>
      </> : <p role="status"><Loader2 size={18} className="auth-spin" aria-hidden="true" /> Connecting to your workspace…</p>}
    </main>
  );
}
