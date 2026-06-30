import type { DomainModuleDefinition } from "../routerTypes";
import { registerTutorExaminerInsightsRoutes } from "../../routes/tutorExaminerInsights";

export const moduleDefinition: DomainModuleDefinition = {
  name: "tutorExaminerInsights",
  register: registerTutorExaminerInsightsRoutes,
};
