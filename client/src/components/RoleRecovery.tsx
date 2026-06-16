import { AlertCircle, LogOut, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { supabase } from "@/lib/supabase";

export default function RoleRecovery({ onRetry }: { onRetry: () => void }) {
  const handleSignOut = async () => {
    await supabase.auth.signOut();
    window.location.assign("/login");
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <div className="w-full max-w-md rounded-2xl border border-danger/30 bg-card/90 p-8 text-center shadow-xl" data-testid="role-recovery">
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full border border-danger/30 bg-danger/10">
          <AlertCircle className="h-7 w-7 text-danger" aria-hidden="true" />
        </div>
        <h1 className="text-xl font-bold text-foreground">We couldn't confirm your account role</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Your data is safe, but we need to verify whether this account is a student, tutor, or admin before opening the portal.
        </p>
        <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:justify-center">
          <Button onClick={onRetry} className="gap-2" data-testid="button-retry-role">
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
            Try again
          </Button>
          <Button variant="outline" onClick={handleSignOut} className="gap-2" data-testid="button-role-sign-out">
            <LogOut className="h-4 w-4" aria-hidden="true" />
            Sign out
          </Button>
        </div>
        <p className="mt-4 text-xs text-muted-foreground/80">
          If this keeps happening, contact support and mention that role lookup failed after sign-in.
        </p>
      </div>
    </div>
  );
}
