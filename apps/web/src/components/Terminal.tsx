"use client";

import { useEffect, useRef } from "react";
import { Terminal as XTerminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
const WS_URL = API_URL.replace(/^http/, "ws");

interface TerminalProps {
  deploymentId: string;
  onStatusChange?: (status: "QUEUED" | "BUILDING" | "READY" | "FAILED") => void;
}

export default function Terminal({ deploymentId, onStatusChange }: TerminalProps) {
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
        background: "#0d1117",
        foreground: "#c9d1d9",
        cursor: "#58a6ff",
        selectionBackground: "#3b4252",
        black: "#484f58",
        red: "#ff7b72",
        green: "#3fb950",
        yellow: "#d29922",
        blue: "#58a6ff",
        magenta: "#bc8cff",
        cyan: "#39c5cf",
        white: "#b1bac4",
      },
      fontSize: 13,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      cursorBlink: true,
      convertEol: true,
      disableStdin: true,
      rows: 16,
    });

    term.open(terminalRef.current);
    term.writeln(`\x1b[36m[STRATUS]\x1b[0m Loading log buffer for \x1b[33m${deploymentId}\x1b[0m...`);

    let isSubscribed = true;
    let ws: WebSocket | null = null;

    // 1. Fetch persisted logs from SQLite first (Instant Log Replay)
    fetch(`${API_URL}/api/deployments/${deploymentId}/logs`)
      .then((res) => (res.ok ? res.json() : { logs: [] }))
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
        ws = new WebSocket(`${WS_URL}/logs?deploymentId=${deploymentId}`);

        ws.onopen = () => {
          term.writeln("\x1b[32m[CONNECTED]\x1b[0m Live WebSocket stream connected to Redis Pub/Sub.\n");
          onStatusChangeRef.current?.("BUILDING");
        };

        ws.onmessage = (event) => {
          const message = event.data as string;
          term.write(message.replace(/\n/g, "\r\n"));

          if (message.includes("[STATUS] READY")) {
            onStatusChangeRef.current?.("READY");
          } else if (message.includes("[STATUS] FAILED")) {
            onStatusChangeRef.current?.("FAILED");
          }
        };

        ws.onerror = () => {
          term.writeln(`\x1b[90m[NOTE] Live stream closed or inactive (viewing static log history).\x1b[0m`);
        };

        ws.onclose = () => {
          term.writeln("\x1b[90m[DISCONNECTED] Live log stream closed.\x1b[0m");
        };
      })
      .catch((err) => {
        console.error("Failed to fetch historical logs:", err);
      });

    return () => {
      isSubscribed = false;
      if (ws) ws.close();
      term.dispose();
    };
  }, [deploymentId]); // พึ่งพาเฉพาะ deploymentId ตัวเดียวเท่านั้น

  return (
    <div className="w-full rounded-xl overflow-hidden border border-zinc-800 bg-[#0d1117] shadow-2xl">
      <div className="flex items-center justify-between px-4 py-2.5 bg-zinc-900/90 border-b border-zinc-800 text-xs text-zinc-400 font-mono">
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded-full bg-zinc-700"></div>
          <div className="w-3 h-3 rounded-full bg-zinc-700"></div>
          <div className="w-3 h-3 rounded-full bg-zinc-700"></div>
          <span className="ml-2 text-zinc-300">build-terminal :: {deploymentId}</span>
        </div>
        <span className="text-zinc-500">xterm.js engine</span>
      </div>
      <div ref={terminalRef} className="p-3" />
    </div>
  );
}