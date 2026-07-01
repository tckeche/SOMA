/**
 * STATIC MANIFEST ⇄ FILESYSTEM PARITY (drift guard)
 *
 * The router loader discovers domain modules two ways:
 *   - dev / tests: filesystem scan of server/modules (any subdir with index.ts)
 *   - production (bundled): the hardcoded server/modules/staticManifest.ts
 *
 * If a new module is added on disk but NOT added to the static manifest, it
 * loads fine locally (filesystem discovery) yet silently 404s in production —
 * the classic "passes in dev, breaks live" drift. These tests assert the two
 * sources describe exactly the same set of modules, so that drift fails CI.
 *
 * A "domain module" is a server/modules subdirectory containing an index.ts
 * that exports `moduleDefinition` (mirrors routerLoader.discoverModuleFiles).
 * Service-only helper dirs (e.g. fileStorageAccess, questionValidation) have no
 * index.ts and are intentionally excluded from both sides.
 */
import { describe, it, expect, vi } from "vitest";
import { readdirSync, existsSync } from "node:fs";
import path from "node:path";

vi.mock("../server/db", () => ({ db: null }));

import { staticDomainModules } from "../server/modules/staticManifest";
import { discoverDomainModules } from "../server/modules/routerLoader";

const MODULES_DIR = path.resolve(process.cwd(), "server/modules");

// Mirror routerLoader.isCandidateDirectory so this test counts exactly what the
// loader would discover (e.g. it ignores dirs whose names don't start with a
// letter, and *.test / tests dirs).
const MODULE_DIRECTORY_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;
function isCandidateDir(name: string): boolean {
  return MODULE_DIRECTORY_PATTERN.test(name) && !name.endsWith(".test") && name !== "tests";
}

function filesystemModuleDirs(): string[] {
  return readdirSync(MODULES_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && isCandidateDir(e.name) && existsSync(path.join(MODULES_DIR, e.name, "index.ts")))
    .map((e) => e.name)
    .sort();
}

describe("staticManifest ⇄ filesystem parity", () => {
  it("registers every filesystem-discovered domain module in the static manifest (prod == dev)", async () => {
    // Filesystem discovery is what dev/tests use; the manifest is what prod uses.
    const discovered = (await discoverDomainModules({ useStaticFallback: false }))
      .map((m) => m.name)
      .sort();
    const manifest = staticDomainModules.map((m) => m.name).sort();

    // Explicit diffs so a failure names the offending module and the fix.
    const missingFromManifest = discovered.filter((n) => !manifest.includes(n));
    const staleInManifest = manifest.filter((n) => !discovered.includes(n));

    expect({ missingFromManifest, staleInManifest }).toEqual({
      missingFromManifest: [],
      staleInManifest: [],
    });
  });

  it("has exactly one manifest entry per index.ts module directory", () => {
    const dirs = filesystemModuleDirs();
    expect(staticDomainModules.length).toBe(dirs.length);
  });

  it("contains no duplicate module names in the manifest", () => {
    const names = staticDomainModules.map((m) => m.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
