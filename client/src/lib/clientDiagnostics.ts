import { getAuthHeaders, supabase, withTimeout } from "@/lib/supabase";

const CLIENT_ERROR_ENDPOINT = "/api/diagnostics/client-error";
const REDACTED = "[redacted]";
const MAX_FIELD_LENGTH = 2_000;
const SECRET_QUERY_KEYS = /(?:token|access_token|refresh_token|id_token|code|secret|password|pass|key|apikey|api_key|session|cookie|auth|jwt|signature|sig)/i;
const SECRET_TEXT_PATTERNS: RegExp[] = [
  /Bearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /([?&](?:token|access_token|refresh_token|id_token|code|secret|password|pass|key|apikey|api_key|session|auth|jwt|signature|sig)=)[^\s&#]+/gi,
  /((?:token|access_token|refresh_token|id_token|secret|password|cookie|authorization|apikey|api_key|jwt)["'\s:=]+)[^"'\s,;}]+/gi,
  /https?:\/\/[^\s)"']+/gi,
];

type ErrorLike = {
  name?: string;
  message?: string;
  stack?: string;
};

export type ClientErrorReportInput = {
  error: unknown;
  componentStack?: string | null;
  boundaryTitle?: string;
  requestId?: string;
};

export type ClientErrorReportPayload = {
  timestamp: string;
  route: string;
  boundaryTitle: string;
  error: {
    name: string;
    message: string;
    stack?: string;
    componentStack?: string;
  };
  user?: {
    id?: string;
    role?: string;
  };
  requestId: string;
};

function truncate(value: string): string {
  return value.length > MAX_FIELD_LENGTH ? `${value.slice(0, MAX_FIELD_LENGTH)}…` : value;
}

export function createClientErrorId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `client-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function getActiveClientRequestId(): string | undefined {
  const globalRequestId = (window as typeof window & {
    __REQUEST_ID__?: unknown;
    __ACTIVE_REQUEST_ID__?: unknown;
  }).__ACTIVE_REQUEST_ID__ ?? (window as typeof window & { __REQUEST_ID__?: unknown }).__REQUEST_ID__;

  return typeof globalRequestId === "string" && globalRequestId.trim() ? globalRequestId.trim() : undefined;
}

function sanitizeUrl(url: string): string {
  try {
    const parsed = new URL(url, window.location.origin);
    for (const key of Array.from(parsed.searchParams.keys())) {
      if (SECRET_QUERY_KEYS.test(key)) {
        parsed.searchParams.set(key, REDACTED);
      }
    }
    parsed.hash = "";
    return parsed.pathname + parsed.search;
  } catch {
    return REDACTED;
  }
}

export function redactClientDiagnosticValue(value: unknown): string | undefined {
  if (value == null) return undefined;

  let text = typeof value === "string" ? value : String(value);
  text = text.replace(SECRET_TEXT_PATTERNS[0], `Bearer ${REDACTED}`);
  text = text.replace(SECRET_TEXT_PATTERNS[1], `$1${REDACTED}`);
  text = text.replace(SECRET_TEXT_PATTERNS[2], `$1${REDACTED}`);
  text = text.replace(SECRET_TEXT_PATTERNS[3], (match) => sanitizeUrl(match));

  return truncate(text);
}

function normalizeError(error: unknown): ErrorLike {
  if (error instanceof Error) {
    return {
      name: error.name || "Error",
      message: error.message || "Unknown client error",
      stack: error.stack,
    };
  }

  return {
    name: "NonErrorThrown",
    message: typeof error === "string" ? error : "A non-Error value was thrown",
  };
}

export async function sendClientErrorReport(input: ClientErrorReportInput): Promise<string> {
  const requestId = input.requestId || getActiveClientRequestId() || createClientErrorId();
  const normalized = normalizeError(input.error);
  const { data: { session } } = await supabase.auth.getSession();
  const role = session?.user?.app_metadata?.role ?? session?.user?.user_metadata?.role;

  const payload: ClientErrorReportPayload = {
    timestamp: new Date().toISOString(),
    route: sanitizeUrl(`${window.location.pathname}${window.location.search}`),
    boundaryTitle: redactClientDiagnosticValue(input.boundaryTitle) || "Application error",
    error: {
      name: redactClientDiagnosticValue(normalized.name) || "Error",
      message: redactClientDiagnosticValue(normalized.message) || "Unknown client error",
      stack: redactClientDiagnosticValue(normalized.stack),
      componentStack: redactClientDiagnosticValue(input.componentStack),
    },
    user: session?.user?.id ? {
      id: session.user.id,
      role: typeof role === "string" ? role : undefined,
    } : undefined,
    requestId,
  };

  const headers = await getAuthHeaders();
  await withTimeout((signal) => fetch(CLIENT_ERROR_ENDPOINT, {
    method: "POST",
    credentials: "include",
    signal,
    headers: {
      ...headers,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  }), { timeoutMs: 5_000, stage: "clientDiagnostics:client-error" });

  return requestId;
}
