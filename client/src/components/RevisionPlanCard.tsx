import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { authFetch } from "@/lib/supabase";
import {
  Calendar,
  CalendarClock,
  Clock,
  Loader2,
  RefreshCcw,
  Sparkles,
  Target,
  AlertTriangle,
} from "lucide-react";

interface PlanSession {
  topic: string;
  subtopic: string | null;
  durationMinutes: number;
  type: "drill" | "review" | "exam_practice" | "concept_recap" | "examiner_misconception";
  rationale: string;
  understandingPercent: number;
  examinerInsightCount: number;
}

interface PlanWeek {
  weekNumber: number;
  label: string;
  focus: string;
  sessions: PlanSession[];
  totalMinutes: number;
}

interface Plan {
  id: number;
  subject: string;
  examBody: string;
  syllabusCode: string;
  level: string;
  examDate: string | null;
  weekHours: number;
  weeks: PlanWeek[];
  summary: string;
  weakAreas: Array<{ topic: string; understandingPercent: number }>;
  stale: boolean;
  generatedAt: string;
}

interface PlansList {
  plans: Plan[];
}

interface SubjectChoice {
  subject: string;
  examBody: string;
  syllabusCode: string;
  level: string;
}

const TYPE_LABEL: Record<PlanSession["type"], string> = {
  drill: "Drill",
  review: "Review",
  exam_practice: "Exam practice",
  concept_recap: "Concept recap",
  examiner_misconception: "Examiner-flagged",
};

const TYPE_COLOUR: Record<PlanSession["type"], string> = {
  drill: "bg-rose-500/15 text-rose-200 border-rose-500/25",
  review: "bg-amber-500/15 text-amber-200 border-amber-500/25",
  exam_practice: "bg-emerald-500/15 text-emerald-200 border-emerald-500/25",
  concept_recap: "bg-sky-500/15 text-sky-200 border-sky-500/25",
  examiner_misconception: "bg-violet-500/15 text-violet-200 border-violet-500/25",
};

export function RevisionPlanCard() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery<PlansList>({
    queryKey: ["/api/student/revision-plans"],
    queryFn: async () => {
      const res = await authFetch("/api/student/revision-plans");
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
  });

  // Subjects the student is enrolled in — sourced from the mastery map
  // so we get canonical (examBody, syllabusCode, level) tuples without
  // a second endpoint.
  const { data: subjectsData } = useQuery<{ subjects: SubjectChoice[] }>({
    queryKey: ["/api/student/mastery-map"],
    queryFn: async () => {
      const res = await authFetch("/api/student/mastery-map");
      if (!res.ok) return { subjects: [] };
      return res.json();
    },
  });
  const subjects: SubjectChoice[] = (subjectsData?.subjects ?? []).map((s) => ({
    subject: s.subject,
    examBody: s.examBody,
    syllabusCode: s.syllabusCode,
    level: s.level,
  }));

  const [selectedSubject, setSelectedSubject] = useState<string>("");
  const [examDate, setExamDate] = useState<string>("");
  const [weekHours, setWeekHours] = useState<number>(6);

  const generate = useMutation({
    mutationFn: async (input: {
      subject: string;
      examBody: string;
      syllabusCode: string;
      level: string;
      examDate?: string | null;
      weekHours?: number;
    }) => {
      const res = await authFetch("/api/student/revision-plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subject: input.subject,
          examBody: input.examBody,
          syllabusCode: input.syllabusCode,
          level: input.level,
          examDate: input.examDate ? new Date(input.examDate).toISOString() : null,
          weekHours: input.weekHours,
        }),
      });
      if (!res.ok) throw new Error("Generate failed");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/student/revision-plans"] });
    },
  });

  const plans = data?.plans ?? [];
  const selected = useMemo(() => {
    if (plans.length === 0) return null;
    if (selectedSubject) {
      const m = plans.find((p) => p.subject === selectedSubject);
      if (m) return m;
    }
    return plans[0];
  }, [plans, selectedSubject]);

  if (isLoading) {
    return (
      <section className="space-y-3" data-testid="section-revision-plan">
        <Header />
        <div className="flex justify-center py-10"><Loader2 className="w-5 h-5 text-primary animate-spin" /></div>
      </section>
    );
  }

  return (
    <section className="space-y-3" data-testid="section-revision-plan">
      <Header />

      {plans.length > 1 && (
        <div className="flex items-center gap-1 bg-foreground/[0.04] rounded-xl p-1 border border-border/60 w-fit">
          {plans.map((p) => {
            const active = (selected?.id ?? -1) === p.id;
            return (
              <button
                key={p.id}
                onClick={() => setSelectedSubject(p.subject)}
                className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium transition ${
                  active
                    ? "bg-primary/15 text-primary border border-primary/25"
                    : "text-muted-foreground hover:text-foreground border border-transparent"
                }`}
                data-testid={`plan-tab-${p.id}`}
              >
                {p.subject}
                {p.stale && <span className="w-1.5 h-1.5 rounded-full bg-warning" title="Plan is out of date" />}
              </button>
            );
          })}
        </div>
      )}

      {selected ? (
        <PlanView
          plan={selected}
          onRefresh={(opts) =>
            generate.mutate({
              subject: selected.subject,
              examBody: selected.examBody,
              syllabusCode: selected.syllabusCode,
              level: selected.level,
              examDate: opts?.examDate ?? selected.examDate,
              weekHours: opts?.weekHours ?? selected.weekHours,
            })
          }
          refreshing={generate.isPending}
        />
      ) : subjects.length === 0 ? (
        <div className="rounded-2xl border border-card-border bg-card/70 p-6 text-center">
          <p className="text-xs text-muted-foreground">Once your tutor sets your subjects, you can generate a revision plan here.</p>
        </div>
      ) : (
        <div className="rounded-2xl border border-card-border bg-card/70 p-5 space-y-3">
          <p className="text-sm text-foreground">Pick a subject and (optionally) when your exam is. SOMA will build a plan focused on what'll lose you the most marks.</p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <select
              value={selectedSubject}
              onChange={(e) => setSelectedSubject(e.target.value)}
              className="bg-foreground/[0.04] border border-border/60 rounded-lg px-3 py-2 text-sm"
              data-testid="select-plan-subject"
            >
              {subjects.map((s) => (
                <option key={`${s.subject}|${s.syllabusCode}|${s.level}`} value={s.subject}>
                  {s.subject} · {s.syllabusCode} · {s.level}
                </option>
              ))}
            </select>
            <input
              type="date"
              value={examDate}
              onChange={(e) => setExamDate(e.target.value)}
              className="bg-foreground/[0.04] border border-border/60 rounded-lg px-3 py-2 text-sm"
              placeholder="Exam date (optional)"
              data-testid="input-exam-date"
            />
            <div className="flex items-center gap-2 bg-foreground/[0.04] border border-border/60 rounded-lg px-3 py-2">
              <Clock className="w-3.5 h-3.5 text-muted-foreground" />
              <input
                type="number"
                min={1}
                max={40}
                value={weekHours}
                onChange={(e) => setWeekHours(Number(e.target.value) || 6)}
                className="bg-transparent text-sm w-12"
                data-testid="input-week-hours"
              />
              <span className="text-xs text-muted-foreground">hrs / week</span>
            </div>
          </div>
          <button
            onClick={() => {
              const choice = subjects.find((s) => s.subject === selectedSubject) ?? subjects[0];
              generate.mutate({
                subject: choice.subject,
                examBody: choice.examBody,
                syllabusCode: choice.syllabusCode,
                level: choice.level,
                examDate: examDate || null,
                weekHours,
              });
            }}
            disabled={generate.isPending}
            className="text-sm px-4 py-2 rounded-lg bg-violet-500/20 border border-violet-500/30 hover:bg-violet-500/30 text-violet-200 flex items-center gap-2 disabled:opacity-50"
            data-testid="button-generate-plan"
          >
            <Sparkles className="w-4 h-4" /> Generate my plan
            {generate.isPending && <Loader2 className="w-3 h-3 animate-spin" />}
          </button>
        </div>
      )}
    </section>
  );
}

function Header() {
  return (
    <header>
      <h2 className="text-lg font-semibold text-foreground">Your revision plan</h2>
      <p className="text-xs text-muted-foreground">Sessions ordered by what'll move your marks the most. Refresh after each quiz to update.</p>
    </header>
  );
}

function PlanView({
  plan,
  onRefresh,
  refreshing,
}: {
  plan: Plan;
  onRefresh: (opts?: { examDate?: string | null; weekHours?: number }) => void;
  refreshing: boolean;
}) {
  return (
    <article className="rounded-2xl border border-card-border bg-card/70 p-5 space-y-4" data-testid={`plan-view-${plan.id}`}>
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-sm font-semibold text-foreground">
              {plan.subject} <span className="text-muted-foreground font-normal">· {plan.syllabusCode} · {plan.level}</span>
            </p>
            {plan.stale && (
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-500/15 border border-amber-500/30 text-amber-200 flex items-center gap-1">
                <AlertTriangle className="w-3 h-3" /> Out of date
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-1">{plan.summary}</p>
          <div className="flex items-center gap-3 mt-2 text-[11px] text-muted-foreground">
            {plan.examDate && (
              <span className="flex items-center gap-1">
                <Calendar className="w-3 h-3" /> Exam {new Date(plan.examDate).toLocaleDateString()}
              </span>
            )}
            <span className="flex items-center gap-1">
              <CalendarClock className="w-3 h-3" /> {plan.weekHours} hrs/week
            </span>
            <span>Generated {new Date(plan.generatedAt).toLocaleDateString()}</span>
          </div>
        </div>
        <button
          onClick={() => onRefresh()}
          disabled={refreshing}
          className="text-xs px-3 py-1.5 rounded-lg bg-violet-500/15 border border-violet-500/30 hover:bg-violet-500/25 text-violet-200 flex items-center gap-1.5 disabled:opacity-50"
          data-testid="button-refresh-plan"
        >
          <RefreshCcw className={`w-3 h-3 ${refreshing ? "animate-spin" : ""}`} /> Refresh
        </button>
      </div>

      {plan.weakAreas.length > 0 && (
        <div className="bg-foreground/[0.02] border border-border/50 rounded-xl p-3">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1">
            <Target className="w-3 h-3" /> Where you'd lose marks today
          </p>
          <div className="flex flex-wrap gap-1.5">
            {plan.weakAreas.map((w, i) => (
              <span key={i} className="text-[11px] text-foreground/85 bg-foreground/[0.04] border border-border/50 rounded px-2 py-0.5">
                {w.topic} · {w.understandingPercent}%
              </span>
            ))}
          </div>
        </div>
      )}

      {plan.weeks.length === 0 ? (
        <p className="text-sm text-muted-foreground">{plan.summary}</p>
      ) : (
        <div className="space-y-3">
          {plan.weeks.map((w) => (
            <WeekRow key={w.weekNumber} week={w} />
          ))}
        </div>
      )}
    </article>
  );
}

function WeekRow({ week }: { week: PlanWeek }) {
  return (
    <div className="rounded-xl border border-border/40 bg-foreground/[0.02]" data-testid={`plan-week-${week.weekNumber}`}>
      <div className="flex items-center justify-between gap-3 px-4 py-2 border-b border-border/40">
        <div>
          <p className="text-sm font-semibold text-foreground">{week.label}</p>
          <p className="text-[11px] text-muted-foreground">{week.focus}</p>
        </div>
        <p className="text-[11px] text-muted-foreground">{week.totalMinutes} min total</p>
      </div>
      <div className="divide-y divide-border/40">
        {week.sessions.map((s, i) => (
          <SessionRow key={i} session={s} />
        ))}
      </div>
    </div>
  );
}

function SessionRow({ session }: { session: PlanSession }) {
  return (
    <div className="px-4 py-2.5 flex items-start gap-3" data-testid="plan-session">
      <span className={`text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full border shrink-0 ${TYPE_COLOUR[session.type]}`}>
        {TYPE_LABEL[session.type]}
      </span>
      <div className="flex-1 min-w-0">
        <p className="text-sm text-foreground truncate">
          {session.subtopic ? <><span className="text-muted-foreground">{session.topic} ·</span> {session.subtopic}</> : session.topic}
        </p>
        <p className="text-[11px] text-muted-foreground mt-0.5">{session.rationale}</p>
      </div>
      <span className="text-[11px] text-muted-foreground shrink-0">{session.durationMinutes} min</span>
    </div>
  );
}
