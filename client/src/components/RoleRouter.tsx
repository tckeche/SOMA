import { useEffect, useState } from "react";
import { Redirect } from "wouter";
import { Loader2 } from "lucide-react";
import { useSupabaseSession } from "@/hooks/use-supabase-session";
import { authFetch } from "@/lib/supabase";

interface RoleRouterProps {
  studentComponent: React.ComponentType<any>;
  tutorComponent: React.ComponentType<any>;
}

export default function RoleRouter({ studentComponent: StudentComp, tutorComponent: TutorComp }: RoleRouterProps) {
  const { session, isLoading: isSessionLoading } = useSupabaseSession();
  const [role, setRole] = useState<string | null>(null);
  const [isRoleLoading, setIsRoleLoading] = useState(true);

  useEffect(() => {
    if (!session?.user?.id) {
      setRole(null);
      setIsRoleLoading(false);
      return;
    }

    setIsRoleLoading(true);
    authFetch("/api/auth/me")
      .then((res) => res.json())
      .then((data) => {
        setRole(data.role || "student");
        setIsRoleLoading(false);
      })
      .catch(() => {
        setRole("student");
        setIsRoleLoading(false);
      });
  }, [session?.user?.id]);

  if (isSessionLoading || isRoleLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="w-8 h-8 text-violet-500 animate-spin" />
          <p className="text-sm text-muted-foreground">Loading...</p>
        </div>
      </div>
    );
  }

  if (!session) {
    return <Redirect to="/login" />;
  }

  if (role === "super_admin") {
    return <Redirect to="/super-admin" />;
  }

  if (role === "tutor") {
    return <TutorComp />;
  }

  return <StudentComp />;
}
