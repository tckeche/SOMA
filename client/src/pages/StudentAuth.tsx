import { useState } from "react";
import { useLocation } from "wouter";
import { supabase, authFetch } from "@/lib/supabase";
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
  const [, setLocation] = useLocation();
  const { toast } = useToast();

  const resetForm = () => {
    setEmail("");
    setPassword("");
    setDisplayName("");
    setShowPassword(false);
    setFormErrors({});
  };

  const switchMode = (newMode: AuthMode) => {
    resetForm();
    setMode(newMode);
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
    setLoading(true);

    try {
      const { data, error } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (error) throw error;

      if (data.user) {
        const syncRes = await authFetch("/api/auth/sync", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            user_metadata: data.user.user_metadata,
          }),
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
      const msg = err?.message || "";
      let friendly = "Something went wrong. Please try again.";
      if (msg.includes("Invalid login credentials")) {
        friendly = "Incorrect email or password. Please try again.";
      } else if (msg.includes("Email not confirmed")) {
        friendly = "Please check your email and verify your account first.";
      } else if (msg.includes("User not found")) {
        friendly = "No account found with that email address.";
      } else if (msg) {
        friendly = msg;
      }
      toast({
        title: "Login failed",
        description: friendly,
        variant: "destructive",
      });
    } finally {
      setLoading(false);
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
    setLoading(true);

    try {
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: {
          data: {
            display_name: displayName || email.split("@")[0],
          },
        },
      });

      if (error) throw error;

      if (data.session) {
        const syncRes = await authFetch("/api/auth/sync", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            user_metadata: data.user!.user_metadata,
          }),
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
        toast({
          title: "Account created",
          description: "Please check your email to verify your account, then log in.",
        });
        switchMode("login");
      }
    } catch (err: any) {
      const msg = err?.message || "";
      let friendly = "Could not create account.";
      if (msg.includes("already registered") || msg.includes("already been registered")) {
        friendly = "An account with this email already exists. Try logging in instead.";
      } else if (msg) {
        friendly = msg;
      }
      toast({
        title: "Sign up failed",
        description: friendly,
        variant: "destructive",
      });
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
    setLoading(true);
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: window.location.origin + "/reset-password",
      });
      if (error) throw error;
      toast({ title: "Reset email sent", description: "Check your inbox for a password reset link." });
      switchMode("login");
    } catch (err: any) {
      toast({ title: "Reset failed", description: err?.message || "Something went wrong.", variant: "destructive" });
    } finally {
      setLoading(false);
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
