import { Trophy, Sparkles, Flag, Award } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import type { DashboardRecentWin } from "@/types/studentDashboard";

interface Props {
  wins: DashboardRecentWin[];
}

const TYPE_META: Record<DashboardRecentWin["type"], { Icon: typeof Trophy; tone: string }> = {
  high_score: { Icon: Trophy, tone: "text-warning" },
  first_completion: { Icon: Flag, tone: "text-success" },
  improvement: { Icon: Sparkles, tone: "text-info" },
  streak: { Icon: Sparkles, tone: "text-primary" },
  mastery: { Icon: Award, tone: "text-success" },
};

export default function RecentWinsList({ wins }: Props) {
  if (wins.length === 0) {
    return (
      <section
        className="rounded-2xl border border-card-border bg-card/70 p-5 shadow-lg"
        aria-label="Recent wins"
        data-testid="panel-recent-wins"
      >
        <header className="flex items-center gap-2 mb-3">
          <Trophy className="w-5 h-5 text-warning" />
          <h2 className="text-sm font-semibold text-foreground">Recent wins</h2>
        </header>
        <p className="text-xs text-muted-foreground">
          Once you've completed a few assessments, your highlights will show up here. Onwards.
        </p>
      </section>
    );
  }

  return (
    <section
      className="rounded-2xl border border-card-border bg-card/70 p-5 shadow-lg"
      aria-label="Recent wins"
      data-testid="panel-recent-wins"
    >
      <header className="flex items-center gap-2 mb-3">
        <Trophy className="w-5 h-5 text-amber-300" />
        <div>
          <h2 className="text-sm font-semibold text-foreground">Recent wins</h2>
          <p className="text-[11px] text-muted-foreground">Worth pausing on</p>
        </div>
      </header>
      <ul className="space-y-2.5">
        {wins.map((w, i) => {
          const meta = TYPE_META[w.type];
          const Icon = meta.Icon;
          return (
            <li key={i} className="flex items-start gap-3 rounded-xl border border-card-border bg-card/50 p-3" data-testid={`win-${w.type}-${i}`}>
              <Icon className={`w-4 h-4 mt-0.5 ${meta.tone} shrink-0`} />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-foreground">{w.title}</p>
                <p className="text-xs text-muted-foreground mt-0.5">{w.detail}</p>
                <p className="text-[10px] text-muted-foreground mt-1">{formatDistanceToNow(new Date(w.ts), { addSuffix: true })}</p>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
