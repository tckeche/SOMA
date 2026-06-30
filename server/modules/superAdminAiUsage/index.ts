import type { DomainModuleDefinition } from "../routerTypes";
import { registerSuperAdminAiUsageRoutes } from "../../routes/superAdminAiUsage";

export const moduleDefinition: DomainModuleDefinition = {
  name: "superAdminAiUsage",
  register: registerSuperAdminAiUsageRoutes,
};
