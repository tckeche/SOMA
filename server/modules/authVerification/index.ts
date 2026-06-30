import type { DomainModuleDefinition } from "../routerTypes";
import { router } from "./routes";
export const moduleDefinition: DomainModuleDefinition = { name: "authVerification", basePath: "/api/auth", router };
