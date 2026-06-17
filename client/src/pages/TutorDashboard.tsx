import { useState, useMemo, useCallback, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import { supabase, authFetch } from "@/lib/supabase";
import { formatPersonName } from "@/lib/personName";
import { useSupabaseSession } from "@/hooks/use-supabase-session";
import type { SomaQuiz, SomaUser } from "@shared/schema";
import { defaultDueDateInputValue } from "@shared/dueDate";
import { getInitials } from "@/lib/utils";
import {
  Users, Plus, X,
  Loader2, Check, AlertTriangle,
  Clock, ChevronRight, ArrowRight, ArrowUpRight,
  Radar as RadarIcon, Flag, TrendingUp, CalendarDays, ClipboardCheck,
  CheckCircle2,
} from "lucide-react";
import { format } from "date-fns";
import { getLevelColor, getSubjectIcon } from "@/lib/subjectColors";
import { useToast } from "@/hooks/use-toast";
import { emitSomaMutation, subscribeToSomaMutations } from "@/lib/realtimeEvents";
import { type DashboardStats } from "@/components/dashboard-charts";
import { Ring, Spark, Donut, RadarChart } from "@/components/soma/Charts";
import SomaHeader from "@/components/soma/SomaHeader";
import TutorFlagsPanel from "@/components/tutor/TutorFlagsPanel";
import TutorNotificationsBell from "@/components/tutor/TutorNotificationsBell";

/* ── status chip → Warm Editorial chip class ──────────────────── */
function statusChipClass(text: string): string {
  switch (text) {
    case "On track": return "chip-success";
    case "Trend up": return "chip-success";
    case "Trend down": return "chip-danger";
    case "Needs marking": return "chip-brand";
    case "Awaiting": return "chip-warning";
    case "Low evidence": return "chip-warning";
    default: return "";
  }
}

function getStatusChip(s: DashboardStats["studentInsights"][0]): { text: string; dot: string } {
  const hasSubmissions = s.completed > 0;
  const allDone = s.assigned > 0 && s.awaiting === 0 && s.completed === s.assigned;
  if (!hasSubmissions && s.assigned > 0) return { text: "Awaiting", dot: "hsl(var(--warning))" };
  if (s.trend === "declining" && s.completed >= 2) return { text: "Trend down", dot: "hsl(var(--danger))" };
  if (s.completed < 3 && s.assigned > 0) return { text: "Low evidence", dot: "hsl(var(--warning))" };
  if (s.awaiting > 0 && !allDone) return { text: "Needs marking", dot: "hsl(var(--primary))" };
  if (s.trend === "improving") return { text: "Trend up", dot: "hsl(var(--success))" };
  if (allDone) return { text: "On track", dot: "hsl(var(--success))" };
  return { text: "Stable", dot: "hsl(var(--muted-foreground))" };
}

function avgColor(avg: number): string {
  if (avg >= 75) return "hsl(var(--success))";
  if (avg >= 55) return "hsl(var(--warning))";
  if (avg > 0) return "hsl(var(--danger))";
  return "hsl(var(--muted-foreground))";
}

/* ── Workload split bar (completed / awaiting / open) ─────────── */
function WorkloadBar({ assigned, completed, awaiting }: { assigned: number; completed: number; awaiting: number }) {
  const total = assigned || 1;
  const c = (completed / total) * 100;
  const a = (awaiting / total) * 100;
  const open = Math.max(0, assigned - completed - awaiting);
  return (
    <div>
      <div className="meter flex" style={{ padding: 0 }}>
        {c > 0 && <span style={{ width: `${c}%`, background: "hsl(var(--success))" }} />}
        {a > 0 && <span style={{ width: `${a}%`, background: "hsl(var(--warning))" }} />}
      </div>
      <div className="flex flex-wrap items-center gap-3 mt-1.5" style={{ fontSize: 11 }}>
        <span className="flex items-center gap-1.5"><b style={{ width: 7, height: 7, borderRadius: 9, background: "hsl(var(--success))", display: "inline-block" }} /><span className="text-muted-foreground">{completed} done</span></span>
        <span className="flex items-center gap-1.5"><b style={{ width: 7, height: 7, borderRadius: 9, background: "hsl(var(--warning))", display: "inline-block" }} /><span className="text-muted-foreground">{awaiting} to mark</span></span>
        <span className="flex items-center gap-1.5"><b style={{ width: 7, height: 7, borderRadius: 9, background: "hsl(var(--border))", display: "inline-block" }} /><span className="text-muted-foreground">{open} open</span></span>
      </div>
    </div>
  );
}

export default function TutorDashboard() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const [showAssignModal, setShowAssignModal] = useState<number | null>(null);
  const [selectedStudentIds, setSelectedStudentIds] = useState<Set<string>>(new Set());
  const [dueDate, setDueDate] = useState("");
  const [tab, setTab] = useState<"action" | "cohort" | "students">("action");
  const [drawerStudentId, setDrawerStudentId] = useState<string | null>(null);
  // Student-first assign flow: pre-select a student and let the tutor pick a quiz.
  const [assignForStudent, setAssignForStudent] = useState<{ id: string; name: string } | null>(null);
  const [assignForStudentQuizId, setAssignForStudentQuizId] = useState<number | null>(null);

  const { session, userId } = useSupabaseSession();
  const displayName = session?.user?.user_metadata?.display_name || session?.user?.email?.split("@")[0] || "Tutor";
  const initials = getInitials(displayName);

  const { data: stats, isLoading, isError: statsError } = useQuery<DashboardStats>({
    queryKey: ["/api/tutor/dashboard-stats", userId],
    queryFn: async () => {
      const res = await authFetch("/api/tutor/dashboard-stats");
      if (!res.ok) throw new Error("Failed to load stats");
      return res.json();
    },
    enabled: !!userId,
    refetchInterval: 15000,
    refetchOnWindowFocus: true,
  });

  const { data: tutorQuizzes = [] } = useQuery<SomaQuiz[]>({
    queryKey: ["/api/tutor/quizzes", userId],
    queryFn: async () => {
      if (!userId) return [];
      const res = await authFetch("/api/tutor/quizzes");
      if (!res.ok) return [];
      return res.json();
    },
    enabled: !!userId,
    refetchInterval: 15000,
    refetchOnWindowFocus: true,
    refetchOnMount: "always",
    staleTime: 0,
  });

  const { data: adoptedStudents = [] } = useQuery<SomaUser[]>({
    queryKey: ["/api/tutor/students", userId],
    queryFn: async () => {
      if (!userId) return [];
      const res = await authFetch("/api/tutor/students");
      if (!res.ok) return [];
      return res.json();
    },
    enabled: !!userId,
    refetchInterval: 15000,
    refetchOnWindowFocus: true,
  });

  const { data: cohortWeaknesses } = useQuery<{
    topics: Array<{
      subject: string; topic: string; subtopic: string | null;
      avgPercent: number; testedStudents: number; totalStudents: number;
      belowThreshold: number; struggleRate: number;
      totalQuestions: number; accuracy: number;
      strugglingStudents: string[];
    }>;
    studentCount: number;
  }>({
    queryKey: ["/api/tutor/cohort-weaknesses", userId],
    queryFn: async () => {
      const res = await authFetch("/api/tutor/cohort-weaknesses");
      if (!res.ok) return { topics: [], studentCount: 0 };
      return res.json();
    },
    enabled: !!userId,
    staleTime: 60000,
    refetchOnWindowFocus: false,
  });

  const assignMutation = useMutation({
    mutationFn: async ({ quizId, studentIds, dueDate: dd }: { quizId: number; studentIds: string[]; dueDate?: string }) => {
      const payload: { studentIds: string[]; dueDate?: string } = { studentIds };
      if (dd) payload.dueDate = new Date(dd).toISOString();
      const res = await authFetch(`/api/tutor/quizzes/${quizId}/assign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error("Failed to assign");
      return res.json();
    },
    onSuccess: (data) => {
      setShowAssignModal(null);
      setSelectedStudentIds(new Set());
      setDueDate("");
      const count = data?.assigned ?? 0;
      toast({
        title: count > 0 ? "Assessment assigned" : "Already assigned",
        description: count > 0
          ? `${count} student${count !== 1 ? "s" : ""} assigned successfully.`
          : "All selected students already have an assignment for this quiz.",
      });
      queryClient.invalidateQueries({ queryKey: ["/api/tutor/dashboard-stats"] });
      emitSomaMutation({ type: "assessment_assigned" });
    },
    onError: (err: Error) => {
      toast({ title: "Assignment failed", description: err.message, variant: "destructive" });
    },
  });

  const handleLogout = async () => {
    await supabase.auth.signOut();
    setLocation("/login");
  };

  const toggleStudentSelection = useCallback((id: string) => {
    setSelectedStudentIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const overdueCount = useMemo(() => {
    if (!stats?.pendingAssignments?.length) return 0;
    const now = new Date();
    return stats.pendingAssignments.filter((p) => p.dueDate && new Date(p.dueDate) < now).length;
  }, [stats]);

  useEffect(() => {
    return subscribeToSomaMutations(() => {
      queryClient.invalidateQueries({ queryKey: ["/api/tutor/dashboard-stats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/tutor/quizzes"] });
    });
  }, [queryClient]);

  /* ── Per-student plaques: derived from real studentInsights + recentSubmissions ── */
  const studentPlaques = useMemo(() => {
    const plaques = (stats?.studentInsights || []).map((s) => {
      const chip = getStatusChip(s);
      const submissions = (stats?.recentSubmissions || []).filter((sub) =>
        sub.studentId ? sub.studentId === s.studentId : sub.studentName === s.studentName,
      );
      const recentScores: number[] = submissions.slice(0, 5).map((sub) => sub.score).reverse();
      const lastScore = submissions.length > 0 ? submissions[0].score : null;
      // Average across the student's real submissions.
      const avg = submissions.length > 0
        ? Math.round(submissions.reduce((a, b) => a + b.score, 0) / submissions.length)
        : 0;
      const completionPct = s.assigned > 0 ? Math.round((s.completed / s.assigned) * 100) : 0;
      const lastSubmission = submissions.length > 0 ? submissions[0] : null;
      const lastActivity = lastSubmission ? lastSubmission.createdAt : null;
      return { ...s, chip, avg, completionPct, recentScores, lastScore, lastActivity, lastSubmission };
    });
    return plaques.sort((a, b) => {
      const aHasWork = a.assigned > 0 ? 0 : 1;
      const bHasWork = b.assigned > 0 ? 0 : 1;
      if (aHasWork !== bHasWork) return aHasWork - bHasWork;
      return a.studentName.localeCompare(b.studentName);
    });
  }, [stats]);

  type Plaque = (typeof studentPlaques)[number];

  /* ── Intervention queue: rank by urgency from real per-student signals.
        This dashboard view is deliberately a QUICK SUMMARY — a short reason plus
        weak-topic chips. The detailed, AI-written intervention narrative and the
        full problem-area breakdown live on the student's profile page. ── */
  const interventions = useMemo(() => {
    return studentPlaques
      .map((s) => {
        let severity: "critical" | "high" | "moderate" | null = null;
        let reason = "";
        if (s.trend === "declining" && s.completed >= 2) {
          severity = "critical";
          reason = s.lastScore !== null ? `Scores declining — last ${s.lastScore}%` : "Scores declining";
        } else if (s.assigned > 0 && s.completed === 0) {
          severity = "high";
          reason = "No submissions yet";
        } else if (s.weakTopics.length > 0) {
          severity = "high";
          reason = "Struggling with key topics";
        } else if (s.completed > 0 && s.completed < 3 && s.assigned > 0) {
          severity = "moderate";
          reason = "Not enough data yet";
        }
        return severity ? { s, severity, reason, topics: s.weakTopics.slice(0, 3) } : null;
      })
      .filter((x): x is { s: Plaque; severity: "critical" | "high" | "moderate"; reason: string; topics: string[] } => x !== null)
      .sort((a, b) => {
        const rank = { critical: 0, high: 1, moderate: 2 };
        return rank[a.severity] - rank[b.severity];
      });
  }, [studentPlaques]);

  /* ── Cohort radar from real per-subject averages ── */
  const radarData = useMemo(
    () => (stats?.cohortAverages || [])
      .filter((c) => c.count > 0)
      .slice(0, 8)
      .map((c) => ({ axis: c.subject?.length > 10 ? c.subject.slice(0, 10) : c.subject, value: Math.round(c.average) })),
    [stats?.cohortAverages],
  );

  /* ── Completion donut totals from real studentInsights ── */
  const completion = useMemo(() => {
    let completed = 0, awaiting = 0, notStarted = 0;
    for (const s of stats?.studentInsights || []) {
      completed += s.completed;
      awaiting += s.awaiting;
      notStarted += Math.max(0, s.assigned - s.completed - s.awaiting);
    }
    return { completed, awaiting, notStarted, total: completed + awaiting + notStarted };
  }, [stats]);

  /* ── Cohort average trend: weekly mean of real submissions (omit if too sparse) ── */
  const cohortTrend = useMemo(() => {
    const subs = stats?.recentSubmissions || [];
    if (subs.length === 0) return { series: [] as number[], delta: 0 };
    const byWeek: Record<string, number[]> = {};
    for (const sub of subs) {
      const d = new Date(sub.createdAt);
      d.setDate(d.getDate() - d.getDay());
      d.setHours(0, 0, 0, 0);
      const key = d.toISOString().slice(0, 10);
      (byWeek[key] ||= []).push(sub.score);
    }
    const series = Object.keys(byWeek)
      .sort()
      .map((k) => Math.round(byWeek[k].reduce((a, b) => a + b, 0) / byWeek[k].length));
    const delta = series.length >= 2 ? series[series.length - 1] - series[0] : 0;
    return { series, delta };
  }, [stats]);

  /* ── Cohort average headline number ── */
  const cohortAverage = useMemo(() => {
    const cas = (stats?.cohortAverages || []).filter((c) => c.count > 0);
    if (cas.length === 0) return null;
    const totalCount = cas.reduce((a, b) => a + b.count, 0);
    if (totalCount === 0) return null;
    return Math.round(cas.reduce((a, b) => a + b.average * b.count, 0) / totalCount);
  }, [stats?.cohortAverages]);

  /* ── Weak topics for "Where the cohort struggles" (real) ── */
  const weakTopics = useMemo(
    () => (cohortWeaknesses?.topics || [])
      .filter((t) => t.belowThreshold > 0)
      .slice(0, 8),
    [cohortWeaknesses],
  );

  const activeStudents = stats?.studentInsights?.length ?? 0;
  const pendingCount = stats?.pendingAssignments?.length ?? 0;
  const needsAttention = interventions.length;

  const drawerStudent = drawerStudentId
    ? studentPlaques.find((s) => s.studentId === drawerStudentId) ?? null
    : null;

  const kpis = [
    { label: "Active students", value: activeStudents, sub: "in your cohort", tone: "ink" },
    { label: "Pending to mark", value: pendingCount, sub: overdueCount > 0 ? `${overdueCount} overdue` : "all on time", tone: "warning" },
    { label: "Cohort average", value: cohortAverage !== null ? `${cohortAverage}%` : "—", sub: "across subjects", tone: "success" },
    { label: "Need attention", value: needsAttention, sub: "flagged below", tone: "danger" },
  ] as const;
  const toneColor: Record<string, string> = {
    ink: "hsl(var(--foreground))",
    warning: "hsl(var(--warning))",
    success: "hsl(var(--success))",
    danger: "hsl(var(--danger))",
  };

  return (
    <div className="min-h-screen">
      <SomaHeader
        roleLabel="Tutor"
        displayName={displayName}
        initials={initials}
        onLogout={handleLogout}
        rightActions={
          <>
            <nav className="hidden md:flex items-center gap-0.5 mr-1">
              <span className="px-3 py-2 text-[13px] font-semibold text-primary cursor-default" data-testid="nav-dashboard">Dashboard</span>
              <Link href="/tutor/students">
                <span className="px-3 py-2 text-[13px] font-medium text-muted-foreground hover:text-foreground cursor-pointer" data-testid="nav-students">Students</span>
              </Link>
              <Link href="/tutor/assessments">
                <span className="px-3 py-2 text-[13px] font-medium text-muted-foreground hover:text-foreground cursor-pointer" data-testid="nav-assessments">Assessments</span>
              </Link>
            </nav>
            <TutorNotificationsBell userId={userId} />
          </>
        }
      />

      <main className="max-w-[1240px] mx-auto px-6 pt-[26px] pb-20 space-y-6">
        {statsError ? (
          <div className="flex flex-col items-center justify-center py-32 gap-4" data-testid="dashboard-error">
            <div className="w-14 h-14 rounded-2xl flex items-center justify-center bg-warning/10 border border-warning/15">
              <AlertTriangle className="w-6 h-6 text-warning/80" />
            </div>
            <p className="text-sm text-foreground/80 font-semibold">Unable to load dashboard data</p>
            <p className="text-xs text-muted-foreground">Check your connection and try refreshing</p>
          </div>
        ) : isLoading ? (
          <div className="space-y-6 animate-in fade-in duration-300">
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 14 }}>
              {[1, 2, 3, 4].map((i) => <div key={i} className="soma-card" style={{ height: 96 }} />)}
            </div>
            <div className="h-10 w-72 rounded-xl bg-muted" />
            <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: 18 }}>
              <div className="soma-card" style={{ height: 320 }} />
              <div className="soma-card" style={{ height: 320 }} />
            </div>
          </div>
        ) : (
          <div className="space-y-6 animate-in fade-in duration-500">

            {/* ── PageIntro ──────────────────────────────────────── */}
            <div className="flex items-center justify-between flex-wrap" style={{ gap: 12 }} data-testid="section-greeting">
              <div>
                <h1 className="soma-display" style={{ fontSize: 34, marginBottom: 4 }} data-testid="text-greeting">
                  Hi {displayName.split(" ")[0]}
                </h1>
                <div className="text-muted-foreground" style={{ fontSize: 14 }}>
                  {format(new Date(), "EEEE, d MMMM yyyy")} · cohort overview
                </div>
              </div>
              <div className="flex items-center gap-2.5">
                <Link href="/tutor/students">
                  <span className="btn btn-ghost btn-sm" data-testid="button-view-students">
                    <Users className="w-3.5 h-3.5" /> Students
                  </span>
                </Link>
                <Link href="/tutor/assessments/new">
                  <span className="btn btn-primary btn-sm" data-testid="button-create-assessment">
                    <ClipboardCheck className="w-3.5 h-3.5" /> Build a quiz
                  </span>
                </Link>
              </div>
            </div>

            {/* ── KPI STRIP ──────────────────────────────────────── */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 14 }} data-testid="kpi-strip">
              {kpis.map((k) => (
                <div key={k.label} className="soma-card" style={{ padding: "16px 18px" }}>
                  <div className="eyebrow" style={{ marginBottom: 10 }}>{k.label}</div>
                  <div className="num" style={{ fontSize: 30, color: toneColor[k.tone] }}>{k.value}</div>
                  <div className="text-muted-foreground" style={{ fontSize: 12, marginTop: 2 }}>{k.sub}</div>
                </div>
              ))}
            </div>

            {/* ── TAB LIST ───────────────────────────────────────── */}
            <div className="seg" style={{ alignSelf: "start" }} role="tablist">
              <button aria-pressed={tab === "action"} onClick={() => setTab("action")} data-testid="dash-tab-action">
                <AlertTriangle className="w-3.5 h-3.5" /> Action Center
              </button>
              <button aria-pressed={tab === "cohort"} onClick={() => setTab("cohort")} data-testid="dash-tab-analytics">
                <RadarIcon className="w-3.5 h-3.5" /> Cohort Analytics
              </button>
              <button aria-pressed={tab === "students"} onClick={() => setTab("students")} data-testid="dash-tab-students">
                <Users className="w-3.5 h-3.5" /> Students
              </button>
            </div>

            {/* ══════════════════════════════════════════════════════
                ACTION CENTER
               ══════════════════════════════════════════════════════ */}
            {tab === "action" && (
              <div className="animate-in fade-in duration-300" style={{ display: "grid", gap: 18 }}>
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-[18px]">

                  {/* Intervention queue */}
                  <section className="soma-card" style={{ padding: 0, overflow: "hidden" }}>
                    <div className="flex items-center justify-between" style={{ padding: "16px 20px", borderBottom: "1px solid hsl(var(--border))" }}>
                      <span className="flex items-center" style={{ gap: 9 }}>
                        <span className="grid place-items-center" style={{ width: 30, height: 30, borderRadius: 8, background: "hsl(var(--danger-soft))", color: "hsl(var(--danger))", border: "1px solid hsl(var(--danger-line))" }}>
                          <AlertTriangle className="w-4 h-4" />
                        </span>
                        <span>
                          <h3 className="font-bold text-foreground" style={{ fontSize: 15 }}>Intervention queue</h3>
                          <span className="text-muted-foreground" style={{ fontSize: 12 }}>Who needs you — open a student for the full breakdown</span>
                        </span>
                      </span>
                      <span className="chip chip-danger">{interventions.length}</span>
                    </div>
                    {interventions.length === 0 ? (
                      <div className="px-5 py-10 text-center">
                        <CheckCircle2 className="w-8 h-8 mx-auto text-success/30 mb-2" />
                        <p className="text-[12px] text-muted-foreground font-medium">No students flagged — great work!</p>
                      </div>
                    ) : (
                      <div style={{ maxHeight: 360, overflow: "auto" }}>
                        {interventions.map(({ s, severity, reason, topics }) => {
                          const bar = severity === "critical" ? "hsl(var(--danger))" : severity === "high" ? "hsl(var(--warning))" : "hsl(var(--muted-foreground))";
                          const cls = severity === "critical" ? "chip-danger" : severity === "high" ? "chip-warning" : "";
                          const label = severity === "critical" ? "Critical" : severity === "high" ? "High" : "Watch";
                          return (
                            <button
                              key={s.studentId}
                              onClick={() => setDrawerStudentId(s.studentId)}
                              className="flex items-center justify-between w-full text-left hover:bg-foreground/[0.03] transition-colors"
                              style={{ gap: 12, padding: "13px 20px", borderBottom: "1px solid hsl(var(--border))", borderLeft: `3px solid ${bar}`, background: "transparent", cursor: "pointer" }}
                              data-testid={`intervention-${s.studentId}`}
                            >
                              <span className="flex items-center" style={{ gap: 12, minWidth: 0 }}>
                                <span className="avatar" style={{ width: 38, height: 38, fontSize: 13 }}>{getInitials(s.studentName)}</span>
                                <span style={{ minWidth: 0 }}>
                                  <span className="flex items-center" style={{ gap: 8 }}>
                                    <b style={{ fontSize: 14 }}>{s.studentName}</b>
                                    <span className={`chip ${cls}`} style={{ fontSize: 10 }}>{label}</span>
                                  </span>
                                  <span className="block text-foreground/70" style={{ fontSize: 12.5, marginTop: 2 }}>{reason}</span>
                                  {topics.length > 0 && (
                                    <span className="flex items-center flex-wrap" style={{ gap: 4, marginTop: 5 }}>
                                      {topics.map((t) => (
                                        <span key={t} className="chip chip-danger" style={{ fontSize: 9.5, padding: "1px 7px" }}>{t}</span>
                                      ))}
                                    </span>
                                  )}
                                </span>
                              </span>
                              <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </section>

                  {/* Pending to mark */}
                  <section className="soma-card" style={{ padding: 0, overflow: "hidden", display: "flex", flexDirection: "column" }}>
                    <div className="flex items-center justify-between" style={{ padding: "16px 20px", borderBottom: "1px solid hsl(var(--border))" }}>
                      <span className="flex items-center" style={{ gap: 9 }}>
                        <span className="grid place-items-center" style={{ width: 30, height: 30, borderRadius: 8, background: "hsl(var(--warning-soft))", color: "hsl(var(--warning))", border: "1px solid hsl(var(--warning-line))" }}>
                          <Clock className="w-4 h-4" />
                        </span>
                        <span>
                          <h3 className="font-bold text-foreground" style={{ fontSize: 15 }}>Pending to mark</h3>
                          <span className="text-muted-foreground" style={{ fontSize: 12 }}>Submissions awaiting review</span>
                        </span>
                      </span>
                      <span className="flex items-center" style={{ gap: 8 }}>
                        {overdueCount > 0 && <span className="chip chip-danger" data-testid="stat-assigned">{overdueCount} overdue</span>}
                        <span className="chip chip-warning">{pendingCount}</span>
                      </span>
                    </div>
                    {pendingCount === 0 ? (
                      <div className="px-5 py-10 text-center">
                        <CheckCircle2 className="w-8 h-8 mx-auto text-success/30 mb-2" />
                        <p className="text-[12px] text-muted-foreground font-medium">No pending work</p>
                      </div>
                    ) : (
                      <div style={{ overflow: "auto", maxHeight: 360 }}>
                        {stats!.pendingAssignments.slice(0, 12).map((pa) => {
                          const isOverdue = pa.dueDate && new Date(pa.dueDate) < new Date();
                          return (
                            <div key={pa.assignmentId} className="flex items-center justify-between" style={{ gap: 12, padding: "11px 20px", borderBottom: "1px solid hsl(var(--border))" }} data-testid={`pending-assignment-${pa.assignmentId}`}>
                              <span style={{ minWidth: 0 }}>
                                <b className="block truncate" style={{ fontSize: 13.5 }}>{pa.quizTitle}</b>
                                <span className="text-muted-foreground" style={{ fontSize: 12 }}>{pa.studentName}</span>
                              </span>
                              <span className="flex items-center shrink-0" style={{ gap: 10 }}>
                                <span className={`chip ${isOverdue ? "chip-danger" : ""}`} style={{ fontSize: 11 }}>
                                  {isOverdue ? "Overdue" : pa.dueDate ? `Due ${format(new Date(pa.dueDate), "MMM d")}` : "Pending"}
                                </span>
                                <Link href={`/tutor/assessment/${pa.quizId}`}>
                                  <span className="btn btn-ghost btn-sm">Mark</span>
                                </Link>
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </section>
                </div>

                {/* Student flags — reuses TutorFlagsPanel (self-fetching) */}
                <section className="soma-card" style={{ padding: 0, overflow: "hidden" }}>
                  <div className="flex items-center justify-between" style={{ padding: "16px 20px", borderBottom: "1px solid hsl(var(--border))" }}>
                    <span className="flex items-center" style={{ gap: 9 }}>
                      <span className="grid place-items-center" style={{ width: 30, height: 30, borderRadius: 8, background: "hsl(var(--info-soft))", color: "hsl(var(--info))", border: "1px solid hsl(var(--info-line))" }}>
                        <Flag className="w-[15px] h-[15px]" />
                      </span>
                      <span>
                        <h3 className="font-bold text-foreground" style={{ fontSize: 15 }}>Student flags</h3>
                        <span className="text-muted-foreground" style={{ fontSize: 12 }}>Questions flagged for review — across all assessments</span>
                      </span>
                    </span>
                  </div>
                  <div className="p-5">
                    <TutorFlagsPanel />
                  </div>
                </section>
              </div>
            )}

            {/* ══════════════════════════════════════════════════════
                COHORT ANALYTICS
               ══════════════════════════════════════════════════════ */}
            {tab === "cohort" && (
              <div className="animate-in fade-in duration-300" style={{ display: "grid", gap: 18 }}>
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-[18px]">
                  <section className="soma-card" style={{ padding: 22 }}>
                    <div className="eyebrow" style={{ marginBottom: 4 }}>Subject radar</div>
                    <h3 className="soma-display" style={{ fontSize: 18, marginBottom: 8 }}>Cohort strengths</h3>
                    {radarData.length >= 2 ? (
                      <div className="grid place-items-center">
                        <RadarChart data={radarData} size={250} />
                      </div>
                    ) : (
                      <div className="flex items-center justify-center text-muted-foreground text-xs font-medium" style={{ height: 250 }}>
                        Need 2+ subjects with data for the radar
                      </div>
                    )}
                  </section>

                  <div style={{ display: "grid", gap: 18 }}>
                    <section className="soma-card" style={{ padding: 22 }}>
                      <div className="eyebrow" style={{ marginBottom: 12 }}>Completion</div>
                      {completion.total > 0 ? (
                        <Donut
                          completed={Math.round((completion.completed / completion.total) * 100)}
                          awaiting={Math.round((completion.awaiting / completion.total) * 100)}
                          notStarted={Math.round((completion.notStarted / completion.total) * 100)}
                          size={130}
                        />
                      ) : (
                        <div className="text-muted-foreground text-xs font-medium py-8 text-center">No assignment data</div>
                      )}
                    </section>

                    {cohortTrend.series.length >= 2 && (
                      <section className="soma-card" style={{ padding: 22 }}>
                        <div className="flex items-center justify-between" style={{ marginBottom: 10 }}>
                          <div className="eyebrow">Cohort average · weekly</div>
                          <span className={`chip ${cohortTrend.delta >= 0 ? "chip-success" : "chip-danger"}`}>
                            <TrendingUp className="w-3 h-3" />
                            {cohortTrend.delta >= 0 ? "+" : ""}{cohortTrend.delta} pts
                          </span>
                        </div>
                        <Spark data={cohortTrend.series} w={300} h={56} stroke="hsl(var(--success))" />
                      </section>
                    )}
                  </div>
                </div>

                {/* Where the cohort struggles — real weak topics */}
                <section className="soma-card" style={{ padding: 0, overflow: "hidden" }}>
                  <div className="flex items-center justify-between" style={{ padding: "16px 20px", borderBottom: "1px solid hsl(var(--border))" }}>
                    <span>
                      <h3 className="font-bold text-foreground" style={{ fontSize: 15 }}>Where the cohort struggles</h3>
                      <span className="text-muted-foreground" style={{ fontSize: 12 }}>Lowest-mastery topics by struggle rate</span>
                    </span>
                    {cohortWeaknesses?.studentCount ? <span className="chip">{cohortWeaknesses.studentCount} students</span> : null}
                  </div>
                  {weakTopics.length === 0 ? (
                    <div className="px-5 py-10 text-center">
                      <CheckCircle2 className="w-8 h-8 mx-auto text-success/30 mb-2" />
                      <p className="text-[12px] text-muted-foreground font-medium">No cohort-wide weaknesses detected</p>
                    </div>
                  ) : (
                    weakTopics.map((t, i) => {
                      const col = t.avgPercent >= 70 ? "hsl(var(--success))" : t.avgPercent >= 50 ? "hsl(var(--warning))" : "hsl(var(--danger))";
                      return (
                        <div key={i} className="flex items-center justify-between" style={{ gap: 14, padding: "13px 20px", borderBottom: i < weakTopics.length - 1 ? "1px solid hsl(var(--border))" : "none" }}>
                          <span style={{ flex: "0 0 200px", minWidth: 160 }}>
                            <b style={{ fontSize: 14 }}>{t.topic}</b>
                            <span className="block text-muted-foreground" style={{ fontSize: 12 }}>{t.subject} · {t.belowThreshold}/{t.testedStudents} struggling</span>
                          </span>
                          <span className="meter" style={{ flex: 1 }}><span style={{ width: `${t.avgPercent}%`, background: col }} /></span>
                          <span className="num" style={{ width: 40, textAlign: "right", color: col, fontSize: 14 }}>{t.avgPercent}%</span>
                          <span className="chip chip-danger shrink-0" style={{ fontSize: 11 }}>{t.struggleRate}% struggle</span>
                        </div>
                      );
                    })
                  )}
                </section>
              </div>
            )}

            {/* ══════════════════════════════════════════════════════
                STUDENTS — plaque grid
               ══════════════════════════════════════════════════════ */}
            {tab === "students" && (
              <div className="animate-in fade-in duration-300">
                <div className="flex items-center justify-between" style={{ marginBottom: 14 }}>
                  <h3 className="soma-display" style={{ fontSize: 20 }}>
                    All students <span className="text-muted-foreground" style={{ fontSize: 15, fontWeight: 400 }}>· {studentPlaques.length}</span>
                  </h3>
                  <Link href="/tutor/students">
                    <span className="btn btn-ghost btn-sm"><Users className="w-3.5 h-3.5" /> Manage students</span>
                  </Link>
                </div>
                {studentPlaques.length === 0 ? (
                  <div className="soma-card px-6 py-16 text-center">
                    <Users className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
                    <p className="text-sm text-muted-foreground font-medium">No students yet</p>
                    <Link href="/tutor/students">
                      <span className="text-xs text-primary hover:text-primary/80 cursor-pointer mt-1 inline-block">Go to the Students page to adopt students</span>
                    </Link>
                  </div>
                ) : (
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(280px,1fr))", gap: 16 }} data-testid="student-plaque-grid">
                    {studentPlaques.map((s) => (
                      <div key={s.studentId} className="soma-card" style={{ padding: 18, display: "flex", flexDirection: "column", gap: 14 }} data-testid={`plaque-${s.studentId}`}>
                        <div className="flex items-center justify-between">
                          <span className="flex items-center" style={{ gap: 11, minWidth: 0 }}>
                            <span className="avatar" style={{ width: 42, height: 42, fontSize: 14 }}>{getInitials(s.studentName)}</span>
                            <span style={{ minWidth: 0 }}>
                              <b className="block truncate" style={{ fontSize: 14.5 }}>{s.studentName}</b>
                              <span className={`chip ${statusChipClass(s.chip.text)}`} style={{ fontSize: 10, marginTop: 3 }}>{s.chip.text}</span>
                            </span>
                          </span>
                          <Ring pct={s.avg} size={52} stroke={5} color={avgColor(s.avg)}>
                            <span className="num" style={{ fontSize: 13 }}>{s.avg ? `${s.avg}%` : "—"}</span>
                          </Ring>
                        </div>

                        <WorkloadBar assigned={s.assigned} completed={s.completed} awaiting={s.awaiting} />

                        <div className="flex items-center justify-between" style={{ paddingTop: 12, borderTop: "1px solid hsl(var(--border))" }}>
                          <span className="flex items-center flex-wrap" style={{ gap: 6 }}>
                            {s.weakTopics.length > 0
                              ? s.weakTopics.slice(0, 3).map((w) => <span key={w} className="chip chip-danger" style={{ fontSize: 10 }}>{w}</span>)
                              : <span className="chip chip-success" style={{ fontSize: 10 }}><Check className="w-3 h-3" />No weak topics</span>}
                          </span>
                          <button className="btn btn-quiet btn-sm" onClick={() => setDrawerStudentId(s.studentId)} data-testid={`button-open-${s.studentId}`}>
                            Open <ArrowRight className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </main>

      {/* ── STUDENT DRAWER (slide-over) ───────────────────────── */}
      {drawerStudent && (
        <div className="fixed inset-0 z-[60]">
          <div className="absolute inset-0" style={{ background: "rgba(20,17,28,.45)", backdropFilter: "blur(2px)" }} onClick={() => setDrawerStudentId(null)} />
          <aside
            className="absolute top-0 right-0 h-full bg-card border-l border-card-border overflow-auto animate-in slide-in-from-right duration-200"
            style={{ width: "min(440px, 92vw)", boxShadow: "var(--shadow-lg)", padding: 24 }}
            data-testid="student-drawer"
          >
            <div className="flex items-center justify-between" style={{ marginBottom: 20 }}>
              <span className="eyebrow">Student detail</span>
              <button className="btn btn-quiet btn-sm px-2" onClick={() => setDrawerStudentId(null)} aria-label="Close"><X className="w-4 h-4" /></button>
            </div>
            <div className="flex items-center" style={{ gap: 14, marginBottom: 20 }}>
              <span className="avatar" style={{ width: 56, height: 56, fontSize: 20 }}>{getInitials(drawerStudent.studentName)}</span>
              <div>
                <h2 className="soma-display" style={{ fontSize: 24 }}>{drawerStudent.studentName}</h2>
                <span className={`chip ${statusChipClass(drawerStudent.chip.text)}`} style={{ marginTop: 6 }}>{drawerStudent.chip.text}</span>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3" style={{ marginBottom: 18 }}>
              <div className="well" style={{ padding: 14 }}>
                <div className="eyebrow">Average</div>
                <div className="num" style={{ fontSize: 26 }}>{drawerStudent.avg ? `${drawerStudent.avg}%` : "—"}</div>
              </div>
              <div className="well" style={{ padding: 14 }}>
                <div className="eyebrow">Completed</div>
                <div className="num" style={{ fontSize: 26 }}>{drawerStudent.completed}/{drawerStudent.assigned}</div>
              </div>
            </div>
            <div className="well" style={{ padding: 16, marginBottom: 18 }}>
              <div className="eyebrow" style={{ marginBottom: 10 }}>Workload</div>
              <WorkloadBar assigned={drawerStudent.assigned} completed={drawerStudent.completed} awaiting={drawerStudent.awaiting} />
            </div>
            <div style={{ marginBottom: 18 }}>
              <div className="eyebrow" style={{ marginBottom: 8 }}>Weak topics</div>
              <div className="flex items-center flex-wrap" style={{ gap: 6 }}>
                {drawerStudent.weakTopics.length > 0
                  ? drawerStudent.weakTopics.map((w) => <span key={w} className="chip chip-danger">{w}</span>)
                  : <span className="chip chip-success"><Check className="w-3 h-3" />None flagged</span>}
              </div>
            </div>
            <div className="flex items-center" style={{ gap: 10 }}>
              <Link href={`/tutor/students/${drawerStudent.studentId}`} className="flex-1">
                <span className="btn btn-primary w-full" data-testid={`link-profile-${drawerStudent.studentId}`}>
                  <ArrowUpRight className="w-4 h-4" /> Open profile
                </span>
              </Link>
              <button
                className="btn btn-ghost flex-1"
                onClick={() => {
                  setAssignForStudent({ id: drawerStudent.studentId, name: drawerStudent.studentName });
                  setAssignForStudentQuizId(null);
                  setDueDate("");
                  setDrawerStudentId(null);
                }}
                data-testid={`button-assign-drawer-${drawerStudent.studentId}`}
              >
                <Plus className="w-4 h-4" /> Assign work
              </button>
            </div>
          </aside>
        </div>
      )}

      {/* ── ASSIGN MODAL (quiz → students) ────────────────────── */}
      {showAssignModal !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 backdrop-blur-lg p-4" onClick={() => setShowAssignModal(null)}>
          <div className="soma-card max-w-lg w-full max-h-[80vh] overflow-y-auto p-6" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between gap-3 mb-5">
              <h3 className="text-base font-bold text-foreground">Assign Assessment</h3>
              <button onClick={() => setShowAssignModal(null)} className="btn btn-quiet btn-sm px-2" data-testid="button-close-assign-modal">
                <X className="w-4 h-4" />
              </button>
            </div>
            <p className="text-[11px] text-muted-foreground mb-4 font-medium">Select students:</p>
            {adoptedStudents.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">No students yet. Go to the Students tab to add students first.</p>
            ) : (
              <>
                <div className="space-y-1.5 max-h-[50vh] overflow-y-auto">
                  {adoptedStudents.map((student) => {
                    const studentLabel = formatPersonName(student);
                    const si = getInitials(studentLabel);
                    const selected = selectedStudentIds.has(student.id);
                    return (
                      <button
                        key={student.id}
                        onClick={() => toggleStudentSelection(student.id)}
                        className={`w-full min-h-[44px] flex items-center gap-3 px-4 py-2.5 rounded-xl transition-all text-left ${selected ? "bg-primary/12 border border-primary/25" : "bg-foreground/[0.03] border border-border/50 hover:bg-foreground/[0.05]"}`}
                        data-testid={`assign-student-${student.id}`}
                      >
                        <div className={`w-5 h-5 rounded-md border flex items-center justify-center transition-colors ${selected ? "bg-primary border-primary" : "border-border"}`}>
                          {selected && <Check className="w-3 h-3 text-white" />}
                        </div>
                        <span className="avatar" style={{ width: 28, height: 28, fontSize: 11 }}>{si}</span>
                        <p className="text-[13px] font-medium text-foreground">{studentLabel}</p>
                      </button>
                    );
                  })}
                </div>
                <div className="mt-4 p-3 rounded-xl bg-foreground/[0.03] border border-border/50">
                  <label className="flex items-center gap-2 text-[11px] font-semibold text-muted-foreground mb-2">
                    <CalendarDays className="w-3.5 h-3.5 text-primary" />
                    Due Date <span className="text-muted-foreground">(defaults to 3 days out)</span>
                  </label>
                  <input
                    type="datetime-local"
                    value={dueDate}
                    onChange={(e) => setDueDate(e.target.value)}
                    className="w-full px-3 py-2.5 min-h-[44px] rounded-lg bg-background/80 border border-border/60 text-sm text-foreground focus:outline-none focus:border-primary/40 focus:ring-1 focus:ring-primary/20"
                    data-testid="input-due-date"
                  />
                </div>
                <button
                  onClick={() => assignMutation.mutate({ quizId: showAssignModal, studentIds: Array.from(selectedStudentIds), dueDate: dueDate || undefined })}
                  disabled={selectedStudentIds.size === 0 || assignMutation.isPending}
                  className="btn btn-primary w-full mt-4 py-3 min-h-[44px]"
                  data-testid="button-confirm-assign"
                >
                  {assignMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mx-auto" /> : `Assign to ${selectedStudentIds.size} Student${selectedStudentIds.size !== 1 ? "s" : ""}`}
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {/* ── STUDENT-FIRST ASSIGN MODAL (student → quiz) ───────── */}
      {assignForStudent !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 backdrop-blur-lg p-4" onClick={() => setAssignForStudent(null)}>
          <div className="soma-card max-w-lg w-full max-h-[80vh] overflow-y-auto p-6" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between gap-3 mb-4">
              <div>
                <h3 className="text-base font-bold text-foreground">Assign to {assignForStudent.name}</h3>
                <p className="text-[11px] text-muted-foreground mt-0.5">Pick an assessment to assign.</p>
              </div>
              <button onClick={() => setAssignForStudent(null)} className="btn btn-quiet btn-sm px-2" data-testid="button-close-student-assign-modal">
                <X className="w-4 h-4" />
              </button>
            </div>
            {tutorQuizzes.length === 0 ? (
              <div className="text-center py-10">
                <p className="text-sm text-muted-foreground mb-3">You haven't created any assessments yet.</p>
                <Link href="/tutor/assessments/new">
                  <span className="text-[12px] text-primary hover:text-primary/80 font-semibold cursor-pointer">Create your first assessment &rarr;</span>
                </Link>
              </div>
            ) : (
              <>
                <div className="space-y-1.5 max-h-[45vh] overflow-y-auto">
                  {tutorQuizzes.map((quiz) => {
                    const sc = getLevelColor(quiz.level);
                    const SubIcon = getSubjectIcon(quiz.subject);
                    const selected = assignForStudentQuizId === quiz.id;
                    return (
                      <button
                        key={quiz.id}
                        onClick={() => { setAssignForStudentQuizId(quiz.id); setDueDate(defaultDueDateInputValue(quiz.createdAt)); }}
                        className={`w-full min-h-[44px] flex items-center gap-3 px-4 py-2.5 rounded-xl transition-all text-left ${selected ? "bg-primary/12 border border-primary/25" : "bg-foreground/[0.03] border border-border/50 hover:bg-foreground/[0.05]"}`}
                        data-testid={`assign-quiz-${quiz.id}`}
                      >
                        <div className={`w-5 h-5 rounded-md border flex items-center justify-center transition-colors ${selected ? "bg-primary border-primary" : "border-border"}`}>
                          {selected && <Check className="w-3 h-3 text-white" />}
                        </div>
                        <div className={`w-7 h-7 rounded-lg flex items-center justify-center border shrink-0 ${sc.bg} ${sc.border}`}>
                          <SubIcon className={`w-3.5 h-3.5 ${sc.label}`} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-[13px] font-medium text-foreground truncate">{quiz.title}</p>
                          <p className="text-[10px] text-muted-foreground truncate">{quiz.subject || "General"}</p>
                        </div>
                      </button>
                    );
                  })}
                </div>
                <div className="mt-4 p-3 rounded-xl bg-foreground/[0.03] border border-border/50">
                  <label className="flex items-center gap-2 text-[11px] font-semibold text-muted-foreground mb-2">
                    <CalendarDays className="w-3.5 h-3.5 text-primary" />
                    Due Date <span className="text-muted-foreground">(defaults to 3 days out)</span>
                  </label>
                  <input
                    type="datetime-local"
                    value={dueDate}
                    onChange={(e) => setDueDate(e.target.value)}
                    className="w-full px-3 py-2.5 min-h-[44px] rounded-lg bg-background/80 border border-border/60 text-sm text-foreground focus:outline-none focus:border-primary/40 focus:ring-1 focus:ring-primary/20"
                    data-testid="input-student-assign-due-date"
                  />
                </div>
                <button
                  onClick={() => {
                    if (!assignForStudentQuizId || !assignForStudent) return;
                    assignMutation.mutate(
                      { quizId: assignForStudentQuizId, studentIds: [assignForStudent.id], dueDate: dueDate || undefined },
                      { onSuccess: () => setAssignForStudent(null) },
                    );
                  }}
                  disabled={assignForStudentQuizId === null || assignMutation.isPending}
                  className="btn btn-primary w-full mt-4 py-3 min-h-[44px]"
                  data-testid="button-confirm-student-assign"
                >
                  {assignMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mx-auto" /> : `Assign to ${assignForStudent.name.split(" ")[0]}`}
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
