import { useCallback, useEffect, useState } from "react";
import useEmblaCarousel from "embla-carousel-react";
import { Sparkles, ChevronLeft, ChevronRight, AlertTriangle } from "lucide-react";

export interface ExaminerInsightCard {
  id: string;
  subject: string;
  level?: string | null;
  topic: string;
  /** The misconception / what examiners repeatedly flag. */
  text: string;
  /** Why it matters / the typical student error. */
  whyItMatters?: string | null;
  /** The correct approach examiners want to see. */
  action?: string | null;
  frequency?: string | null;
}

interface Props {
  insights: ExaminerInsightCard[];
}

const FREQUENCY_LABELS: Record<string, string> = {
  very_common: "Very common in reports",
  common: "Common in reports",
  occasional: "Worth watching",
};

// A carousel of examiner-report insights drawn from across every subject and
// level the student is studying. Each card is one specific, recurring point an
// examiner flagged — labelled by subject · level · topic so the student knows
// exactly what it applies to.
export default function ExaminerInsightsCarousel({ insights }: Props) {
  const [emblaRef, emblaApi] = useEmblaCarousel({ loop: true, align: "start" });
  const [selectedIndex, setSelectedIndex] = useState(0);

  const onSelect = useCallback(() => {
    if (!emblaApi) return;
    setSelectedIndex(emblaApi.selectedScrollSnap());
  }, [emblaApi]);

  useEffect(() => {
    if (!emblaApi) return;
    emblaApi.on("select", onSelect);
    onSelect();
    return () => {
      emblaApi.off("select", onSelect);
    };
  }, [emblaApi, onSelect]);

  // Auto-advance every 9s (only when there's more than one card).
  useEffect(() => {
    if (!emblaApi || insights.length <= 1) return;
    const id = setInterval(() => emblaApi.scrollNext(), 9000);
    return () => clearInterval(id);
  }, [emblaApi, insights.length]);

  if (insights.length === 0) return null;

  return (
    <section
      className="soma-card"
      style={{ padding: 22 }}
      aria-label="Examiner insights"
      data-testid="panel-examiner-insights"
    >
      <header className="row between wrap" style={{ marginBottom: 14, gap: 10 }}>
        <div className="row" style={{ gap: 10 }}>
          <span
            className="grid place-items-center"
            style={{ width: 32, height: 32, borderRadius: 9, background: "hsl(var(--accent))", color: "hsl(var(--accent-foreground))", border: "1px solid var(--accent-border)" }}
          >
            <Sparkles className="w-4 h-4" />
          </span>
          <div>
            <div className="eyebrow">Examiner insights</div>
            <h3 className="soma-display" style={{ fontSize: 18, marginTop: 2 }}>What examiners keep flagging</h3>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground" style={{ fontSize: 11 }}>{insights.length} insights</span>
          <div className="flex items-center gap-1">
            <button
              onClick={() => emblaApi?.scrollPrev()}
              className="p-1.5 rounded-lg border border-border text-muted-foreground hover:text-foreground hover:bg-muted/60"
              aria-label="Previous insight"
              data-testid="button-examiner-prev"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <button
              onClick={() => emblaApi?.scrollNext()}
              className="p-1.5 rounded-lg border border-border text-muted-foreground hover:text-foreground hover:bg-muted/60"
              aria-label="Next insight"
              data-testid="button-examiner-next"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      </header>

      <div className="overflow-hidden" ref={emblaRef}>
        <div className="flex gap-4">
          {insights.map((r) => {
            const badgeLabel = r.frequency ? FREQUENCY_LABELS[r.frequency] ?? "Common in reports" : null;
            const context = [r.subject, r.level].filter(Boolean).join(" · ");
            return (
              <div
                key={r.id}
                className="flex-[0_0_100%] min-w-0 rounded-xl bg-card/60 border border-border p-4"
                data-testid={`examiner-insight-${r.id}`}
              >
                <div className="flex items-center gap-2 flex-wrap mb-2">
                  <span className="text-[10px] uppercase tracking-wider text-accent-foreground font-semibold" style={{ color: "hsl(var(--accent-foreground))" }}>
                    {context ? `${context} · ${r.topic}` : r.topic}
                  </span>
                  {badgeLabel && (
                    <span
                      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[9px] font-semibold uppercase tracking-wide bg-danger/15 border border-danger/40 text-danger"
                      data-testid={`examiner-frequency-${r.id}`}
                    >
                      <AlertTriangle className="w-2.5 h-2.5" />
                      {badgeLabel}
                    </span>
                  )}
                </div>
                <p className="text-sm leading-relaxed text-foreground" data-testid={`examiner-text-${r.id}`}>
                  {r.text}
                </p>
                {r.whyItMatters && (
                  <p className="text-xs leading-relaxed text-muted-foreground mt-2">
                    {r.whyItMatters}
                  </p>
                )}
                {r.action && (
                  <p className="text-[13px] leading-relaxed mt-2 font-semibold">
                    <span style={{ color: "hsl(var(--accent-foreground))" }}>Do this → </span>
                    <span className="text-foreground">{r.action}</span>
                  </p>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {insights.length > 1 && (
        <div className="flex items-center justify-center gap-1.5 mt-3">
          {insights.map((_, i) => (
            <button
              key={i}
              onClick={() => emblaApi?.scrollTo(i)}
              className={`h-1.5 rounded-full transition-all ${i === selectedIndex ? "w-6 bg-foreground/70" : "w-1.5 bg-muted-foreground/30"}`}
              aria-label={`Go to insight ${i + 1}`}
              data-testid={`examiner-dot-${i}`}
            />
          ))}
        </div>
      )}
    </section>
  );
}
