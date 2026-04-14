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
  CalendarDays, ExternalLink,
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
  belowThresholdCount: number;
  weakestTopic: string | null;
}

interface AIInsight {
  name: string;
  reason: string;
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

const GLASS_PANEL = "rounded-2xl border border-white/[0.06] bg-gradient-to-b from-slate-900/95 to-[#0c1222]/95 backdrop-blur-xl shadow-[0_8px_32px_rgba(0,0,0,0.4),inset_0_1px_0_rgba(255,255,255,0.04)]";

function getStatusChip(s: DashboardStats["studentInsights"][0]): { text: string; color: string } {
  const hasSubmissions = s.completed > 0;
  const allDone = s.assigned > 0 && s.awaiting === 0 && s.completed === s.assigned;

  if (!hasSubmissions && s.assigned > 0) return { text: "Awaiting", color: "bg-amber-500/12 text-amber-400 border-amber-500/20" };
  if (s.trend === "declining" && s.completed >= 2) return { text: "Trend down", color: "bg-red-500/12 text-red-400 border-red-500/20" };
  if (s.completed < 3 && s.assigned > 0) return { text: "Low evidence", color: "bg-slate-500/12 text-slate-400 border-slate-500/20" };
  if (s.awaiting > 0 && !allDone) return { text: "Needs marking", color: "bg-violet-500/12 text-violet-400 border-violet-500/20" };
  if (s.trend === "improving") return { text: "Trend up", color: "bg-emerald-500/12 text-emerald-400 border-emerald-500/20" };
  if (allDone) return { text: "On track", color: "bg-emerald-500/12 text-emerald-400 border-emerald-500/20" };
  return { text: "Stable", color: "bg-slate-500/12 text-slate-400 border-slate-500/20" };
}

function MiniSparkline({ scores }: { scores: number[] }) {
  if (scores.length < 2) return null;
  const w = 64, h = 24, pad = 2;
  const min = Math.min(...scores), max = Math.max(...scores);
  const range = max - min || 1;
  const pts = scores.map((v, i) => {
    const x = pad + (i / (scores.length - 1)) * (w - pad * 2);
    const y = h - pad - ((v - min) / range) * (h - pad * 2);
    return `${x},${y}`;
  });
  const last = scores[scores.length - 1];
  const color = last >= 70 ? "#34d399" : last >= 50 ? "#fbbf24" : "#f87171";
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="shrink-0">
      <polyline points={pts.join(" ")} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" opacity="0.7" />
      <circle cx={pts[pts.length - 1].split(",")[0]} cy={pts[pts.length - 1].split(",")[1]} r="2.5" fill={color} />
    </svg>
  );
}

function WorkloadBar({ assigned, completed, awaiting }: { assigned: number; completed: number; awaiting: number }) {
  const total = assigned || 1;
  const cPct = (completed / total) * 100;
  const aPct = (awaiting / total) * 100;
  const pPct = Math.max(0, 100 - cPct - aPct);
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-[6px] rounded-full bg-slate-800/80 overflow-hidden flex">
        {cPct > 0 && <div className="h-full bg-emerald-500/70" style={{ width: `${cPct}%` }} />}
        {aPct > 0 && <div className="h-full bg-amber-500/70" style={{ width: `${aPct}%` }} />}
        {pPct > 0 && <div className="h-full bg-slate-600/40" style={{ width: `${pPct}%` }} />}
      </div>
      <div className="flex items-center gap-1.5 text-[9px] font-bold tabular-nums shrink-0">
        <span className="text-emerald-400">{completed}</span>
        <span className="text-slate-700">/</span>
        <span className="text-slate-400">{assigned}</span>
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

  const { session, userId } = useSupabaseSession();
  const displayName = session?.user?.user_metadata?.display_name || session?.user?.email?.split("@")[0] || "Tutor";
  const initials = displayName.split(" ").map((n: string) => n[0]).join("").toUpperCase().slice(0, 2);

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

  const { data: aiInsights } = useQuery<{ insights: AIInsight[] }>({
    queryKey: ["/api/tutor/ai/intervention-insights", stats?.studentInsights?.map((s) => s.studentId).join(",")],
    queryFn: async () => {
      const atRisk = (stats?.studentInsights || []).filter(
        (s) => s.trend === "declining" || s.weakTopics.length > 0 || (s.awaiting > 0 && s.completed === 0)
      ).slice(0, 6);
      if (atRisk.length === 0) return { insights: [] };
      const res = await authFetch("/api/tutor/ai/intervention-insights", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ students: atRisk }),
      });
      if (!res.ok) return { insights: [] };
      return res.json();
    },
    enabled: (stats?.studentInsights?.length ?? 0) > 0,
    staleTime: 120000,
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

  const overdueCount = useMemo(() => {
    if (!stats?.pendingAssignments?.length) return 0;
    const now = new Date();
    return stats.pendingAssignments.filter((p) => p.dueDate && new Date(p.dueDate) < now).length;
  }, [stats]);

  const weakTopicLeaderboard = useMemo(() => {
    if (!stats?.studentInsights?.length) return [];
    const topicMap: Record<string, number> = {};
    for (const s of stats.studentInsights) {
      for (const t of s.weakTopics) {
        topicMap[t] = (topicMap[t] || 0) + 1;
      }
    }
    return Object.entries(topicMap)
      .map(([topic, count]) => ({ topic, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);
  }, [stats]);

  useEffect(() => {
    return subscribeToSomaMutations(() => {
      queryClient.invalidateQueries({ queryKey: ["/api/tutor/dashboard-stats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/tutor/quizzes"] });
    });
  }, [queryClient]);

  const getInsightChip = (studentName: string): string | null => {
    if (!aiInsights?.insights?.length) return null;
    const match = aiInsights.insights.find((i) => i.name === studentName)
      || aiInsights.insights.find((i) => i.name?.toLowerCase() === studentName?.toLowerCase());
    return match?.reason || null;
  };

  const studentPlaques = useMemo(() => {
    return (stats?.studentInsights || []).map((s) => {
      const chip = getStatusChip(s);
      const completionPct = s.assigned > 0 ? Math.round((s.completed / s.assigned) * 100) : 0;
      const recentScores: number[] = [];
      const submissions = (stats?.recentSubmissions || []).filter(
        (sub) => sub.studentName === s.studentName
      );
      for (const sub of submissions.slice(-5)) {
        recentScores.push(sub.score);
      }
      const lastScore = recentScores.length > 0 ? recentScores[recentScores.length - 1] : null;
      const coveragePct = s.assigned > 0 ? Math.min(100, Math.round((s.completed / Math.max(s.assigned, 1)) * 100)) : 0;

      const lowestCoverage = s.weakTopics.slice(0, 3);

      const lastSubmission = submissions.length > 0 ? submissions[submissions.length - 1] : null;
      const lastActivity = lastSubmission ? lastSubmission.createdAt : null;

      return { ...s, chip, completionPct, recentScores, lastScore, coveragePct, lowestCoverage, lastActivity, lastSubmission };
    });
  }, [stats, aiInsights]);

  return (
    <div className="min-h-screen bg-[#080d1a]">
      <header className="border-b border-white/[0.04] bg-[#0a0f1e]/90 backdrop-blur-2xl sticky top-0 z-20">
        <div className="max-w-[1400px] mx-auto px-6 lg:px-8 py-4 flex items-center justify-between">
          <Link href="/">
            <div className="flex items-center gap-3 cursor-pointer">
              <img src="/MCEC - White Logo.png" alt="MCEC Logo" loading="lazy" className="h-10 w-auto object-contain" />
              <div>
                <h1 className="text-lg font-bold gradient-text">SOMA</h1>
                <p className="text-[10px] text-slate-500 tracking-[0.2em] uppercase font-medium">Tutor Portal</p>
              </div>
            </div>
          </Link>
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-3">
              <div
                className="w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold text-white"
                style={{ background: "linear-gradient(135deg, rgba(139,92,246,0.35), rgba(99,102,241,0.25))", boxShadow: "0 0 20px rgba(139,92,246,0.25), inset 0 1px 0 rgba(255,255,255,0.1)", border: "1.5px solid rgba(139,92,246,0.5)" }}
              >
                {initials}
              </div>
              <div className="hidden sm:block">
                <p className="text-sm font-medium text-slate-200">{displayName}</p>
                <p className="text-[10px] text-violet-400/80 font-semibold uppercase tracking-[0.15em]">Tutor</p>
              </div>
            </div>
            <button onClick={handleLogout} className="text-slate-500 hover:text-slate-300 transition-colors p-2 min-h-[44px] min-w-[44px]" aria-label="Log out" data-testid="button-logout">
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
      </header>

      <nav className="border-b border-white/[0.03] bg-[#0a0f1e]/60 backdrop-blur-xl">
        <div className="max-w-[1400px] mx-auto px-6 lg:px-8 flex gap-1">
          <span className="flex items-center gap-2 px-4 py-3 text-sm font-medium text-violet-300 border-b-2 border-violet-500 cursor-default" data-testid="nav-dashboard">
            <LayoutDashboard className="w-4 h-4" />
            Dashboard
          </span>
          <Link href="/tutor/students">
            <span className="flex items-center gap-2 px-4 py-3 text-sm font-medium text-slate-500 hover:text-slate-300 border-b-2 border-transparent transition-all cursor-pointer" data-testid="nav-students">
              <Users className="w-4 h-4" />
              Students
            </span>
          </Link>
          <Link href="/tutor/assessments">
            <span className="flex items-center gap-2 px-4 py-3 text-sm font-medium text-slate-500 hover:text-slate-300 border-b-2 border-transparent transition-all cursor-pointer" data-testid="nav-assessments">
              <BookOpen className="w-4 h-4" />
              Assessments
            </span>
          </Link>
        </div>
      </nav>

      <main className="max-w-[1400px] mx-auto px-6 lg:px-8 py-8">
        {statsError ? (
          <div className="flex flex-col items-center justify-center py-32 gap-4" data-testid="dashboard-error">
            <AlertTriangle className="w-10 h-10 text-amber-400/70" />
            <p className="text-sm text-slate-400 font-medium">Unable to load dashboard data</p>
            <p className="text-xs text-slate-600">Check your connection and try refreshing</p>
          </div>
        ) : isLoading ? (
          <div className="flex flex-col items-center justify-center py-32 gap-4">
            <div className="relative">
              <div className="w-12 h-12 rounded-full border-2 border-violet-500/20 border-t-violet-500 animate-spin" />
              <div className="absolute inset-0 w-12 h-12 rounded-full border-2 border-transparent border-b-indigo-400/30 animate-spin" style={{ animationDirection: "reverse", animationDuration: "1.5s" }} />
            </div>
            <p className="text-sm text-slate-500 font-medium">Loading dashboard...</p>
          </div>
        ) : (
          <div className="space-y-7 animate-in fade-in duration-500">

            <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
              <div>
                <h2 className="text-2xl font-bold text-slate-100 tracking-tight">Dashboard</h2>
                <p className="text-[13px] text-slate-500 mt-1 font-medium">{format(new Date(), "EEEE, d MMMM yyyy")}</p>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <Link href="/tutor/students">
                  <span className="flex items-center gap-2 px-4 py-2.5 min-h-[44px] rounded-xl text-sm font-medium text-slate-300 bg-slate-800/50 border border-white/[0.06] hover:bg-slate-800/70 hover:border-white/[0.1] transition-all cursor-pointer shadow-lg" data-testid="button-view-students">
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

            {/* ── STUDENT PLAQUE GRID ──────────────────────────────── */}
            {studentPlaques.length === 0 ? (
              <div className={`${GLASS_PANEL} px-6 py-16 text-center`}>
                <Users className="w-12 h-12 mx-auto text-slate-700 mb-4" />
                <p className="text-sm text-slate-400 font-medium">No students yet</p>
                <p className="text-xs text-slate-600 mt-1">Go to the Students tab to adopt students</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4" data-testid="student-plaque-grid">
                {studentPlaques.map((s) => (
                  <StudentPlaque key={s.studentId} student={s} insightChip={getInsightChip(s.studentName)} />
                ))}
              </div>
            )}

            {/* ── SUPPORTING PANELS ───────────────────────────────── */}
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">

              {/* Marking Queue */}
              <div className="lg:col-span-4">
                <div className={GLASS_PANEL}>
                  <div className="px-5 pt-5 pb-3 flex items-center justify-between border-b border-white/[0.04]">
                    <div className="flex items-center gap-2.5">
                      <div className="w-7 h-7 rounded-lg flex items-center justify-center bg-violet-500/10 border border-violet-500/15">
                        <Eye className="w-3.5 h-3.5 text-violet-400" />
                      </div>
                      <h3 className="text-[13px] font-semibold text-slate-100">Marking Queue</h3>
                    </div>
                    {(stats?.recentSubmissions?.length ?? 0) > 0 && (
                      <Badge className="bg-violet-500/10 text-violet-400 border-violet-500/15 text-[10px] font-bold" data-testid="stat-reviews">
                        {stats!.recentSubmissions.length}
                      </Badge>
                    )}
                  </div>
                  {(stats?.recentSubmissions?.length ?? 0) === 0 ? (
                    <div className="px-5 py-10 text-center">
                      <CheckCircle2 className="w-8 h-8 mx-auto text-emerald-500/25 mb-2" />
                      <p className="text-xs text-slate-500 font-medium">All caught up</p>
                    </div>
                  ) : (
                    <div className="divide-y divide-white/[0.03] max-h-[320px] overflow-y-auto">
                      {stats!.recentSubmissions.slice(0, 8).map((sub) => {
                        const scoreColor = sub.score >= 70 ? "text-emerald-400" : sub.score >= 50 ? "text-amber-400" : "text-red-400";
                        return (
                          <Link key={sub.reportId} href={`/soma/review/${sub.reportId}`}>
                            <div className="px-5 py-3 flex items-center gap-3 hover:bg-white/[0.015] transition-colors cursor-pointer" data-testid={`submission-${sub.reportId}`}>
                              <div className="flex-1 min-w-0">
                                <p className="text-[12px] text-slate-200 font-medium truncate">{sub.studentName}</p>
                                <p className="text-[10px] text-slate-500 truncate">{sub.quizTitle}</p>
                              </div>
                              <span className={`text-xs font-bold tabular-nums ${scoreColor}`}>{sub.score}%</span>
                              <ChevronRight className="w-3 h-3 text-slate-700 shrink-0" />
                            </div>
                          </Link>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>

              {/* Awaiting Submissions */}
              <div className="lg:col-span-4">
                <div className={GLASS_PANEL}>
                  <div className="px-5 pt-5 pb-3 flex items-center justify-between border-b border-white/[0.04]">
                    <div className="flex items-center gap-2.5">
                      <div className="w-7 h-7 rounded-lg flex items-center justify-center bg-amber-500/10 border border-amber-500/15">
                        <Clock className="w-3.5 h-3.5 text-amber-400" />
                      </div>
                      <h3 className="text-[13px] font-semibold text-slate-100">Awaiting Submissions</h3>
                    </div>
                    {overdueCount > 0 && (
                      <Badge className="bg-red-500/10 text-red-400 border-red-500/15 text-[10px] font-bold" data-testid="stat-assigned">
                        {overdueCount} overdue
                      </Badge>
                    )}
                  </div>
                  {(stats?.pendingAssignments?.length ?? 0) === 0 ? (
                    <div className="px-5 py-10 text-center">
                      <CheckCircle2 className="w-8 h-8 mx-auto text-emerald-500/25 mb-2" />
                      <p className="text-xs text-slate-500 font-medium">No pending work</p>
                    </div>
                  ) : (
                    <div className="divide-y divide-white/[0.03] max-h-[320px] overflow-y-auto">
                      {stats!.pendingAssignments.slice(0, 8).map((pa) => {
                        const isOverdue = pa.dueDate && new Date(pa.dueDate) < new Date();
                        return (
                          <div key={pa.assignmentId} className="px-5 py-3 flex items-center gap-3" data-testid={`pending-assignment-${pa.assignmentId}`}>
                            <div className="flex-1 min-w-0">
                              <p className="text-[12px] text-slate-200 font-medium truncate">{pa.studentName}</p>
                              <p className="text-[10px] text-slate-500 truncate">{pa.quizTitle}</p>
                            </div>
                            {isOverdue ? (
                              <Badge className="text-[9px] font-bold bg-red-500/10 text-red-400 border border-red-500/15">Overdue</Badge>
                            ) : pa.dueDate ? (
                              <span className="text-[10px] text-amber-400/70 font-medium shrink-0">Due {format(new Date(pa.dueDate), "MMM d")}</span>
                            ) : (
                              <Badge className="text-[9px] font-bold bg-slate-800/60 text-slate-500 border border-white/[0.05]">Pending</Badge>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>

              {/* Recent Assessments */}
              <div className="lg:col-span-4">
                <div className={GLASS_PANEL}>
                  <div className="px-5 pt-5 pb-3 flex items-center justify-between border-b border-white/[0.04]">
                    <div className="flex items-center gap-2.5">
                      <div className="w-7 h-7 rounded-lg flex items-center justify-center bg-emerald-500/10 border border-emerald-500/15">
                        <BookOpen className="w-3.5 h-3.5 text-emerald-400" />
                      </div>
                      <h3 className="text-[13px] font-semibold text-slate-100">Recent Assessments</h3>
                    </div>
                    <Link href="/tutor/assessments">
                      <span className="text-[10px] text-violet-400 hover:text-violet-300 cursor-pointer font-medium" data-testid="link-view-all-assessments">View All</span>
                    </Link>
                  </div>
                  {quizzesLoading ? (
                    <div className="px-5 py-10 flex justify-center">
                      <Loader2 className="w-5 h-5 text-violet-500 animate-spin" />
                    </div>
                  ) : tutorQuizzes.length === 0 ? (
                    <div className="px-5 py-10 text-center">
                      <BookOpen className="w-8 h-8 mx-auto text-slate-700 mb-2" />
                      <p className="text-xs text-slate-500 font-medium">No assessments yet</p>
                    </div>
                  ) : (
                    <div className="divide-y divide-white/[0.03] max-h-[320px] overflow-y-auto">
                      {tutorQuizzes.slice(0, 8).map((quiz) => {
                        const sc = getSubjectColor(quiz.subject);
                        const SubIcon = getSubjectIcon(quiz.subject);
                        return (
                          <div key={quiz.id} className="px-5 py-3 flex items-center gap-3 hover:bg-white/[0.015] transition-colors group" data-testid={`quiz-tile-${quiz.id}`}>
                            <div className="w-7 h-7 rounded-lg flex items-center justify-center border shrink-0" style={{ backgroundColor: `${sc.hex}08`, borderColor: `${sc.hex}18` }}>
                              <SubIcon className="w-3.5 h-3.5" style={{ color: sc.hex }} />
                            </div>
                            <div className="flex-1 min-w-0">
                              <p className="text-[12px] font-medium text-slate-200 truncate" data-testid={`quiz-title-${quiz.id}`}>{quiz.title}</p>
                              <p className="text-[10px] text-slate-500">{quiz.subject || "General"}</p>
                            </div>
                            <button
                              onClick={() => { setShowAssignModal(quiz.id); setSelectedStudentIds(new Set()); setDueDate(""); }}
                              className="text-[10px] font-semibold text-emerald-400 opacity-0 group-hover:opacity-100 transition-opacity"
                              data-testid={`button-assign-${quiz.id}`}
                            >
                              Assign
                            </button>
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

      {/* ── ASSIGN MODAL ──────────────────────────────────────── */}
      {showAssignModal !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-md p-4" onClick={() => setShowAssignModal(null)}>
          <div className={`${GLASS_PANEL} max-w-lg w-full max-h-[80vh] overflow-y-auto p-6`} onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between gap-3 mb-5">
              <h3 className="text-lg font-bold text-slate-200">Assign Assessment</h3>
              <button onClick={() => setShowAssignModal(null)} className="text-slate-400 hover:text-slate-300 p-1" data-testid="button-close-assign-modal">
                <X className="w-5 h-5" />
              </button>
            </div>
            <p className="text-xs text-slate-500 mb-4 font-medium">Select students to assign this assessment:</p>
            {adoptedStudents.length === 0 ? (
              <p className="text-sm text-slate-400 text-center py-8">You have no adopted students. Go to the Students tab to adopt students first.</p>
            ) : (
              <>
                <div className="space-y-2 max-h-[50vh] overflow-y-auto">
                  {adoptedStudents.map((student) => {
                    const studentName = student.displayName || student.email.split("@")[0] || "Student";
                    return (
                      <button
                        key={student.id}
                        onClick={() => toggleStudentSelection(student.id)}
                        className={`w-full min-h-[44px] flex items-center gap-3 px-4 py-3 rounded-xl transition-all text-left ${
                          selectedStudentIds.has(student.id)
                            ? "bg-emerald-500/15 border border-emerald-500/30"
                            : "bg-slate-800/30 border border-white/[0.05] hover:bg-slate-800/50"
                        }`}
                        data-testid={`assign-student-${student.id}`}
                      >
                        <div className={`w-5 h-5 rounded-md border flex items-center justify-center ${
                          selectedStudentIds.has(student.id) ? "bg-emerald-500 border-emerald-500" : "border-slate-600"
                        }`}>
                          {selectedStudentIds.has(student.id) && <Check className="w-3 h-3 text-white" />}
                        </div>
                        <div>
                          <p className="text-sm font-medium text-slate-200">{studentName}</p>
                        </div>
                      </button>
                    );
                  })}
                </div>
                <div className="mt-4 p-3 rounded-xl bg-slate-800/30 border border-white/[0.05]">
                  <label className="flex items-center gap-2 text-xs font-semibold text-slate-300 mb-2">
                    <CalendarDays className="w-3.5 h-3.5 text-violet-400" />
                    Due Date & Time <span className="text-slate-600">(optional)</span>
                  </label>
                  <input
                    type="datetime-local"
                    value={dueDate}
                    onChange={(e) => setDueDate(e.target.value)}
                    className="w-full px-3 py-2.5 min-h-[44px] rounded-lg bg-[#0c1222]/80 border border-white/[0.06] text-sm text-slate-200 focus:outline-none focus:border-violet-500/40 focus:ring-1 focus:ring-violet-500/20 [color-scheme:dark]"
                    data-testid="input-due-date"
                  />
                </div>
                <button
                  onClick={() => assignMutation.mutate({ quizId: showAssignModal, studentIds: Array.from(selectedStudentIds), dueDate: dueDate || undefined })}
                  disabled={selectedStudentIds.size === 0 || assignMutation.isPending}
                  className="w-full mt-4 py-3 min-h-[44px] rounded-xl text-sm font-semibold bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed transition-all shadow-lg shadow-emerald-900/30"
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

      <style>{`
        .plaque-card { perspective: 800px; }
        .plaque-inner {
          position: relative;
          width: 100%;
          transition: transform 0.4s cubic-bezier(0.4, 0, 0.2, 1);
          transform-style: preserve-3d;
        }
        .plaque-card.flipped .plaque-inner { transform: rotateY(180deg); }
        .plaque-front, .plaque-back {
          backface-visibility: hidden;
          -webkit-backface-visibility: hidden;
        }
        .plaque-back { transform: rotateY(180deg); position: absolute; inset: 0; }
        @media (prefers-reduced-motion: reduce) {
          .plaque-inner { transition: none; }
          .plaque-card.flipped .plaque-inner { transform: none; }
          .plaque-card.flipped .plaque-front { display: none; }
          .plaque-card.flipped .plaque-back { transform: none; position: relative; }
          .plaque-card:not(.flipped) .plaque-back { display: none; }
        }
      `}</style>
    </div>
  );
}

interface PlaqueStudent {
  studentId: string;
  studentName: string;
  assigned: number;
  completed: number;
  awaiting: number;
  trend: "improving" | "declining" | "stable";
  weakTopics: string[];
  chip: { text: string; color: string };
  completionPct: number;
  recentScores: number[];
  lastScore: number | null;
  coveragePct: number;
  lowestCoverage: string[];
  lastActivity: string | null;
  lastSubmission: { reportId: number; quizTitle: string; score: number } | null;
}

function StudentPlaque({ student: s, insightChip }: { student: PlaqueStudent; insightChip: string | null }) {
  const [flipped, setFlipped] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);

  const handleToggle = useCallback(() => setFlipped((p) => !p), []);
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setFlipped((p) => !p); }
  }, []);

  const si = s.studentName.split(" ").map((n: string) => n[0]).filter(Boolean).join("").toUpperCase().slice(0, 2);
  const TrendIcon = s.trend === "declining" ? TrendingDown : s.trend === "improving" ? TrendingUpIcon : Minus;
  const trendColor = s.trend === "declining" ? "text-red-400" : s.trend === "improving" ? "text-emerald-400" : "text-slate-500";

  return (
    <div
      ref={cardRef}
      className={`plaque-card group ${flipped ? "flipped" : ""}`}
      onMouseEnter={() => setFlipped(true)}
      onMouseLeave={() => setFlipped(false)}
      onClick={handleToggle}
      onKeyDown={handleKeyDown}
      tabIndex={0}
      role="button"
      aria-label={`Student plaque for ${s.studentName}`}
      data-testid={`plaque-${s.studentId}`}
    >
      <div className="plaque-inner" style={{ minHeight: "230px" }}>
        {/* ── FRONT ─────────────────────────────────────────── */}
        <div className={`plaque-front ${GLASS_PANEL} p-5 h-full flex flex-col`}>
          <div className="flex items-center gap-3 mb-4">
            <div
              className="w-10 h-10 rounded-xl flex items-center justify-center text-xs font-bold text-slate-200 shrink-0"
              style={{ background: "linear-gradient(135deg, rgba(148,163,184,0.12), rgba(100,116,139,0.06))", border: "1px solid rgba(148,163,184,0.1)" }}
            >
              {si}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-slate-200 truncate">{s.studentName}</p>
              <Badge className={`text-[9px] font-bold border mt-0.5 ${s.chip.color}`}>{s.chip.text}</Badge>
            </div>
            <TrendIcon className={`w-4 h-4 shrink-0 ${trendColor}`} />
          </div>

          <div className="space-y-3 flex-1">
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-[10px] text-slate-500 font-semibold uppercase tracking-wider">Workload</span>
              </div>
              <WorkloadBar assigned={s.assigned} completed={s.completed} awaiting={s.awaiting} />
            </div>

            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-[10px] text-slate-500 font-semibold uppercase tracking-wider">Coverage</span>
                <span className="text-[10px] text-cyan-400 font-bold tabular-nums">{s.coveragePct}%</span>
              </div>
              <div className="h-[6px] rounded-full bg-slate-800/80 overflow-hidden">
                <div
                  className="h-full rounded-full transition-all duration-700"
                  style={{
                    width: `${s.coveragePct}%`,
                    background: s.coveragePct >= 60 ? "linear-gradient(90deg, #06b6d4, #22d3ee)" : s.coveragePct >= 30 ? "linear-gradient(90deg, #f59e0b, #fbbf24)" : "linear-gradient(90deg, #94a3b8, #cbd5e1)",
                  }}
                />
              </div>
            </div>

            <div className="flex items-center justify-between">
              <div>
                <span className="text-[10px] text-slate-500 font-semibold uppercase tracking-wider">Performance</span>
                {s.lastScore !== null && (
                  <span className={`ml-2 text-xs font-bold tabular-nums ${s.lastScore >= 70 ? "text-emerald-400" : s.lastScore >= 50 ? "text-amber-400" : "text-red-400"}`}>{s.lastScore}%</span>
                )}
              </div>
              <MiniSparkline scores={s.recentScores} />
            </div>
          </div>
        </div>

        {/* ── BACK ──────────────────────────────────────────── */}
        <div className={`plaque-back ${GLASS_PANEL} p-5 h-full flex flex-col`}>
          <p className="text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-3">{s.studentName}</p>

          {s.weakTopics.length > 0 && (
            <div className="mb-3">
              <p className="text-[9px] text-slate-500 font-bold uppercase tracking-wider mb-1.5">Weak Areas</p>
              <div className="space-y-1">
                {s.weakTopics.slice(0, 3).map((t, i) => (
                  <div key={t} className="flex items-center gap-2">
                    <span className="text-[9px] text-slate-600 font-bold w-3">{i + 1}</span>
                    <span className="text-[11px] text-red-400/80 font-medium truncate">{t}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {insightChip && (
            <div className="mb-3 px-2.5 py-1.5 rounded-lg bg-violet-500/[0.06] border border-violet-500/10">
              <p className="text-[10px] text-violet-300/90 leading-relaxed">{insightChip}</p>
            </div>
          )}

          <div className="text-[10px] text-slate-500 font-medium space-y-1 mb-3">
            {s.lastActivity && (
              <p>Last activity: {formatDistanceToNow(new Date(s.lastActivity), { addSuffix: true })}</p>
            )}
            {s.lastSubmission && (
              <p>Last score: {s.lastSubmission.score}% on {s.lastSubmission.quizTitle}</p>
            )}
          </div>

          <div className="mt-auto flex flex-wrap gap-1.5">
            <Link href={`/tutor/students/${s.studentId}`}>
              <span className="flex items-center gap-1 px-2.5 py-1.5 min-h-[28px] rounded-lg text-[10px] font-semibold text-violet-300 bg-violet-500/10 border border-violet-500/15 hover:bg-violet-500/20 transition-all cursor-pointer" data-testid={`link-profile-${s.studentId}`}>
                <Eye className="w-3 h-3" /> Profile
              </span>
            </Link>
            <Link href="/tutor/assessments">
              <span className="flex items-center gap-1 px-2.5 py-1.5 min-h-[28px] rounded-lg text-[10px] font-semibold text-slate-400 bg-slate-800/40 border border-white/[0.05] hover:bg-slate-800/60 transition-all cursor-pointer">
                <Send className="w-3 h-3" /> Assign
              </span>
            </Link>
            {s.lastSubmission && (
              <Link href={`/soma/review/${s.lastSubmission.reportId}`}>
                <span className="flex items-center gap-1 px-2.5 py-1.5 min-h-[28px] rounded-lg text-[10px] font-semibold text-slate-400 bg-slate-800/40 border border-white/[0.05] hover:bg-slate-800/60 transition-all cursor-pointer">
                  <ExternalLink className="w-3 h-3" /> Last Result
                </span>
              </Link>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
