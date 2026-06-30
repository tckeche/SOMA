import type { Express, Router } from "express";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { log } from "../utils/logging";
import { staticDomainModules } from "./staticManifest";
import { isRouterDomainModule, type DomainModuleDefinition } from "./routerTypes";

const MODULE_EXPORT_NAME = "moduleDefinition";

function moduleRoot(): string {
  return path.resolve(process.cwd(), "server/modules");
}

function isCandidateDirectory(entryName: string): boolean {
  return !entryName.startsWith(".") && !entryName.endsWith(".test") && entryName !== "tests";
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
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !isCandidateDirectory(entry.name)) continue;
    const moduleDir = path.join(root, entry.name);
    const indexTs = path.join(moduleDir, "index.ts");
    const indexJs = path.join(moduleDir, "index.js");
    if (existsSync(indexTs)) files.push(indexTs);
    else if (existsSync(indexJs)) files.push(indexJs);
  }
  return files.sort((a, b) => a.localeCompare(b));
}

function validateNoDuplicates(modules: DomainModuleDefinition[]): void {
  const names = new Set<string>();
  const basePaths = new Map<string, string>();
  for (const mod of modules) {
    if (mod.enabled === false) continue;
    if (names.has(mod.name)) throw new Error(`Duplicate domain module name '${mod.name}'.`);
    names.add(mod.name);
    if (isRouterDomainModule(mod)) {
      const prior = basePaths.get(mod.basePath);
      if (prior) throw new Error(`Duplicate domain module basePath '${mod.basePath}' used by '${prior}' and '${mod.name}'.`);
      basePaths.set(mod.basePath, mod.name);
    }
  }
}

export async function discoverDomainModules(options: { rootDir?: string; useStaticFallback?: boolean } = {}): Promise<DomainModuleDefinition[]> {
  const root = options.rootDir ?? moduleRoot();
  const useStaticFallback = options.useStaticFallback ?? true;
  const files = await discoverModuleFiles(root);

  let modules: DomainModuleDefinition[] = [];
  if (files.length > 0) {
    modules = await Promise.all(files.map(async (file) => {
      const imported = await import(pathToFileURL(file).href);
      return validateModuleDefinition(imported[MODULE_EXPORT_NAME], file);
    }));
  } else if (useStaticFallback) {
    modules = staticDomainModules.map((mod, index) => validateModuleDefinition(mod, `staticManifest[${index}]`));
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
