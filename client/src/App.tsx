import { Switch, Route } from "wouter";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import Landing from "@/pages/landing";

import BuilderPage from "@/pages/builder";
import SomaQuizEngine from "@/pages/soma-quiz";
import SomaQuizReview from "@/pages/SomaQuizReview";
import StudentAuth from "@/pages/StudentAuth";
import StudentDashboard from "@/pages/StudentDashboard";
import TutorDashboard from "@/pages/TutorDashboard";
import TutorStudents from "@/pages/TutorStudents";
import TutorStudentDetail from "@/pages/TutorStudentDetail";
import TutorAssessments from "@/pages/TutorAssessments";
import TutorAssessmentDetails from "@/pages/TutorAssessmentDetails";
import SuperAdminDashboard from "@/pages/SuperAdminDashboard";
import SomaChatPage from "@/pages/soma-chat";
import ForgotPassword from "@/pages/ForgotPassword";
import ResetPassword from "@/pages/ResetPassword";
import ProtectedRoute from "@/components/ProtectedRoute";
import RoleRouter from "@/components/RoleRouter";
import { ErrorBoundary } from "@/components/error-boundary";
import { Redirect } from "wouter";
import ThemeToggle from "@/components/ThemeToggle";

function Router() {
  return (
    <Switch>
      <Route path="/" component={Landing} />
      <Route path="/login" component={StudentAuth} />
      <Route path="/forgot-password" component={ForgotPassword} />
      <Route path="/reset-password" component={ResetPassword} />
      <Route path="/portal">{() => <RoleRouter studentComponent={StudentDashboard} tutorComponent={TutorDashboard} />}</Route>
      <Route path="/super-admin">{() => <ProtectedRoute component={SuperAdminDashboard} />}</Route>
      <Route path="/tutor">{() => <ProtectedRoute component={TutorDashboard} />}</Route>
      <Route path="/tutor/assessment/:quizId">{(params) => <ProtectedRoute component={TutorAssessmentDetails} params={params} />}</Route>
      <Route path="/tutor/students/:id">{(params) => <ProtectedRoute component={TutorStudentDetail} params={params} />}</Route>
      <Route path="/tutor/students">{() => <ProtectedRoute component={TutorStudents} />}</Route>
      <Route path="/tutor/assessments/edit/:id">{(params) => <ProtectedRoute component={BuilderPage} params={params} />}</Route>
      <Route path="/tutor/assessments/new">{() => <ProtectedRoute component={BuilderPage} />}</Route>
      <Route path="/tutor/assessments">{() => <ProtectedRoute component={TutorAssessments} />}</Route>
      <Route path="/admin/:rest*">{() => <Redirect to="/login" />}</Route>
      <Route path="/admin">{() => <Redirect to="/login" />}</Route>
      <Route path="/soma/quiz/:id">{(params) => <ProtectedRoute component={SomaQuizEngine} params={params} />}</Route>
      <Route path="/soma/review/:reportId">{(params) => <ProtectedRoute component={SomaQuizReview} params={params} />}</Route>
      <Route path="/soma/chat">{() => <ProtectedRoute component={SomaChatPage} />}</Route>
      <Route path="/dashboard">{() => <RoleRouter studentComponent={StudentDashboard} tutorComponent={TutorDashboard} />}</Route>
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <TooltipProvider>
      <Toaster />
      <ThemeToggle />
      <ErrorBoundary title="Application error"><Router /></ErrorBoundary>
    </TooltipProvider>
  );
}

export default App;
