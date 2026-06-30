import type { DomainModuleDefinition } from "./routerTypes";
import { moduleDefinition as cohortHeatmap } from "./cohortHeatmap";
import { moduleDefinition as commandWords } from "./commandWords";
import { moduleDefinition as examinerInsightsReview } from "./examinerInsightsReview";
import { moduleDefinition as markLossPredictor } from "./markLossPredictor";
import { moduleDefinition as masteryMap } from "./masteryMap";
import { moduleDefinition as pdfAiMarking } from "./pdfAiMarking";
import { moduleDefinition as revisionPlan } from "./revisionPlan";
import { moduleDefinition as superAdminAiUsage } from "./superAdminAiUsage";
import { moduleDefinition as superAdminDiagnostics } from "./superAdminDiagnostics";
import { moduleDefinition as tutorExaminerInsights } from "./tutorExaminerInsights";

export const staticDomainModules: DomainModuleDefinition[] = [
  cohortHeatmap,
  commandWords,
  examinerInsightsReview,
  markLossPredictor,
  masteryMap,
  pdfAiMarking,
  revisionPlan,
  superAdminAiUsage,
  superAdminDiagnostics,
  tutorExaminerInsights,
];
