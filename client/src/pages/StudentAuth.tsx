import { useRef, useState } from "react";
import { useLocation } from "wouter";
import { AuthRequestError, supabase, authFetch, withTimeout } from "@/lib/supabase";
import { useToast } from "@/hooks/use-toast";
import { Mail, Lock, User, Eye, EyeOff, Loader2, ArrowLeft } from "lucide-react";
import { Link } from "wouter";

type AuthMode = "login" | "signup" | "reset";

export default function StudentAuth() {
  const [mode, setMode] = useState<AuthMode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
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

  const resetForm = () => {
    setEmail("");
    setPassword("");
    setDisplayName("");
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
        if (syncData.role === "super_admin") {
          setLocation("/super-admin");
          return;
        } else if (syncData.role === "tutor") {
          setLocation("/tutor");
          return;
        }
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
      const { data, error } = await withTimeout(() => supabase.auth.signUp({
        email,
        password,
        options: {
          data: {
            display_name: displayName || email.split("@")[0],
          },
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
      if (msg.includes("already registered") || msg.includes("already been registered")) {
        friendly = "An account with this email already exists. Try logging in instead.";
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
      <div className="w-full max-w-md">
        <Link href="/">
          <span className="inline-flex items-center gap-1.5 text-sm text-slate-400 hover:text-violet-400 transition-colors cursor-pointer mb-8 block" data-testid="link-back-home">
            <ArrowLeft className="w-4 h-4" />
            Back to home
          </span>
        </Link>

        <div className="text-center mb-8">
          <img src="/MCEC - White Logo.png" alt="MCEC Logo" loading="lazy" className="h-16 w-auto object-contain mx-auto mb-4" />
          <h1 className="text-2xl font-bold gradient-text drop-shadow-[0_0_15px_rgba(139,92,246,0.5)]" data-testid="text-auth-title">
            SOMA
          </h1>
          <p className="text-xs text-slate-400 mt-1 tracking-widest uppercase">Student Portal</p>
        </div>

        <div className="bg-slate-900/50 backdrop-blur-md border border-white/10 rounded-2xl p-8 shadow-[0_8px_32px_rgba(0,0,0,0.4)]">
          {mode === "reset" ? (
            <div className="mb-6 text-center">
              <h2 className="text-lg font-semibold text-white">Reset Password</h2>
            </div>
          ) : (
            <div className="flex mb-6 bg-black/30 rounded-xl p-1 border border-white/5">
              <button
                type="button"
                onClick={() => switchMode("login")}
                className={`flex-1 py-2.5 text-sm font-medium rounded-lg transition-all ${
                  mode === "login"
                    ? "bg-violet-600/80 text-white shadow-lg shadow-violet-500/20"
                    : "text-slate-400 hover:text-slate-300"
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
                    ? "bg-violet-600/80 text-white shadow-lg shadow-violet-500/20"
                    : "text-slate-400 hover:text-slate-300"
                }`}
                data-testid="button-tab-signup"
              >
                Sign Up
              </button>
            </div>
          )}

          <form onSubmit={mode === "login" ? handleLogin : mode === "signup" ? handleSignup : handleResetPassword} className="space-y-4">
            {statusNote && (
              <div className="text-xs rounded-lg border border-violet-500/30 bg-violet-500/10 text-violet-200 px-3 py-2">
                {statusNote}
              </div>
            )}
            {mode === "signup" && (
              <div>
                <label className="text-xs text-slate-400 mb-1.5 block font-medium">Display Name</label>
                <div className="relative">
                  <User className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                  <input
                    type="text"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    placeholder="Your name"
                    className="glass-input w-full pl-10 pr-4 py-3 text-sm"
                    data-testid="input-display-name"
                  />
                </div>
              </div>
            )}

            <div>
              <label className="text-xs text-slate-400 mb-1.5 block font-medium">Email</label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
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
              {formErrors.email && <p className="text-xs text-red-400 mt-1">{formErrors.email}</p>}
            </div>

            {mode !== "reset" && (
              <div>
                <label className="text-xs text-slate-400 mb-1.5 block font-medium">Password</label>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
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
                    className="absolute right-3 top-1/2 -translate-y-1/2 min-h-[44px] min-w-[44px] text-slate-400 hover:text-slate-300 transition-colors"
                    data-testid="button-toggle-password"
                  >
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
                {formErrors.password && <p className="text-xs text-red-400 mt-1">{formErrors.password}</p>}
              </div>
            )}

            {mode === "login" && (
              <button
                type="button"
                onClick={() => setLocation("/forgot-password")}
                className="text-xs text-violet-400 hover:text-violet-300 transition-colors w-full text-right -mt-1"
                data-testid="button-forgot-password"
              >
                Forgot password?
              </button>
            )}

            {mode === "reset" && (
              <p className="text-xs text-slate-400 -mt-1">
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
                className="flex items-start gap-2 rounded-lg bg-red-500/10 border border-red-500/30 px-3 py-2.5"
                data-testid="text-auth-error"
                role="alert"
              >
                <span className="text-red-400 text-xs leading-relaxed">{authError}</span>
              </div>
            )}
            {mode === "login" && verificationEmail && (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 space-y-2">
                <p className="text-xs text-amber-100">Still waiting for verification at <strong>{verificationEmail}</strong>?</p>
                <div className="flex flex-wrap gap-2">
                  <button type="button" onClick={handleResendVerification} disabled={loading} className="text-xs px-2.5 py-1.5 rounded-md border border-amber-500/30 bg-amber-500/20 text-amber-100">
                    Resend verification email
                  </button>
                  {resendAttempts >= 3 && (
                    <button type="button" onClick={handleSendVerificationCode} disabled={loading} className="text-xs px-2.5 py-1.5 rounded-md border border-violet-500/30 bg-violet-500/20 text-violet-100">
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
                    <button type="button" onClick={handleVerifyCode} disabled={loading} className="text-xs px-3 py-2 rounded-md border border-emerald-500/30 bg-emerald-500/20 text-emerald-100">
                      Verify
                    </button>
                  </div>
                )}
              </div>
            )}
          </form>

          <p className="text-center text-xs text-slate-400 mt-6">
            {mode === "login" ? (
              <>
                Don't have an account?{" "}
                <button
                  type="button"
                  onClick={() => switchMode("signup")}
                  className="text-violet-400 hover:text-violet-300 transition-colors font-medium"
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
                  className="text-violet-400 hover:text-violet-300 transition-colors font-medium"
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
                  className="text-violet-400 hover:text-violet-300 transition-colors font-medium"
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
