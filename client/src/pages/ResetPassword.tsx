import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { supabase } from "@/lib/supabase";
import { useToast } from "@/hooks/use-toast";
import { Lock, Eye, EyeOff, Loader2, CheckCircle, AlertCircle } from "lucide-react";
import { Link } from "wouter";
import { ThemeToggle } from "@/components/ThemeToggle";

type PageState = "loading" | "ready" | "success" | "invalid";

export default function ResetPassword() {
  const [pageState, setPageState] = useState<PageState>("loading");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showNew, setShowNew] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [loading, setLoading] = useState(false);
  const [passwordError, setPasswordError] = useState("");
  const [, setLocation] = useLocation();
  const { toast } = useToast();

  useEffect(() => {
    // Supabase sends different URL formats depending on config:
    //
    //  PKCE (browser-initiated, Supabase v2 default):
    //    /reset-password?code=XXXX
    //    → call supabase.auth.exchangeCodeForSession(code)
    //
    //  OTP hash (server-initiated or PKCE alternate):
    //    /reset-password?token_hash=XXXX&type=recovery
    //    → call supabase.auth.verifyOtp({ token_hash, type: 'recovery' })
    //
    //  Implicit (older clients / Supabase implicit flow):
    //    /reset-password#access_token=XXX&refresh_token=YYY&type=recovery
    //    → call supabase.auth.setSession(...)
    //
    // We also subscribe to onAuthStateChange in case Supabase's client-side
    // listener fires PASSWORD_RECOVERY before the component fully mounts.

    const url = new URL(window.location.href);
    const code = url.searchParams.get("code");
    const tokenHash = url.searchParams.get("token_hash");
    const type = url.searchParams.get("type");
    const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const accessToken = hashParams.get("access_token");
    const refreshToken = hashParams.get("refresh_token");
    const hashType = hashParams.get("type");

    // Subscribe to auth state changes — this catches PASSWORD_RECOVERY events
    // that fire before the component mounts (common with implicit flow).
    const { data: authListener } = supabase.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY") {
        setPageState("ready");
      }
    });

    const settle = (ok: boolean) => setPageState(ok ? "ready" : "invalid");

    if (code) {
      // PKCE flow — exchange authorization code for a session
      supabase.auth.exchangeCodeForSession(code).then(({ error }) => {
        if (error) console.error("[reset-password] exchangeCodeForSession:", error.message);
        settle(!error);
      });
    } else if (tokenHash && type === "recovery") {
      // OTP hash flow
      supabase.auth.verifyOtp({ token_hash: tokenHash, type: "recovery" }).then(({ error }) => {
        if (error) console.error("[reset-password] verifyOtp:", error.message);
        settle(!error);
      });
    } else if (accessToken && hashType === "recovery") {
      // Implicit flow — set the session from the URL hash
      supabase.auth
        .setSession({ access_token: accessToken, refresh_token: refreshToken ?? "" })
        .then(({ error }) => {
          if (error) console.error("[reset-password] setSession:", error.message);
          settle(!error);
        });
    } else {
      // No recognised token in URL — wait briefly for the auth listener to fire
      const timer = setTimeout(() => {
        setPageState((prev) => (prev === "loading" ? "invalid" : prev));
      }, 3000);
      return () => {
        clearTimeout(timer);
        authListener.subscription.unsubscribe();
      };
    }

    return () => authListener.subscription.unsubscribe();
  }, []);

  const validate = (): boolean => {
    if (newPassword.length < 8) {
      setPasswordError("Password must be at least 8 characters.");
      return false;
    }
    if (newPassword !== confirmPassword) {
      setPasswordError("Passwords do not match.");
      return false;
    }
    setPasswordError("");
    return true;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!validate()) return;
    setLoading(true);
    try {
      const { error } = await supabase.auth.updateUser({ password: newPassword });
      if (error) throw error;
      setPageState("success");
      toast({ title: "Password updated", description: "You can now log in with your new password." });
      setTimeout(() => setLocation("/login"), 2500);
    } catch (err: any) {
      toast({ title: "Error", description: err?.message || "Failed to update password.", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen w-full flex items-center justify-center px-4 bg-[radial-gradient(ellipse_80%_80%_at_50%_-20%,rgba(139,92,246,0.15),transparent)]">
      <div className="fixed top-4 right-4 z-30">
        <ThemeToggle />
      </div>
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <img src="/MCEC - White Logo.png" alt="MCEC Logo" loading="lazy" className="h-16 w-auto object-contain mx-auto mb-4 brightness-0 dark:brightness-100" />
          <h1 className="text-2xl font-bold gradient-text drop-shadow-[0_0_15px_rgba(139,92,246,0.5)]">
            SOMA
          </h1>
          <p className="text-xs text-muted-foreground mt-1 tracking-widest uppercase">Reset Password</p>
        </div>

        <div className="bg-card/50 backdrop-blur-md border border-border/50 rounded-2xl p-8 shadow-xl">

          {pageState === "loading" && (
            <div className="text-center py-8" data-testid="status-verifying">
              <Loader2 className="w-8 h-8 text-primary mx-auto animate-spin mb-3" />
              <p className="text-sm text-muted-foreground">Verifying your reset link…</p>
            </div>
          )}

          {pageState === "invalid" && (
            <div className="text-center py-4" data-testid="status-invalid-token">
              <AlertCircle className="w-12 h-12 text-danger mx-auto mb-4" />
              <h2 className="text-lg font-semibold text-foreground mb-2">Link expired or invalid</h2>
              <p className="text-sm text-muted-foreground mb-6">
                This password reset link has expired or already been used. Please request a new one.
              </p>
              <Link href="/forgot-password">
                <button
                  type="button"
                  className="glow-button w-full py-3 min-h-[44px] text-sm"
                  data-testid="button-request-new-link"
                >
                  Request New Link
                </button>
              </Link>
              <p className="text-center text-xs text-muted-foreground mt-4">
                <Link href="/login">
                  <span className="text-primary hover:text-primary/80 transition-colors cursor-pointer" data-testid="link-back-to-login">
                    Back to login
                  </span>
                </Link>
              </p>
            </div>
          )}

          {pageState === "success" && (
            <div className="text-center py-4" data-testid="status-password-updated">
              <CheckCircle className="w-12 h-12 text-success mx-auto mb-4" />
              <h2 className="text-lg font-semibold text-foreground mb-2">Password updated!</h2>
              <p className="text-sm text-muted-foreground">Redirecting you to the login page…</p>
            </div>
          )}

          {pageState === "ready" && (
            <>
              <div className="mb-6">
                <h2 className="text-lg font-semibold text-foreground">Set a new password</h2>
                <p className="text-sm text-muted-foreground mt-1">Choose a strong password of at least 8 characters.</p>
              </div>

              <form onSubmit={handleSubmit} className="space-y-4" data-testid="form-reset-password">
                <div>
                  <label className="text-xs text-muted-foreground mb-1.5 block font-medium">New Password</label>
                  <div className="relative">
                    <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                    <input
                      type={showNew ? "text" : "password"}
                      value={newPassword}
                      onChange={(e) => { setNewPassword(e.target.value); setPasswordError(""); }}
                      placeholder="••••••••"
                      required
                      minLength={8}
                      autoFocus
                      className="glass-input w-full pl-10 pr-12 py-3 text-sm"
                      data-testid="input-new-password"
                    />
                    <button
                      type="button"
                      onClick={() => setShowNew(!showNew)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 min-h-[44px] min-w-[44px] text-muted-foreground hover:text-foreground/80 transition-colors"
                      data-testid="button-toggle-new-password"
                    >
                      {showNew ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>

                <div>
                  <label className="text-xs text-muted-foreground mb-1.5 block font-medium">Confirm New Password</label>
                  <div className="relative">
                    <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                    <input
                      type={showConfirm ? "text" : "password"}
                      value={confirmPassword}
                      onChange={(e) => { setConfirmPassword(e.target.value); setPasswordError(""); }}
                      placeholder="••••••••"
                      required
                      minLength={8}
                      className="glass-input w-full pl-10 pr-12 py-3 text-sm"
                      data-testid="input-confirm-password"
                    />
                    <button
                      type="button"
                      onClick={() => setShowConfirm(!showConfirm)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 min-h-[44px] min-w-[44px] text-muted-foreground hover:text-foreground/80 transition-colors"
                      data-testid="button-toggle-confirm-password"
                    >
                      {showConfirm ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>

                {confirmPassword.length > 0 && (
                  <p
                    className={`text-xs ${newPassword === confirmPassword ? "text-success" : "text-danger"}`}
                    data-testid="text-password-match-status"
                  >
                    {newPassword === confirmPassword ? "✓ Passwords match" : "✗ Passwords do not match"}
                  </p>
                )}

                {passwordError && (
                  <p className="text-xs text-danger" data-testid="text-password-error">{passwordError}</p>
                )}

                <button
                  type="submit"
                  disabled={loading || newPassword !== confirmPassword || newPassword.length < 8}
                  className="glow-button w-full py-3 min-h-[44px] text-sm flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                  data-testid="button-update-password"
                >
                  {loading ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Updating password…
                    </>
                  ) : (
                    "Update Password"
                  )}
                </button>
              </form>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
