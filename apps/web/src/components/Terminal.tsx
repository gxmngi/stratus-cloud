"use client";

import { useEffect, useRef, useState } from "react";
import { Terminal as XTerminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { API_URL, apiFetch, logStreamUrl } from "@/lib/api";

interface TerminalProps {
  deploymentId: string;
  building: boolean;
  onStatusChange?: (status: "QUEUED" | "BUILDING" | "READY" | "FAILED") => void;
}

export default function Terminal({
  deploymentId,
  building,
  onStatusChange,
}: TerminalProps) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const [history, setHistory] = useState<"loading" | "empty" | "saved" | "error">("loading");
  const [stream, setStream] = useState<"connecting" | "live" | "offline">("connecting");

  const status = building && stream === "live" ? "Live"
    : history === "loading" ? "Loading…"
    : building && stream === "offline" ? "Live stream unavailable"
    : history === "error" ? "Logs unavailable"
    : history === "empty" ? "No logs yet"
    : "Saved output";

  // ใช้ Ref เก็บ Callback เพื่อป้องกัน useEffect re-trigger เมื่อ Parent Component re-render
  const onStatusChangeRef = useRef(onStatusChange);
  useEffect(() => {
    onStatusChangeRef.current = onStatusChange;
  }, [onStatusChange]);

  useEffect(() => {
    if (!terminalRef.current) return;

    // เคลียร์เนื้อหาเดิมใน DOM Container ก่อนสร้าง Terminal
    terminalRef.current.innerHTML = "";

    const term = new XTerminal({
      theme: {
        background: "#0e1724",
        foreground: "#d7e4f1",
        cursor: "#9bd0f9",
        selectionBackground: "#3b4252",
        black: "#8798b5",
        brightBlack: "#97a6be",
        red: "#ff7b72",
        green: "#3fb950",
        yellow: "#d29922",
        blue: "#58a6ff",
        magenta: "#bc8cff",
        cyan: "#39c5cf",
        white: "#b1bac4",
      },
      minimumContrastRatio: 4.5,
      fontSize: 13,
      fontFamily:
        "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      cursorBlink: false,
      convertEol: true,
      disableStdin: true,
      rows: 12,
      cols: 80,
    });

    term.open(terminalRef.current);
    const resize = new ResizeObserver(() => {
      const width = terminalRef.current?.clientWidth || 0;
      if (width > 40)
        term.resize(Math.max(16, Math.floor((width - 32) / 7.85)), 12);
    });
    resize.observe(terminalRef.current);


    let isSubscribed = true;
    let ws: WebSocket | null = null;

    // 1. Fetch persisted logs from SQLite first (Instant Log Replay)
    apiFetch(`${API_URL}/api/deployments/${deploymentId}/logs`)
      .then((res) => {
        if (!res.ok)
          throw new Error(
            res.status === 401
              ? "Sign in to view deployment logs"
              : "Logs unavailable",
          );
        return res.json();
      })
      .then((data: { logs: string[] }) => {
        if (!isSubscribed) return;

        const logs = data.logs ?? [];
        setHistory(logs.length > 0 ? "saved" : "empty");
        for (const line of logs) {
          term.writeln(line.replace(/\r?\n$/, ""));
        }

        // 2. Connect to live WebSocket stream
        ws = new WebSocket(logStreamUrl(deploymentId));

        ws.onopen = () => { if (isSubscribed) setStream("live"); };

        ws.onmessage = (event) => {
          if (!isSubscribed) return;
          setHistory("saved");
          const message = event.data as string;
          const output = /^\[(INFO|STATUS|LOGS|ERROR)\]/.test(message) && !message.endsWith("\n") ? message + "\n" : message;
          term.write(output.replace(/\r?\n/g, "\r\n"));

          if (message.includes("[STATUS] READY")) {
            onStatusChangeRef.current?.("READY");
          } else if (message.includes("[STATUS] FAILED")) {
            onStatusChangeRef.current?.("FAILED");
          }
        };

        const disconnect = () => { if (isSubscribed) setStream("offline"); };
        ws.onerror = disconnect;
        ws.onclose = disconnect;
      })
      .catch((err) => {
        if (!isSubscribed) return;
        setHistory("error");
        setStream("offline");
        term.writeln(err instanceof Error ? err.message : "Logs unavailable");
      });

    return () => {
      isSubscribed = false;
      if (ws) ws.close();
      resize.disconnect();
      term.dispose();
    };
  }, [deploymentId]);

  return (
    <section className="build-terminal" aria-label="Build logs">
      <header>
        <span>
          <span className="terminal-dot" data-live={building && stream === "live"} aria-hidden="true" /> Build logs
        </span>
        <span className="terminal-status" role="status">{status}</span>
      </header>
      <div ref={terminalRef} className="terminal-content" />
    </section>
  );
}
