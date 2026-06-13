import React from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { AlertCircle, Home, RefreshCw } from "lucide-react";
import { createClientErrorId, getActiveClientRequestId, sendClientErrorReport } from "@/lib/clientDiagnostics";

type Props = {
  children: React.ReactNode;
  title?: string;
};

type State = {
  hasError: boolean;
  errorId?: string;
};

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: unknown, errorInfo: React.ErrorInfo) {
    const fallbackErrorId = getActiveClientRequestId() || createClientErrorId();
    this.setState({ errorId: fallbackErrorId });
    console.error("UI runtime error:", { error, errorId: fallbackErrorId });

    void sendClientErrorReport({
      error,
      componentStack: errorInfo.componentStack,
      boundaryTitle: this.props.title,
      requestId: fallbackErrorId,
    }).then((requestId) => {
      this.setState({ errorId: requestId });
    }).catch((reportError) => {
      console.warn("Unable to send client error report", reportError);
    });
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
              <p className="text-sm text-muted-foreground mt-2">
                Something went wrong. Please reload the page or return to your dashboard.
              </p>
              {this.state.errorId && (
                <p className="text-xs text-muted-foreground/70 mt-3" data-testid="text-error-reference">
                  Error reference: {this.state.errorId}
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
