import { QueryClient, QueryFunction } from "@tanstack/react-query";

const REQUEST_ID_STORAGE_KEY = "math-quiz-hub-request-id";

export function getOrCreateRequestId(): string {
  const stored = typeof sessionStorage !== "undefined" ? sessionStorage.getItem(REQUEST_ID_STORAGE_KEY) : null;
  if (stored) return stored;

  const requestId = typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

  if (typeof sessionStorage !== "undefined") sessionStorage.setItem(REQUEST_ID_STORAGE_KEY, requestId);
  return requestId;
}

function shortRequestId(requestId?: string | null): string | null {
  if (!requestId) return null;
  return requestId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 6).toUpperCase() || null;
}

function messageWithSupportCode(message: string, requestId?: string | null): string {
  const code = shortRequestId(requestId);
  return code ? `${message} If this keeps happening, contact support with code ${code}.` : message;
}

export class ApiRequestError extends Error {
  requestId?: string;

  constructor(message: string, requestId?: string | null) {
    super(messageWithSupportCode(message, requestId));
    this.name = "ApiRequestError";
    this.requestId = requestId ?? undefined;
  }
}

/**
 * Best-effort Supabase Bearer header for the shared fetchers below.
 *
 * Loaded via dynamic import to avoid a static circular dependency
 * (supabase.ts imports getOrCreateRequestId from this module). If the session
 * lookup fails for any reason we degrade to no auth header — identical to the
 * pre-hardening behaviour — so a telemetry hiccup can never break a request.
 *
 * This is what stops the "bare fetch to an auth-gated route -> 401" class of
 * bug: every request made through apiRequest / the default query fetcher now
 * carries the token automatically, exactly like authFetch.
 */
async function authHeader(): Promise<Record<string, string>> {
  try {
    const { getAuthHeaders } = await import("./supabase");
    return await getAuthHeaders();
  } catch {
    return {};
  }
}

async function throwIfResNotOk(res: Response) {
  if (!res.ok) {
    const text = (await res.text()) || res.statusText;
    const responseRequestId = res.headers.get("x-request-id");
    // Try to extract a user-friendly message from JSON responses
    try {
      const json = JSON.parse(text);
      if (json?.error?.message) {
        throw new ApiRequestError(json.error.message, json.error.requestId || responseRequestId);
      }
      if (json.message) {
        throw new ApiRequestError(json.message, json.requestId || responseRequestId);
      }
    } catch (e) {
      if (e instanceof ApiRequestError) throw e;
    }
    throw new ApiRequestError(text || res.statusText, responseRequestId);
  }
}

export async function apiRequest(
  method: string,
  url: string,
  data?: unknown | undefined,
): Promise<Response> {
  const requestId = getOrCreateRequestId();
  const headers = new Headers(data ? { "Content-Type": "application/json" } : {});
  headers.set("x-request-id", requestId);
  for (const [k, v] of Object.entries(await authHeader())) headers.set(k, v);

  const res = await fetch(url, {
    method,
    headers,
    body: data ? JSON.stringify(data) : undefined,
    credentials: "include",
  });

  await throwIfResNotOk(res);
  return res;
}

type UnauthorizedBehavior = "returnNull" | "throw";
export const getQueryFn: <T>(options: {
  on401: UnauthorizedBehavior;
}) => QueryFunction<T> =
  ({ on401: unauthorizedBehavior }) =>
  async ({ queryKey }) => {
    const requestId = getOrCreateRequestId();
    const headers = new Headers();
    headers.set("x-request-id", requestId);
    for (const [k, v] of Object.entries(await authHeader())) headers.set(k, v);

    const res = await fetch(queryKey.join("/") as string, {
      credentials: "include",
      headers,
    });

    if (unauthorizedBehavior === "returnNull" && res.status === 401) {
      return null;
    }

    await throwIfResNotOk(res);
    return await res.json();
  };

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "throw" }),
      refetchInterval: false,
      refetchOnWindowFocus: false,
      staleTime: 1000 * 60 * 5,
      retry: 3,
      retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 30_000),
    },
    mutations: {
      retry: 1,
      retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 10_000),
    },
  },
});
