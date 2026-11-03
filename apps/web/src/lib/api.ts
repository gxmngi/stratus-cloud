export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000").replace(/\/$/, "");

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
export function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return fetch(input, { ...init, credentials: "include" });
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
  return `${API_URL.replace(/^http/, "ws")}/api/logs?deploymentId=${encodeURIComponent(deploymentId)}`;
}
