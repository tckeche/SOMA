/**
 * Behavioral guard for the shared-fetcher auth hardening.
 *
 * The "Failed to load quiz" bug was a bare fetch() to an auth-gated route with
 * no Supabase Bearer token. To make that class impossible to reintroduce, the
 * two shared fetchers (apiRequest + the default getQueryFn) attach the token
 * automatically. These tests assert the Authorization header is actually
 * present on the outgoing request — not just that the source mentions it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/supabase", () => ({
  getAuthHeaders: vi.fn(async () => ({ Authorization: "Bearer test-token-123" })),
}));

import { apiRequest, getQueryFn } from "@/lib/queryClient";

function jsonResponse() {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("queryClient shared fetchers attach the Supabase bearer token", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("apiRequest sends the Authorization header", async () => {
    const fetchMock = vi.fn(async () => jsonResponse());
    vi.stubGlobal("fetch", fetchMock);

    await apiRequest("POST", "/api/anything", { a: 1 });

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer test-token-123");
  });

  it("the default getQueryFn sends the Authorization header", async () => {
    const fetchMock = vi.fn(async () => jsonResponse());
    vi.stubGlobal("fetch", fetchMock);

    const fn = getQueryFn({ on401: "throw" });
    await fn({ queryKey: ["/api/anything"] } as any);

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer test-token-123");
  });
});
