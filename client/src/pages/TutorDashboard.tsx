import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import { supabase, authFetch } from "@/lib/supabase";
import { useSupabaseSession } from "@/hooks/use-supabase-session";
import type { SomaQuiz, SomaUser } from "@shared/schema";
import type { LucideIcon } from "lucide-react";
import {
  LogOut, Users, BookOpen, Plus, UserPlus, X,
  Loader2, Check, ChevronRight, AlertTriangle,
  LayoutDashboard, Clock, Send, Award, Eye,
  TrendingDown, TrendingUp as TrendingUpIcon, Minus, Activity,
  FileText, ArrowRight, BarChart3, Target, CheckCircle2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { format, formatDistanceToNow } from "date-fns";
import { getSubjectColor, getSubjectIcon } from "@/lib/subjectColors";
import { useToast } from "@/hooks/use-toast";
import { emitSomaMutation, subscribeToSomaMutations } from "@/lib/realtimeEvents";

interface DashboardStats {
  totalStudents: number;
  totalQuizzes: number;
  cohortAverages: { subject: string; average: number; count: number }[];
  recentSubmissions: {
    reportId: number;
    studentName: string;
    score: number;
    quizTitle: string;
    subject: string | null;
    createdAt: string;
    startedAt: string | null;
    completedAt: string | null;
  }[];
  pendingAssignments: {
    assignmentId: number;
    quizId: number;
    quizTitle: string;
    subject: string | null;
    studentId: string;
    studentName: string;
    dueDate: string | null;
    createdAt: string;
  }[];
  studentInsights: {
    studentId: string;
    studentName: string;
    assigned: number;
    completed: number;
    awaiting: number;
    trend: "improving" | "declining" | "stable";
    weakTopics: string[];
  }[];
}

function formatDuration(startedAt: string | null, completedAt: string | null): string {
  if (!startedAt || !completedAt) return "";
  const diffMs = new Date(completedAt).getTime() - new Date(startedAt).getTime();
  if (diffMs < 0 || isNaN(diffMs)) return "";
  const mins = Math.floor(diffMs / 60000);
  const secs = Math.floor((diffMs % 60000) / 1000);
  if (mins === 0) return `${secs}s`;
  return `${mins}m ${secs}s`;
}

function AnimatedNumber({ value, suffix = "" }: { value: number; suffix?: string }) {
  const [display, setDisplay] = useState(0);
  const ref = useRef<number>(0);
  useEffect(() => {
    const target = value;
    const start = ref.current;
    const duration = 800;
    const startTime = performance.now();
    let rafId: number;
    const animate = (now: number) => {
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      const current = Math.round(start + (target - start) * eased);
      setDisplay(current);
      if (progress < 1) { rafId = requestAnimationFrame(animate); }
      else ref.current = target;
    };
    rafId = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(rafId);
  }, [value]);
  return <>{display}{suffix}</>;
}

function MiniBar({ completed, awaiting, total }: { completed: number; awaiting: number; total: number }) {
  const max = Math.max(total, 1);
  const cPct = (completed / max) * 100;
  const aPct = (awaiting / max) * 100;
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 rounded-full bg-slate-800/80 overflow-hidden flex">
        <div className="rounded-l-full bg-emerald-500/80 transition-all duration-700" style={{ width: `${cPct}%` }} />
        <div className="bg-amber-500/60 transition-all duration-700" style={{ width: `${aPct}%` }} />
      </div>
      <span className="text-[10px] text-slate-500 tabular-nums w-10 text-right">{completed}/{total}</span>
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
  const [activeTab, setActiveTab] = useState<"submissions" | "pending">("submissions");

  const { session, userId } = useSupabaseSession();
  const displayName = session?.user?.user_metadata?.display_name || session?.user?.email?.split("@")[0] || "Tutor";
  const initials = displayName.split(" ").map((n: string) => n[0]).join("").toUpperCase().slice(0, 2);

  const { data: stats, isLoading } = useQuery<DashboardStats>({
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

  const { data: tutorQuizzes = [], isLoading: quizzesLoading } = useQuery<SomaQuiz[]>({
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
        variant: count > 0 ? "default" : "destructive",
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

  const overallAvg = useMemo(() => {
    if (!stats?.cohortAverages?.length) return null;
    const total = stats.cohortAverages.reduce((s, c) => s + c.average * c.count, 0);
    const count = stats.cohortAverages.reduce((s, c) => s + c.count, 0);
    return count > 0 ? Math.round(total / count) : null;
  }, [stats]);

  const atRiskStudents = useMemo(() => {
    if (!stats?.studentInsights?.length) return [];
    return stats.studentInsights
      .filter((s) => s.trend === "declining" || s.weakTopics.length > 0 || (s.awaiting > 0 && s.completed === 0))
      .sort((a, b) => {
        const aScore = (a.trend === "declining" ? 3 : 0) + a.weakTopics.length + (a.awaiting > a.completed ? 2 : 0);
        const bScore = (b.trend === "declining" ? 3 : 0) + b.weakTopics.length + (b.awaiting > b.completed ? 2 : 0);
        return bScore - aScore;
      })
      .slice(0, 5);
  }, [stats]);

  const completionRate = useMemo(() => {
    if (!stats?.studentInsights?.length) return null;
    const totalAssigned = stats.studentInsights.reduce((s, i) => s + i.assigned, 0);
    const totalCompleted = stats.studentInsights.reduce((s, i) => s + i.completed, 0);
    return totalAssigned > 0 ? Math.round((totalCompleted / totalAssigned) * 100) : null;
  }, [stats]);

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


  return (
    <div className="min-h-screen bg-slate-950">
      <header className="border-b border-slate-800/60 bg-slate-950/90 backdrop-blur-xl sticky top-0 z-20">
        <div className="max-w-[1280px] mx-auto px-6 py-4 flex items-center justify-between">
          <Link href="/">
            <div className="flex items-center gap-3 cursor-pointer">
              <img src="/MCEC - White Logo.png" alt="MCEC Logo" loading="lazy" className="h-10 w-auto object-contain" />
              <div>
                <h1 className="text-lg font-bold gradient-text">SOMA</h1>
                <p className="text-[10px] text-slate-400 tracking-widest uppercase">Tutor Portal</p>
              </div>
            </div>
          </Link>
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-3">
              <div
                className="w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold text-white"
                style={{ backgroundColor: "rgba(139,92,246,0.3)", boxShadow: "0 0 16px rgba(139,92,246,0.3)", border: "2px solid #8B5CF6" }}
              >
                {initials}
              </div>
              <div className="hidden sm:block">
                <p className="text-sm font-medium text-slate-200">{displayName}</p>
                <p className="text-[10px] text-violet-400 font-semibold uppercase tracking-wider">Tutor</p>
              </div>
            </div>
            <button onClick={handleLogout} className="text-slate-400 hover:text-slate-300 transition-colors p-2 min-h-[44px] min-w-[44px]" aria-label="Log out" data-testid="button-logout">
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
      </header>

      <nav className="border-b border-slate-800/40 bg-slate-950/60 backdrop-blur-md">
        <div className="max-w-[1280px] mx-auto px-6 flex gap-1">
          <span className="flex items-center gap-2 px-4 py-3 text-sm font-medium text-violet-300 border-b-2 border-violet-500 cursor-default" data-testid="nav-dashboard">
            <LayoutDashboard className="w-4 h-4" />
            Dashboard
          </span>
          <Link href="/tutor/students">
            <span className="flex items-center gap-2 px-4 py-3 text-sm font-medium text-slate-400 hover:text-slate-300 border-b-2 border-transparent transition-all cursor-pointer" data-testid="nav-students">
              <Users className="w-4 h-4" />
              Students
            </span>
          </Link>
          <Link href="/tutor/assessments">
            <span className="flex items-center gap-2 px-4 py-3 text-sm font-medium text-slate-400 hover:text-slate-300 border-b-2 border-transparent transition-all cursor-pointer" data-testid="nav-assessments">
              <BookOpen className="w-4 h-4" />
              Assessments
            </span>
          </Link>
        </div>
      </nav>

      <main className="max-w-[1280px] mx-auto px-6 py-8">
        {isLoading ? (
          <div className="flex flex-col items-center justify-center py-32 gap-4">
            <Loader2 className="w-8 h-8 text-violet-500 animate-spin" />
            <p className="text-sm text-slate-500">Loading your dashboard...</p>
          </div>
        ) : (
          <div className="space-y-8 animate-in fade-in duration-500">

            {/* ── SECTION 1: Header ────────────────────────────────────── */}
            <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
              <div>
                <h2 className="text-2xl font-semibold text-slate-100 tracking-tight">Command Centre</h2>
                <p className="text-sm text-slate-500 mt-1">Cohort overview &middot; {format(new Date(), "EEEE, d MMMM yyyy")}</p>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <Link href="/tutor/students">
                  <span className="flex items-center gap-2 px-4 py-2.5 min-h-[44px] rounded-xl text-sm font-medium text-slate-300 bg-slate-800/60 border border-slate-700/50 hover:bg-slate-800/80 transition-all cursor-pointer" data-testid="button-view-students">
                    <Users className="w-4 h-4" />
                    Students
                  </span>
                </Link>
                <Link href="/tutor/assessments/new">
                  <span className="glow-button flex items-center gap-2 px-5 py-2.5 min-h-[44px] rounded-xl text-sm font-semibold cursor-pointer" data-testid="button-create-assessment">
                    <Plus className="w-4 h-4" />
                    Create Assessment
                  </span>
                </Link>
              </div>
            </div>

            {/* ── SECTION 2: Summary Metrics ───────────────────────────── */}
            <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
              <MetricCard
                icon={Users} label="Active Students" value={stats?.totalStudents ?? 0}
                accent="#8B5CF6" testId="stat-students"
              />
              <MetricCard
                icon={Send} label="Awaiting Submission"
                value={stats?.pendingAssignments?.length ?? 0}
                accent="#F59E0B" testId="stat-assigned"
                alert={overdueCount > 0 ? `${overdueCount} overdue` : undefined}
              />
              <MetricCard
                icon={FileText} label="Reviews Pending"
                value={stats?.recentSubmissions?.length ?? 0}
                accent="#3B82F6" testId="stat-reviews"
              />
              <MetricCard
                icon={Award} label="Cohort Average"
                value={overallAvg !== null ? overallAvg : 0}
                suffix="%" accent="#10B981" testId="stat-cohort-avg"
                noValue={overallAvg === null}
              />
              <MetricCard
                icon={Target} label="Completion Rate"
                value={completionRate !== null ? completionRate : 0}
                suffix="%" accent="#06B6D4" testId="stat-completion"
                noValue={completionRate === null}
              />
            </div>

            {/* ── SECTION 3: Attention Required + Subject Performance ── */}
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
              <div className="lg:col-span-7">
                <div className="rounded-2xl border border-slate-800/80 bg-gradient-to-b from-slate-900/90 to-slate-950/90 backdrop-blur-md overflow-hidden">
                  <div className="px-6 pt-5 pb-4 flex items-center justify-between border-b border-slate-800/50">
                    <div className="flex items-center gap-2.5">
                      <div className="w-8 h-8 rounded-lg bg-red-500/10 border border-red-500/20 flex items-center justify-center">
                        <AlertTriangle className="w-4 h-4 text-red-400" />
                      </div>
                      <div>
                        <h3 className="text-sm font-semibold text-slate-200">Attention Required</h3>
                        <p className="text-[11px] text-slate-500">Students who need intervention</p>
                      </div>
                    </div>
                    {atRiskStudents.length > 0 && (
                      <Badge className="bg-red-500/10 text-red-400 border-red-500/20 text-[10px]">
                        {atRiskStudents.length} student{atRiskStudents.length !== 1 ? "s" : ""}
                      </Badge>
                    )}
                  </div>

                  {atRiskStudents.length === 0 ? (
                    <div className="px-6 py-12 text-center">
                      <CheckCircle2 className="w-10 h-10 mx-auto text-emerald-500/40 mb-3" />
                      <p className="text-sm text-slate-400">All students are on track</p>
                      <p className="text-xs text-slate-600 mt-1">No immediate interventions needed</p>
                    </div>
                  ) : (
                    <div className="divide-y divide-slate-800/40">
                      {atRiskStudents.map((s, idx) => {
                        const TrendIcon = s.trend === "declining" ? TrendingDown : s.trend === "improving" ? TrendingUpIcon : Minus;
                        const trendColor = s.trend === "declining" ? "text-red-400" : s.trend === "improving" ? "text-emerald-400" : "text-slate-500";
                        return (
                          <div
                            key={s.studentId}
                            className="px-6 py-4 hover:bg-slate-800/20 transition-colors group"
                            style={{ animationDelay: `${idx * 60}ms` }}
                          >
                            <div className="flex items-start gap-4">
                              <div className="w-9 h-9 rounded-full bg-slate-800 border border-slate-700/60 flex items-center justify-center text-xs font-bold text-slate-300 shrink-0 mt-0.5">
                                {s.studentName.split(" ").map((n) => n[0]).join("").toUpperCase().slice(0, 2)}
                              </div>
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 mb-1">
                                  <p className="text-sm font-medium text-slate-200 truncate">{s.studentName}</p>
                                  <TrendIcon className={`w-3.5 h-3.5 shrink-0 ${trendColor}`} />
                                </div>
                                {s.weakTopics.length > 0 && (
                                  <div className="flex flex-wrap gap-1 mb-2">
                                    {s.weakTopics.map((t) => (
                                      <span key={t} className="text-[10px] px-1.5 py-0.5 rounded bg-red-500/10 text-red-400/80 border border-red-500/10">{t}</span>
                                    ))}
                                  </div>
                                )}
                                <MiniBar completed={s.completed} awaiting={s.awaiting} total={s.assigned} />
                              </div>
                              <Link href={`/tutor/students/${s.studentId}`}>
                                <span className="text-[11px] text-slate-500 hover:text-violet-400 transition-colors cursor-pointer flex items-center gap-1 shrink-0 opacity-0 group-hover:opacity-100 mt-1" data-testid={`link-risk-student-${s.studentId}`}>
                                  View <ArrowRight className="w-3 h-3" />
                                </span>
                              </Link>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>

              <div className="lg:col-span-5">
                <div className="rounded-2xl border border-slate-800/80 bg-gradient-to-b from-slate-900/90 to-slate-950/90 backdrop-blur-md overflow-hidden h-full">
                  <div className="px-6 pt-5 pb-4 border-b border-slate-800/50">
                    <div className="flex items-center gap-2.5">
                      <div className="w-8 h-8 rounded-lg bg-blue-500/10 border border-blue-500/20 flex items-center justify-center">
                        <BarChart3 className="w-4 h-4 text-blue-400" />
                      </div>
                      <div>
                        <h3 className="text-sm font-semibold text-slate-200">Subject Performance</h3>
                        <p className="text-[11px] text-slate-500">Cohort averages by subject</p>
                      </div>
                    </div>
                  </div>

                  {(stats?.cohortAverages?.length ?? 0) === 0 ? (
                    <div className="px-6 py-12 text-center">
                      <BarChart3 className="w-10 h-10 mx-auto text-slate-700 mb-3" />
                      <p className="text-sm text-slate-400">No performance data yet</p>
                    </div>
                  ) : (
                    <div className="px-6 py-4 space-y-3">
                      {stats!.cohortAverages.slice().sort((a, b) => b.average - a.average).map((ca) => {
                        const sc = getSubjectColor(ca.subject);
                        const barColor = ca.average >= 70 ? "#10B981" : ca.average >= 50 ? "#F59E0B" : "#EF4444";
                        return (
                          <div key={ca.subject} className="group">
                            <div className="flex items-center justify-between mb-1.5">
                              <span className="text-xs text-slate-300 truncate">{ca.subject}</span>
                              <span className="text-xs font-semibold tabular-nums" style={{ color: barColor }}>{ca.average}%</span>
                            </div>
                            <div className="h-2 rounded-full bg-slate-800/80 overflow-hidden">
                              <div
                                className="h-full rounded-full transition-all duration-1000 ease-out"
                                style={{ width: `${ca.average}%`, backgroundColor: barColor, opacity: 0.8 }}
                              />
                            </div>
                            <p className="text-[10px] text-slate-600 mt-0.5">{ca.count} submission{ca.count !== 1 ? "s" : ""}</p>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* ── SECTION 4: Review Queue / Submissions (Tabbed) ─────── */}
            <div className="rounded-2xl border border-slate-800/80 bg-gradient-to-b from-slate-900/90 to-slate-950/90 backdrop-blur-md overflow-hidden">
              <div className="px-6 pt-5 pb-0 flex items-center gap-6 border-b border-slate-800/50">
                <button
                  onClick={() => setActiveTab("submissions")}
                  className={`pb-3 text-sm font-medium transition-all border-b-2 ${activeTab === "submissions" ? "text-violet-300 border-violet-500" : "text-slate-500 border-transparent hover:text-slate-400"}`}
                  data-testid="tab-submissions"
                >
                  Recent Submissions
                  {(stats?.recentSubmissions?.length ?? 0) > 0 && (
                    <span className="ml-2 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-violet-500/15 text-violet-400">{stats!.recentSubmissions.length}</span>
                  )}
                </button>
                <button
                  onClick={() => setActiveTab("pending")}
                  className={`pb-3 text-sm font-medium transition-all border-b-2 ${activeTab === "pending" ? "text-violet-300 border-violet-500" : "text-slate-500 border-transparent hover:text-slate-400"}`}
                  data-testid="tab-pending"
                >
                  Pending Assignments
                  {overdueCount > 0 && (
                    <span className="ml-2 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-red-500/15 text-red-400">{overdueCount} overdue</span>
                  )}
                </button>
              </div>

              {activeTab === "submissions" ? (
                (stats?.recentSubmissions?.length ?? 0) === 0 ? (
                  <div className="px-6 py-12 text-center">
                    <Activity className="w-10 h-10 mx-auto text-slate-700 mb-3" />
                    <p className="text-sm text-slate-400">No submissions yet</p>
                    <p className="text-xs text-slate-600 mt-1">Student results will appear here</p>
                  </div>
                ) : (
                  <div className="divide-y divide-slate-800/40">
                    {stats!.recentSubmissions.map((sub, idx) => {
                      const sc = getSubjectColor(sub.subject);
                      const SubIcon = getSubjectIcon(sub.subject);
                      const duration = formatDuration(sub.startedAt, sub.completedAt);
                      const scoreColor = sub.score >= 70 ? "text-emerald-400 bg-emerald-500/10 border-emerald-500/20"
                        : sub.score >= 40 ? "text-amber-400 bg-amber-500/10 border-amber-500/20"
                        : "text-red-400 bg-red-500/10 border-red-500/20";
                      return (
                        <Link key={idx} href={`/soma/review/${sub.reportId}`}>
                          <div className="px-6 py-3.5 flex items-center gap-4 hover:bg-slate-800/20 transition-colors cursor-pointer group" data-testid={`submission-${idx}`}>
                            <div className="w-9 h-9 rounded-lg flex items-center justify-center border shrink-0" style={{ backgroundColor: `${sc.hex}10`, borderColor: `${sc.hex}25` }}>
                              <SubIcon className="w-4 h-4" style={{ color: sc.hex }} />
                            </div>
                            <div className="flex-1 min-w-0">
                              <p className="text-sm text-slate-200 truncate">
                                <span className="font-medium">{sub.studentName}</span>
                                <span className="text-slate-600 mx-1.5">&middot;</span>
                                <span className="text-slate-400">{sub.quizTitle}</span>
                              </p>
                              <div className="flex items-center gap-3 text-[10px] text-slate-500 mt-0.5">
                                <span>{formatDistanceToNow(new Date(sub.createdAt), { addSuffix: true })}</span>
                                {duration && <span className="text-violet-400/70">{duration}</span>}
                              </div>
                            </div>
                            <Badge className={`text-xs font-bold px-2.5 py-1 border ${scoreColor}`} data-testid={`score-${idx}`}>
                              {sub.score}%
                            </Badge>
                            <Eye className="w-4 h-4 text-slate-600 group-hover:text-violet-400 transition-colors shrink-0" />
                          </div>
                        </Link>
                      );
                    })}
                  </div>
                )
              ) : (
                (stats?.pendingAssignments?.length ?? 0) === 0 ? (
                  <div className="px-6 py-12 text-center">
                    <Send className="w-10 h-10 mx-auto text-slate-700 mb-3" />
                    <p className="text-sm text-slate-400">No pending assignments</p>
                    <p className="text-xs text-slate-600 mt-1">Use "Assign to Students" to assign assessments</p>
                  </div>
                ) : (
                  <div className="divide-y divide-slate-800/40">
                    {stats!.pendingAssignments.map((pa, idx) => {
                      const sc = getSubjectColor(pa.subject);
                      const SubIcon = getSubjectIcon(pa.subject);
                      const isOverdue = pa.dueDate && new Date(pa.dueDate) < new Date();
                      return (
                        <div key={pa.assignmentId} className="px-6 py-3.5 flex items-center gap-4" data-testid={`pending-assignment-${idx}`}>
                          <div className="w-9 h-9 rounded-lg flex items-center justify-center border shrink-0" style={{ backgroundColor: `${sc.hex}10`, borderColor: `${sc.hex}25` }}>
                            <SubIcon className="w-4 h-4" style={{ color: sc.hex }} />
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm text-slate-200 truncate">
                              <span className="font-medium">{pa.studentName}</span>
                              <span className="text-slate-600 mx-1.5">&middot;</span>
                              <span className="text-slate-400">{pa.quizTitle}</span>
                            </p>
                            <div className="flex items-center gap-3 text-[10px] text-slate-500 mt-0.5">
                              <span>Assigned {formatDistanceToNow(new Date(pa.createdAt), { addSuffix: true })}</span>
                              {pa.dueDate && (
                                <span className={`flex items-center gap-1 ${isOverdue ? "text-red-400" : "text-amber-400/70"}`}>
                                  <Clock className="w-3 h-3" />
                                  Due {format(new Date(pa.dueDate), "MMM d")}
                                </span>
                              )}
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            {isOverdue ? (
                              <Badge className="text-[10px] font-semibold px-2 py-0.5 bg-red-500/10 text-red-400 border border-red-500/20">Overdue</Badge>
                            ) : (
                              <Badge className="text-[10px] font-semibold px-2 py-0.5 bg-slate-800/60 text-slate-400 border border-slate-700/50">Pending</Badge>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )
              )}
            </div>

            {/* ── SECTION 5: Student Workload Roster ───────────────────── */}
            {(stats?.studentInsights?.length ?? 0) > 0 && (
              <div className="rounded-2xl border border-slate-800/80 bg-gradient-to-b from-slate-900/90 to-slate-950/90 backdrop-blur-md overflow-hidden">
                <div className="px-6 pt-5 pb-4 flex items-center justify-between border-b border-slate-800/50">
                  <div className="flex items-center gap-2.5">
                    <div className="w-8 h-8 rounded-lg bg-violet-500/10 border border-violet-500/20 flex items-center justify-center">
                      <Activity className="w-4 h-4 text-violet-400" />
                    </div>
                    <div>
                      <h3 className="text-sm font-semibold text-slate-200">Student Workload</h3>
                      <p className="text-[11px] text-slate-500">Assignment completion across your cohort</p>
                    </div>
                  </div>
                  <Link href="/tutor/students">
                    <span className="text-xs text-violet-400 hover:text-violet-300 cursor-pointer flex items-center gap-1" data-testid="link-all-students">
                      View All <ChevronRight className="w-3 h-3" />
                    </span>
                  </Link>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[600px]">
                    <thead>
                      <tr className="border-b border-slate-800/40">
                        <th className="text-left text-[10px] font-semibold text-slate-500 uppercase tracking-wider px-6 py-3">Student</th>
                        <th className="text-center text-[10px] font-semibold text-slate-500 uppercase tracking-wider px-3 py-3 w-20">Assigned</th>
                        <th className="text-center text-[10px] font-semibold text-slate-500 uppercase tracking-wider px-3 py-3 w-20">Done</th>
                        <th className="text-center text-[10px] font-semibold text-slate-500 uppercase tracking-wider px-3 py-3 w-20">Awaiting</th>
                        <th className="text-left text-[10px] font-semibold text-slate-500 uppercase tracking-wider px-3 py-3 w-40">Progress</th>
                        <th className="text-center text-[10px] font-semibold text-slate-500 uppercase tracking-wider px-3 py-3 w-16">Trend</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/30">
                      {stats!.studentInsights.map((s) => {
                        const rate = s.assigned > 0 ? Math.round((s.completed / s.assigned) * 100) : 0;
                        const TrendIcon = s.trend === "declining" ? TrendingDown : s.trend === "improving" ? TrendingUpIcon : Minus;
                        const trendColor = s.trend === "declining" ? "text-red-400" : s.trend === "improving" ? "text-emerald-400" : "text-slate-600";
                        return (
                          <tr key={s.studentId} className="hover:bg-slate-800/15 transition-colors">
                            <td className="px-6 py-3">
                              <Link href={`/tutor/students/${s.studentId}`}>
                                <span className="text-sm text-slate-200 hover:text-violet-300 cursor-pointer transition-colors" data-testid={`workload-student-${s.studentId}`}>{s.studentName}</span>
                              </Link>
                            </td>
                            <td className="text-center text-sm tabular-nums text-slate-400 px-3 py-3">{s.assigned}</td>
                            <td className="text-center text-sm tabular-nums text-emerald-400 px-3 py-3">{s.completed}</td>
                            <td className="text-center text-sm tabular-nums text-amber-400 px-3 py-3">{s.awaiting}</td>
                            <td className="px-3 py-3">
                              <div className="flex items-center gap-2">
                                <div className="flex-1 h-1.5 rounded-full bg-slate-800/80 overflow-hidden">
                                  <div className="h-full rounded-full bg-emerald-500/70 transition-all duration-700" style={{ width: `${rate}%` }} />
                                </div>
                                <span className="text-[10px] text-slate-500 tabular-nums w-8 text-right">{rate}%</span>
                              </div>
                            </td>
                            <td className="text-center px-3 py-3">
                              <TrendIcon className={`w-4 h-4 mx-auto ${trendColor}`} />
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* ── SECTION 6: Quick Actions + Recent Assessments ─────── */}
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
              <div className="lg:col-span-3">
                <div className="rounded-2xl border border-slate-800/80 bg-gradient-to-b from-slate-900/90 to-slate-950/90 backdrop-blur-md p-5">
                  <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-4">Quick Actions</h3>
                  <div className="space-y-2">
                    <QuickAction icon={Plus} label="Create Assessment" href="/tutor/assessments/new" testId="qa-create" />
                    <QuickAction icon={UserPlus} label="Add Student" href="/tutor/students" testId="qa-add-student" />
                    <QuickAction icon={BookOpen} label="My Assessments" href="/tutor/assessments" testId="qa-assessments" />
                    <QuickAction icon={Users} label="View Students" href="/tutor/students" testId="qa-students" />
                  </div>
                </div>
              </div>

              <div className="lg:col-span-9">
                <div className="rounded-2xl border border-slate-800/80 bg-gradient-to-b from-slate-900/90 to-slate-950/90 backdrop-blur-md overflow-hidden">
                  <div className="px-6 pt-5 pb-4 flex items-center justify-between border-b border-slate-800/50">
                    <div className="flex items-center gap-2.5">
                      <div className="w-8 h-8 rounded-lg bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center">
                        <BookOpen className="w-4 h-4 text-emerald-400" />
                      </div>
                      <h3 className="text-sm font-semibold text-slate-200">Recent Assessments</h3>
                    </div>
                    <Link href="/tutor/assessments">
                      <span className="text-xs text-violet-400 hover:text-violet-300 cursor-pointer flex items-center gap-1" data-testid="link-view-all-assessments">
                        View All <ChevronRight className="w-3 h-3" />
                      </span>
                    </Link>
                  </div>

                  {quizzesLoading ? (
                    <div className="px-6 py-8 flex justify-center">
                      <Loader2 className="w-6 h-6 text-violet-500 animate-spin" />
                    </div>
                  ) : tutorQuizzes.length === 0 ? (
                    <div className="px-6 py-12 text-center">
                      <BookOpen className="w-10 h-10 mx-auto text-slate-700 mb-3" />
                      <p className="text-sm text-slate-400">No assessments yet</p>
                      <p className="text-xs text-slate-600 mt-1">Create your first assessment to get started</p>
                    </div>
                  ) : (
                    <div className="divide-y divide-slate-800/40">
                      {tutorQuizzes.slice(0, 6).map((quiz) => {
                        const sc = getSubjectColor(quiz.subject);
                        const SubIcon = getSubjectIcon(quiz.subject);
                        return (
                          <div key={quiz.id} className="px-6 py-3.5 flex items-center gap-4 hover:bg-slate-800/20 transition-colors group" data-testid={`quiz-tile-${quiz.id}`}>
                            <div className="w-9 h-9 rounded-lg flex items-center justify-center border shrink-0" style={{ backgroundColor: `${sc.hex}10`, borderColor: `${sc.hex}25` }}>
                              <SubIcon className="w-4 h-4" style={{ color: sc.hex }} />
                            </div>
                            <div className="flex-1 min-w-0">
                              <h4 className="text-sm font-medium text-slate-200 truncate" data-testid={`quiz-title-${quiz.id}`}>{quiz.title}</h4>
                              <div className="flex items-center gap-2 mt-0.5">
                                <span className="text-[10px] text-slate-500">{quiz.subject || "General"}</span>
                                {quiz.level && <span className="text-[10px] text-slate-600">&middot; {quiz.level}</span>}
                              </div>
                            </div>
                            <button
                              onClick={() => { setShowAssignModal(quiz.id); setSelectedStudentIds(new Set()); setDueDate(""); }}
                              className="flex items-center gap-1.5 px-3 py-1.5 min-h-[32px] rounded-lg text-[11px] font-medium bg-emerald-600/15 text-emerald-400 border border-emerald-500/20 hover:bg-emerald-600/25 transition-all opacity-0 group-hover:opacity-100"
                              data-testid={`button-assign-${quiz.id}`}
                            >
                              <UserPlus className="w-3 h-3" />
                              Assign
                            </button>
                            <Link href="/tutor/assessments">
                              <span className="flex items-center gap-1 text-[11px] text-slate-500 hover:text-violet-400 cursor-pointer transition-colors" data-testid={`button-details-${quiz.id}`}>
                                <Eye className="w-3.5 h-3.5" />
                              </span>
                            </Link>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            </div>

          </div>
        )}
      </main>

      {/* ── ASSIGN MODAL ──────────────────────────────────────────── */}
      {showAssignModal !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={() => setShowAssignModal(null)}>
          <div className="bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl max-w-lg w-full max-h-[80vh] overflow-y-auto p-6" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between gap-3 mb-5">
              <h3 className="text-lg font-bold text-slate-200">Assign Assessment</h3>
              <button onClick={() => setShowAssignModal(null)} className="text-slate-400 hover:text-slate-300 p-1" data-testid="button-close-assign-modal">
                <X className="w-5 h-5" />
              </button>
            </div>
            <p className="text-xs text-slate-400 mb-4">Select students to assign this assessment:</p>
            {adoptedStudents.length === 0 ? (
              <p className="text-sm text-slate-400 text-center py-8">You have no adopted students. Go to the Students tab to adopt students first.</p>
            ) : (
              <>
                <div className="space-y-2 max-h-[50vh] overflow-y-auto">
                  {adoptedStudents.map((student) => (
                    <button
                      key={student.id}
                      onClick={() => toggleStudentSelection(student.id)}
                      className={`w-full min-h-[44px] flex items-center gap-3 px-4 py-3 rounded-xl transition-all text-left ${
                        selectedStudentIds.has(student.id)
                          ? "bg-emerald-500/20 border border-emerald-500/40"
                          : "bg-slate-800/40 border border-slate-700/50 hover:bg-slate-800/60"
                      }`}
                      data-testid={`assign-student-${student.id}`}
                    >
                      <div className={`w-5 h-5 rounded-md border flex items-center justify-center ${
                        selectedStudentIds.has(student.id) ? "bg-emerald-500 border-emerald-500" : "border-slate-600"
                      }`}>
                        {selectedStudentIds.has(student.id) && <Check className="w-3 h-3 text-white" />}
                      </div>
                      <div>
                        <p className="text-sm font-medium text-slate-200">{student.displayName || "Student"}</p>
                        <p className="text-xs text-slate-400">{student.email}</p>
                      </div>
                    </button>
                  ))}
                </div>
                <div className="mt-4 p-3 rounded-xl bg-slate-800/60 border border-slate-700/50">
                  <label className="flex items-center gap-2 text-xs font-medium text-slate-300 mb-2">
                    <Clock className="w-3.5 h-3.5 text-violet-400" />
                    Due Date & Time <span className="text-slate-500">(optional)</span>
                  </label>
                  <input
                    type="datetime-local"
                    value={dueDate}
                    onChange={(e) => setDueDate(e.target.value)}
                    className="w-full px-3 py-2.5 min-h-[44px] rounded-lg bg-slate-900/80 border border-slate-600/50 text-sm text-slate-200 focus:outline-none focus:border-violet-500/50 focus:ring-1 focus:ring-violet-500/30 [color-scheme:dark]"
                    data-testid="input-due-date"
                  />
                </div>
                <button
                  onClick={() => assignMutation.mutate({ quizId: showAssignModal, studentIds: Array.from(selectedStudentIds), dueDate: dueDate || undefined })}
                  disabled={selectedStudentIds.size === 0 || assignMutation.isPending}
                  className="w-full mt-4 py-3 min-h-[44px] rounded-xl text-sm font-medium bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
                  data-testid="button-confirm-assign"
                >
                  {assignMutation.isPending ? (
                    <Loader2 className="w-4 h-4 animate-spin mx-auto" />
                  ) : (
                    `Assign to ${selectedStudentIds.size} Student${selectedStudentIds.size !== 1 ? "s" : ""}`
                  )}
                </button>
              </>
            )}
          </div>
        </div>
      )}

    </div>
  );
}

function MetricCard({ icon: Icon, label, value, suffix = "", accent, testId, alert, noValue }: {
  icon: LucideIcon; label: string; value: number; suffix?: string; accent: string; testId: string; alert?: string; noValue?: boolean;
}) {
  return (
    <div
      className="rounded-2xl border bg-gradient-to-b from-slate-900/80 to-slate-950/80 backdrop-blur-md p-5 transition-all hover:translate-y-[-1px] hover:shadow-lg"
      style={{ borderColor: `${accent}15` }}
      data-testid={testId}
    >
      <div className="flex items-start justify-between mb-3">
        <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ backgroundColor: `${accent}10`, border: `1px solid ${accent}20` }}>
          <Icon className="w-5 h-5" style={{ color: accent }} />
        </div>
        {alert && (
          <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-red-500/15 text-red-400 border border-red-500/15">{alert}</span>
        )}
      </div>
      <p className="text-2xl font-bold text-slate-100 tabular-nums leading-none">
        {noValue ? <span className="text-slate-600">&mdash;</span> : <AnimatedNumber value={value} suffix={suffix} />}
      </p>
      <p className="text-[11px] text-slate-500 mt-1.5 font-medium">{label}</p>
    </div>
  );
}

function QuickAction({ icon: Icon, label, href, testId }: { icon: LucideIcon; label: string; href: string; testId: string }) {
  return (
    <Link href={href}>
      <span className="flex items-center gap-3 px-4 py-3 min-h-[44px] rounded-xl text-sm text-slate-300 bg-slate-800/30 border border-slate-800/60 hover:bg-slate-800/50 hover:border-slate-700/60 transition-all cursor-pointer group" data-testid={testId}>
        <Icon className="w-4 h-4 text-slate-500 group-hover:text-violet-400 transition-colors" />
        {label}
        <ArrowRight className="w-3.5 h-3.5 ml-auto text-slate-700 group-hover:text-slate-500 transition-colors" />
      </span>
    </Link>
  );
}
