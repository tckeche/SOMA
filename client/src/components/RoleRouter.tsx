import { useEffect, useState } from "react";
import { Redirect } from "wouter";
import { Loader2 } from "lucide-react";
import { useSupabaseSession } from "@/hooks/use-supabase-session";
import { authFetch } from "@/lib/supabase";
import RoleRecovery from "@/components/RoleRecovery";

interface RoleRouterProps {
  studentComponent: React.ComponentType<any>;
  tutorComponent: React.ComponentType<any>;
}

export default function RoleRouter({ studentComponent: StudentComp, tutorComponent: TutorComp }: RoleRouterProps) {
  const { session, isLoading: isSessionLoading } = useSupabaseSession();
  const [role, setRole] = useState<string | null>(null);
  const [isRoleLoading, setIsRoleLoading] = useState(true);
  const [roleError, setRoleError] = useState(false);
  const [retryNonce, setRetryNonce] = useState(0);

  useEffect(() => {
    if (!session?.user?.id) {
      setRole(null);
      setRoleError(false);
      setIsRoleLoading(false);
      return;
    }

    setIsRoleLoading(true);
    setRoleError(false);
    authFetch("/api/auth/me")
      .then((res) => {
        if (!res.ok) throw new Error("Role lookup failed");
        return res.json();
      })
      .then((data) => {
        const nextRole = typeof data?.role === "string" ? data.role : null;
        if (!nextRole) throw new Error("Role missing");
        setRole(nextRole);
        setRoleError(false);
        setIsRoleLoading(false);
      })
      .catch(() => {
        setRole(null);
        setRoleError(true);
        setIsRoleLoading(false);
      });
  }, [session?.user?.id, retryNonce]);

  if (isSessionLoading || isRoleLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="w-8 h-8 text-primary animate-spin" />
          <p className="text-sm text-muted-foreground">Loading...</p>
        </div>
      </div>
    );
  }

  if (!session) {
    return <Redirect to="/login" />;
  }

  if (roleError) {
    return <RoleRecovery onRetry={() => setRetryNonce((n) => n + 1)} />;
  }

  if (role === "super_admin") {
    return <Redirect to="/super-admin" />;
  }

  if (role === "tutor") {
    return <TutorComp />;
  }

  return <StudentComp />;
}
