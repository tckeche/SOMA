import type React from "react";
import { AlertCircle, BookOpen, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

export function DataErrorState({
  title,
  message,
  onRetry,
  testId = "data-error-state",
}: {
  title: string;
  message: string;
  onRetry?: () => void;
  testId?: string;
}) {
  return (
    <div className="rounded-2xl border border-danger/30 bg-danger/10 p-8 text-center" data-testid={testId}>
      <AlertCircle className="mx-auto mb-3 h-10 w-10 text-danger" aria-hidden="true" />
      <h3 className="text-base font-semibold text-danger">{title}</h3>
      <p className="mx-auto mt-2 max-w-xl text-sm text-danger/90">{message}</p>
      {onRetry && (
        <Button variant="outline" onClick={onRetry} className="mt-4 gap-2 border-danger/40 text-danger hover:bg-danger/10" data-testid={`${testId}-retry`}>
          <RefreshCw className="h-4 w-4" aria-hidden="true" />
          Retry
        </Button>
      )}
    </div>
  );
}

export function EmptyState({
  title,
  message,
  action,
  testId = "empty-state",
}: {
  title: string;
  message: string;
  action?: React.ReactNode;
  testId?: string;
}) {
  return (
    <div className="rounded-2xl border border-card-border bg-card/70 p-10 text-center" data-testid={testId}>
      <BookOpen className="mx-auto mb-4 h-12 w-12 text-muted-foreground" aria-hidden="true" />
      <h3 className="text-base font-semibold text-foreground">{title}</h3>
      <p className="mx-auto mt-2 max-w-xl text-sm text-muted-foreground">{message}</p>
      {action && <div className="mt-5 flex justify-center">{action}</div>}
    </div>
  );
}
