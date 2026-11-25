const loopback = typeof window !== "undefined" && window.location.protocol === "http:" &&
  ["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname);
export const API_URL = (process.env.NEXT_PUBLIC_API_URL || (loopback ? "http://localhost:4000" : "")).replace(/\/$/, "");
let sessionEpoch = 0;
export function advanceSessionEpoch() { sessionEpoch++; }

export interface AuthUser {
  id: string;
  email: string;
  created_at: number;
}

export class ApiError extends Error {
  constructor(public readonly status: number, message: string, public readonly retryAfter: string | null = null) {
    super(message);
    this.name = "ApiError";
  }
}

// Browser-only transport. HttpOnly session tokens never enter application state.
export async function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const requestEpoch = sessionEpoch;
  const response = await fetch(input, { ...init, credentials: "include", signal: init?.signal ?? AbortSignal.timeout(15000) });
  const url = input instanceof Request ? input.url : String(input);
  if (response.status === 401 && requestEpoch === sessionEpoch && typeof window !== "undefined" &&
      !new URL(url, window.location.origin).pathname.startsWith("/api/auth/")) {
    window.dispatchEvent(new Event("stratus:session-expired"));
  }
  return response;
}

async function authRequest<T>(route: string, body?: { email: string; password: string }): Promise<T> {
  const response = await apiFetch(`${API_URL}/api/auth/${route}`, {
    method: route === "me" ? "GET" : "POST",
    ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new ApiError(response.status, payload.error || "Request failed", response.headers.get("retry-after"));
  }
  return response.status === 204 ? undefined as T : response.json();
}

export const authApi = {
  register: (email: string, password: string) => authRequest<{ user: AuthUser }>("register", { email, password }),
  login: (email: string, password: string) => authRequest<{ user: AuthUser }>("login", { email, password }),
  me: () => authRequest<{ user: AuthUser }>("me"),
  logout: () => authRequest<void>("logout"),
};

export function logStreamUrl(deploymentId: string): string {
  const url = new URL(`${API_URL}/api/logs`, window.location.origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("deploymentId", deploymentId);
  return url.href;
}
