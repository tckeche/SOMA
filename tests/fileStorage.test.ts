/**
 * FILE STORAGE SERVICE TESTS
 *
 * Exercises the Supabase Storage REST wrapper in
 * `server/services/fileStorage.ts` by mocking the global `fetch`. We verify:
 *   - ensureUploadBucket treats 409 as success and no-ops when unconfigured
 *   - uploadPdf posts to the correct URL with auth + content-type, throws on 500
 *   - createSignedDownloadUrl returns the absolute URL from `{ signedURL }`
 *   - unconfigured createSignedDownloadUrl throws
 *
 * `fetch` and the Supabase env vars are saved/restored around every test so
 * nothing leaks between cases or out to other suites.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  ensureUploadBucket,
  uploadPdf,
  createSignedDownloadUrl,
  isStorageConfigured,
  UPLOAD_BUCKET,
  PDF_MIME,
} from "../server/services/fileStorage";

const URL_BASE = "https://proj.supabase.co";
const SERVICE_ROLE = "service-role-key";

const originalFetch = global.fetch;
const originalEnv = {
  VITE_SUPABASE_URL: process.env.VITE_SUPABASE_URL,
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
};

function configure() {
  process.env.VITE_SUPABASE_URL = URL_BASE;
  process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_ROLE;
  delete process.env.SUPABASE_URL;
}

function unconfigure() {
  delete process.env.VITE_SUPABASE_URL;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
}

function mockResponse(init: { ok: boolean; status: number; text?: string; json?: any }): Response {
  return {
    ok: init.ok,
    status: init.status,
    text: async () => init.text ?? "",
    json: async () => init.json ?? {},
  } as unknown as Response;
}

beforeEach(() => {
  configure();
});

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
  // Restore env exactly as it was.
  for (const [k, v] of Object.entries(originalEnv)) {
    if (v === undefined) delete (process.env as any)[k];
    else (process.env as any)[k] = v;
  }
});

describe("isStorageConfigured", () => {
  it("is true when both url and service role are set", () => {
    expect(isStorageConfigured()).toBe(true);
  });
  it("is false when unconfigured", () => {
    unconfigure();
    expect(isStorageConfigured()).toBe(false);
  });
});

describe("ensureUploadBucket", () => {
  it("treats HTTP 409 as success (no throw)", async () => {
    global.fetch = vi.fn(async () => mockResponse({ ok: false, status: 409, text: "Bucket already exists" })) as any;
    await expect(ensureUploadBucket()).resolves.toBeUndefined();
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("posts to the bucket endpoint with the private bucket body", async () => {
    const spy = vi.fn(async () => mockResponse({ ok: true, status: 200 }));
    global.fetch = spy as any;
    await ensureUploadBucket();
    const [url, init] = spy.mock.calls[0];
    expect(url).toBe(`${URL_BASE}/storage/v1/bucket`);
    expect(init.method).toBe("POST");
    expect(init.headers.apikey).toBe(SERVICE_ROLE);
    expect(init.headers.Authorization).toBe(`Bearer ${SERVICE_ROLE}`);
    expect(JSON.parse(init.body)).toEqual({ id: UPLOAD_BUCKET, name: UPLOAD_BUCKET, public: false });
  });

  it("no-ops (does not call fetch or throw) when unconfigured", async () => {
    unconfigure();
    const spy = vi.fn();
    global.fetch = spy as any;
    await expect(ensureUploadBucket()).resolves.toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("uploadPdf", () => {
  it("posts to the object endpoint with auth, content-type and upsert", async () => {
    const spy = vi.fn(async () => mockResponse({ ok: true, status: 200 }));
    global.fetch = spy as any;
    const buf = Buffer.from("%PDF-1.4 test");
    await uploadPdf("quiz/42/file.pdf", buf);
    const [url, init] = spy.mock.calls[0];
    expect(url).toBe(`${URL_BASE}/storage/v1/object/${UPLOAD_BUCKET}/quiz/42/file.pdf`);
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe(PDF_MIME);
    expect(init.headers["x-upsert"]).toBe("true");
    expect(init.headers.apikey).toBe(SERVICE_ROLE);
    expect(init.body).toBe(buf);
  });

  it("throws on a non-2xx (500) response including status", async () => {
    global.fetch = vi.fn(async () => mockResponse({ ok: false, status: 500, text: "boom" })) as any;
    await expect(uploadPdf("p.pdf", Buffer.from("x"))).rejects.toMatchObject({ status: 500 });
  });
});

describe("createSignedDownloadUrl", () => {
  it("returns the absolute URL built from the relative signedURL path", async () => {
    global.fetch = vi.fn(async () =>
      mockResponse({ ok: true, status: 200, json: { signedURL: "/object/sign/soma-uploads/p.pdf?token=abc" } }),
    ) as any;
    const url = await createSignedDownloadUrl("p.pdf");
    expect(url).toBe(`${URL_BASE}/storage/v1/object/sign/soma-uploads/p.pdf?token=abc`);
  });

  it("throws when unconfigured", async () => {
    unconfigure();
    await expect(createSignedDownloadUrl("p.pdf")).rejects.toThrow();
  });
});
