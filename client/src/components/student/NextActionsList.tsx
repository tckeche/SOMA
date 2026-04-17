import { Link } from "wouter";
import { Compass, ArrowRight, Clock, AlertTriangle, RefreshCw, Eye, Flag } from "lucide-react";
import type { DashboardNextAction } from "@/types/studentDashboard";

interface Props {
  actions: DashboardNextAction[];
}

const KIND_META: Record<DashboardNextAction["kind"], { Icon: typeof Compass; tone: string; bg: string }> = {
  overdue: { Icon: AlertTriangle, tone: "text-rose-300", bg: "border-rose-500/30 bg-rose-500/5" },
  due_today: { Icon: Clock, tone: "text-amber-300", bg: "border-amber-500/30 bg-amber-500/5" },
  due_tomorrow: { Icon: Clock, tone: "text-amber-200", bg: "border-amber-400/20 bg-amber-400/5" },
  review_low_score: { Icon: RefreshCw, tone: "text-cyan-300", bg: "border-cyan-500/30 bg-cyan-500/5" },
  untested_topic: { Icon: Eye, tone: "text-violet-300", bg: "border-violet-500/30 bg-violet-500/5" },
  fresh_start: { Icon: Flag, tone: "text-emerald-300", bg: "border-emerald-500/20 bg-emerald-500/5" },
};

export default function NextActionsList({ actions }: Props) {
  return (
    <section
      className="rounded-2xl border border-slate-800 bg-slate-900/70 p-5 shadow-lg"
      aria-label="What to do now"
      data-testid="panel-next-actions"
    >
      <header className="flex items-center gap-2 mb-3">
        <Compass className="w-5 h-5 text-violet-400" />
        <div>
          <h2 className="text-sm font-semibold text-slate-100">What to do now</h2>
          <p className="text-[11px] text-slate-400">Bite-sized, in priority order</p>
        </div>
      </header>
      <ul className="space-y-2.5">
        {actions.map((a, i) => {
          const meta = KIND_META[a.kind];
          const Icon = meta.Icon;
          const body = (
            <div className={`flex items-start gap-3 rounded-xl border p-3 transition-colors ${meta.bg} hover:bg-slate-800/40`}>
              <div className={`w-8 h-8 rounded-lg ${meta.bg} flex items-center justify-center shrink-0`}>
                <Icon className={`w-4 h-4 ${meta.tone}`} />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-slate-100">{a.title}</p>
                <p className="text-xs text-slate-400 mt-0.5">{a.detail}</p>
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
