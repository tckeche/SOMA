import { useCallback, useEffect, useState } from "react";
import useEmblaCarousel from "embla-carousel-react";
import { Lightbulb, ChevronLeft, ChevronRight } from "lucide-react";
import type { DashboardReminder } from "@/types/studentDashboard";

interface Props {
  reminders: DashboardReminder[];
}

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
        aria-label="Things to remember"
        data-testid="panel-reminders-empty"
      >
        <div className="flex items-center gap-2 text-amber-300 text-sm">
          <Lightbulb className="w-4 h-4" />
          Reminders will appear once your subjects are set up.
        </div>
      </section>
    );
  }

  return (
    <section
      className="rounded-2xl border border-amber-500/20 bg-gradient-to-br from-amber-500/10 to-orange-500/5 p-5 shadow-lg"
      aria-label="Things to remember"
      data-testid="panel-reminders"
    >
      <header className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Lightbulb className="w-5 h-5 text-amber-300" />
          <div>
            <h2 className="text-sm font-semibold text-amber-200">Things to remember</h2>
            <p className="text-[11px] text-amber-300/70">Examiner-style reminders for the topics you're studying</p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => emblaApi?.scrollPrev()}
            className="p-1.5 rounded-lg border border-amber-500/30 text-amber-300 hover:bg-amber-500/10"
            aria-label="Previous reminder"
            data-testid="button-reminders-prev"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <button
            onClick={() => emblaApi?.scrollNext()}
            className="p-1.5 rounded-lg border border-amber-500/30 text-amber-300 hover:bg-amber-500/10"
            aria-label="Next reminder"
            data-testid="button-reminders-next"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      </header>

      <div className="overflow-hidden" ref={emblaRef}>
        <div className="flex gap-4">
          {reminders.map((r) => (
            <div
              key={r.id}
              className="flex-[0_0_100%] min-w-0 rounded-xl bg-slate-900/60 border border-amber-500/15 p-4"
              data-testid={`reminder-${r.id}`}
            >
              <p className="text-[10px] uppercase tracking-wider text-amber-400/80 mb-1.5">{r.topic}</p>
              <p className="text-sm leading-relaxed text-slate-100">{r.text}</p>
            </div>
          ))}
        </div>
      </div>

      {reminders.length > 1 && (
        <div className="flex items-center justify-center gap-1.5 mt-3">
          {reminders.map((_, i) => (
            <button
              key={i}
              onClick={() => emblaApi?.scrollTo(i)}
              className={`h-1.5 rounded-full transition-all ${i === selectedIndex ? "w-6 bg-amber-300" : "w-1.5 bg-amber-500/30"}`}
              aria-label={`Go to reminder ${i + 1}`}
              data-testid={`dot-reminder-${i}`}
            />
          ))}
        </div>
      )}
    </section>
  );
}
