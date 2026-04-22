import { Redirect } from "wouter";
import { Loader2 } from "lucide-react";
import { useSupabaseSession } from "@/hooks/use-supabase-session";

interface ProtectedRouteProps {
  component: React.ComponentType<any>;
}

export default function ProtectedRoute({ component: Component, ...rest }: ProtectedRouteProps & Record<string, any>) {
  const { session, isLoading } = useSupabaseSession();

  if (isLoading) {
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

  return <Component {...rest} />;
}
