import type { Express, Router } from "express";
import { existsSync } from "node:fs";
import { readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { log } from "../utils/logging";
import { staticDomainModules } from "./staticManifest";
import { isRouterDomainModule, type DomainModuleDefinition } from "./routerTypes";

const MODULE_EXPORT_NAME = "moduleDefinition";
const MODULE_DIRECTORY_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;

function moduleRoot(): string {
  return path.resolve(process.cwd(), "server/modules");
}

function isCandidateDirectory(entryName: string): boolean {
  return MODULE_DIRECTORY_PATTERN.test(entryName) && !entryName.endsWith(".test") && entryName !== "tests";
}

function assertPathInsideRoot(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing to load domain module outside module root: ${candidate}`);
  }
}

function validateModuleDefinition(value: unknown, source: string): DomainModuleDefinition {
  if (!value || typeof value !== "object") {
    throw new Error(`Malformed domain module at ${source}: expected exported ${MODULE_EXPORT_NAME} object.`);
  }

  const candidate = value as Partial<DomainModuleDefinition> & { router?: Router; basePath?: string; register?: unknown };
  if (typeof candidate.name !== "string" || candidate.name.trim().length === 0) {
    throw new Error(`Malformed domain module at ${source}: ${MODULE_EXPORT_NAME}.name must be a non-empty string.`);
  }

  if (candidate.enabled === false) return candidate as DomainModuleDefinition;

  const hasRouterContract = typeof candidate.basePath === "string" && candidate.basePath.startsWith("/") && candidate.router && typeof candidate.router === "function";
  const hasRegisterContract = typeof candidate.register === "function";

  if (!hasRouterContract && !hasRegisterContract) {
    throw new Error(`Malformed domain module '${candidate.name}' at ${source}: export either { name, basePath, router } or { name, register }.`);
  }

  return candidate as DomainModuleDefinition;
}

async function discoverModuleFiles(root: string): Promise<string[]> {
  if (!existsSync(root)) return [];
  const canonicalRoot = await realpath(root);
  const entries = await readdir(canonicalRoot, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !isCandidateDirectory(entry.name)) continue;
    const moduleDir = path.join(canonicalRoot, entry.name);
    const indexTs = path.join(moduleDir, "index.ts");
    const indexJs = path.join(moduleDir, "index.js");
    const selected = existsSync(indexTs) ? indexTs : existsSync(indexJs) ? indexJs : undefined;
    if (!selected) continue;
    const canonicalFile = await realpath(selected);
    assertPathInsideRoot(canonicalRoot, canonicalFile);
    files.push(canonicalFile);
  }
  return files.sort((a, b) => a.localeCompare(b));
}

function getRouterRouteSignatures(mod: DomainModuleDefinition): string[] {
  if (!isRouterDomainModule(mod)) return [];
  const stack = (mod.router as any).stack;
  if (!Array.isArray(stack)) return [];
  return stack
    .filter((layer) => layer?.route?.path)
    .flatMap((layer) => {
      const methods = Object.keys(layer.route.methods || {}).filter((method) => layer.route.methods[method]);
      return methods.map((method) => `${method.toUpperCase()} ${mod.basePath}${layer.route.path}`);
    });
}

function validateNoDuplicates(modules: DomainModuleDefinition[]): void {
  const names = new Set<string>();
  const routeSignatures = new Map<string, string>();
  for (const mod of modules) {
    if (mod.enabled === false) continue;
    if (names.has(mod.name)) throw new Error(`Duplicate domain module name '${mod.name}'.`);
    names.add(mod.name);
    for (const signature of getRouterRouteSignatures(mod)) {
      const prior = routeSignatures.get(signature);
      if (prior) throw new Error(`Duplicate domain route '${signature}' used by '${prior}' and '${mod.name}'.`);
      routeSignatures.set(signature, mod.name);
    }
  }
}

export async function discoverDomainModules(options: { rootDir?: string; useStaticFallback?: boolean } = {}): Promise<DomainModuleDefinition[]> {
  const root = path.resolve(options.rootDir ?? moduleRoot());
  const useStaticFallback = options.useStaticFallback ?? true;

  // In the bundled production build (`NODE_ENV=production node dist/index.cjs`)
  // the app is a single compiled CommonJS file, but the repo's
  // server/modules/*/index.ts sources can still sit under process.cwd() (e.g.
  // Replit deployments copy the source tree alongside dist). Plain Node cannot
  // import those TypeScript sources, so filesystem discovery would abort route
  // registration with ERR_MODULE_NOT_FOUND / ERR_UNKNOWN_FILE_EXTENSION and the
  // server would never listen. Every module is compiled into the bundle via the
  // static manifest, so prefer it in production and skip filesystem discovery
  // entirely. Dev (tsx) and tests can load .ts, so they keep live discovery.
  // An explicit rootDir (used by the loader's own tests) always uses discovery.
  const preferStaticManifest =
    useStaticFallback && options.rootDir === undefined && process.env.NODE_ENV === "production";

  let modules: DomainModuleDefinition[] = [];
  if (preferStaticManifest) {
    modules = staticDomainModules.map((mod, index) => validateModuleDefinition(mod, `staticManifest[${index}]`));
  } else {
    const files = await discoverModuleFiles(root);
    if (files.length > 0) {
      modules = await Promise.all(files.map(async (file) => {
        const imported = await import(pathToFileURL(file).href);
        return validateModuleDefinition(imported[MODULE_EXPORT_NAME], file);
      }));
    } else if (useStaticFallback) {
      modules = staticDomainModules.map((mod, index) => validateModuleDefinition(mod, `staticManifest[${index}]`));
    }
  }

  const enabledModules = modules.filter((mod) => mod.enabled !== false).sort((a, b) => a.name.localeCompare(b.name));
  validateNoDuplicates(enabledModules);
  return enabledModules;
}

export async function registerDomainModules(app: Express): Promise<void> {
  const modules = await discoverDomainModules();
  for (const mod of modules) {
    if (isRouterDomainModule(mod)) app.use(mod.basePath, mod.router);
    else await mod.register(app);
    if (process.env.NODE_ENV === "development") {
      log(`mounted domain module: ${mod.name}${isRouterDomainModule(mod) ? ` at ${mod.basePath}` : ""}`);
    }
  }
}
