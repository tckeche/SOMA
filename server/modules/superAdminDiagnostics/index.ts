import type { DomainModuleDefinition } from "../routerTypes";
import { registerSuperAdminDiagnosticsRoutes } from "../../routes/superAdminDiagnostics";

export const moduleDefinition: DomainModuleDefinition = {
  name: "superAdminDiagnostics",
  register: registerSuperAdminDiagnosticsRoutes,
};
