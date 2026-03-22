import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { supabase } from "@/lib/supabase";
import { useToast } from "@/hooks/use-toast";
import { Lock, Eye, EyeOff, Loader2, CheckCircle, AlertCircle } from "lucide-react";
import { Link } from "wouter";

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
    // Supabase recovery links arrive in two flavours:
    //   PKCE  → ?token_hash=XXX&type=recovery  (Supabase v2 default)
    //   Implicit → #access_token=XXX&type=recovery
    const url = new URL(window.location.href);
    const tokenHash = url.searchParams.get("token_hash");
    const type = url.searchParams.get("type");
    const hashParams = new URLSearchParams(window.location.hash.slice(1));
    const accessToken = hashParams.get("access_token");
    const refreshToken = hashParams.get("refresh_token");
    const hashType = hashParams.get("type");

    if (tokenHash && type === "recovery") {
      // PKCE flow — verify OTP to establish a session
      supabase.auth
        .verifyOtp({ token_hash: tokenHash, type: "recovery" })
        .then(({ error }) => {
          if (error) {
            console.error("[reset-password] verifyOtp error:", error);
            setPageState("invalid");
          } else {
            setPageState("ready");
          }
        });
    } else if (accessToken && hashType === "recovery") {
      // Implicit flow — set the session directly from the hash tokens
      supabase.auth
        .setSession({ access_token: accessToken, refresh_token: refreshToken ?? "" })
        .then(({ error }) => {
          if (error) {
            console.error("[reset-password] setSession error:", error);
            setPageState("invalid");
          } else {
            setPageState("ready");
          }
        });
    } else {
      // Listen for PASSWORD_RECOVERY event (emitted when Supabase detects the URL)
      const { data: listener } = supabase.auth.onAuthStateChange((event) => {
        if (event === "PASSWORD_RECOVERY") {
          setPageState("ready");
        }
      });

      // Give the auth listener a moment before deciding the link is invalid
      const timer = setTimeout(() => {
        setPageState((prev) => (prev === "loading" ? "invalid" : prev));
      }, 3000);

      return () => {
        listener.subscription.unsubscribe();
        clearTimeout(timer);
      };
    }
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
      const msg = err?.message || "Failed to update password.";
      toast({ title: "Error", description: msg, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen w-full flex items-center justify-center px-4 bg-[radial-gradient(ellipse_80%_80%_at_50%_-20%,rgba(139,92,246,0.15),transparent)]">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <img src="/MCEC - White Logo.png" alt="MCEC Logo" loading="lazy" className="h-16 w-auto object-contain mx-auto mb-4" />
          <h1 className="text-2xl font-bold gradient-text drop-shadow-[0_0_15px_rgba(139,92,246,0.5)]">
            SOMA
          </h1>
          <p className="text-xs text-slate-400 mt-1 tracking-widest uppercase">Reset Password</p>
        </div>

        <div className="bg-slate-900/50 backdrop-blur-md border border-white/10 rounded-2xl p-8 shadow-[0_8px_32px_rgba(0,0,0,0.4)]">

          {/* Loading */}
          {pageState === "loading" && (
            <div className="text-center py-8" data-testid="status-verifying">
              <Loader2 className="w-8 h-8 text-violet-400 mx-auto animate-spin mb-3" />
              <p className="text-sm text-slate-400">Verifying your reset link…</p>
            </div>
          )}

          {/* Invalid / expired link */}
          {pageState === "invalid" && (
            <div className="text-center py-4" data-testid="status-invalid-token">
              <AlertCircle className="w-12 h-12 text-red-400 mx-auto mb-4" />
              <h2 className="text-lg font-semibold text-white mb-2">Link expired or invalid</h2>
              <p className="text-sm text-slate-400 mb-6">
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
              <p className="text-center text-xs text-slate-400 mt-4">
                <Link href="/login">
                  <span className="text-violet-400 hover:text-violet-300 transition-colors cursor-pointer" data-testid="link-back-to-login">
                    Back to login
                  </span>
                </Link>
              </p>
            </div>
          )}

          {/* Success */}
          {pageState === "success" && (
            <div className="text-center py-4" data-testid="status-password-updated">
              <CheckCircle className="w-12 h-12 text-emerald-400 mx-auto mb-4" />
              <h2 className="text-lg font-semibold text-white mb-2">Password updated!</h2>
              <p className="text-sm text-slate-400">Redirecting you to the login page…</p>
            </div>
          )}

          {/* New password form */}
          {pageState === "ready" && (
            <>
              <div className="mb-6">
                <h2 className="text-lg font-semibold text-white">Set a new password</h2>
                <p className="text-sm text-slate-400 mt-1">Choose a strong password of at least 8 characters.</p>
              </div>

              <form onSubmit={handleSubmit} className="space-y-4" data-testid="form-reset-password">
                <div>
                  <label className="text-xs text-slate-400 mb-1.5 block font-medium">New Password</label>
                  <div className="relative">
                    <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
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
                      className="absolute right-3 top-1/2 -translate-y-1/2 min-h-[44px] min-w-[44px] text-slate-400 hover:text-slate-300 transition-colors"
                      data-testid="button-toggle-new-password"
                    >
                      {showNew ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>

                <div>
                  <label className="text-xs text-slate-400 mb-1.5 block font-medium">Confirm New Password</label>
                  <div className="relative">
                    <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
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
                      className="absolute right-3 top-1/2 -translate-y-1/2 min-h-[44px] min-w-[44px] text-slate-400 hover:text-slate-300 transition-colors"
                      data-testid="button-toggle-confirm-password"
                    >
                      {showConfirm ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>

                {/* Live password match indicator */}
                {confirmPassword.length > 0 && (
                  <p
                    className={`text-xs ${newPassword === confirmPassword ? "text-emerald-400" : "text-red-400"}`}
                    data-testid="text-password-match-status"
                  >
                    {newPassword === confirmPassword ? "✓ Passwords match" : "✗ Passwords do not match"}
                  </p>
                )}

                {passwordError && (
                  <p className="text-xs text-red-400" data-testid="text-password-error">{passwordError}</p>
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
