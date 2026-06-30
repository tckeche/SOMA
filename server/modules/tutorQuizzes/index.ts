import type { DomainModuleDefinition } from "../routerTypes";
import { router } from "./routes";
export const moduleDefinition: DomainModuleDefinition = { name: "tutorQuizzes", basePath: "/api/tutor/quizzes", router };
