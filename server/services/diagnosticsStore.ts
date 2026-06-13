export const diagnosticsCategories = [
  "client",
  "server",
  "database",
  "auth",
  "permission",
  "rate_limit",
  "integration",
  "performance",
] as const;

export type DiagnosticsCategory = (typeof diagnosticsCategories)[number];
export type DiagnosticsSeverity = "debug" | "info" | "warn" | "error" | "critical";

export interface DiagnosticsEvent {
  id: string;
  timestamp: string;
  severity: DiagnosticsSeverity;
  category: DiagnosticsCategory;
  route: string;
  method: string;
  statusCode?: number;
  durationMs?: number;
  requestId?: string;
  user?: {
    id?: string;
    role?: string;
  };
  error?: {
    name?: string;
    message?: string;
  };
  likelyRootCause?: string;
  metadata?: Record<string, unknown>;
}

const DEFAULT_CAPACITY = 500;
const capacity = Math.max(50, Number(process.env.DIAGNOSTICS_BUFFER_SIZE) || DEFAULT_CAPACITY);
const events: DiagnosticsEvent[] = [];
let sequence = 0;

function safeUser(user: any): DiagnosticsEvent["user"] | undefined {
  const id = typeof user?.id === "string" || typeof user?.id === "number" ? String(user.id) : undefined;
  const role = typeof user?.role === "string" ? user.role : undefined;
  if (!id && !role) return undefined;
  return { id, role };
}

export function inferCategory(input: {
  path?: string;
  statusCode?: number;
  error?: any;
  durationMs?: number;
}): DiagnosticsCategory {
  const message = String(input.error?.message ?? "").toLowerCase();
  const code = String(input.error?.code ?? "").toLowerCase();
  const path = String(input.path ?? "").toLowerCase();

  if (input.statusCode === 401 || message.includes("authentication") || message.includes("token")) return "auth";
  if (input.statusCode === 403 || message.includes("permission") || message.includes("access denied")) return "permission";
  if (input.statusCode === 429 || message.includes("rate limit")) return "rate_limit";
  if (path.includes("supabase") || path.includes("integration") || code.includes("api")) return "integration";
  if (code.includes("db") || code.includes("sql") || message.includes("database") || message.includes("connection") || message.includes("relation")) return "database";
  if ((input.durationMs ?? 0) > 2000) return "performance";
  return "server";
}

export function inferSeverity(statusCode?: number, durationMs?: number): DiagnosticsSeverity {
  if ((statusCode ?? 0) >= 500) return "error";
  if ((statusCode ?? 0) >= 400) return "warn";
  if ((durationMs ?? 0) > 2000) return "warn";
  return "info";
}

export function inferLikelyRootCause(input: { statusCode?: number; error?: any; durationMs?: number }): string | undefined {
  const message = String(input.error?.message ?? "").toLowerCase();
  if (input.statusCode === 401) return "Missing, invalid, or expired authentication credentials.";
  if (input.statusCode === 403) return "Authenticated user does not have the required role or permission.";
  if (input.statusCode === 404) return "Route or resource was not found.";
  if (input.statusCode === 429) return "Client exceeded a configured rate limit.";
  if (message.includes("database") || message.includes("connection") || message.includes("relation")) return "Database query, schema, or connectivity issue.";
  if ((input.durationMs ?? 0) > 2000) return "Request exceeded expected latency threshold.";
  if ((input.statusCode ?? 0) >= 500) return "Unhandled server exception or upstream dependency failure.";
  return undefined;
}

export function recordDiagnosticsEvent(event: Omit<DiagnosticsEvent, "id" | "timestamp"> & { id?: string; timestamp?: string }): DiagnosticsEvent {
  const full: DiagnosticsEvent = {
    id: event.id ?? `${Date.now()}-${++sequence}`,
    timestamp: event.timestamp ?? new Date().toISOString(),
    ...event,
  };
  events.push(full);
  if (events.length > capacity) events.splice(0, events.length - capacity);
  return full;
}

export function recordRequestDiagnostics(req: any, statusCode: number, durationMs: number, error?: any): DiagnosticsEvent | undefined {
  const path = req.originalUrl || req.path || "unknown";
  if (!String(path).startsWith("/api")) return undefined;

  const requestId = typeof req.headers?.["x-request-id"] === "string" ? req.headers["x-request-id"] : undefined;
  const user = safeUser(req.authUser) ?? safeUser(req.adminUser) ?? safeUser(req.tutorUser);
  const severity = inferSeverity(statusCode, durationMs);
  const category = inferCategory({ path, statusCode, error, durationMs });

  return recordDiagnosticsEvent({
    severity,
    category,
    route: path,
    method: req.method || "UNKNOWN",
    statusCode,
    durationMs,
    requestId,
    user,
    error: error ? { name: error.name || "Error", message: error.message || String(error) } : undefined,
    likelyRootCause: inferLikelyRootCause({ statusCode, error, durationMs }),
  });
}

export function getRecentDiagnostics(options: { limit?: number; severity?: DiagnosticsSeverity; category?: DiagnosticsCategory } = {}): DiagnosticsEvent[] {
  const limit = Math.max(1, Math.min(500, options.limit ?? 100));
  return events
    .filter((event) => !options.severity || event.severity === options.severity)
    .filter((event) => !options.category || event.category === options.category)
    .slice(-limit)
    .reverse();
}

export function getDiagnosticsSummary() {
  const now = Date.now();
  const lastHour = events.filter((event) => now - Date.parse(event.timestamp) <= 60 * 60 * 1000);
  const bySeverity = Object.fromEntries(["debug", "info", "warn", "error", "critical"].map((severity) => [severity, 0]));
  const byCategory = Object.fromEntries(diagnosticsCategories.map((category) => [category, 0]));
  let slowest: DiagnosticsEvent | null = null;

  for (const event of lastHour) {
    bySeverity[event.severity] = (bySeverity[event.severity] ?? 0) + 1;
    byCategory[event.category] = (byCategory[event.category] ?? 0) + 1;
    if ((event.durationMs ?? 0) > (slowest?.durationMs ?? 0)) slowest = event;
  }

  return {
    bufferSize: events.length,
    capacity,
    lastHour: {
      total: lastHour.length,
      bySeverity,
      byCategory,
      errorCount: lastHour.filter((event) => event.severity === "error" || event.severity === "critical").length,
      warningCount: lastHour.filter((event) => event.severity === "warn").length,
      slowestRequest: slowest,
    },
    generatedAt: new Date().toISOString(),
  };
}
