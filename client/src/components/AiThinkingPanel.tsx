import { useEffect, useState } from "react";
import { Sparkles } from "lucide-react";

/**
 * Rotates through a list of short status messages on a fixed interval, so a
 * long AI wait shows visible, changing progress instead of a frozen spinner.
 * Cleans up its timer on unmount / when the message set changes.
 */
export function useRotatingMessage(messages: string[], intervalMs = 2200): string {
  const [idx, setIdx] = useState(0);
  useEffect(() => {
    setIdx(0);
    if (messages.length <= 1) return;
    const id = setInterval(() => setIdx((i) => (i + 1) % messages.length), intervalMs);
    return () => clearInterval(id);
  }, [messages.length, intervalMs]);
  return messages[idx] ?? "";
}

interface AiThinkingPanelProps {
  /** Bold header line, e.g. "SOMA is analysing this student". */
  title?: string;
  /** Short phrases cycled every ~2.2s to make the wait feel alive. */
  messages?: string[];
  /** Number of shimmer skeleton lines that preview the eventual content. */
  lines?: number;
  className?: string;
  "data-testid"?: string;
}

const DEFAULT_MESSAGES = [
  "Reviewing the evidence…",
  "Cross-referencing the syllabus…",
  "Identifying the key gaps…",
  "Drafting recommendations…",
];

/**
 * On-brand "AI is thinking" panel for extended generation waits (Premium design
 * system v2): a pulsing brand mark, a rotating status line, an indeterminate
 * shimmer bar, and shimmer skeleton lines that hint at the content to come.
 * Built entirely from the existing index.css animation primitives
 * (status-pulse / progress-shimmer / shimmer-pulse / skeleton-bar) so it stays
 * visually consistent and adds no new dependencies.
 */
export function AiThinkingPanel({
  title = "SOMA is thinking",
  messages = DEFAULT_MESSAGES,
  lines = 3,
  className = "",
  "data-testid": dataTestId = "ai-thinking-panel",
}: AiThinkingPanelProps) {
  const message = useRotatingMessage(messages);

  return (
    <div
      className={`rounded-xl border border-primary/20 bg-primary/[0.04] p-4 ${className}`}
      role="status"
      aria-live="polite"
      data-testid={dataTestId}
    >
      <div className="flex items-center gap-2.5">
        <span className="relative flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary/15">
          <span className="absolute inset-0 rounded-lg border border-primary/30 animate-ping" />
          <Sparkles className="relative h-3.5 w-3.5 text-primary status-pulse" />
        </span>
        <div className="min-w-0">
          <p className="text-[13px] font-semibold text-foreground/90 leading-tight">{title}</p>
          {/* key forces a fresh fade-in each time the phrase changes */}
          <p
            key={message}
            className="text-[11px] text-primary/80 leading-tight shimmer-pulse"
            data-testid={`${dataTestId}-message`}
          >
            {message}
          </p>
        </div>
      </div>

      {/* Indeterminate shimmer bar — reuses the progress-shimmer keyframe. */}
      <div className="mt-3 h-1 w-full overflow-hidden rounded-full bg-foreground/[0.06]">
        <div className="h-full w-full rounded-full bg-gradient-to-r from-transparent via-primary to-transparent opacity-70 progress-shimmer" />
      </div>

      {/* Shimmer skeleton lines previewing the eventual content. */}
      <div className="mt-3 space-y-2">
        {Array.from({ length: lines }).map((_, i) => (
          <div
            key={i}
            className="skeleton-bar h-3"
            style={{ width: `${Math.max(40, 92 - i * 14)}%` }}
          />
        ))}
      </div>
    </div>
  );
}
