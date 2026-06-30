import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { discoverDomainModules } from "../server/modules/routerLoader";

async function withTempModules<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), "soma-router-loader-"));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeModule(root: string, dir: string, source: string) {
  const moduleDir = path.join(root, dir);
  await mkdir(moduleDir, { recursive: true });
  await writeFile(path.join(moduleDir, "index.ts"), source, "utf8");
}

describe("domain router loader", () => {
  it("mounts modules deterministically by module name", async () => {
    await withTempModules(async (root) => {
      await writeModule(root, "zeta", `import { Router } from "express"; export const moduleDefinition = { name: "zeta", basePath: "/z", router: Router() };`);
      await writeModule(root, "alpha", `import { Router } from "express"; export const moduleDefinition = { name: "alpha", basePath: "/a", router: Router() };`);

      const modules = await discoverDomainModules({ rootDir: root, useStaticFallback: false });

      expect(modules.map((module) => module.name)).toEqual(["alpha", "zeta"]);
    });
  });

  it("fails clearly for malformed modules", async () => {
    await withTempModules(async (root) => {
      await writeModule(root, "broken", `export const moduleDefinition = { name: "broken" };`);

      await expect(discoverDomainModules({ rootDir: root, useStaticFallback: false }))
        .rejects.toThrow(/Malformed domain module 'broken'.*export either \{ name, basePath, router \} or \{ name, register \}/);
    });
  });

  it("rejects duplicate module names", async () => {
    await withTempModules(async (root) => {
      await writeModule(root, "one", `import { Router } from "express"; export const moduleDefinition = { name: "same", basePath: "/one", router: Router() };`);
      await writeModule(root, "two", `import { Router } from "express"; export const moduleDefinition = { name: "same", basePath: "/two", router: Router() };`);

      await expect(discoverDomainModules({ rootDir: root, useStaticFallback: false }))
        .rejects.toThrow("Duplicate domain module name 'same'.");
    });
  });
});
