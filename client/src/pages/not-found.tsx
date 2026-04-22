import { AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Link } from "wouter";
import { Home } from "lucide-react";

export default function NotFound() {
  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-background">
      <div className="glass-card w-full max-w-md mx-4 p-10 text-center">
        <AlertCircle className="h-12 w-12 text-red-400/60 mx-auto mb-4" />
        <h1 className="text-2xl font-bold gradient-text mb-2">404 Page Not Found</h1>
        <p className="text-sm text-muted-foreground mb-6">
          The page you're looking for doesn't exist.
        </p>
        <Link href="/dashboard">
          <Button className="glow-button" data-testid="button-back-home-404">
            <Home className="w-4 h-4 mr-1.5" />
            Return Home
          </Button>
        </Link>
      </div>
    </div>
  );
}
