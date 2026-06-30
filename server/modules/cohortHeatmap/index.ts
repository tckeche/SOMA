import type { DomainModuleDefinition } from "../routerTypes";
import { registerCohortHeatmapRoutes } from "../../routes/cohortHeatmap";

export const moduleDefinition: DomainModuleDefinition = {
  name: "cohortHeatmap",
  register: registerCohortHeatmapRoutes,
};
