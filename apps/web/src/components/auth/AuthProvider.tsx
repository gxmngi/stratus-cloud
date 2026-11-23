"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { ApiError, authApi, advanceSessionEpoch, type AuthUser } from "@/lib/api";

type SessionStatus = "loading" | "authenticated" | "anonymous" | "error";
interface SessionContext {
  user: AuthUser | null;
  status: SessionStatus;
  refresh: () => Promise<void>;
  acceptUser: (user: AuthUser) => void;
  signOut: () => Promise<void>;
}
const AuthContext = createContext<SessionContext | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [status, setStatus] = useState<SessionStatus>("loading");
  const generation = useRef(0);
  const channel = useRef<BroadcastChannel | null>(null);
  const invalidate = useCallback(() => { generation.current++; }, []);

  const clearSession = useCallback(() => {
    advanceSessionEpoch();
    generation.current++;
    setUser(null);
    setStatus("anonymous");
  }, []);
  const refresh = useCallback(async () => {
    const current = ++generation.current;
    try {
      const response = await authApi.me();
      if (generation.current !== current) return;
      setUser(response.user);
      setStatus("authenticated");
    } catch (error) {
      if (generation.current !== current) return;
      if (error instanceof ApiError && error.status === 401) clearSession();
      else setStatus(previous => previous === "authenticated" ? previous : "error");
    }
  }, [clearSession]);
  const acceptUser = useCallback((nextUser: AuthUser) => {
    advanceSessionEpoch();
    generation.current++;
    setUser(nextUser);
    setStatus("authenticated");
    channel.current?.postMessage("refresh");
  }, []);
  const signOut = useCallback(async () => {
    await authApi.logout();
    clearSession();
    channel.current?.postMessage("logout");
  }, [clearSession]);

  useEffect(() => {
    if (status !== "authenticated") return;
    const timer = window.setInterval(() => void refresh(), 60000);
    return () => window.clearInterval(timer);
  }, [refresh, status]);

  useEffect(() => {
    const startup = window.setTimeout(() => void refresh(), 0);
    const expired = () => clearSession();
    const visible = () => { if (document.visibilityState === "visible") void refresh(); };
    window.addEventListener("stratus:session-expired", expired);
    document.addEventListener("visibilitychange", visible);
    if (typeof BroadcastChannel !== "undefined") {
      const connection = new BroadcastChannel("stratus-session");
      channel.current = connection;
      connection.onmessage = event => {
        if (event.data === "logout") clearSession();
        if (event.data === "refresh") void refresh();
      };
    }
    return () => {
      window.clearTimeout(startup);
      invalidate();
      window.removeEventListener("stratus:session-expired", expired);
      document.removeEventListener("visibilitychange", visible);
      channel.current?.close();
      channel.current = null;
    };
  }, [clearSession, invalidate, refresh]);

  return <AuthContext.Provider value={{ user, status, refresh, acceptUser, signOut }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const session = useContext(AuthContext);
  if (!session) throw new Error("useAuth requires AuthProvider");
  return session;
}
