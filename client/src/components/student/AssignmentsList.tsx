import { Link } from "wouter";
import { format } from "date-fns";
import { ArrowRight, Calendar, BookOpen, AlertTriangle } from "lucide-react";
import { getSubjectColor, getSubjectIcon } from "@/lib/subjectColors";
import type { DashboardAssignmentRow } from "@/types/studentDashboard";

interface Props {
  assignments: DashboardAssignmentRow[];
}

export default function AssignmentsList({ assignments }: Props) {
  const open = assignments.filter((a) => a.status !== "completed");
  if (open.length === 0) {
    return (
      <div className="rounded-2xl border border-card-border bg-card/70 p-8 text-center" data-testid="empty-assignments">
        <BookOpen className="w-10 h-10 mx-auto text-muted-foreground mb-3" />
        <p className="text-sm text-muted-foreground">Nothing pending right now.</p>
        <p className="text-xs text-muted-foreground mt-1">Your tutor will assign new work as you progress.</p>
      </div>
    );
  }

  // Sort: overdue first, then due-soonest pending, then no-due-date
  const sorted = open.slice().sort((a, b) => {
    if (a.status === "overdue" && b.status !== "overdue") return -1;
    if (b.status === "overdue" && a.status !== "overdue") return 1;
    const ad = a.dueDate ? new Date(a.dueDate).getTime() : Infinity;
    const bd = b.dueDate ? new Date(b.dueDate).getTime() : Infinity;
    return ad - bd;
  });

  return (
    <ul className="space-y-2.5" data-testid="list-assignments">
      {sorted.map((row) => {
        const sc = getSubjectColor(row.quizSubject || "General");
        const Icon = getSubjectIcon(row.quizSubject || "General");
        const isOverdue = row.status === "overdue";
        const dueLabel = row.dueDate
          ? isOverdue
            ? "Overdue"
            : `Due ${format(new Date(row.dueDate), "MMM d, h:mm a")}`
          : "No due date";
        return (
          <li key={row.assignmentId} data-testid={`assignment-${row.quizId}`}>
            <Link href={`/soma/quiz/${row.quizId}`}>
              <div className={`flex items-center gap-3 rounded-xl border p-3 transition-colors hover:bg-muted/60 ${isOverdue ? "border-rose-500/30 bg-rose-500/5" : "border-card-border bg-card/50"}`}>
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
                    <span className={`inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full ${isOverdue ? "bg-rose-500/15 text-rose-300 border border-rose-500/30" : "bg-amber-500/10 text-amber-300 border border-amber-500/20"}`}>
                      {isOverdue ? <AlertTriangle className="w-3 h-3" /> : <Calendar className="w-3 h-3" />}
                      {dueLabel}
                    </span>
                  </div>
                  <p className="text-sm text-foreground mt-1 truncate">{row.quizTitle}</p>
                </div>
                <ArrowRight className="w-4 h-4 text-muted-foreground" />
              </div>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
