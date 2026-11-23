"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "./AuthProvider";
import { SessionScreen } from "./SessionScreen";

export function ProtectedWorkspace({ children }: { children: React.ReactNode }) {
  const { status } = useAuth();
  const router = useRouter();
  useEffect(() => {
    if (status === "anonymous") router.replace("/login");
  }, [router, status]);
  return status === "authenticated" ? children : <SessionScreen />;
}
