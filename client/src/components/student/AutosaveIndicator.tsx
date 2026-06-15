import { useEffect, useState } from "react";
import { Check, CloudOff, Loader2 } from "lucide-react";
import { formatSavedLabel, type SaveStatus } from "@/lib/quizAutosave";

// A compact pill that reassures the student their progress is being saved.
// States: idle (shows nothing), saving (spinner), saved (tick + relative
// time), failed (cloud-off icon + warning colour).
export function AutosaveIndicator({
  status,
  savedAt,
}: {
  status: SaveStatus;
  savedAt: string | null;
}) {
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    if (status !== "saved" || !savedAt) return;
    const id = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(id);
  }, [status, savedAt]);

  if (status === "idle") return null;

  if (status === "saving") {
    return (
      <span
        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[11px] font-medium bg-muted/60 text-foreground/80 border-border/60"
        role="status"
        aria-live="polite"
        data-testid="autosave-indicator"
      >
        <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" />
        Saving…
      </span>
    );
  }

  if (status === "failed") {
    return (
      <span
        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[11px] font-medium bg-danger/10 text-danger border-danger/30"
        role="status"
        aria-live="assertive"
        data-testid="autosave-indicator"
      >
        <CloudOff className="w-3 h-3" aria-hidden="true" />
        Couldn't save — check your connection
      </span>
    );
  }

  // saved
  return (
    <span
      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[11px] font-medium bg-success/10 text-success border-success/30"
      role="status"
      aria-live="polite"
      data-testid="autosave-indicator"
    >
      <Check className="w-3 h-3" aria-hidden="true" />
      {formatSavedLabel(savedAt, now)}
    </span>
  );
}

export default AutosaveIndicator;
