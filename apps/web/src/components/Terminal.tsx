"use client";

import { useEffect, useRef } from "react";
import { Terminal as XTerminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

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
    term.writeln(`\x1b[36m[STRATUS]\x1b[0m Connecting to log stream for \x1b[33m${deploymentId}\x1b[0m...`);

    const ws = new WebSocket(`ws://localhost:4000/logs?deploymentId=${deploymentId}`);

    ws.onopen = () => {
      term.writeln("\x1b[32m[CONNECTED]\x1b[0m WebSocket stream established with Redis Pub/Sub gateway.\n");
      onStatusChangeRef.current?.("BUILDING");
    };

    ws.onmessage = (event) => {
      const message = event.data as string;
      term.write(message);

      if (message.includes("[STATUS] READY")) {
        onStatusChangeRef.current?.("READY");
      } else if (message.includes("[STATUS] FAILED")) {
        onStatusChangeRef.current?.("FAILED");
      }
    };

    ws.onerror = () => {
      term.writeln("\x1b[31m[ERROR]\x1b[0m Failed to connect to WebSocket server at ws://localhost:4000/logs");
    };

    ws.onclose = () => {
      term.writeln("\n\x1b[90m[DISCONNECTED] Log stream closed.\x1b[0m");
    };

    return () => {
      ws.close();
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