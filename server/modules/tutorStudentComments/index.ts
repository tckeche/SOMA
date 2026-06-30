import type { DomainModuleDefinition } from "../routerTypes";
import { router } from "./routes";
export const moduleDefinition: DomainModuleDefinition = { name: "tutorStudentComments", basePath: "/api/tutor/students/:studentId/comments", router };
