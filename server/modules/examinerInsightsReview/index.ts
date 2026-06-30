import type { DomainModuleDefinition } from "../routerTypes";
import { registerExaminerInsightsReviewRoutes } from "../../routes/examinerInsightsReview";

export const moduleDefinition: DomainModuleDefinition = {
  name: "examinerInsightsReview",
  register: registerExaminerInsightsReviewRoutes,
};
