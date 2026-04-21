import React from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { AlertCircle, Home, RefreshCw } from "lucide-react";

type Props = {
  children: React.ReactNode;
  title?: string;
};

type State = {
  hasError: boolean;
  message?: string;
};

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(error: unknown) {
    const message = error instanceof Error ? error.message : String(error ?? "");
    return { hasError: true, message };
  }

  componentDidCatch(error: unknown) {
    console.error("UI runtime error:", error);
  }

  private handleReturnHome = () => {
    window.location.assign("/dashboard");
  };

  private handleReload = () => {
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-background flex items-center justify-center px-4">
          <Card className="w-full max-w-md text-center">
            <CardContent className="py-12">
              <AlertCircle className="w-12 h-12 mx-auto text-destructive/60 mb-3" />
              <h2 className="font-serif text-xl font-bold">{this.props.title || "Something went wrong"}</h2>
              <p className="text-sm text-muted-foreground mt-2">Please refresh the page and try again.</p>
              {this.state.message && (
                <p className="text-xs text-muted-foreground/70 mt-3 break-words font-mono" data-testid="text-error-detail">
                  {this.state.message}
                </p>
              )}
              <div className="mt-4 flex items-center justify-center gap-2">
                <Button variant="outline" onClick={this.handleReload} data-testid="button-error-reload">
                  <RefreshCw className="w-4 h-4 mr-1.5" />
                  Reload
                </Button>
                <Button variant="outline" onClick={this.handleReturnHome} data-testid="button-error-home">
                  <Home className="w-4 h-4 mr-1.5" />
                  Return Home
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      );
    }

    return this.props.children;
  }
}
