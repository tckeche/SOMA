import type { DomainModuleDefinition } from "../routerTypes";
import { router } from "./routes";
export const moduleDefinition: DomainModuleDefinition = { name: "quizDrafts", basePath: "/api/tutor/quizzes", router };
