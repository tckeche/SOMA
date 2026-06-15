import { useState } from "react";
import { ChevronDown, ChevronUp, TrendingUp, TrendingDown, Minus, CheckCircle2, Circle, AlertCircle, Sparkles } from "lucide-react";
import { getSubjectColor, getSubjectIcon } from "@/lib/subjectColors";
import type { StudentDashboardSubject } from "@/types/studentDashboard";

interface Props {
  subject: StudentDashboardSubject;
}

const STATUS_LABEL: Record<StudentDashboardSubject["topics"][number]["status"], { label: string; tone: string; Icon: typeof CheckCircle2 }> = {
  mastered: { label: "Mastered", tone: "text-success", Icon: CheckCircle2 },
  in_progress: { label: "In progress", tone: "text-warning", Icon: Sparkles },
  needs_work: { label: "Needs work", tone: "text-danger", Icon: AlertCircle },
  untested: { label: "Untested", tone: "text-muted-foreground", Icon: Circle },
};

function TrendBadge({ trend }: { trend: StudentDashboardSubject["recentTrend"] }) {
  if (trend === "up") return <span className="inline-flex items-center gap-1 text-[11px] text-success"><TrendingUp className="w-3 h-3" /> trending up</span>;
  if (trend === "down") return <span className="inline-flex items-center gap-1 text-[11px] text-danger"><TrendingDown className="w-3 h-3" /> needs attention</span>;
  if (trend === "flat") return <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground"><Minus className="w-3 h-3" /> steady</span>;
  return <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">just getting started</span>;
}

export default function SubjectCoverageCard({ subject }: Props) {
  const [expanded, setExpanded] = useState(false);
  const sc = getSubjectColor(subject.subject);
  const SubjectIcon = getSubjectIcon(subject.subject);
  const visibleTopics = expanded ? subject.topics : subject.topics.slice(0, 5);
  const masteredPct = subject.coverage.masteryPercent;
  const coveragePct = subject.coverage.coveragePercent;

  const levelTag = subject.level
    ? subject.level === "IGCSE" ? "IGCSE" : `${subject.level} Level`
    : "Mixed levels";

  return (
    <article
      className="rounded-2xl border border-card-border bg-card/70 p-5 shadow-lg flex flex-col"
      style={{ boxShadow: `0 8px 32px rgba(0,0,0,0.3), 0 0 24px ${sc.hex}10` }}
      data-testid={`card-subject-${subject.subject.replace(/\s+/g, "-").toLowerCase()}`}
    >
      <header className="flex items-start gap-3">
        <div className={`w-10 h-10 rounded-xl ${sc.bg} border ${sc.border} flex items-center justify-center shrink-0`}>
          <SubjectIcon className={`w-5 h-5 ${sc.label}`} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <h3 className="text-base font-semibold text-foreground truncate">{subject.subject}</h3>
            <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${sc.bg} ${sc.label}`}>{levelTag}</span>
          </div>
          <div className="flex items-center gap-3 mt-1 text-[11px] text-muted-foreground">
            <span>{subject.completedCount} done</span>
            {subject.pendingCount > 0 && <span>{subject.pendingCount} pending</span>}
            {subject.overdueCount > 0 && <span className="text-danger">{subject.overdueCount} overdue</span>}
            <TrendBadge trend={subject.recentTrend} />
          </div>
        </div>
      </header>

      <div className="grid grid-cols-2 gap-3 mt-4">
        <div className="rounded-xl border border-card-border bg-card/60 p-3">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Average</p>
          <p className="text-lg font-semibold text-foreground">
            {subject.averageScorePercent !== null ? `${subject.averageScorePercent}%` : "—"}
          </p>
        </div>
        <div className="rounded-xl border border-card-border bg-card/60 p-3">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Topics mastered</p>
          <p className="text-lg font-semibold text-foreground">
            {subject.coverage.masteredTopics}/{subject.coverage.totalTopics || "—"}
          </p>
        </div>
      </div>

      <div className="mt-4 space-y-2">
        <div>
          <div className="flex items-center justify-between text-[11px] text-muted-foreground mb-1">
            <span>Coverage</span>
            <span>{coveragePct}%</span>
          </div>
          <div className="h-1.5 rounded-full bg-muted overflow-hidden">
            <div className="h-full rounded-full transition-all duration-500" style={{ width: `${coveragePct}%`, background: sc.hex }} />
          </div>
        </div>
        <div>
          <div className="flex items-center justify-between text-[11px] text-muted-foreground mb-1">
            <span>Mastery</span>
            <span>{masteredPct}%</span>
          </div>
          <div className="h-1.5 rounded-full bg-muted overflow-hidden">
            <div className="h-full rounded-full bg-gradient-to-r from-success to-success transition-all duration-500" style={{ width: `${masteredPct}%` }} />
          </div>
        </div>
      </div>

      {subject.topics.length === 0 ? (
        <p className="text-xs text-muted-foreground mt-4 italic">
          We don't have a topic list for this subject yet — your work will still be tracked on assignments.
        </p>
      ) : (
        <div className="mt-4 space-y-1.5" data-testid={`topics-${subject.subject}`}>
          {visibleTopics.map((t) => {
            const meta = STATUS_LABEL[t.status];
            const StatusIcon = meta.Icon;
            return (
              <div key={t.topic} className="flex items-center justify-between gap-2 text-xs px-2.5 py-1.5 rounded-lg bg-card/40 border border-card-border/60">
                <div className="flex items-center gap-2 min-w-0">
                  <StatusIcon className={`w-3.5 h-3.5 ${meta.tone} shrink-0`} />
                  <span className="text-foreground truncate">{t.topic}</span>
                </div>
                <span className={`text-[10px] ${meta.tone} shrink-0`}>
                  {t.status === "untested" ? "Not yet" : `${t.understandingPercent}%`}
                </span>
              </div>
            );
          })}
          {subject.topics.length > 5 && (
            <button
              onClick={() => setExpanded((v) => !v)}
              className="w-full text-center mt-1 py-1.5 text-[11px] text-muted-foreground hover:text-foreground"
              data-testid={`button-toggle-topics-${subject.subject}`}
            >
              {expanded ? <ChevronUp className="w-3 h-3 inline" /> : <ChevronDown className="w-3 h-3 inline" />}
              {expanded ? " Show less" : ` Show all ${subject.topics.length} topics`}
            </button>
          )}
        </div>
      )}
    </article>
  );
}
