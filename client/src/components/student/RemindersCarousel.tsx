import { useCallback, useEffect, useState } from "react";
import useEmblaCarousel from "embla-carousel-react";
import { Lightbulb, ChevronLeft, ChevronRight, AlertTriangle } from "lucide-react";
import type { DashboardReminder } from "@/types/studentDashboard";

interface Props {
  reminders: DashboardReminder[];
}

const FREQUENCY_LABELS: Record<string, string> = {
  very_common: "Very common mistake",
  common: "Common mistake",
  occasional: "Watch out",
};

export default function RemindersCarousel({ reminders }: Props) {
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

  // Auto-advance every 9s
  useEffect(() => {
    if (!emblaApi || reminders.length <= 1) return;
    const id = setInterval(() => emblaApi.scrollNext(), 9000);
    return () => clearInterval(id);
  }, [emblaApi, reminders.length]);

  if (reminders.length === 0) {
    return (
      <section
        className="rounded-2xl border border-amber-500/20 bg-amber-500/5 p-5 shadow-lg"
        aria-label="Tips for your studies"
        data-testid="panel-reminders-empty"
      >
        <div className="flex items-center gap-2 text-amber-300 text-sm">
          <Lightbulb className="w-4 h-4" />
          Tips will appear once your subjects are set up.
        </div>
      </section>
    );
  }

  return (
    <section
      className="rounded-2xl border border-amber-500/20 bg-gradient-to-br from-amber-500/10 to-orange-500/5 p-5 shadow-lg"
      aria-label="Tips for your studies"
      data-testid="panel-reminders"
    >
      <header className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Lightbulb className="w-5 h-5 text-amber-300" />
          <div>
            <h2 className="text-sm font-semibold text-amber-200">Tips for your studies</h2>
            <p className="text-[11px] text-amber-300/70">
              Examiner-style reminders for the topics you're studying
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => emblaApi?.scrollPrev()}
            className="p-1.5 rounded-lg border border-amber-500/30 text-amber-300 hover:bg-amber-500/10"
            aria-label="Previous tip"
            data-testid="button-reminders-prev"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <button
            onClick={() => emblaApi?.scrollNext()}
            className="p-1.5 rounded-lg border border-amber-500/30 text-amber-300 hover:bg-amber-500/10"
            aria-label="Next tip"
            data-testid="button-reminders-next"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      </header>

      <div className="overflow-hidden" ref={emblaRef}>
        <div className="flex gap-4">
          {reminders.map((r) => {
            const badgeLabel = r.frequency ? FREQUENCY_LABELS[r.frequency] ?? "Common mistake" : null;
            return (
              <div
                key={r.id}
                className="flex-[0_0_100%] min-w-0 rounded-xl bg-card/60 border border-amber-500/15 p-4"
                data-testid={`reminder-${r.id}`}
              >
                <div className="flex items-center gap-2 mb-1.5">
                  <p className="text-[10px] uppercase tracking-wider text-amber-400/80">
                    {r.subject ? `${r.subject} · ${r.topic}` : r.topic}
                  </p>
                  {badgeLabel && (
                    <span
                      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[9px] font-semibold uppercase tracking-wide bg-rose-500/15 border border-rose-500/40 text-rose-300"
                      data-testid={`badge-frequency-${r.id}`}
                    >
                      <AlertTriangle className="w-2.5 h-2.5" />
                      {badgeLabel}
                    </span>
                  )}
                </div>
                <p className="text-sm leading-relaxed text-foreground" data-testid={`text-reminder-${r.id}`}>
                  {r.text}
                </p>
                {r.whyItMatters && (
                  <p
                    className="text-xs leading-relaxed text-amber-300/80 mt-1.5"
                    data-testid={`text-why-${r.id}`}
                  >
                    {r.whyItMatters}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {reminders.length > 1 && (
        <div className="flex items-center justify-center gap-1.5 mt-3">
          {reminders.map((_, i) => (
            <button
              key={i}
              onClick={() => emblaApi?.scrollTo(i)}
              className={`h-1.5 rounded-full transition-all ${i === selectedIndex ? "w-6 bg-amber-300" : "w-1.5 bg-amber-500/30"}`}
              aria-label={`Go to tip ${i + 1}`}
              data-testid={`dot-reminder-${i}`}
            />
          ))}
        </div>
      )}
    </section>
  );
}
