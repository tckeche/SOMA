import type { DomainModuleDefinition } from "../routerTypes";
import { router } from "./routes";
export const moduleDefinition: DomainModuleDefinition = { name: "studentSubjects", basePath: "/api/tutor/students/:studentId/subjects", router };
