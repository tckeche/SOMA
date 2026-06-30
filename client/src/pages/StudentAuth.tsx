import { useEffect, useRef, useState } from "react";
import { useLocation, useSearch } from "wouter";
import { AuthRequestError, supabase, authFetch, withTimeout } from "@/lib/supabase";
import { useToast } from "@/hooks/use-toast";
import { Mail, Lock, User, Eye, EyeOff, Loader2, ArrowLeft, BookOpen, GraduationCap, Check, ChevronsUpDown } from "lucide-react";
import { Link } from "wouter";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/**
 * Searchable subject select for signup. Fetches catalogue subject names from the
 * public endpoint and lets the user filter + pick. Falls back to free-text entry
 * if the list fails to load so signup is never hard-blocked. The selected value
 * is always a plain subject-name string (same shape the payload expects).
 */
function SubjectCombobox({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/auth/catalogue/subjects");
        if (!res.ok) throw new Error("Failed to load subjects");
        const data = await res.json();
        if (!cancelled && Array.isArray(data)) {
          setOptions(data.filter((s): s is string => typeof s === "string"));
        }
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Free-text fallback if the catalogue could not be loaded.
  if (failed) {
    return (
      <div className="relative">
        <BookOpen className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="e.g. Mathematics"
          required
          className="glass-input w-full pl-10 pr-4 py-3 text-sm"
          data-testid="input-subject"
        />
      </div>
    );
  }

  const filtered = query.trim()
    ? options.filter((o) => o.toLowerCase().includes(query.trim().toLowerCase()))
    : options;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          role="combobox"
          aria-expanded={open}
          className="glass-input w-full pl-10 pr-9 py-3 text-sm flex items-center justify-between relative text-left"
          data-testid="input-subject"
        >
          <BookOpen className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <span className={cn("truncate", !value && "text-muted-foreground")}>
            {value || "Search and select a subject"}
          </span>
          <ChevronsUpDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground opacity-60" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
        <div className="p-2 border-b border-border/40">
          <input
            type="text"
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Type to search subjects..."
            className="glass-input w-full px-3 py-2 text-sm"
            data-testid="input-subject-search"
          />
        </div>
        <div className="max-h-56 overflow-y-auto py-1">
          {filtered.length === 0 ? (
            <div className="px-3 py-2 text-xs text-muted-foreground">
              {query.trim() ? (
                <button
                  type="button"
                  onClick={() => {
                    onChange(query.trim());
                    setOpen(false);
                  }}
                  className="text-primary hover:text-primary/80"
                >
                  Use "{query.trim()}"
                </button>
              ) : (
                "No subjects found."
              )}
            </div>
          ) : (
            filtered.map((opt) => (
              <button
                key={opt}
                type="button"
                onClick={() => {
                  onChange(opt);
                  setOpen(false);
                  setQuery("");
                }}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left hover:bg-primary/10 transition-colors"
              >
                <Check className={cn("w-4 h-4", value === opt ? "opacity-100 text-primary" : "opacity-0")} />
                <span className="truncate">{opt}</span>
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

type AuthMode = "login" | "signup" | "reset";

export default function StudentAuth() {
  // The auth page is portal-aware: `?portal=tutor` makes this the tutor entry
  // (tutors / super-admins only); anything else is the student entry. Login is
  // gated on the resolved portal and signup is locked to it.
  const search = useSearch();
  const portal: "student" | "tutor" =
    new URLSearchParams(search).get("portal") === "tutor" ? "tutor" : "student";
  const [mode, setMode] = useState<AuthMode>("login");
  const [accountType, setAccountType] = useState<"student" | "tutor">(portal);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [firstName, setFirstName] = useState("");
  const [surname, setSurname] = useState("");
  const [subject, setSubject] = useState("");
  const [syllabus, setSyllabus] = useState("");
  const [level, setLevel] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [formErrors, setFormErrors] = useState<{ email?: string; password?: string }>({});
  const [authError, setAuthError] = useState<string | null>(null);
  const [statusNote, setStatusNote] = useState<string | null>(null);
  const [verificationEmail, setVerificationEmail] = useState<string | null>(null);
  const [resendAttempts, setResendAttempts] = useState(0);
  const [codeSent, setCodeSent] = useState(false);
  const [codeInput, setCodeInput] = useState("");
  const activeRequestId = useRef(0);
  const [, setLocation] = useLocation();
  const { toast } = useToast();

  // Keep the signup account type locked to the active portal, even if the user
  // switches between /login?portal=student and ?portal=tutor without remounting.
  useEffect(() => {
    setAccountType(portal);
  }, [portal]);

  const resetForm = () => {
    setEmail("");
    setPassword("");
    setFirstName("");
    setSurname("");
    setSubject("");
    setSyllabus("");
    setLevel("");
    setShowPassword(false);
    setFormErrors({});
    setAuthError(null);
    setVerificationEmail(null);
    setResendAttempts(0);
    setCodeSent(false);
    setCodeInput("");
  };

  const switchMode = (newMode: AuthMode) => {
    resetForm();
    setStatusNote(null);
    setMode(newMode);
  };

  const nextRequestId = () => {
    activeRequestId.current += 1;
    return activeRequestId.current;
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    const nextErrors: { email?: string; password?: string } = {};
    if (!email.trim()) nextErrors.email = "Please enter your email address.";
    if (!password.trim()) nextErrors.password = "Please enter your password.";
    if (Object.keys(nextErrors).length > 0) {
      setFormErrors(nextErrors);
      toast({
        title: "Missing required fields",
        description: "Enter your email and password to continue.",
        variant: "destructive",
      });
      return;
    }
    setFormErrors({});
    const requestId = nextRequestId();
    setAuthError(null);
    setStatusNote("Signing you in securely...");
    setLoading(true);

    try {
      const { data, error } = await withTimeout(() => supabase.auth.signInWithPassword({
        email,
        password,
      }), { timeoutMs: 15000, stage: "supabase_signin" });
      if (requestId !== activeRequestId.current) return;

      if (error) throw error;

      if (data.user) {
        setStatusNote("Finalizing your account...");
        const syncRes = await authFetch("/api/auth/sync", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            user_metadata: data.user.user_metadata,
          }),
          timeoutMs: 12000,
        });
        if (!syncRes.ok) throw new Error("Failed to sync account");
        const syncData = await syncRes.json();
        const role: string = syncData.role;
        // Enforce the portal the user logged in through: the tutor login accepts
        // only tutor / super-admin accounts, the student login only students.
        const portalAllowsRole =
          portal === "tutor"
            ? role === "tutor" || role === "super_admin"
            : role === "student";
        if (!portalAllowsRole) {
          await supabase.auth.signOut().catch(() => {});
          const friendly =
            portal === "tutor"
              ? "This isn't a tutor account. Please use the student login instead."
              : "This is the student login. Tutors should use the tutor login instead.";
          setAuthError(friendly);
          toast({ title: "Wrong login page", description: friendly, variant: "destructive" });
          return;
        }
        if (role === "super_admin") {
          setLocation("/super-admin");
          return;
        } else if (role === "tutor") {
          setLocation("/tutor");
          return;
        }
        setLocation("/dashboard");
        return;
      }

      setLocation("/dashboard");
    } catch (err: any) {
      if (requestId !== activeRequestId.current) return;
      const msg = err?.message || "";
      let friendly = "Something went wrong. Please try again.";
      if (msg.includes("Invalid login credentials")) {
        friendly = "Incorrect email or password. Please try again.";
      } else if (msg.includes("Email not confirmed")) {
        friendly = "Please check your email and verify your account first.";
      } else if (msg.includes("User not found")) {
        friendly = "No account found with that email address.";
      } else if (err instanceof AuthRequestError && err.code === "TIMEOUT") {
        friendly = "Login timed out. Please try again.";
      } else if (msg) {
        friendly = msg;
      }
      setAuthError(friendly);
      toast({
        title: "Login failed",
        description: friendly,
        variant: "destructive",
      });
    } finally {
      if (requestId === activeRequestId.current) {
        setLoading(false);
        setStatusNote(null);
      }
    }
  };

  const handleSignup = async (e: React.FormEvent) => {
    e.preventDefault();
    const nextErrors: { email?: string; password?: string } = {};
    if (!email.trim()) nextErrors.email = "Please enter your email address.";
    if (!password.trim()) nextErrors.password = "Please create a password.";
    // Reflect field-level errors inline immediately. Without this, an early
    // return below (missing name / missing subject) would skip setFormErrors,
    // so a user missing BOTH their name and email/password never saw the
    // email/password field errors highlighted.
    setFormErrors(nextErrors);
    if (!firstName.trim() || !surname.trim()) {
      toast({
        title: "Name required",
        description: "Please enter both your first name and surname.",
        variant: "destructive",
      });
      return;
    }
    if (accountType === "student" && (!subject || !syllabus || !level)) {
      toast({
        title: "Missing required fields",
        description: "Please add subject, exam body/syllabus, and level.",
        variant: "destructive",
      });
      return;
    }
    if (Object.keys(nextErrors).length > 0) {
      setFormErrors(nextErrors);
      toast({
        title: "Missing required fields",
        description: "Please complete all required fields.",
        variant: "destructive",
      });
      return;
    }
    setFormErrors({});
    if (password.length < 6) {
      setFormErrors({ password: "Password must be at least 6 characters." });
      toast({
        title: "Password too short",
        description: "Password must be at least 6 characters.",
        variant: "destructive",
      });
      return;
    }
    const requestId = nextRequestId();
    setAuthError(null);
    setStatusNote("Creating your account...");
    setLoading(true);

    try {
      const fullName = `${firstName.trim()} ${surname.trim()}`.trim();
      const signupData = accountType === "tutor"
        ? {
            display_name: fullName,
            first_name: firstName.trim(),
            surname: surname.trim(),
            requested_role: "tutor",
          }
        : {
            display_name: fullName,
            first_name: firstName.trim(),
            surname: surname.trim(),
            requested_role: "student",
            subject,
            syllabus,
            // Syllabus code is no longer collected at signup (students found it
            // confusing). Sent empty so downstream profile sync keeps the key
            // shape; it can be derived/edited later.
            syllabus_code: "",
            level,
            subjects: [{ subject, examBody: syllabus, syllabusCode: "", level }],
          };
      const { data, error } = await withTimeout(() => supabase.auth.signUp({
        email,
        password,
        options: {
          data: signupData,
        },
      }), { timeoutMs: 18000, stage: "supabase_signup" });
      if (requestId !== activeRequestId.current) return;

      if (error) throw error;

      if (data.session) {
        setStatusNote("Finalizing your account...");
        const syncRes = await authFetch("/api/auth/sync", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            user_metadata: data.user!.user_metadata,
          }),
          timeoutMs: 12000,
        });
        if (!syncRes.ok) throw new Error("Failed to sync account");
        const syncData = await syncRes.json();
        toast({ title: "Welcome!", description: "Your account has been created." });
        if (syncData.role === "super_admin") {
          setLocation("/super-admin");
        } else if (syncData.role === "tutor") {
          setLocation("/tutor");
        } else {
          setLocation("/dashboard");
        }
      } else {
        setVerificationEmail(email.trim().toLowerCase());
        toast({
          title: "Account created",
          description: "Please check your email to verify your account, then log in. If no email arrives in 2 minutes, retry sign up.",
        });
        setMode("login");
      }
    } catch (err: any) {
      if (requestId !== activeRequestId.current) return;
      const msg = err?.message || "";
      let friendly = "Could not create account.";
      if (
        msg.includes("already registered") ||
        msg.includes("already been registered") ||
        msg.includes("User already registered") ||
        err?.code === "user_already_exists"
      ) {
        friendly = "This account already exists. Please log in or click 'Forgot password' to reset your password.";
      } else if (err instanceof AuthRequestError && err.code === "TIMEOUT") {
        friendly = "Sign up timed out. Please retry. If this keeps happening, check your email for a verification link before retrying.";
      } else if (msg) {
        friendly = msg;
      }
      setAuthError(friendly);
      toast({
        title: "Sign up failed",
        description: friendly,
        variant: "destructive",
      });
    } finally {
      if (requestId === activeRequestId.current) {
        setLoading(false);
        setStatusNote(null);
      }
    }
  };

  const handleResendVerification = async () => {
    if (!verificationEmail) return;
    setLoading(true);
    try {
      const res = await fetch("/api/auth/resend-verification", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: verificationEmail }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error?.message || data?.message || "Could not resend verification email.");
      setResendAttempts(data?.attemptCount ?? (resendAttempts + 1));
      toast({ title: "Verification email sent", description: "Check your inbox and spam folder." });
    } catch (err: any) {
      toast({ title: "Resend failed", description: err?.message || "Please try again shortly.", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  const handleSendVerificationCode = async () => {
    if (!verificationEmail) return;
    setLoading(true);
    try {
      const res = await fetch("/api/auth/send-verification-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: verificationEmail }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error?.message || data?.message || "Could not send fallback code.");
      setCodeSent(true);
      toast({ title: "Code sent", description: "A 7-digit verification code has been sent to your email." });
    } catch (err: any) {
      toast({ title: "Code send failed", description: err?.message || "Please try again.", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  const handleVerifyCode = async () => {
    if (!verificationEmail || !/^\d{7}$/.test(codeInput)) {
      toast({ title: "Invalid code", description: "Enter a valid 7-digit code.", variant: "destructive" });
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/auth/verify-verification-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: verificationEmail, code: codeInput }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error?.message || data?.message || "Verification failed.");
      toast({ title: "Email verified", description: "Verification complete. You can now log in." });
      setVerificationEmail(null);
      setResendAttempts(0);
      setCodeSent(false);
      setCodeInput("");
    } catch (err: any) {
      toast({ title: "Verification failed", description: err?.message || "Invalid, expired, or already-used code.", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  const handleResetPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email) {
      toast({ title: "Email required", description: "Please enter your email address.", variant: "destructive" });
      return;
    }
    const requestId = nextRequestId();
    setAuthError(null);
    setStatusNote("Sending reset email...");
    setLoading(true);
    try {
      const { error } = await withTimeout(() => supabase.auth.resetPasswordForEmail(email, {
        redirectTo: window.location.origin + "/reset-password",
      }), { timeoutMs: 15000, stage: "supabase_reset" });
      if (requestId !== activeRequestId.current) return;
      if (error) throw error;
      toast({ title: "Reset email sent", description: "Check your inbox for a password reset link." });
      switchMode("login");
    } catch (err: any) {
      if (requestId !== activeRequestId.current) return;
      const friendly = err instanceof AuthRequestError
        ? "Reset request timed out. Please try again."
        : err?.message || "Something went wrong.";
      setAuthError(friendly);
      toast({ title: "Reset failed", description: friendly, variant: "destructive" });
    } finally {
      if (requestId === activeRequestId.current) {
        setLoading(false);
        setStatusNote(null);
      }
    }
  };

  return (
    <div className="min-h-screen w-full flex items-center justify-center px-4 bg-[radial-gradient(ellipse_80%_80%_at_50%_-20%,rgba(139,92,246,0.15),transparent)]">
      <div className="fixed top-4 right-4 z-30">
        <ThemeToggle />
      </div>
      <div className="w-full max-w-md">
        <Link href="/">
          <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-primary transition-colors cursor-pointer mb-8 block" data-testid="link-back-home">
            <ArrowLeft className="w-4 h-4" />
            Back to home
          </span>
        </Link>

        <div className="text-center mb-8">
          <img src="/MCEC - White Logo.png" alt="MCEC Logo" loading="lazy" className="h-16 w-auto object-contain mx-auto mb-4 brightness-0 dark:brightness-100" />
          <h1 className="text-2xl font-bold gradient-text drop-shadow-[0_0_15px_rgba(139,92,246,0.5)]" data-testid="text-auth-title">
            SOMA
          </h1>
          <p className="text-xs text-muted-foreground mt-1 tracking-widest uppercase">{portal === "tutor" ? "Tutor Portal" : "Student Portal"}</p>
          <p className="text-[11px] text-muted-foreground mt-2">
            {portal === "tutor" ? "Tutor access only. " : "Student access only. "}
            <Link href={portal === "tutor" ? "/login?portal=student" : "/login?portal=tutor"}>
              <span className="text-primary hover:underline cursor-pointer" data-testid="link-switch-portal">
                {portal === "tutor" ? "Student login" : "Tutor login"}
              </span>
            </Link>
          </p>
        </div>

        <div className="bg-card/50 backdrop-blur-md border border-border/50 rounded-2xl p-8 shadow-xl">
          {mode === "reset" ? (
            <div className="mb-6 text-center">
              <h2 className="text-lg font-semibold text-foreground">Reset Password</h2>
            </div>
          ) : (
            <div className="flex mb-6 bg-background/40 rounded-xl p-1 border border-border/30">
              <button
                type="button"
                onClick={() => switchMode("login")}
                className={`flex-1 py-2.5 text-sm font-medium rounded-lg transition-all ${
                  mode === "login"
                    ? "bg-primary/80 text-white shadow-lg shadow-primary/20"
                    : "text-muted-foreground hover:text-foreground/80"
                }`}
                data-testid="button-tab-login"
              >
                Log In
              </button>
              <button
                type="button"
                onClick={() => switchMode("signup")}
                className={`flex-1 py-2.5 text-sm font-medium rounded-lg transition-all ${
                  mode === "signup"
                    ? "bg-primary/80 text-white shadow-lg shadow-primary/20"
                    : "text-muted-foreground hover:text-foreground/80"
                }`}
                data-testid="button-tab-signup"
              >
                Sign Up
              </button>
            </div>
          )}

          <form onSubmit={mode === "login" ? handleLogin : mode === "signup" ? handleSignup : handleResetPassword} className="space-y-4">
            {statusNote && (
              <div className="text-xs rounded-lg border border-primary/30 bg-primary/10 text-primary px-3 py-2">
                {statusNote}
              </div>
            )}
            {mode === "signup" && (
              <>
                <div
                  className="flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/10 px-3 py-2.5 text-sm text-foreground"
                  data-testid={`signup-account-type-${accountType}`}
                >
                  {accountType === "tutor" ? (
                    <BookOpen className="w-4 h-4 text-primary" />
                  ) : (
                    <GraduationCap className="w-4 h-4 text-primary" />
                  )}
                  <span>
                    Creating a{" "}
                    <span className="font-semibold">{accountType === "tutor" ? "tutor" : "student"}</span>{" "}
                    account
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs text-muted-foreground mb-1.5 block font-medium">
                      First Name <span className="text-danger">*</span>
                    </label>
                    <div className="relative">
                      <User className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                      <input
                        type="text"
                        value={firstName}
                        onChange={(e) => setFirstName(e.target.value)}
                        placeholder="First name"
                        required
                        className="glass-input w-full pl-10 pr-4 py-3 text-sm"
                        data-testid="input-first-name"
                      />
                    </div>
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground mb-1.5 block font-medium">
                      Surname <span className="text-danger">*</span>
                    </label>
                    <div className="relative">
                      <User className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                      <input
                        type="text"
                        value={surname}
                        onChange={(e) => setSurname(e.target.value)}
                        placeholder="Surname"
                        required
                        className="glass-input w-full pl-10 pr-4 py-3 text-sm"
                        data-testid="input-surname"
                      />
                    </div>
                  </div>
                </div>
                {accountType === "student" && (
                <div>
                  <label className="text-xs text-muted-foreground mb-1.5 block font-medium">
                    Subject <span className="text-danger">*</span>
                  </label>
                  <SubjectCombobox value={subject} onChange={setSubject} />
                </div>
                )}
                {accountType === "student" && (
                <>
                <div>
                  <label className="text-xs text-muted-foreground mb-1.5 block font-medium">
                    Exam Body / Syllabus <span className="text-danger">*</span>
                  </label>
                  <div className="relative">
                    <BookOpen className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                    <select
                      value={syllabus}
                      onChange={(e) => setSyllabus(e.target.value)}
                      required
                      className="glass-input w-full pl-10 pr-4 py-3 text-sm appearance-none cursor-pointer"
                      data-testid="input-syllabus"
                    >
                      <option value="" disabled>Select your syllabus</option>
                      <option value="Cambridge">Cambridge (IGCSE / AS / A-Level)</option>
                      <option value="IB">IB (International Baccalaureate)</option>
                      <option value="IEB">IEB</option>
                      <option value="CAPS">CAPS (South Africa)</option>
                      <option value="Edexcel">Edexcel</option>
                      <option value="AQA">AQA</option>
                      <option value="Other">Other</option>
                    </select>
                  </div>
                </div>
                <div>
                  <label className="text-xs text-muted-foreground mb-1.5 block font-medium">
                    Level <span className="text-danger">*</span>
                  </label>
                  <div className="relative">
                    <GraduationCap className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                    <select
                      value={level}
                      onChange={(e) => setLevel(e.target.value)}
                      required
                      className="glass-input w-full pl-10 pr-4 py-3 text-sm appearance-none cursor-pointer"
                      data-testid="input-level"
                    >
                      <option value="" disabled>Select your level</option>
                      <option value="IGCSE">IGCSE</option>
                      <option value="AS Level">AS Level</option>
                      <option value="A2 Level">A2 Level</option>
                      <option value="IB SL">IB SL</option>
                      <option value="IB HL">IB HL</option>
                      <option value="Grade 8">Grade 8</option>
                      <option value="Grade 9">Grade 9</option>
                      <option value="Grade 10">Grade 10</option>
                      <option value="Grade 11">Grade 11</option>
                      <option value="Grade 12">Grade 12</option>
                      <option value="University">University</option>
                      <option value="Other">Other</option>
                    </select>
                  </div>
                </div>
                </>
                )}
              </>
            )}

            <div>
              <label className="text-xs text-muted-foreground mb-1.5 block font-medium">Email</label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <input
                  type="email"
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value);
                    if (formErrors.email) setFormErrors((prev) => ({ ...prev, email: undefined }));
                    if (authError) setAuthError(null);
                  }}
                  placeholder="student@example.com"
                  required
                  className="glass-input w-full pl-10 pr-4 py-3 text-sm"
                  data-testid="input-email"
                />
              </div>
              {formErrors.email && <p className="text-xs text-danger mt-1">{formErrors.email}</p>}
            </div>

            {mode !== "reset" && (
              <div>
                <label className="text-xs text-muted-foreground mb-1.5 block font-medium">Password</label>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                  <input
                    type={showPassword ? "text" : "password"}
                    value={password}
                    onChange={(e) => {
                      setPassword(e.target.value);
                      if (formErrors.password) setFormErrors((prev) => ({ ...prev, password: undefined }));
                      if (authError) setAuthError(null);
                    }}
                    placeholder="••••••••"
                    required
                    minLength={6}
                    className="glass-input w-full pl-10 pr-12 py-3 text-sm"
                    data-testid="input-password"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    aria-label={showPassword ? "Hide password" : "Show password"}
                    title={showPassword ? "Hide password" : "Show password"}
                    className="absolute right-3 top-1/2 -translate-y-1/2 min-h-[44px] min-w-[44px] flex items-center justify-center text-muted-foreground hover:text-foreground/80 transition-colors"
                    data-testid="button-toggle-password"
                  >
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
                {formErrors.password && <p className="text-xs text-danger mt-1">{formErrors.password}</p>}
              </div>
            )}

            {mode === "login" && (
              <button
                type="button"
                onClick={() => setLocation("/forgot-password")}
                className="text-xs text-primary hover:text-primary/80 transition-colors w-full text-right -mt-1"
                data-testid="button-forgot-password"
              >
                Forgot password?
              </button>
            )}

            {mode === "reset" && (
              <p className="text-xs text-muted-foreground -mt-1">
                Enter your email and we'll send you a link to reset your password.
              </p>
            )}

            <button
              type="submit"
              disabled={loading}
              className="glow-button w-full py-3 min-h-[44px] text-sm flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
              data-testid="button-auth-submit"
            >
              {loading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  {mode === "login" ? "Logging in..." : mode === "signup" ? "Creating account..." : "Sending reset link..."}
                </>
              ) : (
                mode === "login" ? "Log In" : mode === "signup" ? "Create Account" : "Send Reset Link"
              )}
            </button>

            {authError && (
              <div
                className="flex items-start gap-2 rounded-lg bg-danger/10 border border-danger/30 px-3 py-2.5"
                data-testid="text-auth-error"
                role="alert"
              >
                <span className="text-danger text-xs leading-relaxed">{authError}</span>
              </div>
            )}
            {mode === "login" && verificationEmail && (
              <div className="rounded-lg border border-warning/30 bg-warning/10 p-3 space-y-2">
                <p className="text-xs text-warning">Still waiting for verification at <strong>{verificationEmail}</strong>?</p>
                <div className="flex flex-wrap gap-2">
                  <button type="button" onClick={handleResendVerification} disabled={loading} className="text-xs px-2.5 py-1.5 rounded-md border border-warning/30 bg-warning/20 text-warning">
                    Resend verification email
                  </button>
                  {resendAttempts >= 3 && (
                    <button type="button" onClick={handleSendVerificationCode} disabled={loading} className="text-xs px-2.5 py-1.5 rounded-md border border-primary/30 bg-primary/20 text-primary">
                      Get a code instead
                    </button>
                  )}
                </div>
                {codeSent && (
                  <div className="flex gap-2">
                    <input
                      type="text"
                      inputMode="numeric"
                      value={codeInput}
                      onChange={(e) => setCodeInput(e.target.value.replace(/\D/g, "").slice(0, 7))}
                      className="flex-1 glass-input py-2 text-xs"
                      placeholder="7-digit code"
                    />
                    <button type="button" onClick={handleVerifyCode} disabled={loading} className="text-xs px-3 py-2 rounded-md border border-success/30 bg-success/20 text-success">
                      Verify
                    </button>
                  </div>
                )}
              </div>
            )}
          </form>

          <p className="text-center text-xs text-muted-foreground mt-6">
            {mode === "login" ? (
              <>
                Don't have an account?{" "}
                <button
                  type="button"
                  onClick={() => switchMode("signup")}
                  className="text-primary hover:text-primary/80 transition-colors font-medium"
                  data-testid="link-switch-to-signup"
                >
                  Sign up
                </button>
              </>
            ) : mode === "signup" ? (
              <>
                Already have an account?{" "}
                <button
                  type="button"
                  onClick={() => switchMode("login")}
                  className="text-primary hover:text-primary/80 transition-colors font-medium"
                  data-testid="link-switch-to-login"
                >
                  Log in
                </button>
              </>
            ) : (
              <>
                Remember your password?{" "}
                <button
                  type="button"
                  onClick={() => switchMode("login")}
                  className="text-primary hover:text-primary/80 transition-colors font-medium"
                  data-testid="link-back-to-login"
                >
                  Back to login
                </button>
              </>
            )}
          </p>
        </div>
      </div>
    </div>
  );
}
