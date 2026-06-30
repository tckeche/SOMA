import type { DomainModuleDefinition } from "../routerTypes";
import { router } from "./routes";
export const moduleDefinition: DomainModuleDefinition = { name: "tutorNotifications", basePath: "/api/tutor/notifications", router };
