"use client";

import { useEffect, useRef } from "react";
import { Terminal as XTerminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { API_URL, apiFetch, logStreamUrl } from "@/lib/api";

interface TerminalProps {
  deploymentId: string;
  onStatusChange?: (status: "QUEUED" | "BUILDING" | "READY" | "FAILED") => void;
}

export default function Terminal({
  deploymentId,
  onStatusChange,
}: TerminalProps) {
  const terminalRef = useRef<HTMLDivElement>(null);

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
        background: "#152038",
        foreground: "#cbd6e9",
        cursor: "#58a6ff",
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
      cursorBlink: true,
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
    term.writeln(
      `\x1b[36m[STRATUS]\x1b[0m Loading log buffer for \x1b[33m${deploymentId}\x1b[0m...`,
    );

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

        if (data.logs && data.logs.length > 0) {
          term.writeln("\x1b[90m--- PERSISTED LOG REPLAY START ---\x1b[0m");
          for (const line of data.logs) {
            term.write(line.endsWith("\n") ? line : line + "\r\n");
          }
          term.writeln("\x1b[90m--- PERSISTED LOG REPLAY END ---\x1b[0m\n");
        }

        // 2. Connect to live WebSocket stream
        ws = new WebSocket(logStreamUrl(deploymentId));

        ws.onopen = () => {
          term.writeln(
            "\x1b[32m[CONNECTED]\x1b[0m Live WebSocket stream connected to Redis Pub/Sub.\n",
          );
        };

        ws.onmessage = (event) => {
          const message = event.data as string;
          const output = /^\[(INFO|STATUS|LOGS|ERROR)\]/.test(message) && !message.endsWith("\n") ? message + "\n" : message;
          term.write(output.replace(/\r?\n/g, "\r\n"));

          if (message.includes("[STATUS] READY")) {
            onStatusChangeRef.current?.("READY");
          } else if (message.includes("[STATUS] FAILED")) {
            onStatusChangeRef.current?.("FAILED");
          }
        };

        ws.onerror = () => {
          term.writeln(
            `\x1b[90m[NOTE] Live stream closed or inactive (viewing static log history).\x1b[0m`,
          );
        };

        ws.onclose = () => {
          term.writeln("\x1b[90m[DISCONNECTED] Live log stream closed.\x1b[0m");
        };
      })
      .catch((err) => {
        if (isSubscribed)
          term.writeln(
            `\r\n[STRATUS] ${err instanceof Error ? err.message : "Logs unavailable"}`,
          );
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
          <span className="terminal-dot" /> Build logs
        </span>
        <code>{deploymentId}</code>
      </header>
      <div ref={terminalRef} className="terminal-content" />
    </section>
  );
}
