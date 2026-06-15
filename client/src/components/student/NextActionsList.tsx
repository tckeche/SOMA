import { Link } from "wouter";
import { Compass, ArrowRight, Clock, AlertTriangle, RefreshCw, Eye, Flag } from "lucide-react";
import type { DashboardNextAction } from "@/types/studentDashboard";

interface Props {
  actions: DashboardNextAction[];
}

const KIND_META: Record<DashboardNextAction["kind"], { Icon: typeof Compass; tone: string; bg: string }> = {
  overdue: { Icon: AlertTriangle, tone: "text-danger", bg: "border-danger/30 bg-danger/5" },
  due_today: { Icon: Clock, tone: "text-warning", bg: "border-warning/30 bg-warning/5" },
  due_tomorrow: { Icon: Clock, tone: "text-warning", bg: "border-warning/20 bg-warning/5" },
  review_low_score: { Icon: RefreshCw, tone: "text-info", bg: "border-info/30 bg-info/5" },
  untested_topic: { Icon: Eye, tone: "text-primary", bg: "border-primary/30 bg-primary/5" },
  fresh_start: { Icon: Flag, tone: "text-success", bg: "border-success/20 bg-success/5" },
};

export default function NextActionsList({ actions }: Props) {
  return (
    <section
      className="rounded-2xl border border-card-border bg-card/70 p-5 shadow-lg"
      aria-label="What to do now"
      data-testid="panel-next-actions"
    >
      <header className="flex items-center gap-2 mb-3">
        <Compass className="w-5 h-5 text-primary" />
        <div>
          <h2 className="text-sm font-semibold text-foreground">What to do now</h2>
          <p className="text-[11px] text-muted-foreground">Bite-sized, in priority order</p>
        </div>
      </header>
      <ul className="space-y-2.5">
        {actions.map((a, i) => {
          const meta = KIND_META[a.kind];
          const Icon = meta.Icon;
          const body = (
            <div className={`flex items-start gap-3 rounded-xl border p-3 transition-colors ${meta.bg} hover:bg-muted/40`}>
              <div className={`w-8 h-8 rounded-lg ${meta.bg} flex items-center justify-center shrink-0`}>
                <Icon className={`w-4 h-4 ${meta.tone}`} />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-foreground">{a.title}</p>
                <p className="text-xs text-muted-foreground mt-0.5">{a.detail}</p>
              </div>
              {a.href && <ArrowRight className={`w-4 h-4 ${meta.tone} mt-2`} />}
            </div>
          );
          return (
            <li key={i} data-testid={`action-${a.kind}-${i}`}>
              {a.href ? <Link href={a.href}>{body}</Link> : body}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
