/**
 * ROUTER LOADER — PRODUCTION MANIFEST PATH (regression pin)
 *
 * In the bundled production build (`NODE_ENV=production node dist/index.cjs`),
 * the repo's server/modules TypeScript source indexes can still sit under
 * process.cwd() (e.g. Replit deployments copy the source tree alongside dist).
 * Plain Node cannot import those TypeScript sources, so filesystem discovery
 * would abort route registration with ERR_MODULE_NOT_FOUND and the server would
 * never listen. discoverDomainModules() must therefore use the compiled-in
 * static manifest — and NOT scan the filesystem — when running in production.
 *
 * These tests mock readdir() to throw, so any attempt at filesystem discovery
 * is observable: production must succeed (manifest), non-production must attempt
 * discovery (and here hit the mocked throw).
 */
import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../server/db", () => ({ db: null }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readdir: () => {
      throw new Error("FS_DISCOVERY_CALLED");
    },
  };
});

import { discoverDomainModules } from "../server/modules/routerLoader";

const prevNodeEnv = process.env.NODE_ENV;

describe("router loader production manifest path", () => {
  afterEach(() => {
    process.env.NODE_ENV = prevNodeEnv;
  });

  it("uses the static manifest in production without scanning the filesystem", async () => {
    process.env.NODE_ENV = "production";
    const modules = await discoverDomainModules();
    const names = modules.map((m) => m.name);
    expect(names).toContain("authAccount");
    expect(names).toContain("pdfSubmissions");
    expect(names.length).toBeGreaterThanOrEqual(20);
  });

  it("attempts filesystem discovery when not in production (guard sanity)", async () => {
    process.env.NODE_ENV = "development";
    await expect(discoverDomainModules()).rejects.toThrow("FS_DISCOVERY_CALLED");
  });

  it("honours an explicit rootDir even in production (loader tests keep discovery)", async () => {
    process.env.NODE_ENV = "production";
    await expect(discoverDomainModules({ rootDir: "server/modules" })).rejects.toThrow("FS_DISCOVERY_CALLED");
  });
});
