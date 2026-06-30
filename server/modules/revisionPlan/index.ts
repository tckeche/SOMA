import type { DomainModuleDefinition } from "../routerTypes";
import { registerRevisionPlanRoutes } from "../../routes/revisionPlan";

export const moduleDefinition: DomainModuleDefinition = {
  name: "revisionPlan",
  register: registerRevisionPlanRoutes,
};
