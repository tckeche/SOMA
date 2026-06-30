import { Redirect } from "wouter";
import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { useSupabaseSession } from "@/hooks/use-supabase-session";
import { authFetch } from "@/lib/supabase";

interface ProtectedRouteProps {
  component: React.ComponentType<any>;
  // When provided, the route additionally requires the authenticated user's
  // role to be in this set. This is defense-in-depth: the server already
  // enforces authorization on every data call, but without a role gate a
  // logged-in student could still load a tutor/admin page *shell* (and hit a
  // wall of 403s). With it, they're redirected to their own home instead.
  allowedRoles?: string[];
}

function FullScreenLoader() {
  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="flex flex-col items-center gap-3">
        <Loader2 className="w-8 h-8 text-primary animate-spin" />
        <p className="text-sm text-muted-foreground">Loading...</p>
      </div>
    </div>
  );
}

export default function ProtectedRoute({ component: Component, allowedRoles, ...rest }: ProtectedRouteProps & Record<string, any>) {
  const { session, isLoading } = useSupabaseSession();
  const [role, setRole] = useState<string | null>(null);
  const [isRoleLoading, setIsRoleLoading] = useState(!!allowedRoles);

  useEffect(() => {
    if (!allowedRoles) return; // no role gate requested — auth-only route
    if (!session?.user?.id) {
      setRole(null);
      setIsRoleLoading(false);
      return;
    }
    let active = true;
    setIsRoleLoading(true);
    authFetch("/api/auth/me")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!active) return;
        setRole(typeof data?.role === "string" ? data.role : null);
        setIsRoleLoading(false);
      })
      .catch(() => {
        if (!active) return;
        setRole(null);
        setIsRoleLoading(false);
      });
    return () => {
      active = false;
    };
  }, [allowedRoles, session?.user?.id]);

  if (isLoading || (allowedRoles && isRoleLoading)) {
    return <FullScreenLoader />;
  }

  if (!session) {
    return <Redirect to="/login" />;
  }

  if (allowedRoles && (!role || !allowedRoles.includes(role))) {
    // Authenticated but wrong role — bounce to /portal, which routes each role
    // to its correct home (student dashboard / tutor / super-admin).
    return <Redirect to="/portal" />;
  }

  return <Component {...rest} />;
}
