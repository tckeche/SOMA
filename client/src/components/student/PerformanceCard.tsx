import { TrendingUp, TrendingDown, Minus, Target, Award, Heart } from "lucide-react";
import type { DashboardPerformance, StudentDashboardSubject } from "@/types/studentDashboard";
import { getSubjectColor } from "@/lib/subjectColors";

interface Props {
  performance: DashboardPerformance;
  subjects: StudentDashboardSubject[];
}

const TREND_META: Record<DashboardPerformance["recentTrend"], { Icon: typeof TrendingUp; tone: string; label: string }> = {
  up: { Icon: TrendingUp, tone: "text-emerald-300", label: "Trending up" },
  down: { Icon: TrendingDown, tone: "text-rose-300", label: "Slight dip — easy to bounce back" },
  flat: { Icon: Minus, tone: "text-foreground/80", label: "Steady" },
  new: { Icon: Heart, tone: "text-violet-300", label: "Just getting started" },
};

export default function PerformanceCard({ performance, subjects }: Props) {
  const trendMeta = TREND_META[performance.recentTrend];
  const TrendIcon = trendMeta.Icon;
  const ranked = subjects
    .filter((s) => s.averageScorePercent !== null)
    .slice()
    .sort((a, b) => (b.averageScorePercent ?? 0) - (a.averageScorePercent ?? 0));

  return (
    <section
      className="rounded-2xl border border-card-border bg-gradient-to-br from-card/95 to-card/60 p-6 shadow-xl"
      aria-label="Performance"
      data-testid="panel-performance"
    >
      <header className="flex items-start justify-between gap-4 mb-5">
        <div>
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Your performance, today</p>
          <h2 className="text-xl font-semibold text-foreground mt-1 flex items-center gap-2">
            <Target className="w-5 h-5 text-violet-400" />
            How you're doing
          </h2>
        </div>
        <div className={`inline-flex items-center gap-1.5 text-xs ${trendMeta.tone} px-3 py-1.5 rounded-full bg-card/60 border border-card-border`}>
          <TrendIcon className="w-3.5 h-3.5" />
          {trendMeta.label}
        </div>
      </header>

      <p className="text-sm text-foreground leading-relaxed" data-testid="text-performance-message">
        {performance.message}
      </p>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-5">
        <div className="rounded-xl border border-card-border bg-card/60 p-3">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Average</p>
          <p className="text-2xl font-semibold text-foreground">
            {performance.averageScorePercent !== null ? `${performance.averageScorePercent}%` : "—"}
          </p>
        </div>
        <div className="rounded-xl border border-card-border bg-card/60 p-3">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Accuracy</p>
          <p className="text-2xl font-semibold text-foreground">
            {performance.accuracyPercent !== null ? `${performance.accuracyPercent}%` : "—"}
          </p>
        </div>
        <div className="rounded-xl border border-card-border bg-card/60 p-3">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Completed</p>
          <p className="text-2xl font-semibold text-foreground">
            {performance.totalCompleted}<span className="text-sm text-muted-foreground"> / {performance.totalAssigned}</span>
          </p>
        </div>
        <div className="rounded-xl border border-card-border bg-card/60 p-3">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground flex items-center gap-1">
            <Award className="w-3 h-3" /> Strongest
          </p>
          <p className="text-base font-semibold text-foreground truncate" title={performance.bestSubject ?? undefined}>
            {performance.bestSubject ?? "—"}
          </p>
        </div>
      </div>

      {ranked.length > 0 && (
        <div className="mt-5">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">By subject</p>
          <div className="space-y-2">
            {ranked.map((s) => {
              const sc = getSubjectColor(s.subject);
              const pct = s.averageScorePercent ?? 0;
              return (
                <div key={s.subject} className="flex items-center gap-3" data-testid={`perf-row-${s.subject}`}>
                  <div className={`text-[11px] font-medium w-28 truncate ${sc.label}`}>{s.subject}</div>
                  <div className="flex-1 h-2 rounded-full bg-muted overflow-hidden">
                    <div className="h-full rounded-full transition-all duration-500" style={{ width: `${pct}%`, background: sc.hex }} />
                  </div>
                  <div className="text-xs text-foreground/80 w-10 text-right">{pct}%</div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}
