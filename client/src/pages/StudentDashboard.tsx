import { useEffect, useMemo, useState, lazy, Suspense } from "react";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { formatDistanceToNow } from "date-fns";
import { supabase, authFetch } from "@/lib/supabase";
import { useSupabaseSession } from "@/hooks/use-supabase-session";
import { subscribeToSomaMutations } from "@/lib/realtimeEvents";
import {
  Sparkles, ArrowRight, AlertCircle, RefreshCw, BookOpen, Clock, ChevronRight,
  TrendingUp, TrendingDown, Minus, Award, Trophy, Flag, Flame,
} from "lucide-react";
import SomaHeader from "@/components/soma/SomaHeader";
import { Ring, Spark } from "@/components/soma/Charts";
import AssignmentsList from "@/components/student/AssignmentsList";
import CompletedAssessmentsTab from "@/components/student/CompletedAssessmentsTab";
import StudentNotificationsBell from "@/components/student/StudentNotificationsBell";
import { MarkLossPredictor } from "@/components/MarkLossPredictor";
import { RevisionPlanCard } from "@/components/RevisionPlanCard";
import { CommandWordCoach } from "@/components/CommandWordCoach";
import MarkdownRenderer from "@/components/MarkdownRenderer";
import { type SubjectInsight } from "@/components/SyllabusInsightsSection";
// Lazy-loaded: this section pulls in recharts (the app's heaviest dependency,
// isolated into its own "charts" chunk). Deferring it keeps the recharts bundle
// off the dashboard's initial download — it only loads when this section paints.
const SyllabusInsightsSection = lazy(() =>
  import("@/components/SyllabusInsightsSection").then((m) => ({ default: m.SyllabusInsightsSection })),
);
import ExaminerInsightsCarousel, { type ExaminerInsightCard } from "@/components/student/ExaminerInsightsCarousel";
import TopicCoverageExplorer from "@/components/student/TopicCoverageExplorer";
import type {
  DashboardAssignmentRow,
  DashboardRecentWin,
  StudentDashboardPayload,
} from "@/types/studentDashboard";

interface StudyTipResponse {
  tips: Array<{
    id: string;
    topic: string;
    tip: string;
    whyItMatters: string;
    correctApproach: string;
    frequency: "very_common" | "common" | "occasional";
  }>;
  cacheHit: boolean;
  elapsedMs: number;
}

type ViewKey = "dashboard" | "assignments" | "tools";

// ---- small helpers ----

/** Humanize an ISO timestamp / date into a short relative or due label. */
function humanize(iso: string | null): string {
  if (!iso) return "No due date";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return formatDistanceToNow(d, { addSuffix: true });
}

/** Days from now (negative = past). */
function daysUntil(iso: string | null): number | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return (d.getTime() - Date.now()) / 86_400_000;
}

function scoreColor(pct: number): string {
  if (pct >= 75) return "hsl(var(--success))";
  if (pct >= 55) return "hsl(var(--warning))";
  return "hsl(var(--danger))";
}

// Categorical per-subject palette (matches the mockup's brand → info → warning →
// success cycle): the by-subject bar colour encodes subject identity, not score.
const SUBJECT_COLORS = [
  "hsl(var(--primary))",
  "hsl(var(--info))",
  "hsl(var(--warning))",
  "hsl(var(--success))",
];

/** Source PageIntro condenses "Good afternoon, Calvin" → "Hi Calvin". */
function friendlyGreeting(greeting: string): string {
  const m = greeting.match(/^Good (?:morning|afternoon|evening),\s*(.+)$/i);
  return m ? `Hi ${m[1]}` : greeting;
}

/** Compact due status for the hero chip (e.g. "2 due · 1 overdue") — the full
 *  `dueSummary` sentence belongs in the PageIntro subtitle, not a chip. */
function shortDueStatus(assignments: DashboardAssignmentRow[]): string {
  let due = 0;
  let overdue = 0;
  for (const a of assignments) {
    if (a.status === "completed") continue;
    if (a.status === "overdue") overdue++;
    else due++;
  }
  const parts: string[] = [];
  if (due > 0) parts.push(`${due} due`);
  if (overdue > 0) parts.push(`${overdue} overdue`);
  return parts.join(" · ") || "All caught up";
}

const MASTERY_META: Record<
  string,
  { label: string; cls: string }
> = {
  needs_work: { label: "Weak", cls: "chip-danger" },
  in_progress: { label: "Developing", cls: "chip-warning" },
  mastered: { label: "Secure", cls: "chip-success" },
  untested: { label: "Untested", cls: "chip" },
};

const WIN_META: Record<DashboardRecentWin["type"], { Icon: typeof Trophy }> = {
  high_score: { Icon: Trophy },
  first_completion: { Icon: Flag },
  improvement: { Icon: Sparkles },
  streak: { Icon: Flame },
  mastery: { Icon: Award },
};

function DashboardSkeleton() {
  return (
    <div className="space-y-6 animate-pulse" data-testid="dashboard-skeleton">
      <div className="h-32 rounded-2xl bg-card/60 border border-card-border" />
      <div className="grid md:grid-cols-3 gap-4">
        <div className="h-48 rounded-2xl bg-card/60 border border-card-border md:col-span-2" />
        <div className="h-48 rounded-2xl bg-card/60 border border-card-border" />
      </div>
      <div className="grid md:grid-cols-2 gap-4">
        <div className="h-64 rounded-2xl bg-card/60 border border-card-border" />
        <div className="h-64 rounded-2xl bg-card/60 border border-card-border" />
      </div>
    </div>
  );
}

function ErrorState({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="rounded-2xl border border-danger/40 bg-danger/10 p-8 text-center" data-testid="dashboard-error">
      <AlertCircle className="w-10 h-10 text-danger mx-auto mb-3" />
      <h2 className="text-lg font-semibold text-danger">We couldn't load your dashboard</h2>
      <p className="text-sm text-danger/90 mt-1">Check your connection and try again — your data is safe.</p>
      <button
        onClick={onRetry}
        className="mt-4 inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-danger/50 bg-danger/15 text-danger hover:bg-danger/25 transition-colors"
        data-testid="button-retry-dashboard"
      >
        <RefreshCw className="w-4 h-4" /> Retry
      </button>
    </div>
  );
}

// ---- Dashboard sections ----

/** 1. Next actions (hero + up next). */
function NextActions({
  assignments,
  onStart,
}: {
  assignments: DashboardAssignmentRow[];
  onStart: (quizId: number) => void;
}) {
  const overdue = assignments.find((a) => a.status === "overdue");
  const pending = assignments.find((a) => a.status === "pending");
  const hero = overdue ?? pending;
  if (!hero) {
    return (
      <section className="soma-card" style={{ padding: 22 }}>
        <div className="eyebrow">Pick up where you left off</div>
        <h2 className="soma-display" style={{ fontSize: 22, marginTop: 6 }}>You're all caught up</h2>
        <p className="text-sm text-muted-foreground mt-1">Nothing pending right now — your tutor will assign new work as you progress.</p>
      </section>
    );
  }

  const d = daysUntil(hero.dueDate);
  const heroTone =
    hero.status === "overdue" ? "danger" : d !== null && d <= 2 ? "warning" : "brand";
  const toneVar =
    heroTone === "danger" ? "hsl(var(--danger))" : heroTone === "warning" ? "hsl(var(--warning))" : "hsl(var(--primary))";
  const heroDue = hero.status === "overdue" ? "Overdue" : humanize(hero.dueDate);

  // Hero meta line: "{q} questions · {marks} marks · ~{minutes} min", dropping
  // any part we don't have data for (graceful zero-states). The time estimate
  // is derived from marks (~1.2 min/mark), matching the design source.
  const heroMetaParts: string[] = [];
  if (hero.questionCount > 0) heroMetaParts.push(`${hero.questionCount} questions`);
  if (hero.maxScore > 0) heroMetaParts.push(`${hero.maxScore} marks`);
  if (hero.maxScore > 0) heroMetaParts.push(`~${Math.round(hero.maxScore * 1.2)} min`);
  const heroMeta = heroMetaParts.join(" · ") || "Ready when you are";

  // "Up next" = next 2-3 assignments after the hero.
  const upNext = assignments.filter((a) => a !== hero).slice(0, 3);

  return (
    <section className="soma-card" style={{ padding: 0, overflow: "hidden" }}>
      <div className="row between" style={{ padding: "18px 22px 0" }}>
        <div className="eyebrow">Pick up where you left off</div>
        <span className={`chip ${heroTone === "brand" ? "chip-info" : `chip-${heroTone}`}`}>{shortDueStatus(assignments)}</span>
      </div>

      <div style={{ padding: "14px 22px 20px" }}>
        {/* hero action */}
        <div className="soma-card-2" style={{ padding: 0, position: "relative", overflow: "hidden", background: "hsl(var(--card))", borderColor: "hsl(var(--card-border))", boxShadow: "var(--shadow-sm)" }}>
          <span style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 3, background: toneVar }} />
          <div style={{ padding: "20px 22px 20px 24px" }}>
            <div className="row between wrap" style={{ gap: 16, alignItems: "flex-start" }}>
              <div style={{ minWidth: 0 }}>
                <div className="row" style={{ gap: 8, marginBottom: 8 }}>
                  <span className={`chip chip-${heroTone}`}>
                    {hero.status === "overdue" ? <AlertCircle className="w-3.5 h-3.5" /> : <Clock className="w-3.5 h-3.5" />}
                    {heroDue}
                  </span>
                  <span className="chip">
                    <BookOpen className="w-3.5 h-3.5" />
                    {hero.quizSubject || "General"}{hero.quizLevel ? ` · ${hero.quizLevel}` : ""}
                  </span>
                </div>
                <h2 className="soma-display" style={{ fontSize: 26, marginBottom: 8, lineHeight: 1.12 }}>{hero.quizTitle}</h2>
                <div className="text-muted-foreground" style={{ fontSize: 13 }}>{heroMeta}</div>
              </div>
              <button className="btn btn-primary" onClick={() => onStart(hero.quizId)} style={{ flex: "none" }}>
                Start now <ArrowRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>

        {/* up next */}
        {upNext.length > 0 && (
          <div style={{ marginTop: 14, display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 8 }}>
            <div className="eyebrow" style={{ marginBottom: 2 }}>Up next</div>
            {upNext.map((a) => {
              const ad = daysUntil(a.dueDate);
              const soon = a.status === "overdue" || (ad !== null && ad <= 2);
              const dueLabel = a.status === "overdue" ? "Overdue" : humanize(a.dueDate);
              return (
                <button
                  key={a.assignmentId}
                  onClick={() => onStart(a.quizId)}
                  className="row between"
                  style={{
                    width: "100%", textAlign: "left", gap: 12, padding: "12px 14px",
                    background: "hsl(var(--secondary))", border: "1px solid hsl(var(--border))", borderRadius: 12, cursor: "pointer",
                  }}
                  data-testid={`up-next-${a.quizId}`}
                >
                  <span className="row" style={{ gap: 12, minWidth: 0 }}>
                    <span style={{
                      width: 36, height: 36, borderRadius: 9, flex: "none", display: "grid", placeItems: "center",
                      background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", color: "hsl(var(--primary))",
                    }}>
                      <BookOpen className="w-4 h-4" />
                    </span>
                    <span style={{ minWidth: 0 }}>
                      <span style={{ display: "block", fontWeight: 600, fontSize: 14, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{a.quizTitle}</span>
                      <span className="text-muted-foreground" style={{ fontSize: 12 }}>
                        {a.quizSubject || "General"}
                        {a.questionCount > 0 ? ` · ${a.questionCount} Q` : ""}
                        {a.maxScore > 0 ? ` · ${a.maxScore} marks` : ""}
                      </span>
                    </span>
                  </span>
                  <span className="row" style={{ gap: 10, flex: "none" }}>
                    <span className={`chip ${soon ? "chip-warning" : ""}`} style={{ fontSize: 11 }}>{dueLabel}</span>
                    <ChevronRight className="w-4 h-4 text-muted-foreground" />
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}

/** 2. Performance. */
function PerformanceBlock({
  data,
}: {
  data: StudentDashboardPayload;
}) {
  const p = data.performance;
  const avg = p.averageScorePercent ?? 0;
  const accuracy = p.accuracyPercent ?? 0;

  // Sparkline: completed assessments by completedAt ascending → scorePercent (skip nulls).
  const sparkData = useMemo(() => {
    return data.completed
      .filter((c) => c.completedAt && c.scorePercent != null)
      .slice()
      .sort((a, b) => new Date(a.completedAt!).getTime() - new Date(b.completedAt!).getTime())
      .map((c) => c.scorePercent as number)
      .slice(-8);
  }, [data.completed]);

  const bySubject = data.subjects
    .filter((s) => s.averageScorePercent != null)
    .map((s) => ({ subject: s.subject, pct: Math.round(s.averageScorePercent as number) }));

  const trend = p.recentTrend;
  const trendMeta =
    trend === "up"
      ? { Icon: TrendingUp, cls: "chip-success", label: "Improving" }
      : trend === "down"
      ? { Icon: TrendingDown, cls: "chip-danger", label: "Slipping" }
      : trend === "new"
      ? { Icon: Sparkles, cls: "chip-brand", label: "New" }
      : { Icon: Minus, cls: "chip", label: "Steady" };
  const TrendIcon = trendMeta.Icon;

  return (
    <section className="soma-card" style={{ padding: 22 }}>
      <div className="row between" style={{ marginBottom: 16 }}>
        <div>
          <div className="eyebrow">How you're doing</div>
          <h3 className="soma-display" style={{ fontSize: 20, marginTop: 4, whiteSpace: "nowrap" }}>Your progress</h3>
        </div>
        <span className={`chip ${trendMeta.cls}`}><TrendIcon className="w-3.5 h-3.5" />{trendMeta.label}</span>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1.1fr 1fr", gap: 18, alignItems: "center" }} className="grid-collapse">
        <div className="row" style={{ gap: 16 }}>
          <Ring pct={Math.round(avg)} size={92} stroke={9}>
            <div style={{ textAlign: "center" }}>
              <div className="num" style={{ fontSize: 24 }}>{Math.round(avg)}%</div>
              <div className="eyebrow" style={{ fontSize: 8 }}>avg</div>
            </div>
          </Ring>
          <div style={{ display: "grid", gap: 10, flex: 1 }}>
            <div className="row between" style={{ paddingBottom: 8, borderBottom: "1px solid hsl(var(--border))" }}>
              <span className="text-muted-foreground" style={{ fontSize: 13 }}>Accuracy</span>
              <span className="num" style={{ fontSize: 17 }}>{Math.round(accuracy)}%</span>
            </div>
            <div className="row between" style={{ paddingBottom: 8, borderBottom: "1px solid hsl(var(--border))" }}>
              <span className="text-muted-foreground" style={{ fontSize: 13 }}>Completed</span>
              <span className="num" style={{ fontSize: 17 }}>{p.totalCompleted}/{p.totalAssigned}</span>
            </div>
            {sparkData.length >= 2 && (
              <div className="row between">
                <span className="text-muted-foreground" style={{ fontSize: 13 }}>Recent trend</span>
                <Spark data={sparkData} w={96} h={28} />
              </div>
            )}
          </div>
        </div>

        <div style={{ display: "grid", gap: 11 }}>
          <div className="eyebrow">By subject</div>
          {bySubject.length === 0 ? (
            <p className="text-muted-foreground" style={{ fontSize: 12 }}>No scored subjects yet.</p>
          ) : (
            bySubject.map((s, i) => (
              <div key={s.subject} className="row" style={{ gap: 12 }}>
                <span style={{ width: 92, fontSize: 13, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{s.subject}</span>
                <span className="meter" style={{ flex: 1 }}><span style={{ width: s.pct + "%", background: SUBJECT_COLORS[i % SUBJECT_COLORS.length] }} /></span>
                <span className="num" style={{ fontSize: 13, width: 34, textAlign: "right" }}>{s.pct}%</span>
              </div>
            ))
          )}
        </div>
      </div>
    </section>
  );
}

/** 3. Where to focus — readiness rings + topic mastery + examiner tip. */
function FocusBlock({
  data,
}: {
  data: StudentDashboardPayload;
}) {
  const readiness = data.subjects.map((s) => ({
    label: s.subject,
    pct: Math.round(s.coverage.masteryPercent),
  }));

  const topics = useMemo(() => {
    const flat = data.subjects.flatMap((s) =>
      s.topics.map((t) => ({
        topic: t.topic,
        subject: s.subject,
        pct: Math.round(t.understandingPercent),
        status: t.status,
      })),
    );
    return flat.sort((a, b) => a.pct - b.pct).slice(0, 6);
  }, [data.subjects]);

  return (
    <section className="soma-card" style={{ padding: 22 }}>
      <div className="row between wrap" style={{ marginBottom: 16, gap: 10 }}>
        <div>
          <div className="eyebrow">Where to focus</div>
          <h3 className="soma-display" style={{ fontSize: 20, marginTop: 4, whiteSpace: "nowrap" }}>Mastery &amp; readiness</h3>
        </div>
        <span className="text-muted-foreground" style={{ fontSize: 12, maxWidth: 240, textAlign: "right" }}>
          One view: how exam-ready each subject is, and the topics moving the needle.
        </span>
      </div>

      {/* readiness rings */}
      {readiness.length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(92px, 1fr))", gap: 12, marginBottom: 18 }}>
          {readiness.map((r) => (
            <div key={r.label} className="well" style={{ padding: 12, display: "grid", placeItems: "center", gap: 8 }}>
              <Ring pct={r.pct} size={64} stroke={6} color={scoreColor(r.pct)}>
                <span className="num" style={{ fontSize: 15 }}>{r.pct}%</span>
              </Ring>
              <span style={{ fontSize: 11, fontWeight: 600, color: "hsl(var(--secondary-foreground))" }}>{r.label}</span>
            </div>
          ))}
        </div>
      )}

      {/* topic mastery list */}
      {topics.length > 0 && (
        <div style={{ display: "grid", gap: 8 }}>
          {topics.map((t) => {
            const m = MASTERY_META[t.status] ?? MASTERY_META.untested;
            return (
              <div
                key={`${t.subject}-${t.topic}`}
                className="row between"
                style={{ gap: 12, padding: "11px 14px", background: "hsl(var(--secondary))", border: "1px solid hsl(var(--border))", borderRadius: 12 }}
              >
                <span style={{ minWidth: 0, flex: 1 }}>
                  <span className="row" style={{ gap: 8, marginBottom: 7 }}>
                    <span style={{ fontWeight: 600, fontSize: 14 }}>{t.topic}</span>
                    <span className="text-muted-foreground" style={{ fontSize: 11 }}>{t.subject}</span>
                  </span>
                  <span className="meter" style={{ maxWidth: 280 }}><span style={{ width: t.pct + "%", background: scoreColor(t.pct) }} /></span>
                </span>
                <span className="row" style={{ gap: 8, flex: "none" }}>
                  <span className="num" style={{ fontSize: 14, width: 34, textAlign: "right", color: scoreColor(t.pct) }}>{t.pct}%</span>
                  <span className={`chip ${m.cls}`} style={{ fontSize: 11 }}>{m.label}</span>
                </span>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

/** 3b. Written-answer feedback — where the student lost marks + how to improve. */
function WrittenFeedbackBlock({ data }: { data: StudentDashboardPayload }) {
  const items = data.structuredFeedback ?? [];
  if (items.length === 0) return null;
  return (
    <section className="soma-card" style={{ padding: 22 }} data-testid="section-written-feedback">
      <div className="row between" style={{ marginBottom: 14 }}>
        <div>
          <div className="eyebrow">Where to improve</div>
          <h3 className="soma-display" style={{ fontSize: 18, marginTop: 4 }}>Your written answers</h3>
        </div>
        <Flag className="w-5 h-5" style={{ color: "hsl(var(--warning))" }} />
      </div>
      <div style={{ display: "grid", gap: 10 }}>
        {items.map((f) => (
          <div
            key={`${f.quizId}-${f.questionId}`}
            className="well"
            style={{ padding: 14 }}
            data-testid={`written-feedback-${f.quizId}-${f.questionId}`}
          >
            <div className="row between" style={{ marginBottom: 8, flexWrap: "wrap", gap: 8 }}>
              <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                {f.topic && <span className="chip chip-brand" style={{ fontSize: 10 }}>{f.topic}</span>}
                {f.subtopic && <span className="chip" style={{ fontSize: 10 }}>{f.subtopic}</span>}
                <span style={{ fontSize: 11, color: "hsl(var(--muted-foreground))", fontWeight: 500 }}>
                  {f.subject || f.quizTitle}
                </span>
              </div>
              <span className="chip chip-danger num" style={{ fontSize: 10 }} data-testid={`written-feedback-score-${f.quizId}-${f.questionId}`}>
                {f.awardedMarks}/{f.maxMarks} marks
              </span>
            </div>
            {f.whereFailing && (
              <div style={{ marginBottom: 6 }}>
                <span className="eyebrow" style={{ color: "hsl(var(--warning))" }}>Where it fell short</span>
                <div style={{ fontSize: 12 }}><MarkdownRenderer content={f.whereFailing} /></div>
              </div>
            )}
            {f.howToImprove && (
              <div>
                <span className="eyebrow" style={{ color: "hsl(var(--success))" }}>How to improve</span>
                <div style={{ fontSize: 12 }}><MarkdownRenderer content={f.howToImprove} /></div>
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

/** 4. Recent wins. */
function WinsBlock({ wins }: { wins: DashboardRecentWin[] }) {
  if (wins.length === 0) return null;
  return (
    <section className="soma-card" style={{ padding: 22 }}>
      <div className="row between" style={{ marginBottom: 14 }}>
        <div>
          <div className="eyebrow">Recent wins</div>
          <h3 className="soma-display" style={{ fontSize: 18, marginTop: 4, whiteSpace: "nowrap" }}>Worth celebrating</h3>
        </div>
        <Award className="w-5 h-5" style={{ color: "hsl(var(--primary))" }} />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 10 }}>
        {wins.map((w, i) => {
          const Icon = (WIN_META[w.type] ?? WIN_META.mastery).Icon;
          return (
            <div key={i} className="well" style={{ padding: 14 }} data-testid={`win-${w.type}-${i}`}>
              <div className="row between" style={{ marginBottom: 6 }}>
                <span style={{
                  width: 30, height: 30, borderRadius: 8, display: "grid", placeItems: "center",
                  background: "hsl(var(--success) / 0.12)", color: "hsl(var(--success))", border: "1px solid hsl(var(--success) / 0.25)",
                }}>
                  <Icon className="w-4 h-4" />
                </span>
                <span className="text-muted-foreground" style={{ fontSize: 11 }}>{humanize(w.ts)}</span>
              </div>
              <div style={{ fontWeight: 600, fontSize: 14 }}>{w.title}</div>
              <div className="text-muted-foreground" style={{ fontSize: 12 }}>{w.detail}</div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

export default function StudentDashboard() {
  const queryClient = useQueryClient();
  const [, setLocation] = useLocation();
  const { session, userId } = useSupabaseSession();
  const [view, setView] = useState<ViewKey>("dashboard");

  useEffect(() => {
    return subscribeToSomaMutations(() => {
      queryClient.invalidateQueries({ queryKey: ["/api/student/dashboard", userId] });
    });
  }, [queryClient, userId]);

  const { data, isLoading, isError, refetch } = useQuery<StudentDashboardPayload>({
    queryKey: ["/api/student/dashboard", userId],
    queryFn: async () => {
      const res = await authFetch("/api/student/dashboard");
      if (!res.ok) throw new Error(`Failed to load dashboard (${res.status})`);
      return res.json();
    },
    enabled: !!userId,
    // This is the page's heaviest aggregate. Local actions already refresh it
    // instantly via subscribeToSomaMutations (above), so we only need a slow
    // safety-net poll for server-originated changes (e.g. a tutor assigning new
    // work) plus a focus refetch — not a 10s storm of full-dashboard rebuilds.
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });

  // Syllabus-insights query — drives the topic-coverage radar + paper-readiness
  // heatmap so the dashboard shows topic + subject + paper-specific detail.
  const { data: syllabusInsights, isLoading: syllabusInsightsLoading } = useQuery<{ subjects: SubjectInsight[] }>({
    queryKey: ["/api/student/syllabus-insights", userId],
    queryFn: async () => {
      const res = await authFetch("/api/student/syllabus-insights");
      if (!res.ok) return { subjects: [] };
      return res.json();
    },
    enabled: !!userId,
  });

  // Examiner-driven study tips, fetched per subject.
  const subjectsForTips = useMemo(
    () => (data?.subjects ?? []).slice(0, 4),
    [data?.subjects],
  );
  const tipQueries = useQueries({
    queries: subjectsForTips.map((s) => ({
      queryKey: ["/api/student/study-tips", s.subject],
      queryFn: async (): Promise<StudyTipResponse> => {
        // Pull a generous slice per subject so the examiner-insights carousel
        // can show many different points across all of the student's subjects.
        const params = new URLSearchParams({ subject: s.subject, board: "Cambridge", top: "8" });
        const res = await authFetch(`/api/student/study-tips?${params.toString()}`);
        if (!res.ok) return { tips: [], cacheHit: false, elapsedMs: 0 };
        return res.json();
      },
      enabled: !!userId && !!s.subject,
      staleTime: 5 * 60 * 1000,
    })),
  });

  // All examiner insights across every subject the student studies, flattened
  // into carousel cards labelled by subject · level · topic. Interleaved by
  // subject so the carousel doesn't show one subject's tips all in a row.
  const examinerInsights: ExaminerInsightCard[] = useMemo(() => {
    const perSubject = subjectsForTips.map((s, i) => {
      const subj = subjectsForTips[i]?.subject;
      const level = (subjectsForTips[i] as any)?.level ?? null;
      return (tipQueries[i]?.data?.tips ?? []).map((t) => ({
        id: t.id,
        subject: subj,
        level,
        topic: t.topic,
        text: t.tip,
        whyItMatters: t.whyItMatters,
        action: t.correctApproach,
        frequency: t.frequency,
      }));
    });
    // Round-robin interleave so subjects alternate in the carousel.
    const out: ExaminerInsightCard[] = [];
    const maxLen = Math.max(0, ...perSubject.map((p) => p.length));
    for (let i = 0; i < maxLen; i++) {
      for (const p of perSubject) {
        if (p[i]) out.push(p[i]);
      }
    }
    return out;
  }, [tipQueries, subjectsForTips]);

  const handleLogout = async () => {
    await supabase.auth.signOut();
    setLocation("/login");
  };

  const launchQuiz = (quizId: number) => setLocation(`/soma/quiz/${quizId}`);

  const displayName = data?.student.displayName ?? (session?.user?.user_metadata?.display_name || session?.user?.email?.split("@")[0] || "Student");
  const initials = displayName.split(" ").map((n: string) => n[0]).join("").toUpperCase().slice(0, 2);

  const streakWin = data?.recentWins.find((w) => w.type === "streak");

  return (
    <div className="min-h-screen">
      <SomaHeader
        roleLabel="Student"
        displayName={displayName}
        initials={initials}
        onLogout={handleLogout}
        rightActions={
          <StudentNotificationsBell
            items={data?.notifications.items ?? []}
            unreadCount={data?.notifications.unreadCount ?? 0}
            studentKey={userId ?? ""}
          />
        }
      />

      <main className="max-w-[1240px] mx-auto px-6 pt-[26px] pb-20 space-y-8">
        {isLoading ? (
          <DashboardSkeleton />
        ) : isError || !data ? (
          <ErrorState onRetry={() => refetch()} />
        ) : (
          <>
            {/* PageIntro */}
            <div className="row between wrap" style={{ gap: 12 }} data-testid="section-greeting">
              <div>
                <h1 className="soma-display" style={{ fontSize: 34, marginBottom: 4 }} data-testid="text-greeting">{friendlyGreeting(data.greeting)}</h1>
                <div className="text-muted-foreground" style={{ fontSize: 14 }} data-testid="text-due-summary">{data.dueSummary}</div>
              </div>
              {streakWin && (
                <span className="chip chip-brand" style={{ fontSize: 12 }}>
                  <Flame className="w-3.5 h-3.5" />{streakWin.title}
                </span>
              )}
            </div>

            {/* view switcher */}
            <div className="seg" role="group" aria-label="View" style={{ marginBottom: 12 }}>
              <button aria-pressed={view === "dashboard"} onClick={() => setView("dashboard")}>Dashboard</button>
              <button aria-pressed={view === "assignments"} onClick={() => setView("assignments")}>Assignments</button>
              <button aria-pressed={view === "tools"} onClick={() => setView("tools")}>Study tools</button>
            </div>

            {view === "dashboard" && (
              <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 20, maxWidth: 880, margin: "0 auto", width: "100%" }}>
                <NextActions assignments={data.assignments} onStart={launchQuiz} />
                <PerformanceBlock data={data} />
                <FocusBlock data={data} />
                <ExaminerInsightsCarousel insights={examinerInsights} />
                <Suspense fallback={null}>
                  <SyllabusInsightsSection
                    insights={syllabusInsights}
                    isLoading={syllabusInsightsLoading}
                    studentFirstName={(data.student.displayName || "").split(" ")[0]}
                  />
                </Suspense>
                <WrittenFeedbackBlock data={data} />
                <WinsBlock wins={data.recentWins} />
              </div>
            )}

            {view === "assignments" && (
              <div className="space-y-6">
                <section className="space-y-3" data-testid="section-assignments">
                  <div className="eyebrow">Pending assessments</div>
                  <AssignmentsList assignments={data.assignments} />
                </section>
                <section className="space-y-3">
                  <div className="eyebrow">Completed ({data.completed.length})</div>
                  <CompletedAssessmentsTab completed={data.completed} />
                </section>
              </div>
            )}

            {view === "tools" && (
              <div className="space-y-6">
                {/* Topic coverage is the anchor: it frames every other tool by
                    showing what's covered, what's mastered, and what to study next. */}
                <TopicCoverageExplorer subjects={data.subjects} />
                <RevisionPlanCard />
                <MarkLossPredictor />
                <CommandWordCoach />
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}
