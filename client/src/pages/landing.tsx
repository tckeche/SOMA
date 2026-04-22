import { useEffect } from "react";
import { Link, useLocation } from "wouter";
import { useSupabaseSession } from "@/hooks/use-supabase-session";
import { Loader2 } from "lucide-react";
import { ThemeToggle } from "@/components/ThemeToggle";

export default function Landing() {
  const { session, isLoading: loading } = useSupabaseSession();
  const [, setLocation] = useLocation();

  useEffect(() => {
    if (!loading && session) {
      setLocation("/dashboard");
    }
  }, [loading, session, setLocation]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="w-8 h-8 text-violet-500 animate-spin" />
      </div>
    );
  }

  return (
    <div className="min-h-screen w-full relative overflow-hidden flex flex-col items-center justify-center px-4 bg-[radial-gradient(ellipse_80%_80%_at_50%_-20%,rgba(139,92,246,0.2),transparent)]">
      <div className="fixed top-4 right-4 z-30">
        <ThemeToggle />
      </div>
      <div className="text-center z-10 relative">
        <img src="/MCEC - White Logo.png" alt="MCEC Logo" loading="lazy" className="h-[106px] w-auto object-contain mx-auto mb-8 brightness-0 dark:brightness-100" />

        <h1 className="text-4xl md:text-6xl font-black gradient-text drop-shadow-[0_0_20px_rgba(139,92,246,0.3)] tracking-tight mb-4" data-testid="text-main-title">
          Welcome to SOMA
        </h1>

        <p className="text-sm md:text-lg font-light tracking-[0.2em] text-muted-foreground uppercase mb-1" data-testid="text-subtitle">
          An Intelligent Assessment Platform
        </p>

        <p className="text-sm md:text-base font-light tracking-[0.2em] text-muted-foreground uppercase" data-testid="text-byline">
          by MCEC
        </p>

        <Link href="/login">
          <button
            className="bg-gradient-to-r from-violet-600 to-indigo-600 hover:shadow-[0_0_20px_rgba(139,92,246,0.6)] text-white font-medium rounded-full px-8 py-4 min-h-[44px] mt-10 transition-all block w-fit mx-auto cursor-pointer"
            data-testid="button-enter-portal"
          >
            Enter Student Portal
          </button>
        </Link>

        <Link href="/login">
          <span
            className="text-xs text-muted-foreground hover:text-violet-400 mt-6 tracking-widest uppercase transition-colors block mx-auto cursor-pointer"
            data-testid="link-admin-access"
          >
            Tutor Access
          </span>
        </Link>
      </div>
    </div>
  );
}
