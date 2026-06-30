import type { DomainModuleDefinition } from "./routerTypes";
import { moduleDefinition as authAccount } from "./authAccount";
import { moduleDefinition as authVerification } from "./authVerification";
import { moduleDefinition as clientDiagnostics } from "./clientDiagnostics";
import { moduleDefinition as graphRendering } from "./graphRendering";
import { moduleDefinition as flaggedQuestions } from "./flaggedQuestions";
import { moduleDefinition as quizAssignments } from "./quizAssignments";
import { moduleDefinition as quizDrafts } from "./quizDrafts";
import { moduleDefinition as quizPublish } from "./quizPublish";
import { moduleDefinition as tutorDashboard } from "./tutorDashboard";
import { moduleDefinition as tutorQuizzes } from "./tutorQuizzes";
import { moduleDefinition as tutorReports } from "./tutorReports";
import { moduleDefinition as cohortHeatmap } from "./cohortHeatmap";
import { moduleDefinition as commandWords } from "./commandWords";
import { moduleDefinition as examinerInsightsReview } from "./examinerInsightsReview";
import { moduleDefinition as markLossPredictor } from "./markLossPredictor";
import { moduleDefinition as masteryMap } from "./masteryMap";
import { moduleDefinition as pdfAiMarking } from "./pdfAiMarking";
import { moduleDefinition as pdfAttachments } from "./pdfAttachments";
import { moduleDefinition as pdfSubmissions } from "./pdfSubmissions";
import { moduleDefinition as revisionPlan } from "./revisionPlan";
import { moduleDefinition as superAdminAiUsage } from "./superAdminAiUsage";
import { moduleDefinition as superAdminDiagnostics } from "./superAdminDiagnostics";
import { moduleDefinition as tutorExaminerInsights } from "./tutorExaminerInsights";
import { moduleDefinition as studentSubjects } from "./studentSubjects";
import { moduleDefinition as syllabusCatalogue } from "./syllabusCatalogue";
import { moduleDefinition as tutorNotifications } from "./tutorNotifications";
import { moduleDefinition as tutorStudentComments } from "./tutorStudentComments";

export const staticDomainModules: DomainModuleDefinition[] = [
  authAccount,
  authVerification,
  cohortHeatmap,
  clientDiagnostics,
  commandWords,
  examinerInsightsReview,
  flaggedQuestions,
  graphRendering,
  markLossPredictor,
  masteryMap,
  pdfAiMarking,
  pdfAttachments,
  pdfSubmissions,
  quizAssignments,
  quizDrafts,
  quizPublish,
  revisionPlan,
  studentSubjects,
  superAdminAiUsage,
  superAdminDiagnostics,
  syllabusCatalogue,
  tutorDashboard,
  tutorExaminerInsights,
  tutorNotifications,
  tutorQuizzes,
  tutorReports,
  tutorStudentComments,
];
