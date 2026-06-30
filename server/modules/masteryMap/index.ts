import type { DomainModuleDefinition } from "../routerTypes";
import { registerMasteryMapRoutes } from "../../routes/masteryMap";

export const moduleDefinition: DomainModuleDefinition = {
  name: "masteryMap",
  register: registerMasteryMapRoutes,
};
