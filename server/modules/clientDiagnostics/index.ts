import type { DomainModuleDefinition } from "../routerTypes";
import { router } from "./routes";
export const moduleDefinition: DomainModuleDefinition = { name: "clientDiagnostics", basePath: "/api/diagnostics", router };
