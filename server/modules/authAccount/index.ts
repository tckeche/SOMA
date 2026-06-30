import type { DomainModuleDefinition } from "../routerTypes";
import { router } from "./routes";

export const moduleDefinition: DomainModuleDefinition = { name: "authAccount", basePath: "/api/auth", router };
