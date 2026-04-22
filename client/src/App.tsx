import { Switch, Route, useLocation } from "wouter";
import { useEffect } from "react";
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
import SuperAdminTutorDetail from "@/pages/SuperAdminTutorDetail";
import SomaChatPage from "@/pages/soma-chat";
import ForgotPassword from "@/pages/ForgotPassword";
import ResetPassword from "@/pages/ResetPassword";
import ProtectedRoute from "@/components/ProtectedRoute";
import RoleRouter from "@/components/RoleRouter";
import { ErrorBoundary } from "@/components/error-boundary";
import { AIStatusLights } from "@/components/AIStatusLights";
import { Redirect } from "wouter";
import { supabase } from "@/lib/supabase";

function Router() {
  return (
    <Switch>
      <Route path="/" component={Landing} />
      <Route path="/login" component={StudentAuth} />
      <Route path="/forgot-password" component={ForgotPassword} />
      <Route path="/reset-password" component={ResetPassword} />
      <Route path="/portal">{() => <RoleRouter studentComponent={StudentDashboard} tutorComponent={TutorDashboard} />}</Route>
      {/* Student-facing dashboard at /student — complements /tutor.
          Wraps StudentDashboard in RoleRouter so a tutor hitting /student
          is redirected to their own dashboard (and vice versa). */}
      <Route path="/student">{() => <RoleRouter studentComponent={StudentDashboard} tutorComponent={TutorDashboard} />}</Route>
      <Route path="/super-admin">{() => <ProtectedRoute component={SuperAdminDashboard} />}</Route>
      <Route path="/super-admin/tutors/:tutorId">{(params) => <ProtectedRoute component={SuperAdminTutorDetail} params={params} />}</Route>
      <Route path="/tutor">{() => <ProtectedRoute component={TutorDashboard} />}</Route>
      <Route path="/tutor/assessment/:quizId">{(params) => <ProtectedRoute component={TutorAssessmentDetails} params={params} />}</Route>
      <Route path="/tutor/students/:id">{(params) => <ProtectedRoute component={TutorStudentDetail} params={params} />}</Route>
      <Route path="/tutor/students">{() => <ProtectedRoute component={TutorStudents} />}</Route>
      <Route path="/tutor/assessments/edit/:id">{(params) => <ProtectedRoute component={BuilderPage} params={params} />}</Route>
      <Route path="/tutor/assessments/new">{() => <ProtectedRoute component={BuilderPage} />}</Route>
      <Route path="/tutor/assessments">{() => <ProtectedRoute component={TutorAssessments} />}</Route>
      <Route path="/tutor/:rest*">{() => <ProtectedRoute component={NotFound} />}</Route>
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
  const [, setLocation] = useLocation();

  useEffect(() => {
    // ── Recovery-token interceptor ──────────────────────────────────────
    // Supabase sends the reset email pointing to /login (old config) or
    // /reset-password (new config).  After Supabase verifies the token it
    // redirects here with one of three URL shapes:
    //
    //   PKCE   → ?code=XXX                      (query param, not cleared yet)
    //   OTP    → ?token_hash=XXX&type=recovery  (query param)
    //   Implicit → #access_token=XXX&type=recovery  (URL hash)
    //
    // The implicit hash is consumed by the Supabase client asynchronously
    // (after a microtask), so we can still read it here synchronously.
    // For PKCE / OTP the params stay in the URL until explicitly exchanged.

    const url = new URL(window.location.href);
    const code      = url.searchParams.get("code");
    const tokenHash = url.searchParams.get("token_hash");
    const type      = url.searchParams.get("type");
    const hash      = window.location.hash;
    const hashParams = new URLSearchParams(hash.replace(/^#/, ""));
    const hashType  = hashParams.get("type");

    // Already on the reset page — nothing to do.
    if (window.location.pathname === "/reset-password") return;

    if (code) {
      setLocation(`/reset-password?code=${encodeURIComponent(code)}`);
      return;
    }
    if (tokenHash && type === "recovery") {
      setLocation(`/reset-password?token_hash=${encodeURIComponent(tokenHash)}&type=recovery`);
      return;
    }
    if (hashType === "recovery" && hash) {
      // Pass the full hash so /reset-password can extract access_token etc.
      setLocation("/reset-password" + hash);
      return;
    }

    // Fallback: listen for Supabase's PASSWORD_RECOVERY auth event.
    // Supabase fires this when it processes a recovery token from the URL hash.
    // Registering here (App level, always mounted) means we never miss it
    // regardless of which page the user lands on.
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY") {
        setLocation("/reset-password");
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  return (
    <TooltipProvider>
      <Toaster />
      <ErrorBoundary title="Application error"><Router /></ErrorBoundary>
      <AIStatusLights />
    </TooltipProvider>
  );
}

export default App;
