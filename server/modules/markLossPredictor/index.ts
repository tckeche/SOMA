import type { DomainModuleDefinition } from "../routerTypes";
import { registerMarkLossPredictorRoutes } from "../../routes/markLossPredictor";

export const moduleDefinition: DomainModuleDefinition = {
  name: "markLossPredictor",
  register: registerMarkLossPredictorRoutes,
};
