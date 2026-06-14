/**
 * Supabase Storage service — PDF uploads foundation.
 *
 * Mirrors how the rest of the server talks to Supabase (see
 * server/routes.ts:2132 — the email-verification admin flow): we read
 * `VITE_SUPABASE_URL` (fallback `SUPABASE_URL`) + `SUPABASE_SERVICE_ROLE_KEY`
 * from the environment and call the REST API via `fetch` with the
 * `{ apikey, Authorization: Bearer }` headers. We deliberately do NOT add
 * the `@supabase/supabase-js` dependency.
 *
 * Every function is safe to import in tests: nothing touches the network or
 * throws on missing config at module load. All network calls funnel through
 * `storageFetch` so they're easy to mock by stubbing global `fetch`.
 */
import { logWarn } from "../utils/logging";

export const UPLOAD_BUCKET = "soma-uploads";
export const MAX_PDF_BYTES = 20 * 1024 * 1024; // 20 MB
export const PDF_MIME = "application/pdf";

/** Typed error thrown when a Supabase Storage call fails. */
export class FileStorageError extends Error {
  readonly status: number;
  readonly responseBody: string;
  constructor(message: string, status: number, responseBody: string) {
    super(message);
    this.name = "FileStorageError";
    this.status = status;
    this.responseBody = responseBody;
  }
}

/** Resolve the Supabase project URL, mirroring routes.ts (VITE_ first). */
function getSupabaseUrl(): string | undefined {
  return process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || undefined;
}

function getServiceRoleKey(): string | undefined {
  return process.env.SUPABASE_SERVICE_ROLE_KEY || undefined;
}

/** True iff both the project URL and the service-role key are present. */
export function isStorageConfigured(): boolean {
  return Boolean(getSupabaseUrl() && getServiceRoleKey());
}

type StorageConfig = { url: string; serviceRole: string };

function requireConfig(action: string): StorageConfig {
  const url = getSupabaseUrl();
  const serviceRole = getServiceRoleKey();
  if (!url || !serviceRole) {
    throw new FileStorageError(
      `Supabase Storage is not configured (${action}): set VITE_SUPABASE_URL/SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.`,
      0,
      "",
    );
  }
  return { url, serviceRole };
}

/**
 * Single choke point for all Supabase Storage network calls so tests can
 * mock `fetch` once. Returns the raw Response; callers decide how to read it.
 */
async function storageFetch(
  config: StorageConfig,
  pathname: string,
  init: { method: string; headers?: Record<string, string>; body?: BodyInit },
): Promise<Response> {
  return fetch(`${config.url}/storage/v1${pathname}`, {
    method: init.method,
    headers: {
      apikey: config.serviceRole,
      Authorization: `Bearer ${config.serviceRole}`,
      ...(init.headers ?? {}),
    },
    body: init.body,
  });
}

/**
 * Idempotently create the private upload bucket. No-ops (with a warning) when
 * storage is unconfigured — must NOT throw on missing config so server boot
 * can call it unconditionally. Treats 409 / "already exists" as success.
 */
export async function ensureUploadBucket(): Promise<void> {
  if (!isStorageConfigured()) {
    logWarn("file_storage_bucket_skip_unconfigured", {
      module: "fileStorage",
      bucket: UPLOAD_BUCKET,
    });
    return;
  }
  const config = requireConfig("ensureUploadBucket");
  const resp = await storageFetch(config, "/bucket", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: UPLOAD_BUCKET, name: UPLOAD_BUCKET, public: false }),
  });
  if (resp.ok || resp.status === 409) return;
  const text = await resp.text();
  if (/already exists/i.test(text)) return;
  throw new FileStorageError(
    `Failed to create upload bucket (HTTP ${resp.status})`,
    resp.status,
    text,
  );
}

/** Upload a PDF buffer to `path` within the bucket (upsert). */
export async function uploadPdf(path: string, data: Buffer): Promise<void> {
  const config = requireConfig("uploadPdf");
  const resp = await storageFetch(config, `/object/${UPLOAD_BUCKET}/${path}`, {
    method: "POST",
    headers: { "Content-Type": PDF_MIME, "x-upsert": "true" },
    body: data as unknown as BodyInit,
  });
  if (resp.ok) return;
  const text = await resp.text();
  throw new FileStorageError(
    `Failed to upload PDF to ${path} (HTTP ${resp.status})`,
    resp.status,
    text,
  );
}

/**
 * Create a short-lived signed download URL for an object. The API returns a
 * relative `signedURL` path; we return the absolute URL.
 */
export async function createSignedDownloadUrl(
  path: string,
  expiresInSec = 300,
  downloadName?: string,
): Promise<string> {
  const config = requireConfig("createSignedDownloadUrl");
  const resp = await storageFetch(config, `/object/sign/${UPLOAD_BUCKET}/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expiresIn: expiresInSec }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new FileStorageError(
      `Failed to sign download URL for ${path} (HTTP ${resp.status})`,
      resp.status,
      text,
    );
  }
  const json = (await resp.json()) as { signedURL?: string };
  if (!json?.signedURL) {
    throw new FileStorageError(
      `Sign response missing signedURL for ${path}`,
      resp.status,
      JSON.stringify(json),
    );
  }
  // The signed URL already carries a `?token=...` query, so a download-filename
  // override (sets Content-Disposition so the browser saves the original name
  // instead of the opaque storage key) is appended with `&`.
  const suffix = downloadName ? `&download=${encodeURIComponent(downloadName)}` : "";
  return `${config.url}/storage/v1${json.signedURL}${suffix}`;
}

/** Delete an object from the bucket. 404 (already gone) is ignored. */
export async function deleteObject(path: string): Promise<void> {
  const config = requireConfig("deleteObject");
  const resp = await storageFetch(config, `/object/${UPLOAD_BUCKET}/${path}`, {
    method: "DELETE",
  });
  if (resp.ok || resp.status === 404) return;
  const text = await resp.text();
  throw new FileStorageError(
    `Failed to delete object ${path} (HTTP ${resp.status})`,
    resp.status,
    text,
  );
}
