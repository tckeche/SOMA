import { useState } from "react";
import { Link } from "wouter";
import { useToast } from "@/hooks/use-toast";
import { Mail, ArrowLeft, Loader2, CheckCircle } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { apiRequest } from "@/lib/queryClient";
import { ThemeToggle } from "@/components/ThemeToggle";

export default function ForgotPassword() {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const { toast } = useToast();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = email.trim().toLowerCase();
    if (!trimmed) {
      toast({ title: "Email required", description: "Please enter your email address.", variant: "destructive" });
      return;
    }
    setLoading(true);
    try {
      // Step 1 — backend validates email exists and logs the request (audit trail)
      await apiRequest("POST", "/api/auth/forgot-password", { email: trimmed });

      // Step 2 — browser calls Supabase directly so the PKCE code-verifier is
      // stored in this browser's localStorage.  This is what makes the email
      // link work: when the user clicks it, the verifier is present to exchange.
      const redirectTo = `${window.location.origin}/reset-password`;
      const { error } = await supabase.auth.resetPasswordForEmail(trimmed, { redirectTo });
      if (error) {
        // Supabase errors here are usually config issues; still show success to
        // avoid leaking whether an account exists.
        console.error("[forgot-password] supabase error:", error.message);
      }

      setSent(true);
    } catch (err: any) {
      const msg = err?.message || "Something went wrong. Please try again.";
      if (msg.includes("Too many")) {
        toast({ title: "Too many attempts", description: "Please wait 15 minutes before trying again.", variant: "destructive" });
      } else {
        toast({ title: "Error", description: msg, variant: "destructive" });
      }
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
        <Link href="/login">
          <span
            className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-primary transition-colors cursor-pointer mb-8 block"
            data-testid="link-back-to-login"
          >
            <ArrowLeft className="w-4 h-4" />
            Back to login
          </span>
        </Link>

        <div className="text-center mb-8">
          <img src="/MCEC - White Logo.png" alt="MCEC Logo" loading="lazy" className="h-16 w-auto object-contain mx-auto mb-4 brightness-0 dark:brightness-100" />
          <h1 className="text-2xl font-bold gradient-text drop-shadow-[0_0_15px_rgba(139,92,246,0.5)]">
            SOMA
          </h1>
          <p className="text-xs text-muted-foreground mt-1 tracking-widest uppercase">Password Recovery</p>
        </div>

        <div className="bg-card/50 backdrop-blur-md border border-border/50 rounded-2xl p-8 shadow-xl">
          {sent ? (
            <div className="text-center py-4" data-testid="status-reset-sent">
              <CheckCircle className="w-12 h-12 text-success mx-auto mb-4" />
              <h2 className="text-lg font-semibold text-foreground mb-2">Check your inbox</h2>
              <p className="text-sm text-muted-foreground mb-6">
                If <span className="text-primary font-medium">{email}</span> is registered, you'll receive a password reset link shortly. Check your spam folder if it doesn't arrive within a minute.
              </p>
              <Link href="/login">
                <button
                  type="button"
                  className="glow-button w-full py-3 min-h-[44px] text-sm"
                  data-testid="button-back-to-login"
                >
                  Back to Login
                </button>
              </Link>
            </div>
          ) : (
            <>
              <div className="mb-6">
                <h2 className="text-lg font-semibold text-foreground">Forgot your password?</h2>
                <p className="text-sm text-muted-foreground mt-1">
                  Enter the email address linked to your account and we'll send you a reset link.
                </p>
              </div>

              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <label className="text-xs text-muted-foreground mb-1.5 block font-medium">Email address</label>
                  <div className="relative">
                    <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                    <input
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="student@example.com"
                      required
                      autoFocus
                      className="glass-input w-full pl-10 pr-4 py-3 text-sm"
                      data-testid="input-reset-email"
                    />
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={loading}
                  className="glow-button w-full py-3 min-h-[44px] text-sm flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                  data-testid="button-send-reset"
                >
                  {loading ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Sending reset link...
                    </>
                  ) : (
                    "Send Reset Link"
                  )}
                </button>
              </form>

              <p className="text-center text-xs text-muted-foreground mt-6">
                Remember your password?{" "}
                <Link href="/login">
                  <span className="text-primary hover:text-primary/80 transition-colors font-medium cursor-pointer" data-testid="link-sign-in">
                    Sign in
                  </span>
                </Link>
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
