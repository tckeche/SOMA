import { Switch, Route, useLocation } from "wouter";
import { useEffect, lazy, Suspense } from "react";
import { Loader2 } from "lucide-react";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import Landing from "@/pages/landing";

// Route-level code splitting: every page below is loaded on demand rather than
// bundled into the initial download. Landing + NotFound stay eager because they
// are tiny and on the first-paint path. This keeps the main bundle small so the
// app shell paints fast; each page's JS (and its heavy deps like the markdown/
// katex/pdf/chart stacks) only downloads when that route is actually visited.
const BuilderPage = lazy(() => import("@/pages/builder"));
const SomaQuizEngine = lazy(() => import("@/pages/soma-quiz"));
const SomaQuizReview = lazy(() => import("@/pages/SomaQuizReview"));
const StudentAuth = lazy(() => import("@/pages/StudentAuth"));
const StudentDashboard = lazy(() => import("@/pages/StudentDashboard"));
const TutorDashboard = lazy(() => import("@/pages/TutorDashboard"));
const TutorStudents = lazy(() => import("@/pages/TutorStudents"));
const TutorStudentDetail = lazy(() => import("@/pages/TutorStudentDetail"));
const TutorAssessments = lazy(() => import("@/pages/TutorAssessments"));
const TutorAssessmentDetails = lazy(() => import("@/pages/TutorAssessmentDetails"));
const TutorQuizReview = lazy(() => import("@/pages/TutorQuizReview"));
const SuperAdminDashboard = lazy(() => import("@/pages/SuperAdminDashboard"));
const SuperAdminTutorDetail = lazy(() => import("@/pages/SuperAdminTutorDetail"));
const SuperAdminDiagnostics = lazy(() => import("@/pages/SuperAdminDiagnostics"));
const SomaChatPage = lazy(() => import("@/pages/soma-chat"));
const ForgotPassword = lazy(() => import("@/pages/ForgotPassword"));
const ResetPassword = lazy(() => import("@/pages/ResetPassword"));
import ProtectedRoute from "@/components/ProtectedRoute";
import RoleRouter from "@/components/RoleRouter";
import { ErrorBoundary } from "@/components/error-boundary";
import { Redirect } from "wouter";
import { supabase } from "@/lib/supabase";

function RouteFallback() {
  return (
    <div className="min-h-screen flex items-center justify-center">
      <Loader2 className="w-8 h-8 text-primary animate-spin" />
    </div>
  );
}

function Router() {
  return (
    <Switch>
      <Route path="/" component={Landing} />
      <Route path="/login" component={StudentAuth} />
      <Route path="/forgot-password" component={ForgotPassword} />
      <Route path="/reset-password" component={ResetPassword} />
      <Route path="/portal">{() => <RoleRouter studentComponent={StudentDashboard} tutorComponent={TutorDashboard} />}</Route>
      <Route path="/super-admin/diagnostics">{() => <ProtectedRoute component={SuperAdminDiagnostics} />}</Route>
      <Route path="/super-admin">{() => <ProtectedRoute component={SuperAdminDashboard} />}</Route>
      <Route path="/super-admin/tutors/:tutorId">{(params) => <ProtectedRoute component={SuperAdminTutorDetail} params={params} />}</Route>
      <Route path="/tutor">{() => <ProtectedRoute component={TutorDashboard} />}</Route>
      <Route path="/tutor/assessment/:quizId">{(params) => <ProtectedRoute component={TutorAssessmentDetails} params={params} />}</Route>
      <Route path="/tutor/quizzes/:quizId/review">{(params) => <ProtectedRoute component={TutorQuizReview} params={params} />}</Route>
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

const TITLE_SUFFIX = "SOMA";
function titleForPath(path: string): string {
  if (path === "/") return "SOMA — Intelligent Assessment Platform";
  if (path === "/login") return `Sign In · ${TITLE_SUFFIX}`;
  if (path === "/forgot-password" || path === "/reset-password") return `Reset Password · ${TITLE_SUFFIX}`;
  if (path.startsWith("/super-admin")) return `Admin · ${TITLE_SUFFIX}`;
  if (path.startsWith("/tutor")) return `Tutor Portal · ${TITLE_SUFFIX}`;
  if (path.startsWith("/soma/quiz")) return `Quiz · ${TITLE_SUFFIX}`;
  if (path.startsWith("/soma/review")) return `Quiz Review · ${TITLE_SUFFIX}`;
  if (path.startsWith("/soma/chat")) return `Soma Chat · ${TITLE_SUFFIX}`;
  if (path === "/portal" || path === "/dashboard") return `Dashboard · ${TITLE_SUFFIX}`;
  return TITLE_SUFFIX;
}

function App() {
  const [location, setLocation] = useLocation();

  useEffect(() => {
    document.title = titleForPath(location);
  }, [location]);

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
      <ErrorBoundary title="Application error">
        <Suspense fallback={<RouteFallback />}>
          <Router />
        </Suspense>
      </ErrorBoundary>
    </TooltipProvider>
  );
}

export default App;
