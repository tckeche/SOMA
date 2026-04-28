import { useMemo } from "react";
import { Link } from "wouter";
import { format } from "date-fns";
import { CheckCircle2, Eye, Printer, TrendingDown, TrendingUp } from "lucide-react";
import { getSubjectColor, getSubjectIcon } from "@/lib/subjectColors";
import type { DashboardAssignmentRow } from "@/types/studentDashboard";

interface Props {
  completed: DashboardAssignmentRow[];
}

export default function CompletedAssessmentsTab({ completed }: Props) {
  const stats = useMemo(() => {
    const graded = completed.filter((c) => c.scorePercent !== null);
    const avg = graded.length > 0
      ? Math.round(graded.reduce((s, r) => s + (r.scorePercent ?? 0), 0) / graded.length)
      : null;
    const bySubject = new Map<string, { total: number; sum: number }>();
    for (const c of graded) {
      const k = c.quizSubject || "General";
      if (!bySubject.has(k)) bySubject.set(k, { total: 0, sum: 0 });
      const v = bySubject.get(k)!;
      v.total += 1;
      v.sum += c.scorePercent ?? 0;
    }
    return { avg, bySubject: Array.from(bySubject.entries()).map(([subject, v]) => ({ subject, avg: Math.round(v.sum / v.total), count: v.total })) };
  }, [completed]);

  if (completed.length === 0) {
    return (
      <div className="rounded-2xl border border-card-border bg-card/70 p-8 text-center" data-testid="empty-completed">
        <CheckCircle2 className="w-10 h-10 mx-auto text-muted-foreground mb-3" />
        <p className="text-sm text-muted-foreground">No completed assessments yet.</p>
        <p className="text-xs text-muted-foreground mt-1">Once you submit your first assessment, your history and averages will appear here.</p>
      </div>
    );
  }

  return (
    <div className="space-y-5" data-testid="tab-completed">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="rounded-xl border border-card-border bg-card/60 p-4">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Total completed</p>
          <p className="text-2xl font-semibold text-foreground">{completed.length}</p>
        </div>
        <div className="rounded-xl border border-card-border bg-card/60 p-4">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Average score</p>
          <p className="text-2xl font-semibold text-foreground">{stats.avg !== null ? `${stats.avg}%` : "—"}</p>
        </div>
        {stats.bySubject.slice(0, 2).map((s) => {
          const sc = getSubjectColor(s.subject);
          return (
            <div key={s.subject} className="rounded-xl border border-card-border bg-card/60 p-4">
              <p className={`text-[10px] uppercase tracking-wider ${sc.label}`}>{s.subject}</p>
              <p className="text-2xl font-semibold text-foreground">{s.avg}%</p>
              <p className="text-[10px] text-muted-foreground">{s.count} done</p>
            </div>
          );
        })}
      </div>

      <ul className="space-y-2.5" data-testid="list-completed">
        {completed.map((row) => {
          const sc = getSubjectColor(row.quizSubject || "General");
          const Icon = getSubjectIcon(row.quizSubject || "General");
          const pct = row.scorePercent ?? 0;
          const tone = pct >= 70 ? "text-emerald-300" : pct >= 50 ? "text-amber-300" : "text-rose-300";
          const TrendIcon = pct >= 70 ? TrendingUp : TrendingDown;
          return (
            <li
              key={row.assignmentId}
              className="flex items-center gap-3 rounded-xl border border-card-border bg-card/50 p-3"
              data-testid={`completed-row-${row.quizId}`}
            >
              <div className={`w-10 h-10 rounded-lg ${sc.bg} border ${sc.border} flex items-center justify-center shrink-0`}>
                <Icon className={`w-5 h-5 ${sc.label}`} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${sc.bg} ${sc.label}`}>
                    {row.quizSubject || "General"}
                  </span>
                  {row.quizLevel && (
                    <span className="text-[10px] text-muted-foreground px-2 py-0.5 rounded-full bg-muted/60">{row.quizLevel}</span>
                  )}
                </div>
                <p className="text-sm text-foreground mt-1 truncate">{row.quizTitle}</p>
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  Completed {row.completedAt ? format(new Date(row.completedAt), "MMM d, yyyy") : "—"}
                </p>
              </div>
              <div className="text-right">
                <div className={`flex items-center justify-end gap-1 text-lg font-semibold ${tone}`}>
                  <TrendIcon className="w-4 h-4" />
                  {row.scorePercent !== null ? `${row.scorePercent}%` : "—"}
                </div>
                <p className="text-[10px] text-muted-foreground">
                  {row.score ?? 0} / {row.maxScore || "?"} marks
                </p>
                <div className="flex items-center gap-3 mt-1.5 justify-end">
                  {row.reportId ? (
                    <>
                      <Link href={`/soma/review/${row.reportId}`}>
                        <button className="inline-flex items-center gap-1 text-[11px] text-cyan-300 hover:text-cyan-200" data-testid={`button-review-${row.quizId}`}>
                          <Eye className="w-3.5 h-3.5" /> Review
                        </button>
                      </Link>
                      <Link href={`/soma/review/${row.reportId}?view=report`}>
                        <button
                          className="inline-flex items-center gap-1 text-[11px] text-violet-300 hover:text-violet-200"
                          title="Open a printable report of this assessment"
                          data-testid={`button-report-${row.quizId}`}
                        >
                          <Printer className="w-3.5 h-3.5" /> Report
                        </button>
                      </Link>
                    </>
                  ) : (
                    <span className="text-[11px] text-muted-foreground/70 italic" data-testid={`text-review-pending-${row.quizId}`}>
                      Report pending
                    </span>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
