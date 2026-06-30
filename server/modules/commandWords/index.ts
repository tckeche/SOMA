import type { DomainModuleDefinition } from "../routerTypes";
import { registerCommandWordsRoutes } from "../../routes/commandWords";

export const moduleDefinition: DomainModuleDefinition = {
  name: "commandWords",
  register: registerCommandWordsRoutes,
};
