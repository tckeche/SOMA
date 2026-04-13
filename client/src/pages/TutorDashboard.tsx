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
  Sparkles, Shield, Zap, CalendarDays,
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

const GLASS_PANEL = "rounded-2xl border border-white/[0.06] bg-gradient-to-b from-slate-900/95 to-[#0c1222]/95 backdrop-blur-xl shadow-[0_8px_32px_rgba(0,0,0,0.4),inset_0_1px_0_rgba(255,255,255,0.04)]";

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

  const atRiskStudents = useMemo(() => {
    if (!stats?.studentInsights?.length) return [];
    return stats.studentInsights
      .filter((s) => s.trend === "declining" || s.weakTopics.length > 0 || (s.awaiting > 0 && s.completed === 0))
      .sort((a, b) => {
        const aScore = (a.trend === "declining" ? 3 : 0) + a.weakTopics.length + (a.awaiting > a.completed ? 2 : 0);
        const bScore = (b.trend === "declining" ? 3 : 0) + b.weakTopics.length + (b.awaiting > b.completed ? 2 : 0);
        return bScore - aScore;
      })
      .slice(0, 6);
  }, [stats]);

  const { data: aiInsights, isLoading: aiLoading } = useQuery<{ insights: AIInsight[] }>({
    queryKey: ["/api/tutor/ai/intervention-insights", atRiskStudents.map((s) => s.studentId).join(",")],
    queryFn: async () => {
      const res = await authFetch("/api/tutor/ai/intervention-insights", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ students: atRiskStudents }),
      });
      if (!res.ok) return { insights: [] };
      return res.json();
    },
    enabled: atRiskStudents.length > 0,
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

  const overallAvg = useMemo(() => {
    if (!stats?.cohortAverages?.length) return null;
    const total = stats.cohortAverages.reduce((s, c) => s + c.average * c.count, 0);
    const count = stats.cohortAverages.reduce((s, c) => s + c.count, 0);
    return count > 0 ? Math.round(total / count) : null;
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
      .slice(0, 6);
  }, [stats]);

  useEffect(() => {
    return subscribeToSomaMutations(() => {
      queryClient.invalidateQueries({ queryKey: ["/api/tutor/dashboard-stats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/tutor/quizzes"] });
    });
  }, [queryClient]);

  const getAIReason = (studentId: string, studentName: string): string | null => {
    if (!aiInsights?.insights?.length) return null;
    const match = aiInsights.insights.find((i) => i.name === studentName) 
      || aiInsights.insights.find((i) => i.name?.toLowerCase() === studentName?.toLowerCase());
    return match?.reason || null;
  };

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
            <p className="text-sm text-slate-500 font-medium">Loading command centre...</p>
          </div>
        ) : (
          <div className="space-y-7 animate-in fade-in duration-500">

            {/* ── Header ─────────────────────────────────────────────── */}
            <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
              <div>
                <h2 className="text-2xl font-bold text-slate-100 tracking-tight">Command Centre</h2>
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

            {/* ── SECTION A: Strategic Command Tiles ────────────────── */}
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-7 gap-3">
              <CommandTile icon={Users} label="Active Students" value={stats?.totalStudents ?? 0} accent="violet" testId="stat-students" />
              <CommandTile icon={Send} label="Awaiting Submission" value={stats?.pendingAssignments?.length ?? 0} accent="amber" testId="stat-assigned" alert={overdueCount > 0 ? `${overdueCount} overdue` : undefined} />
              <CommandTile icon={Eye} label="Reviews Pending" value={stats?.recentSubmissions?.length ?? 0} accent="blue" testId="stat-reviews" />
              <CommandTile icon={Award} label="Cohort Average" value={overallAvg ?? 0} suffix="%" accent="emerald" testId="stat-cohort-avg" noValue={overallAvg === null} />
              <CommandTile icon={Target} label="Completion Rate" value={completionRate ?? 0} suffix="%" accent="cyan" testId="stat-completion" noValue={completionRate === null} />
              <CommandTile icon={Shield} label="Below Threshold" value={stats?.belowThresholdCount ?? 0} accent="red" testId="stat-below" />
              <CommandTile icon={AlertTriangle} label="Weakest Topic" textValue={stats?.weakestTopic || null} accent="orange" testId="stat-weakest" />
            </div>

            {/* ── SECTION B: Intervention Queue ─────────────────────── */}
            <div className={GLASS_PANEL}>
              <div className="px-6 pt-6 pb-4 flex items-center justify-between border-b border-white/[0.04]">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-xl flex items-center justify-center" style={{ background: "linear-gradient(135deg, rgba(239,68,68,0.15), rgba(220,38,38,0.08))", border: "1px solid rgba(239,68,68,0.15)" }}>
                    <Zap className="w-4.5 h-4.5 text-red-400" />
                  </div>
                  <div>
                    <h3 className="text-[15px] font-semibold text-slate-100 tracking-tight">Intervention Queue</h3>
                    <p className="text-[11px] text-slate-500 font-medium">Priority learners requiring tutor action</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {aiLoading && <Loader2 className="w-3.5 h-3.5 text-violet-400/60 animate-spin" />}
                  {aiInsights?.insights?.length ? (
                    <Badge className="bg-violet-500/10 text-violet-400 border-violet-500/15 text-[10px] gap-1">
                      <Sparkles className="w-3 h-3" /> AI Insights
                    </Badge>
                  ) : null}
                  {atRiskStudents.length > 0 && (
                    <Badge className="bg-red-500/10 text-red-400 border-red-500/15 text-[10px] font-semibold">
                      {atRiskStudents.length}
                    </Badge>
                  )}
                </div>
              </div>

              {atRiskStudents.length === 0 ? (
                <div className="px-6 py-14 text-center">
                  <CheckCircle2 className="w-11 h-11 mx-auto text-emerald-500/30 mb-3" />
                  <p className="text-sm text-slate-400 font-medium">All students are on track</p>
                  <p className="text-xs text-slate-600 mt-1">No interventions required at this time</p>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-px bg-white/[0.02]">
                  {atRiskStudents.map((s) => {
                    const TrendIcon = s.trend === "declining" ? TrendingDown : s.trend === "improving" ? TrendingUpIcon : Minus;
                    const trendColor = s.trend === "declining" ? "text-red-400" : s.trend === "improving" ? "text-emerald-400" : "text-slate-500";
                    const trendBg = s.trend === "declining" ? "bg-red-500/8" : s.trend === "improving" ? "bg-emerald-500/8" : "bg-slate-500/8";
                    const aiReason = getAIReason(s.studentId, s.studentName);
                    const completionPct = s.assigned > 0 ? Math.round((s.completed / s.assigned) * 100) : 0;
                    return (
                      <div key={s.studentId} className="p-5 hover:bg-white/[0.015] transition-all group border-b border-r border-white/[0.03]">
                        <div className="flex items-start justify-between mb-3">
                          <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-xl flex items-center justify-center text-xs font-bold text-slate-200 shrink-0" style={{ background: "linear-gradient(135deg, rgba(148,163,184,0.12), rgba(100,116,139,0.06))", border: "1px solid rgba(148,163,184,0.1)" }}>
                              {s.studentName.split(" ").map((n) => n[0]).join("").toUpperCase().slice(0, 2)}
                            </div>
                            <div>
                              <p className="text-sm font-semibold text-slate-200">{s.studentName}</p>
                              <div className="flex items-center gap-1.5 mt-0.5">
                                <div className={`flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-semibold ${trendBg} ${trendColor}`}>
                                  <TrendIcon className="w-3 h-3" />
                                  {s.trend}
                                </div>
                              </div>
                            </div>
                          </div>
                        </div>

                        {aiReason && (
                          <div className="mb-3 px-3 py-2 rounded-lg bg-violet-500/[0.06] border border-violet-500/10">
                            <p className="text-[11px] text-violet-300/90 leading-relaxed">{aiReason}</p>
                          </div>
                        )}

                        {s.weakTopics.length > 0 && (
                          <div className="flex flex-wrap gap-1 mb-3">
                            {s.weakTopics.map((t) => (
                              <span key={t} className="text-[10px] px-2 py-0.5 rounded-md bg-red-500/8 text-red-400/80 border border-red-500/10 font-medium">{t}</span>
                            ))}
                          </div>
                        )}

                        <div className="grid grid-cols-3 gap-2 mb-3">
                          <div className="text-center">
                            <p className="text-lg font-bold text-slate-200 tabular-nums">{s.assigned}</p>
                            <p className="text-[9px] text-slate-500 uppercase tracking-wider font-semibold">Assigned</p>
                          </div>
                          <div className="text-center">
                            <p className="text-lg font-bold text-emerald-400 tabular-nums">{s.completed}</p>
                            <p className="text-[9px] text-slate-500 uppercase tracking-wider font-semibold">Done</p>
                          </div>
                          <div className="text-center">
                            <p className="text-lg font-bold text-amber-400 tabular-nums">{s.awaiting}</p>
                            <p className="text-[9px] text-slate-500 uppercase tracking-wider font-semibold">Awaiting</p>
                          </div>
                        </div>

                        <div className="mb-3">
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-[10px] text-slate-500 font-medium">Completion</span>
                            <span className="text-[10px] text-slate-400 font-semibold tabular-nums">{completionPct}%</span>
                          </div>
                          <div className="h-1.5 rounded-full bg-slate-800/80 overflow-hidden">
                            <div className="h-full rounded-full transition-all duration-700" style={{ width: `${completionPct}%`, background: completionPct >= 60 ? "linear-gradient(90deg, #10b981, #34d399)" : completionPct >= 30 ? "linear-gradient(90deg, #f59e0b, #fbbf24)" : "linear-gradient(90deg, #ef4444, #f87171)" }} />
                          </div>
                        </div>

                        <div className="flex items-center gap-2 pt-1">
                          <Link href={`/tutor/students/${s.studentId}`}>
                            <span className="flex items-center gap-1.5 px-3 py-1.5 min-h-[32px] rounded-lg text-[11px] font-semibold text-violet-300 bg-violet-500/10 border border-violet-500/15 hover:bg-violet-500/20 transition-all cursor-pointer" data-testid={`link-risk-student-${s.studentId}`}>
                              <Eye className="w-3 h-3" /> View Profile
                            </span>
                          </Link>
                          <Link href="/tutor/assessments">
                            <span className="flex items-center gap-1.5 px-3 py-1.5 min-h-[32px] rounded-lg text-[11px] font-semibold text-slate-400 bg-slate-800/40 border border-white/[0.05] hover:bg-slate-800/60 transition-all cursor-pointer">
                              <Send className="w-3 h-3" /> Assign Work
                            </span>
                          </Link>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* ── SECTION C & D: Review Queue + Cohort Signals ──────── */}
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">

              {/* Review Queue */}
              <div className="lg:col-span-7">
                <div className={GLASS_PANEL}>
                  <div className="px-6 pt-5 pb-0 flex items-center gap-6 border-b border-white/[0.04]">
                    <button
                      onClick={() => setActiveTab("submissions")}
                      className={`pb-3 text-sm font-semibold transition-all border-b-2 ${activeTab === "submissions" ? "text-violet-300 border-violet-500" : "text-slate-500 border-transparent hover:text-slate-400"}`}
                      data-testid="tab-submissions"
                    >
                      Review Queue
                      {(stats?.recentSubmissions?.length ?? 0) > 0 && (
                        <span className="ml-2 text-[10px] font-bold px-1.5 py-0.5 rounded-md bg-violet-500/10 text-violet-400">{stats!.recentSubmissions.length}</span>
                      )}
                    </button>
                    <button
                      onClick={() => setActiveTab("pending")}
                      className={`pb-3 text-sm font-semibold transition-all border-b-2 ${activeTab === "pending" ? "text-violet-300 border-violet-500" : "text-slate-500 border-transparent hover:text-slate-400"}`}
                      data-testid="tab-pending"
                    >
                      Pending Submissions
                      {overdueCount > 0 && (
                        <span className="ml-2 text-[10px] font-bold px-1.5 py-0.5 rounded-md bg-red-500/10 text-red-400">{overdueCount} overdue</span>
                      )}
                    </button>
                  </div>

                  {activeTab === "submissions" ? (
                    (stats?.recentSubmissions?.length ?? 0) === 0 ? (
                      <div className="px-6 py-14 text-center">
                        <Activity className="w-10 h-10 mx-auto text-slate-700 mb-3" />
                        <p className="text-sm text-slate-400 font-medium">No submissions to review</p>
                        <p className="text-xs text-slate-600 mt-1">Student results will appear here</p>
                      </div>
                    ) : (
                      <div className="divide-y divide-white/[0.03]">
                        {stats!.recentSubmissions.map((sub, idx) => {
                          const sc = getSubjectColor(sub.subject);
                          const SubIcon = getSubjectIcon(sub.subject);
                          const duration = formatDuration(sub.startedAt, sub.completedAt);
                          const scoreColor = sub.score >= 70 ? "text-emerald-400 bg-emerald-500/10 border-emerald-500/15"
                            : sub.score >= 40 ? "text-amber-400 bg-amber-500/10 border-amber-500/15"
                            : "text-red-400 bg-red-500/10 border-red-500/15";
                          return (
                            <Link key={sub.reportId} href={`/soma/review/${sub.reportId}`}>
                              <div className="px-6 py-3.5 flex items-center gap-4 hover:bg-white/[0.015] transition-colors cursor-pointer group" data-testid={`submission-${sub.reportId}`}>
                                <div className="w-9 h-9 rounded-lg flex items-center justify-center border shrink-0" style={{ backgroundColor: `${sc.hex}08`, borderColor: `${sc.hex}18` }}>
                                  <SubIcon className="w-4 h-4" style={{ color: sc.hex }} />
                                </div>
                                <div className="flex-1 min-w-0">
                                  <p className="text-[13px] text-slate-200 truncate">
                                    <span className="font-semibold">{sub.studentName}</span>
                                    <span className="text-slate-600 mx-1.5">&middot;</span>
                                    <span className="text-slate-400">{sub.quizTitle}</span>
                                  </p>
                                  <div className="flex items-center gap-3 text-[10px] text-slate-500 mt-0.5 font-medium">
                                    <span>{formatDistanceToNow(new Date(sub.createdAt), { addSuffix: true })}</span>
                                    {duration && <span className="text-violet-400/60">{duration}</span>}
                                    {sub.subject && <span className="text-slate-600">{sub.subject}</span>}
                                  </div>
                                </div>
                                <Badge className={`text-xs font-bold px-2.5 py-1 border ${scoreColor}`} data-testid={`score-${idx}`}>
                                  {sub.score}%
                                </Badge>
                                <ArrowRight className="w-4 h-4 text-slate-700 group-hover:text-violet-400 transition-colors shrink-0" />
                              </div>
                            </Link>
                          );
                        })}
                      </div>
                    )
                  ) : (
                    (stats?.pendingAssignments?.length ?? 0) === 0 ? (
                      <div className="px-6 py-14 text-center">
                        <Send className="w-10 h-10 mx-auto text-slate-700 mb-3" />
                        <p className="text-sm text-slate-400 font-medium">No pending assignments</p>
                      </div>
                    ) : (
                      <div className="divide-y divide-white/[0.03]">
                        {stats!.pendingAssignments.map((pa, idx) => {
                          const sc = getSubjectColor(pa.subject);
                          const SubIcon = getSubjectIcon(pa.subject);
                          const isOverdue = pa.dueDate && new Date(pa.dueDate) < new Date();
                          return (
                            <div key={pa.assignmentId} className="px-6 py-3.5 flex items-center gap-4" data-testid={`pending-assignment-${idx}`}>
                              <div className="w-9 h-9 rounded-lg flex items-center justify-center border shrink-0" style={{ backgroundColor: `${sc.hex}08`, borderColor: `${sc.hex}18` }}>
                                <SubIcon className="w-4 h-4" style={{ color: sc.hex }} />
                              </div>
                              <div className="flex-1 min-w-0">
                                <p className="text-[13px] text-slate-200 truncate">
                                  <span className="font-semibold">{pa.studentName}</span>
                                  <span className="text-slate-600 mx-1.5">&middot;</span>
                                  <span className="text-slate-400">{pa.quizTitle}</span>
                                </p>
                                <div className="flex items-center gap-3 text-[10px] text-slate-500 mt-0.5 font-medium">
                                  <span>Assigned {formatDistanceToNow(new Date(pa.createdAt), { addSuffix: true })}</span>
                                  {pa.dueDate && (
                                    <span className={`flex items-center gap-1 ${isOverdue ? "text-red-400" : "text-amber-400/70"}`}>
                                      <Clock className="w-3 h-3" />
                                      Due {format(new Date(pa.dueDate), "MMM d")}
                                    </span>
                                  )}
                                </div>
                              </div>
                              {isOverdue ? (
                                <Badge className="text-[10px] font-bold px-2 py-0.5 bg-red-500/10 text-red-400 border border-red-500/15">Overdue</Badge>
                              ) : (
                                <Badge className="text-[10px] font-bold px-2 py-0.5 bg-slate-800/60 text-slate-400 border border-white/[0.06]">Pending</Badge>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )
                  )}
                </div>
              </div>

              {/* Cohort Signals: Subject Performance + Weak Topic Leaderboard */}
              <div className="lg:col-span-5 space-y-6">
                <div className={GLASS_PANEL}>
                  <div className="px-6 pt-5 pb-4 border-b border-white/[0.04]">
                    <div className="flex items-center gap-2.5">
                      <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: "linear-gradient(135deg, rgba(59,130,246,0.12), rgba(99,102,241,0.06))", border: "1px solid rgba(59,130,246,0.12)" }}>
                        <BarChart3 className="w-4 h-4 text-blue-400" />
                      </div>
                      <div>
                        <h3 className="text-[14px] font-semibold text-slate-100">Subject Performance</h3>
                        <p className="text-[11px] text-slate-500 font-medium">Cohort averages by subject</p>
                      </div>
                    </div>
                  </div>

                  {(stats?.cohortAverages?.length ?? 0) === 0 ? (
                    <div className="px-6 py-12 text-center">
                      <BarChart3 className="w-10 h-10 mx-auto text-slate-700 mb-3" />
                      <p className="text-sm text-slate-400">No performance data yet</p>
                    </div>
                  ) : (
                    <div className="px-6 py-4 space-y-4">
                      {stats!.cohortAverages.slice().sort((a, b) => b.average - a.average).map((ca) => {
                        const barGradient = ca.average >= 70 ? "linear-gradient(90deg, #10b981, #34d399)" : ca.average >= 50 ? "linear-gradient(90deg, #f59e0b, #fbbf24)" : "linear-gradient(90deg, #ef4444, #f87171)";
                        const textColor = ca.average >= 70 ? "text-emerald-400" : ca.average >= 50 ? "text-amber-400" : "text-red-400";
                        return (
                          <div key={ca.subject}>
                            <div className="flex items-center justify-between mb-1.5">
                              <span className="text-[12px] text-slate-300 font-medium truncate">{ca.subject}</span>
                              <div className="flex items-center gap-2">
                                <span className="text-[10px] text-slate-600 font-medium">{ca.count} submissions</span>
                                <span className={`text-xs font-bold tabular-nums ${textColor}`}>{ca.average}%</span>
                              </div>
                            </div>
                            <div className="h-2.5 rounded-full bg-slate-800/60 overflow-hidden">
                              <div className="h-full rounded-full transition-all duration-1000 ease-out" style={{ width: `${ca.average}%`, background: barGradient }} />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {weakTopicLeaderboard.length > 0 && (
                  <div className={GLASS_PANEL}>
                    <div className="px-6 pt-5 pb-4 border-b border-white/[0.04]">
                      <div className="flex items-center gap-2.5">
                        <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: "linear-gradient(135deg, rgba(249,115,22,0.12), rgba(234,88,12,0.06))", border: "1px solid rgba(249,115,22,0.12)" }}>
                          <AlertTriangle className="w-4 h-4 text-orange-400" />
                        </div>
                        <div>
                          <h3 className="text-[14px] font-semibold text-slate-100">Recurring Weak Topics</h3>
                          <p className="text-[11px] text-slate-500 font-medium">Topics appearing as weaknesses across students</p>
                        </div>
                      </div>
                    </div>
                    <div className="px-6 py-3 divide-y divide-white/[0.03]">
                      {weakTopicLeaderboard.map((w, idx) => (
                        <div key={w.topic} className="flex items-center justify-between py-2.5">
                          <div className="flex items-center gap-3">
                            <span className="text-[11px] text-slate-600 font-bold tabular-nums w-5">{idx + 1}</span>
                            <span className="text-[13px] text-slate-300 font-medium">{w.topic}</span>
                          </div>
                          <Badge className="text-[10px] font-bold bg-orange-500/8 text-orange-400 border border-orange-500/12">{w.count} student{w.count !== 1 ? "s" : ""}</Badge>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* ── SECTION E: Cohort Workload Matrix ─────────────────── */}
            {(stats?.studentInsights?.length ?? 0) > 0 && (
              <div className={GLASS_PANEL}>
                <div className="px-6 pt-5 pb-4 flex items-center justify-between border-b border-white/[0.04]">
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-xl flex items-center justify-center" style={{ background: "linear-gradient(135deg, rgba(139,92,246,0.12), rgba(99,102,241,0.06))", border: "1px solid rgba(139,92,246,0.12)" }}>
                      <Activity className="w-4 h-4 text-violet-400" />
                    </div>
                    <div>
                      <h3 className="text-[15px] font-semibold text-slate-100 tracking-tight">Cohort Workload Matrix</h3>
                      <p className="text-[11px] text-slate-500 font-medium">Assignment completion and performance across your cohort</p>
                    </div>
                  </div>
                  <Link href="/tutor/students">
                    <span className="text-xs text-violet-400 hover:text-violet-300 cursor-pointer flex items-center gap-1 font-medium" data-testid="link-all-students">
                      View All <ChevronRight className="w-3 h-3" />
                    </span>
                  </Link>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[700px]">
                    <thead>
                      <tr className="border-b border-white/[0.04]">
                        <th className="text-left text-[10px] font-bold text-slate-500 uppercase tracking-wider px-6 py-3">Student</th>
                        <th className="text-center text-[10px] font-bold text-slate-500 uppercase tracking-wider px-3 py-3 w-16">Assigned</th>
                        <th className="text-center text-[10px] font-bold text-slate-500 uppercase tracking-wider px-3 py-3 w-16">Done</th>
                        <th className="text-center text-[10px] font-bold text-slate-500 uppercase tracking-wider px-3 py-3 w-16">Awaiting</th>
                        <th className="text-left text-[10px] font-bold text-slate-500 uppercase tracking-wider px-3 py-3 w-44">Progress</th>
                        <th className="text-center text-[10px] font-bold text-slate-500 uppercase tracking-wider px-3 py-3 w-16">Trend</th>
                        <th className="text-center text-[10px] font-bold text-slate-500 uppercase tracking-wider px-3 py-3 w-16"></th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/[0.025]">
                      {stats!.studentInsights.map((s) => {
                        const rate = s.assigned > 0 ? Math.round((s.completed / s.assigned) * 100) : 0;
                        const TrendIcon = s.trend === "declining" ? TrendingDown : s.trend === "improving" ? TrendingUpIcon : Minus;
                        const trendColor = s.trend === "declining" ? "text-red-400" : s.trend === "improving" ? "text-emerald-400" : "text-slate-600";
                        const barGradient = rate >= 60 ? "linear-gradient(90deg, #10b981, #34d399)" : rate >= 30 ? "linear-gradient(90deg, #f59e0b, #fbbf24)" : "linear-gradient(90deg, #ef4444, #f87171)";
                        return (
                          <tr key={s.studentId} className="hover:bg-white/[0.01] transition-colors group">
                            <td className="px-6 py-3.5">
                              <Link href={`/tutor/students/${s.studentId}`}>
                                <span className="text-[13px] font-medium text-slate-200 hover:text-violet-300 cursor-pointer transition-colors" data-testid={`workload-student-${s.studentId}`}>{s.studentName}</span>
                              </Link>
                            </td>
                            <td className="text-center text-[13px] tabular-nums text-slate-400 font-medium px-3 py-3.5">{s.assigned}</td>
                            <td className="text-center text-[13px] tabular-nums text-emerald-400 font-medium px-3 py-3.5">{s.completed}</td>
                            <td className="text-center text-[13px] tabular-nums text-amber-400 font-medium px-3 py-3.5">{s.awaiting}</td>
                            <td className="px-3 py-3.5">
                              <div className="flex items-center gap-3">
                                <div className="flex-1 h-2 rounded-full bg-slate-800/60 overflow-hidden">
                                  <div className="h-full rounded-full transition-all duration-700" style={{ width: `${rate}%`, background: barGradient }} />
                                </div>
                                <span className="text-[11px] text-slate-500 font-semibold tabular-nums w-8 text-right">{rate}%</span>
                              </div>
                            </td>
                            <td className="text-center px-3 py-3.5">
                              <TrendIcon className={`w-4 h-4 mx-auto ${trendColor}`} />
                            </td>
                            <td className="text-center px-3 py-3.5">
                              <Link href={`/tutor/students/${s.studentId}`}>
                                <span className="text-slate-600 hover:text-violet-400 transition-colors cursor-pointer">
                                  <ChevronRight className="w-4 h-4 mx-auto" />
                                </span>
                              </Link>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* ── SECTION F & G: Quick Actions + Recent Assessments ─── */}
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
              <div className="lg:col-span-3">
                <div className={`${GLASS_PANEL} p-5`}>
                  <h3 className="text-[10px] font-bold text-slate-500 uppercase tracking-[0.15em] mb-4">Quick Actions</h3>
                  <div className="space-y-2">
                    <QuickAction icon={Plus} label="Create Assessment" href="/tutor/assessments/new" testId="qa-create" />
                    <QuickAction icon={UserPlus} label="Add Student" href="/tutor/students" testId="qa-add-student" />
                    <QuickAction icon={BookOpen} label="My Assessments" href="/tutor/assessments" testId="qa-assessments" />
                    <QuickAction icon={Users} label="View Students" href="/tutor/students" testId="qa-students" />
                  </div>
                </div>
              </div>

              <div className="lg:col-span-9">
                <div className={GLASS_PANEL}>
                  <div className="px-6 pt-5 pb-4 flex items-center justify-between border-b border-white/[0.04]">
                    <div className="flex items-center gap-2.5">
                      <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: "linear-gradient(135deg, rgba(16,185,129,0.12), rgba(5,150,105,0.06))", border: "1px solid rgba(16,185,129,0.12)" }}>
                        <BookOpen className="w-4 h-4 text-emerald-400" />
                      </div>
                      <h3 className="text-[14px] font-semibold text-slate-100">Recent Assessments</h3>
                    </div>
                    <Link href="/tutor/assessments">
                      <span className="text-xs text-violet-400 hover:text-violet-300 cursor-pointer flex items-center gap-1 font-medium" data-testid="link-view-all-assessments">
                        View All <ChevronRight className="w-3 h-3" />
                      </span>
                    </Link>
                  </div>

                  {quizzesLoading ? (
                    <div className="px-6 py-10 flex justify-center">
                      <Loader2 className="w-6 h-6 text-violet-500 animate-spin" />
                    </div>
                  ) : tutorQuizzes.length === 0 ? (
                    <div className="px-6 py-14 text-center">
                      <BookOpen className="w-10 h-10 mx-auto text-slate-700 mb-3" />
                      <p className="text-sm text-slate-400 font-medium">No assessments yet</p>
                      <p className="text-xs text-slate-600 mt-1">Create your first assessment to get started</p>
                    </div>
                  ) : (
                    <div className="divide-y divide-white/[0.03]">
                      {tutorQuizzes.slice(0, 6).map((quiz) => {
                        const sc = getSubjectColor(quiz.subject);
                        const SubIcon = getSubjectIcon(quiz.subject);
                        return (
                          <div key={quiz.id} className="px-6 py-3.5 flex items-center gap-4 hover:bg-white/[0.015] transition-colors group" data-testid={`quiz-tile-${quiz.id}`}>
                            <div className="w-9 h-9 rounded-lg flex items-center justify-center border shrink-0" style={{ backgroundColor: `${sc.hex}08`, borderColor: `${sc.hex}18` }}>
                              <SubIcon className="w-4 h-4" style={{ color: sc.hex }} />
                            </div>
                            <div className="flex-1 min-w-0">
                              <h4 className="text-[13px] font-semibold text-slate-200 truncate" data-testid={`quiz-title-${quiz.id}`}>{quiz.title}</h4>
                              <div className="flex items-center gap-2 mt-0.5">
                                <span className="text-[10px] text-slate-500 font-medium">{quiz.subject || "General"}</span>
                                {quiz.level && <span className="text-[10px] text-slate-600">&middot; {quiz.level}</span>}
                              </div>
                            </div>
                            <button
                              onClick={() => { setShowAssignModal(quiz.id); setSelectedStudentIds(new Set()); setDueDate(""); }}
                              className="flex items-center gap-1.5 px-3 py-1.5 min-h-[32px] rounded-lg text-[11px] font-semibold bg-emerald-600/10 text-emerald-400 border border-emerald-500/15 hover:bg-emerald-600/20 transition-all opacity-0 group-hover:opacity-100"
                              data-testid={`button-assign-${quiz.id}`}
                            >
                              <UserPlus className="w-3 h-3" />
                              Assign
                            </button>
                            <Link href="/tutor/assessments">
                              <span className="text-slate-600 hover:text-violet-400 transition-colors cursor-pointer" data-testid={`button-details-${quiz.id}`}>
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
    </div>
  );
}

const ACCENT_MAP: Record<string, { bg: string; border: string; text: string; glow: string }> = {
  violet: { bg: "rgba(139,92,246,0.08)", border: "rgba(139,92,246,0.12)", text: "#a78bfa", glow: "rgba(139,92,246,0.15)" },
  amber: { bg: "rgba(245,158,11,0.08)", border: "rgba(245,158,11,0.12)", text: "#fbbf24", glow: "rgba(245,158,11,0.15)" },
  blue: { bg: "rgba(59,130,246,0.08)", border: "rgba(59,130,246,0.12)", text: "#60a5fa", glow: "rgba(59,130,246,0.15)" },
  emerald: { bg: "rgba(16,185,129,0.08)", border: "rgba(16,185,129,0.12)", text: "#34d399", glow: "rgba(16,185,129,0.15)" },
  cyan: { bg: "rgba(6,182,212,0.08)", border: "rgba(6,182,212,0.12)", text: "#22d3ee", glow: "rgba(6,182,212,0.15)" },
  red: { bg: "rgba(239,68,68,0.08)", border: "rgba(239,68,68,0.12)", text: "#f87171", glow: "rgba(239,68,68,0.15)" },
  orange: { bg: "rgba(249,115,22,0.08)", border: "rgba(249,115,22,0.12)", text: "#fb923c", glow: "rgba(249,115,22,0.15)" },
};

function CommandTile({ icon: Icon, label, value, suffix = "", accent, testId, alert, noValue, textValue }: {
  icon: LucideIcon; label: string; value?: number; suffix?: string; accent: string; testId: string; alert?: string; noValue?: boolean; textValue?: string | null;
}) {
  const a = ACCENT_MAP[accent] || ACCENT_MAP.violet;
  return (
    <div
      className="rounded-2xl border backdrop-blur-xl p-4 transition-all hover:translate-y-[-2px] hover:shadow-xl group"
      style={{ background: `linear-gradient(135deg, ${a.bg}, transparent)`, borderColor: a.border, boxShadow: `0 4px 24px ${a.glow}` }}
      data-testid={testId}
    >
      <div className="flex items-center justify-between mb-2">
        <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: a.bg, border: `1px solid ${a.border}` }}>
          <Icon className="w-4 h-4" style={{ color: a.text }} />
        </div>
        {alert && (
          <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-red-500/10 text-red-400 border border-red-500/12">{alert}</span>
        )}
      </div>
      {textValue !== undefined ? (
        <p className="text-[15px] font-bold text-slate-100 leading-tight truncate mt-1">
          {textValue || <span className="text-slate-600">&mdash;</span>}
        </p>
      ) : (
        <p className="text-2xl font-bold text-slate-100 tabular-nums leading-none">
          {noValue ? <span className="text-slate-600">&mdash;</span> : <AnimatedNumber value={value!} suffix={suffix} />}
        </p>
      )}
      <p className="text-[10px] text-slate-500 mt-1 font-semibold uppercase tracking-wider leading-tight">{label}</p>
    </div>
  );
}

function QuickAction({ icon: Icon, label, href, testId }: { icon: LucideIcon; label: string; href: string; testId: string }) {
  return (
    <Link href={href}>
      <span className="flex items-center gap-3 px-4 py-3 min-h-[44px] rounded-xl text-sm text-slate-300 bg-white/[0.02] border border-white/[0.04] hover:bg-white/[0.04] hover:border-white/[0.08] transition-all cursor-pointer group font-medium" data-testid={testId}>
        <Icon className="w-4 h-4 text-slate-500 group-hover:text-violet-400 transition-colors" />
        {label}
        <ArrowRight className="w-3.5 h-3.5 ml-auto text-slate-700 group-hover:text-slate-500 transition-colors" />
      </span>
    </Link>
  );
}
