type Severity = "critical" | "high" | "medium" | "low";
type LogLevel = "info" | "warn" | "error" | "security";

type LogContext = Record<string, unknown> & {
  severity?: Severity;
  route?: string;
  method?: string;
  requestId?: string;
  userId?: string | number | null;
  role?: string | null;
  module?: string;
  component?: string;
};

const SENSITIVE_KEY_PATTERNS = [
  /password/i,
  /token/i,
  /authorization/i,
  /cookie/i,
  /secret/i,
  /api[-_]?key/i,
  /private[-_]?key/i,
  /card/i,
  /cvv/i,
  /cvc/i,
  /payment/i,
  /billing/i,
  /iban/i,
  /account[-_]?number/i,
  /routing[-_]?number/i,
];

const REDACTED = "[REDACTED]";

function getAppVersion(): string {
  return (
    process.env.APP_VERSION ||
    process.env.npm_package_version ||
    process.env.RENDER_GIT_COMMIT ||
    process.env.VERCEL_GIT_COMMIT_SHA ||
    process.env.GIT_COMMIT ||
    process.env.COMMIT_SHA ||
    "unknown"
  );
}

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

export function redactSensitive(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return value;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return serializeError(value);
  if (seen.has(value)) return "[Circular]";

  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redactSensitive(item, seen));
  }

  return Object.entries(value as Record<string, unknown>).reduce<Record<string, unknown>>((acc, [key, entry]) => {
    acc[key] = isSensitiveKey(key) ? REDACTED : redactSensitive(entry, seen);
    return acc;
  }, {});
}

function serializeError(error: unknown): Record<string, unknown> | undefined {
  if (!error) return undefined;
  if (error instanceof Error) {
    return redactSensitive({
      name: error.name,
      message: error.message,
      stack: error.stack,
    }) as Record<string, unknown>;
  }
  if (typeof error === "object") {
    return redactSensitive(error) as Record<string, unknown>;
  }
  return { message: String(error) };
}

function writeLog(level: LogLevel, event: string, context: LogContext = {}, error?: unknown) {
  const redactedContext = redactSensitive(context) as LogContext;
  const entry = {
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || "development",
    appVersion: getAppVersion(),
    level,
    event,
    severity: redactedContext.severity || (level === "error" ? "high" : level === "warn" ? "medium" : "low"),
    route: redactedContext.route,
    method: redactedContext.method,
    requestId: redactedContext.requestId,
    userId: redactedContext.userId,
    role: redactedContext.role,
    module: redactedContext.module,
    component: redactedContext.component,
    context: redactedContext,
    error: serializeError(error),
  };

  const line = JSON.stringify(entry);
  if (level === "error" || level === "security") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export function logInfo(event: string, context: LogContext = {}) {
  writeLog("info", event, context);
}

export function logWarn(event: string, context: LogContext = {}) {
  writeLog("warn", event, context);
}

export function logError(event: string, error?: unknown, context: LogContext = {}) {
  writeLog("error", event, context, error);
}

export function logSecurity(event: string, context: LogContext = {}) {
  writeLog("security", event, { severity: "high", ...context });
}

export function requestLogContext(req: { method?: string; path?: string; originalUrl?: string; headers?: Record<string, unknown> } & Record<string, any>): LogContext {
  const authUser = req.authUser || req.tutorUser || req.adminUser;
  return {
    route: req.path || req.originalUrl,
    method: req.method,
    requestId: String(req.headers?.["x-request-id"] || req.headers?.["x-correlation-id"] || ""),
    userId: authUser?.id || req.tutorId || req.adminId,
    role: authUser?.role,
  };
}

export function log(message: string, source = "express") {
  logInfo(message, { module: source });
}
