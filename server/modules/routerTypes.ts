import type { Express, Router } from "express";

export interface RouterDomainModule {
  name: string;
  basePath: string;
  router: Router;
  enabled?: boolean;
}

export interface RegisterDomainModule {
  name: string;
  register: (app: Express) => void | Promise<void>;
  enabled?: boolean;
}

export type DomainModuleDefinition = RouterDomainModule | RegisterDomainModule;

export function isRouterDomainModule(module: DomainModuleDefinition): module is RouterDomainModule {
  return "router" in module && "basePath" in module;
}
