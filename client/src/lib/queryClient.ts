import { QueryClient, QueryFunction } from "@tanstack/react-query";

export class ApiRequestError extends Error {
  code?: string;
  requestId?: string;
  details?: unknown;
  status: number;

  constructor(message: string, options: { status: number; code?: string; requestId?: string; details?: unknown }) {
    super(message);
    this.name = "ApiRequestError";
    this.status = options.status;
    this.code = options.code;
    this.requestId = options.requestId;
    this.details = options.details;
  }
}

type StandardErrorEnvelope = {
  error?: {
    code?: unknown;
    message?: unknown;
    requestId?: unknown;
    details?: unknown;
  };
  message?: unknown;
};

function parseErrorEnvelope(json: StandardErrorEnvelope, status: number, fallbackMessage: string): ApiRequestError {
  const standardError = json?.error && typeof json.error === "object" ? json.error : undefined;
  if (standardError && typeof standardError.message === "string") {
    return new ApiRequestError(standardError.message, {
      status,
      code: typeof standardError.code === "string" ? standardError.code : undefined,
      requestId: typeof standardError.requestId === "string" ? standardError.requestId : undefined,
      details: standardError.details,
    });
  }

  // Backward-compatible fallback while any endpoint or proxy still returns
  // the previous `{ message }` shape during migration.
  if (typeof json?.message === "string") {
    return new ApiRequestError(json.message, { status });
  }

  return new ApiRequestError(fallbackMessage, { status });
}

async function throwIfResNotOk(res: Response) {
  if (!res.ok) {
    const text = (await res.text()) || res.statusText;
    try {
      const json = JSON.parse(text) as StandardErrorEnvelope;
      throw parseErrorEnvelope(json, res.status, res.statusText);
    } catch (e) {
      if (e instanceof ApiRequestError) throw e;
    }
    throw new ApiRequestError(text || res.statusText, { status: res.status });
  }
}

export async function apiRequest(
  method: string,
  url: string,
  data?: unknown | undefined,
): Promise<Response> {
  const res = await fetch(url, {
    method,
    headers: data ? { "Content-Type": "application/json" } : {},
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
    const res = await fetch(queryKey.join("/") as string, {
      credentials: "include",
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
