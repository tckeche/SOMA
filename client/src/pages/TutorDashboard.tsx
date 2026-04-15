import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import { motion } from "framer-motion";
import { supabase, authFetch } from "@/lib/supabase";
import { useSupabaseSession } from "@/hooks/use-supabase-session";
import type { SomaQuiz, SomaUser } from "@shared/schema";
import type { LucideIcon } from "lucide-react";
import {
  LogOut, Users, BookOpen, Plus, UserPlus, X,
  Loader2, Check, ChevronRight, AlertTriangle,
  LayoutDashboard, Clock, Send, Award, Eye, Bell,
  TrendingDown, TrendingUp as TrendingUpIcon, Minus, Activity,
  FileText, ArrowRight, BarChart3, Target, CheckCircle2,
  CalendarDays, ExternalLink, RefreshCcw, Sparkles,
  Radar, PieChart as PieChartIcon, TrendingUp, Grid3X3, BarChart2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { format, formatDistanceToNow } from "date-fns";
import { getSubjectColor, getSubjectIcon } from "@/lib/subjectColors";
import { useToast } from "@/hooks/use-toast";
import { emitSomaMutation, subscribeToSomaMutations } from "@/lib/realtimeEvents";
import {
  CohortRadarChart,
  StudentComparisonBarChart,
  PerformanceTrendAreaChart,
  SubjectDistributionChart,
  CompletionDonutChart,
  WorkloadHeatmap,
  ActivityTimelineChart,
} from "@/components/dashboard-charts";

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

const GP = "glass-panel-elite";

const AVATAR_GRADIENTS = [
  "linear-gradient(135deg, #667eea, #764ba2)",
  "linear-gradient(135deg, #f093fb, #f5576c)",
  "linear-gradient(135deg, #4facfe, #00f2fe)",
  "linear-gradient(135deg, #43e97b, #38f9d7)",
  "linear-gradient(135deg, #fa709a, #fee140)",
  "linear-gradient(135deg, #a18cd1, #fbc2eb)",
  "linear-gradient(135deg, #fccb90, #d57eeb)",
  "linear-gradient(135deg, #f6d365, #fda085)",
];

function getGreeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

function TimeElapsedBadge({ date }: { date: string }) {
  const hours = (Date.now() - new Date(date).getTime()) / (1000 * 60 * 60);
  if (hours < 1) return <span className="text-[9px] font-bold text-emerald-400 bg-emerald-500/10 px-1.5 py-0.5 rounded border border-emerald-500/15">Just now</span>;
  if (hours < 24) return <span className="text-[9px] font-bold text-amber-400 bg-amber-500/10 px-1.5 py-0.5 rounded border border-amber-500/15">{Math.floor(hours)}h ago</span>;
  return <span className="text-[9px] font-bold text-rose-400 bg-rose-500/10 px-1.5 py-0.5 rounded border border-rose-500/15">{Math.floor(hours / 24)}d ago</span>;
}

function FadeInSection({ children, className, delay = 0 }: { children: React.ReactNode; className?: string; delay?: number }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-40px" }}
      transition={{ duration: 0.45, delay, ease: [0.25, 0.46, 0.45, 0.94] }}
      className={className}
    >
      {children}
    </motion.div>
  );
}

function SectionHeader({ icon: Icon, title, subtitle, action }: { icon: LucideIcon; title: string; subtitle?: string; action?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between mb-4">
      <div className="flex items-center gap-2.5">
        <div className="w-7 h-7 rounded-lg flex items-center justify-center bg-indigo-500/15 border border-indigo-500/20">
          <Icon className="w-3.5 h-3.5 text-indigo-400" />
        </div>
        <div>
          <h3 className="text-lg font-bold text-slate-100" style={{ letterSpacing: "0.3px" }}>{title}</h3>
          {subtitle && <p className="text-[10px] text-slate-500 font-medium mt-0.5">{subtitle}</p>}
        </div>
      </div>
      {action}
    </div>
  );
}

function ChartCard({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`${GP} p-5 ${className || ""}`}>
      {children}
    </div>
  );
}

function getStatusChip(s: DashboardStats["studentInsights"][0]): { text: string; color: string; dot: string } {
  const hasSubmissions = s.completed > 0;
  const allDone = s.assigned > 0 && s.awaiting === 0 && s.completed === s.assigned;

  if (!hasSubmissions && s.assigned > 0) return { text: "Awaiting", color: "bg-amber-500/10 text-amber-300 border-amber-500/20", dot: "bg-amber-400" };
  if (s.trend === "declining" && s.completed >= 2) return { text: "Trend down", color: "bg-rose-500/10 text-rose-300 border-rose-500/20", dot: "bg-rose-400" };
  if (s.completed < 3 && s.assigned > 0) return { text: "Low evidence", color: "bg-slate-500/10 text-slate-400 border-slate-500/20", dot: "bg-slate-400" };
  if (s.awaiting > 0 && !allDone) return { text: "Needs marking", color: "bg-violet-500/10 text-violet-300 border-violet-500/20", dot: "bg-violet-400" };
  if (s.trend === "improving") return { text: "Trend up", color: "bg-emerald-500/10 text-emerald-300 border-emerald-500/20", dot: "bg-emerald-400" };
  if (allDone) return { text: "On track", color: "bg-emerald-500/10 text-emerald-300 border-emerald-500/20", dot: "bg-emerald-400" };
  return { text: "Stable", color: "bg-slate-500/10 text-slate-400 border-slate-500/20", dot: "bg-slate-400" };
}

function MiniSparkline({ scores }: { scores: number[] }) {
  if (scores.length < 2) return null;
  const w = 72, h = 28, pad = 3;
  const min = Math.min(...scores), max = Math.max(...scores);
  const range = max - min || 1;
  const pts = scores.map((v, i) => {
    const x = pad + (i / (scores.length - 1)) * (w - pad * 2);
    const y = h - pad - ((v - min) / range) * (h - pad * 2);
    return [x, y] as const;
  });
  const last = scores[scores.length - 1];
  const color = last >= 70 ? "#34d399" : last >= 50 ? "#fbbf24" : "#f87171";
  const lineStr = pts.map(([x, y]) => `${x},${y}`).join(" ");
  const areaStr = `${pts[0][0]},${h} ${lineStr} ${pts[pts.length - 1][0]},${h}`;
  const uid = `sp-${scores.join("-")}`;
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="shrink-0">
      <defs>
        <linearGradient id={uid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.25" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={areaStr} fill={`url(#${uid})`} />
      <polyline points={lineStr} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" opacity="0.8" />
      <circle cx={pts[pts.length - 1][0]} cy={pts[pts.length - 1][1]} r="2.5" fill={color} />
    </svg>
  );
}

function WorkloadBar({ assigned, completed, awaiting }: { assigned: number; completed: number; awaiting: number }) {
  const total = assigned || 1;
  const cPct = (completed / total) * 100;
  const aPct = (awaiting / total) * 100;
  const pPct = Math.max(0, 100 - cPct - aPct);
  return (
    <div className="space-y-1.5">
      <div className="flex-1 h-[7px] rounded-full bg-slate-800/60 overflow-hidden flex">
        {cPct > 0 && <div className="h-full rounded-l-full" style={{ width: `${cPct}%`, background: "linear-gradient(90deg, #059669, #34d399)" }} />}
        {aPct > 0 && <div className="h-full" style={{ width: `${aPct}%`, background: "linear-gradient(90deg, #d97706, #fbbf24)" }} />}
        {pPct > 0 && <div className="h-full rounded-r-full bg-slate-700/30" style={{ width: `${pPct}%` }} />}
      </div>
      <div className="flex items-center gap-3 text-[9px] tabular-nums">
        <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-emerald-400 inline-block" /><span className="text-slate-500 font-medium">{completed}</span></span>
        <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-amber-400 inline-block" /><span className="text-slate-500 font-medium">{awaiting}</span></span>
        <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-slate-600 inline-block" /><span className="text-slate-600 font-medium">{Math.max(0, assigned - completed - awaiting)}</span></span>
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
  const [activeTab, setActiveTab] = useState<"overview" | "notifications">("overview");

  const { session, userId } = useSupabaseSession();
  const displayName = session?.user?.user_metadata?.display_name || session?.user?.email?.split("@")[0] || "Tutor";
  const initials = displayName.split(" ").map((n: string) => n[0]).join("").toUpperCase().slice(0, 2);

  const { data: stats, isLoading, isError: statsError, dataUpdatedAt } = useQuery<DashboardStats>({
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
    <div className="min-h-screen">
      {/* ── HEADER ─────────────────────────────────────────────── */}
      <header className="sticky top-0 z-30 border-b border-white/[0.06] backdrop-blur-2xl" style={{ background: "linear-gradient(180deg, rgba(8,13,26,0.92) 0%, rgba(8,13,26,0.85) 100%)" }}>
        <div className="max-w-[1440px] mx-auto px-6 lg:px-10 py-3.5 flex items-center justify-between">
          <Link href="/">
            <div className="flex items-center gap-3.5 cursor-pointer group">
              <img src="/MCEC - White Logo.png" alt="MCEC Logo" loading="lazy" className="h-9 w-auto object-contain opacity-90 group-hover:opacity-100 transition-opacity" />
              <div>
                <h1 className="text-lg font-extrabold tracking-tight gradient-text leading-none">SOMA</h1>
                <p className="text-[9px] text-slate-500 tracking-[0.25em] uppercase font-semibold mt-0.5">Assessment Platform</p>
              </div>
            </div>
          </Link>
          <div className="flex items-center gap-5">
            <nav className="hidden md:flex items-center gap-0.5 mr-2">
              <span className="flex items-center gap-2 px-4 py-2 text-[13px] font-semibold text-violet-300 border-b-2 border-violet-500 cursor-default" data-testid="nav-dashboard">
                <LayoutDashboard className="w-3.5 h-3.5" /> Dashboard
              </span>
              <Link href="/tutor/students">
                <span className="flex items-center gap-2 px-4 py-2 text-[13px] font-medium text-slate-500 hover:text-slate-300 border-b-2 border-transparent transition-all cursor-pointer" data-testid="nav-students">
                  <Users className="w-3.5 h-3.5" /> Students
                </span>
              </Link>
              <Link href="/tutor/assessments">
                <span className="flex items-center gap-2 px-4 py-2 text-[13px] font-medium text-slate-500 hover:text-slate-300 border-b-2 border-transparent transition-all cursor-pointer" data-testid="nav-assessments">
                  <BookOpen className="w-3.5 h-3.5" /> Assessments
                </span>
              </Link>
            </nav>
            <div className="flex items-center gap-3">
              <div
                className="w-9 h-9 rounded-xl flex items-center justify-center text-xs font-bold text-white shrink-0"
                style={{ background: "linear-gradient(135deg, rgba(139,92,246,0.3), rgba(99,102,241,0.2))", boxShadow: "0 0 24px rgba(139,92,246,0.2), inset 0 1px 0 rgba(255,255,255,0.08)", border: "1.5px solid rgba(139,92,246,0.4)" }}
              >
                {initials}
              </div>
              <div className="hidden sm:block">
                <p className="text-[13px] font-medium text-slate-200 leading-none">{displayName}</p>
                <p className="text-[9px] text-violet-400/70 font-bold uppercase tracking-[0.2em] mt-0.5">Tutor</p>
              </div>
            </div>
            <button onClick={handleLogout} className="text-slate-600 hover:text-slate-300 transition-colors p-2 min-h-[44px] min-w-[44px] rounded-lg hover:bg-white/[0.03]" aria-label="Log out" data-testid="button-logout">
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
        {/* Mobile nav */}
        <div className="md:hidden border-t border-white/[0.04] flex">
          <span className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2.5 text-[12px] font-semibold text-violet-300 border-b-2 border-violet-500" data-testid="nav-dashboard-mobile">
            <LayoutDashboard className="w-3.5 h-3.5" /> Dashboard
          </span>
          <Link href="/tutor/students">
            <span className="flex items-center justify-center gap-1.5 px-4 py-2.5 text-[12px] font-medium text-slate-500">
              <Users className="w-3.5 h-3.5" /> Students
            </span>
          </Link>
          <Link href="/tutor/assessments">
            <span className="flex items-center justify-center gap-1.5 px-4 py-2.5 text-[12px] font-medium text-slate-500">
              <BookOpen className="w-3.5 h-3.5" /> Assessments
            </span>
          </Link>
        </div>
      </header>

      {/* ── MAIN ───────────────────────────────────────────────── */}
      <main className="max-w-[1440px] mx-auto px-6 lg:px-10 py-7">
        {statsError ? (
          <div className="flex flex-col items-center justify-center py-32 gap-4" data-testid="dashboard-error">
            <div className="w-14 h-14 rounded-2xl flex items-center justify-center bg-amber-500/10 border border-amber-500/15">
              <AlertTriangle className="w-6 h-6 text-amber-400/80" />
            </div>
            <p className="text-sm text-slate-300 font-semibold">Unable to load dashboard data</p>
            <p className="text-xs text-slate-600">Check your connection and try refreshing</p>
          </div>
        ) : isLoading ? (
          <div className="space-y-6 animate-in fade-in duration-300">
            {/* Skeleton header */}
            <div className="flex items-end justify-between">
              <div>
                <div className="h-4 w-32 rounded-lg skeleton-bar mb-2" />
                <div className="h-7 w-48 rounded-lg skeleton-bar" />
                <div className="h-3 w-56 rounded-md skeleton-bar mt-2" />
              </div>
              <div className="flex gap-3">
                <div className="h-11 w-28 rounded-xl skeleton-bar" />
                <div className="h-11 w-44 rounded-xl skeleton-bar" />
              </div>
            </div>
            {/* Skeleton tab switcher */}
            <div className="h-10 w-64 rounded-xl skeleton-bar" />
            {/* Skeleton panels */}
            <div className="grid grid-cols-1 lg:grid-cols-5 gap-5">
              <div className={`${GP} lg:col-span-3 p-5`} style={{ minHeight: 200 }}>
                <div className="h-4 w-40 rounded skeleton-bar mb-4" />
                <div className="space-y-3">{[1,2,3].map(i => <div key={i} className="h-12 rounded-lg skeleton-bar" />)}</div>
              </div>
              <div className={`${GP} lg:col-span-2 p-5`} style={{ minHeight: 200 }}>
                <div className="h-4 w-36 rounded skeleton-bar mb-4" />
                <div className="space-y-3">{[1,2,3].map(i => <div key={i} className="h-12 rounded-lg skeleton-bar" />)}</div>
              </div>
            </div>
            {/* Skeleton plaques */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {[1,2,3,4,5,6].map(i => (
                <div key={i} className={`${GP} p-5`} style={{ minHeight: 240 }}>
                  <div className="flex items-center gap-3 mb-5">
                    <div className="w-11 h-11 rounded-xl skeleton-bar" />
                    <div className="flex-1">
                      <div className="h-4 w-24 rounded skeleton-bar" />
                      <div className="h-3 w-16 rounded skeleton-bar mt-1.5" />
                    </div>
                  </div>
                  <div className="space-y-4 mt-2">
                    <div className="h-2 w-full rounded-full skeleton-bar" />
                    <div className="h-2 w-3/4 rounded-full skeleton-bar" />
                    <div className="h-2 w-1/2 rounded-full skeleton-bar" />
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="space-y-6 animate-in fade-in duration-500">

            {/* ── TITLE BAR ──────────────────────────────────────── */}
            <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
              <div>
                <p className="text-sm text-violet-400/80 font-medium mb-0.5">{getGreeting()}, {displayName.split(" ")[0]}</p>
                <h2 className="text-4xl font-extrabold text-slate-100 tracking-tight" style={{ letterSpacing: "0.5px" }}>SOMA</h2>
                <div className="flex items-center gap-2 mt-1">
                  <p className="text-[12px] text-slate-500 font-medium tracking-wide">{format(new Date(), "EEEE, d MMMM yyyy")}</p>
                  {dataUpdatedAt > 0 && (
                    <span className="text-[10px] text-slate-600 font-medium">
                      &middot; Updated {formatDistanceToNow(new Date(dataUpdatedAt), { addSuffix: true })}
                    </span>
                  )}
                  <button
                    onClick={() => queryClient.invalidateQueries({ queryKey: ["/api/tutor/dashboard-stats"] })}
                    className="text-slate-600 hover:text-violet-400 transition-colors p-1 rounded-md hover:bg-white/[0.04]"
                    aria-label="Refresh data"
                  >
                    <RefreshCcw className="w-3 h-3" />
                  </button>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2.5">
                <Link href="/tutor/students">
                  <span className="flex items-center gap-2 px-4 py-2.5 min-h-[42px] rounded-xl text-[13px] font-medium text-slate-300 bg-white/[0.04] border border-white/[0.06] hover:bg-white/[0.07] hover:border-white/[0.1] transition-all cursor-pointer" data-testid="button-view-students">
                    <Users className="w-3.5 h-3.5" /> Students
                  </span>
                </Link>
                <Link href="/tutor/assessments/new">
                  <span className="glow-button flex items-center gap-2 px-5 py-2.5 min-h-[42px] rounded-xl text-[13px] font-semibold cursor-pointer" data-testid="button-create-assessment">
                    <Plus className="w-3.5 h-3.5" /> New Assessment
                  </span>
                </Link>
              </div>
            </div>

            {/* ── TAB SWITCHER ─────────────────────────────────── */}
            <div className="flex items-center gap-1 bg-white/[0.03] rounded-xl p-1 border border-white/[0.06] w-fit">
              <button
                onClick={() => setActiveTab("overview")}
                className={`flex items-center gap-2 px-4 py-2 min-h-[38px] rounded-lg text-[13px] font-semibold transition-all ${
                  activeTab === "overview"
                    ? "bg-violet-500/15 text-violet-300 border border-violet-500/25 shadow-sm"
                    : "text-slate-500 hover:text-slate-300 border border-transparent"
                }`}
              >
                <LayoutDashboard className="w-3.5 h-3.5" /> Overview
              </button>
              <button
                onClick={() => setActiveTab("notifications")}
                className={`flex items-center gap-2 px-4 py-2 min-h-[38px] rounded-lg text-[13px] font-semibold transition-all ${
                  activeTab === "notifications"
                    ? "bg-violet-500/15 text-violet-300 border border-violet-500/25 shadow-sm"
                    : "text-slate-500 hover:text-slate-300 border border-transparent"
                }`}
              >
                <Bell className="w-3.5 h-3.5" /> Notifications
                {(stats?.recentSubmissions?.length ?? 0) > 0 && (
                  <span className="text-[10px] font-bold tabular-nums bg-violet-500/20 text-violet-300 px-1.5 py-0.5 rounded-md border border-violet-500/25 leading-none">
                    {stats!.recentSubmissions.length}
                  </span>
                )}
              </button>
            </div>

            {/* ── NOTIFICATIONS TAB ──────────────────────────────── */}
            {activeTab === "notifications" && (
              <FadeInSection>
                <SectionHeader icon={Bell} title="Submissions" subtitle="Recent student submissions awaiting review" />
                {(stats?.recentSubmissions?.length ?? 0) === 0 ? (
                  <div className={`${GP} px-6 py-16 text-center`}>
                    <Bell className="w-12 h-12 mx-auto text-slate-700 mb-4" />
                    <p className="text-sm text-slate-400 font-medium">No submissions yet</p>
                    <p className="text-xs text-slate-600 mt-1">Submissions will appear here as students complete assessments</p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {stats!.recentSubmissions.map((sub) => {
                      const scoreColor = sub.score >= 75 ? "text-emerald-400" : sub.score >= 50 ? "text-amber-400" : "text-rose-400";
                      const scoreBg = sub.score >= 75 ? "bg-emerald-500/10 border-emerald-500/15" : sub.score >= 50 ? "bg-amber-500/10 border-amber-500/15" : "bg-rose-500/10 border-rose-500/15";
                      const duration = formatDuration(sub.startedAt, sub.completedAt);
                      const sc = getSubjectColor(sub.subject);
                      const SubIcon = getSubjectIcon(sub.subject);
                      return (
                        <div key={sub.reportId} className={`${GP} p-5 hover:bg-white/[0.02] transition-colors`} data-testid={`notification-${sub.reportId}`}>
                          <div className="flex items-start gap-4">
                            <div className="w-10 h-10 rounded-xl flex items-center justify-center border shrink-0" style={{ backgroundColor: `${sc.hex}10`, borderColor: `${sc.hex}20` }}>
                              <SubIcon className="w-5 h-5" style={{ color: sc.hex }} />
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 mb-1">
                                <p className="text-[14px] font-semibold text-slate-100">{sub.studentName}</p>
                                <Badge className={`text-[10px] font-bold border px-2 py-0.5 ${scoreBg} ${scoreColor}`}>{sub.score}%</Badge>
                              </div>
                              <p className="text-[12px] text-slate-400 font-medium mb-2">{sub.quizTitle}</p>
                              <div className="flex items-center gap-4 text-[11px] text-slate-500 font-medium flex-wrap">
                                <span className="flex items-center gap-1"><Clock className="w-3 h-3" /> {format(new Date(sub.createdAt), "MMM d, h:mm a")}</span>
                                {duration && <span className="flex items-center gap-1"><Activity className="w-3 h-3" /> {duration}</span>}
                                {sub.subject && <span className="flex items-center gap-1"><BookOpen className="w-3 h-3" /> {sub.subject}</span>}
                              </div>
                            </div>
                            <div className="flex items-center gap-2 shrink-0">
                              <Link href={`/soma/review/${sub.reportId}`}>
                                <span className="flex items-center gap-1.5 px-3 py-2 min-h-[36px] rounded-lg text-[11px] font-semibold text-indigo-300 bg-indigo-500/10 border border-indigo-500/15 hover:bg-indigo-500/20 transition-all cursor-pointer">
                                  <Eye className="w-3.5 h-3.5" /> Review
                                </span>
                              </Link>
                              <Link href={`/soma/quiz/${sub.reportId}`}>
                                <span className="flex items-center gap-1.5 px-3 py-2 min-h-[36px] rounded-lg text-[11px] font-semibold text-slate-400 bg-white/[0.03] border border-white/[0.06] hover:bg-white/[0.06] transition-all cursor-pointer">
                                  <FileText className="w-3.5 h-3.5" /> Quiz
                                </span>
                              </Link>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </FadeInSection>
            )}

            {/* ── OVERVIEW TAB ───────────────────────────────────── */}
            {activeTab === "overview" && (<>

            {/* ══════════════════════════════════════════════════════
                ROW 1 — Intervention Queue + Pending Submissions
               ══════════════════════════════════════════════════════ */}
            <FadeInSection>
              <div className="grid grid-cols-1 lg:grid-cols-5 gap-5">

                {/* Intervention Queue */}
                <div className={`${GP} lg:col-span-3`}>
                  <div className="px-5 pt-4 pb-3 flex items-center justify-between border-b border-white/[0.06] relative overflow-hidden">
                    <div className="absolute inset-0 bg-gradient-to-r from-rose-500/[0.06] to-transparent pointer-events-none" />
                    <div className="flex items-center gap-2.5 relative">
                      <div className="w-7 h-7 rounded-lg flex items-center justify-center bg-rose-500/15 border border-rose-500/20">
                        <AlertTriangle className="w-3.5 h-3.5 text-rose-400" />
                      </div>
                      <h3 className="text-[13px] font-bold text-slate-100 tracking-wide" style={{ letterSpacing: "0.3px" }}>Intervention Queue</h3>
                      {aiInsights?.insights && aiInsights.insights.length > 0 && (
                        <span className="text-[9px] font-bold text-violet-400 bg-violet-500/15 px-2 py-0.5 rounded-md border border-violet-500/20" style={{ animation: "status-pulse 2.5s ease-in-out infinite" }}>
                          <Sparkles className="w-3 h-3 inline mr-0.5 -mt-0.5" /> AI Insights
                        </span>
                      )}
                    </div>
                    <Link href="/tutor/students">
                      <span className="relative text-[10px] text-violet-400 hover:text-violet-300 cursor-pointer font-semibold">View All &rarr;</span>
                    </Link>
                  </div>
                  {(() => {
                    const atRisk = studentPlaques.filter(
                      (s) => s.trend === "declining" || s.weakTopics.length > 0 || (s.assigned > 0 && s.completed === 0)
                    );
                    if (atRisk.length === 0) return (
                      <div className="px-5 py-10 text-center">
                        <CheckCircle2 className="w-8 h-8 mx-auto text-emerald-500/20 mb-2" />
                        <p className="text-[11px] text-slate-600 font-medium">No students flagged — great work!</p>
                      </div>
                    );
                    return (
                      <div className="divide-y divide-white/[0.03] max-h-[340px] overflow-y-auto">
                        {atRisk.slice(0, 6).map((s) => {
                          const borderColor = s.trend === "declining" ? "#EF4444" : s.completed === 0 ? "#FBBF24" : "#F97316";
                          const insight = getInsightChip(s.studentName);
                          return (
                            <div key={s.studentId} className="px-5 py-3 flex items-start gap-3 hover:bg-white/[0.02] transition-colors relative" style={{ borderLeft: `3px solid ${borderColor}` }}>
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 mb-1">
                                  <p className="text-[12px] text-slate-100 font-semibold truncate">{s.studentName}</p>
                                  <Badge className={`text-[8px] font-bold border px-1.5 py-0 leading-[18px] ${s.chip.color}`}>{s.chip.text}</Badge>
                                </div>
                                {insight && (
                                  <p className="text-[10px] text-indigo-300/80 leading-relaxed mb-1">{insight}</p>
                                )}
                                <div className="flex items-center gap-3 text-[10px] text-slate-500">
                                  {s.weakTopics.length > 0 && <span>Weak subjects: {s.weakTopics.slice(0, 2).join(", ")}</span>}
                                  {s.lastScore !== null && <span className={s.lastScore >= 70 ? "text-emerald-400" : s.lastScore >= 50 ? "text-amber-400" : "text-rose-400"}>Last: {s.lastScore}%</span>}
                                </div>
                              </div>
                              <Link href={`/tutor/students/${s.studentId}`}>
                                <span className="text-[10px] font-semibold text-indigo-400 hover:text-indigo-300 cursor-pointer shrink-0 mt-1">View &rarr;</span>
                              </Link>
                            </div>
                          );
                        })}
                      </div>
                    );
                  })()}
                </div>

                {/* Pending Submissions — prominent right panel */}
                <div className={`${GP} lg:col-span-2`}>
                  <div className="px-5 pt-4 pb-3 flex items-center justify-between border-b border-white/[0.06] relative overflow-hidden">
                    <div className="absolute inset-0 bg-gradient-to-r from-amber-500/[0.06] to-transparent pointer-events-none" />
                    <div className="flex items-center gap-2.5 relative">
                      <div className="w-7 h-7 rounded-lg flex items-center justify-center bg-amber-500/15 border border-amber-500/20">
                        <Clock className="w-3.5 h-3.5 text-amber-400" />
                      </div>
                      <h3 className="text-[13px] font-bold text-slate-100 tracking-wide" style={{ letterSpacing: "0.3px" }}>Pending Submissions</h3>
                    </div>
                    <div className="relative flex items-center gap-2">
                      {(stats?.pendingAssignments?.length ?? 0) > 0 && (
                        <span className="text-[10px] font-bold text-amber-400 tabular-nums bg-amber-500/15 px-2.5 py-0.5 rounded-lg border border-amber-500/20">
                          {stats!.pendingAssignments.length}
                        </span>
                      )}
                      {overdueCount > 0 && (
                        <span className="text-[10px] font-bold text-rose-400 tabular-nums bg-rose-500/15 px-2.5 py-0.5 rounded-lg border border-rose-500/20 status-pulse" data-testid="stat-assigned">
                          {overdueCount} overdue
                        </span>
                      )}
                    </div>
                  </div>
                  {(stats?.pendingAssignments?.length ?? 0) === 0 ? (
                    <div className="px-5 py-8 text-center">
                      <CheckCircle2 className="w-7 h-7 mx-auto text-emerald-500/20 mb-2" />
                      <p className="text-[11px] text-slate-600 font-medium">No pending work</p>
                    </div>
                  ) : (
                    <div className="divide-y divide-white/[0.03] max-h-[340px] overflow-y-auto">
                      {stats!.pendingAssignments.slice(0, 10).map((pa) => {
                        const isOverdue = pa.dueDate && new Date(pa.dueDate) < new Date();
                        return (
                          <div key={pa.assignmentId} className="px-5 py-2.5 flex items-center gap-3" data-testid={`pending-assignment-${pa.assignmentId}`}>
                            <div className="flex-1 min-w-0">
                              <p className="text-[11px] text-slate-200 font-medium truncate">{pa.studentName}</p>
                              <p className="text-[10px] text-slate-600 truncate">{pa.quizTitle}</p>
                            </div>
                            {isOverdue ? (
                              <span className="text-[9px] font-bold text-rose-400 bg-rose-500/10 px-1.5 py-0.5 rounded border border-rose-500/15">Overdue</span>
                            ) : pa.dueDate ? (
                              <span className="text-[10px] text-amber-400/70 font-medium shrink-0">Due {format(new Date(pa.dueDate), "MMM d")}</span>
                            ) : (
                              <span className="text-[9px] font-bold text-slate-500 bg-slate-800/40 px-1.5 py-0.5 rounded border border-white/[0.05]">Pending</span>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            </FadeInSection>

            {/* ══════════════════════════════════════════════════════
                ROW 2 — Cohort Overview: Radar + Donut + Mini Trend
               ══════════════════════════════════════════════════════ */}
            <FadeInSection>
              <SectionHeader icon={Radar} title="Cohort Performance Overview" subtitle="Averages across all subjects and assignment completion" />
              <div className="grid grid-cols-1 lg:grid-cols-10 gap-5">
                <ChartCard className="lg:col-span-4">
                  <p className="text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-3">Subject Radar</p>
                  <div style={{ height: 280 }}>
                    <CohortRadarChart stats={stats!} />
                  </div>
                </ChartCard>
                <ChartCard className="lg:col-span-2 flex flex-col items-center justify-center">
                  <p className="text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-2 self-start">Completion</p>
                  <div style={{ height: 220, width: "100%" }}>
                    <CompletionDonutChart stats={stats!} />
                  </div>
                </ChartCard>
                <ChartCard className="lg:col-span-4">
                  <p className="text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-3">Performance Trend</p>
                  <div style={{ height: 280 }}>
                    <PerformanceTrendAreaChart stats={stats!} />
                  </div>
                </ChartCard>
              </div>
            </FadeInSection>

            {/* ══════════════════════════════════════════════════════
                ROW 3 — Student Performance Comparison Bar Chart
               ══════════════════════════════════════════════════════ */}
            <FadeInSection delay={0.05}>
              <SectionHeader icon={BarChart2} title="Student Comparison" subtitle="Average score, completion rate, and reliability across all students" />
              <ChartCard>
                <div style={{ height: 320 }}>
                  <StudentComparisonBarChart stats={stats!} />
                </div>
              </ChartCard>
            </FadeInSection>

            {/* ══════════════════════════════════════════════════════
                ROW 4 — Student Card Grid
               ══════════════════════════════════════════════════════ */}
            <FadeInSection delay={0.05}>
              <SectionHeader icon={Users} title="Students" subtitle={`${studentPlaques.length} students in your cohort`} />
              {studentPlaques.length === 0 ? (
                <div className={`${GP} px-6 py-16 text-center`}>
                  <Users className="w-12 h-12 mx-auto text-slate-700 mb-4" />
                  <p className="text-sm text-slate-400 font-medium">No students yet</p>
                  <p className="text-xs text-slate-600 mt-1">Go to the Students tab to adopt students</p>
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4" data-testid="student-plaque-grid">
                  {studentPlaques.map((s, i) => (
                    <StudentPlaque key={s.studentId} student={s} insightChip={getInsightChip(s.studentName)} index={i} />
                  ))}
                </div>
              )}
            </FadeInSection>

            {/* ══════════════════════════════════════════════════════
                ROW 5 — Performance Trends (full-width area chart)
               ══════════════════════════════════════════════════════ */}
            <FadeInSection delay={0.05}>
              <SectionHeader icon={TrendingUp} title="Performance Trends" subtitle="Cohort and individual student performance over time" />
              <ChartCard>
                <div style={{ height: 320 }}>
                  <PerformanceTrendAreaChart stats={stats!} />
                </div>
              </ChartCard>
            </FadeInSection>

            {/* ══════════════════════════════════════════════════════
                ROW 7 — Heatmap + Subject Distribution
               ══════════════════════════════════════════════════════ */}
            <FadeInSection delay={0.05}>
              <div className="grid grid-cols-1 lg:grid-cols-5 gap-5">
                <ChartCard className="lg:col-span-3">
                  <SectionHeader icon={Grid3X3} title="Workload Heatmap" subtitle="Student × Subject performance matrix" />
                  <WorkloadHeatmap stats={stats!} />
                </ChartCard>
                <ChartCard className="lg:col-span-2">
                  <SectionHeader icon={Target} title="Score Distribution" subtitle="Individual scores per subject" />
                  <div style={{ height: 300 }}>
                    <SubjectDistributionChart stats={stats!} />
                  </div>
                </ChartCard>
              </div>
            </FadeInSection>

            {/* ══════════════════════════════════════════════════════
                ROW 8 — Activity Timeline (stacked bar)
               ══════════════════════════════════════════════════════ */}
            <FadeInSection delay={0.05}>
              <SectionHeader icon={Activity} title="Activity &amp; Engagement" subtitle="Submission activity over the past 4 weeks" />
              <ChartCard>
                <div style={{ height: 280 }}>
                  <ActivityTimelineChart stats={stats!} />
                </div>
              </ChartCard>
            </FadeInSection>

            {/* ══════════════════════════════════════════════════════
                ROW 8 — Recent Assessments
               ══════════════════════════════════════════════════════ */}
            <FadeInSection delay={0.05}>
              <div className={GP}>
                <div className="px-5 pt-4 pb-3 flex items-center justify-between border-b border-white/[0.06] relative overflow-hidden">
                  <div className="absolute inset-0 bg-gradient-to-r from-emerald-500/[0.06] to-transparent pointer-events-none" />
                  <div className="flex items-center gap-2.5 relative">
                    <div className="w-7 h-7 rounded-lg flex items-center justify-center bg-emerald-500/15 border border-emerald-500/20">
                      <BookOpen className="w-3.5 h-3.5 text-emerald-400" />
                    </div>
                    <h3 className="text-[13px] font-bold text-slate-100 tracking-wide" style={{ letterSpacing: "0.3px" }}>Recent Assessments</h3>
                  </div>
                  <Link href="/tutor/assessments">
                    <span className="relative text-[10px] text-violet-400 hover:text-violet-300 cursor-pointer font-semibold" data-testid="link-view-all-assessments">View All &rarr;</span>
                  </Link>
                </div>
                {quizzesLoading ? (
                  <div className="px-5 py-8 flex justify-center">
                    <Loader2 className="w-4 h-4 text-violet-500 animate-spin" />
                  </div>
                ) : tutorQuizzes.length === 0 && (stats?.totalQuizzes ?? 0) === 0 ? (
                  <div className="px-5 py-8 text-center">
                    <BookOpen className="w-7 h-7 mx-auto text-slate-700 mb-2" />
                    <p className="text-[11px] text-slate-600 font-medium">No assessments yet</p>
                    <Link href="/tutor/assessments/new">
                      <span className="text-[10px] text-violet-400 hover:text-violet-300 cursor-pointer font-medium mt-1 inline-block">Create your first assessment</span>
                    </Link>
                  </div>
                ) : tutorQuizzes.length === 0 ? (
                  <div className="px-5 py-5 text-center">
                    <p className="text-[11px] text-slate-400 font-medium">{stats?.totalQuizzes ?? 0} assessments in system</p>
                    <Link href="/tutor/assessments">
                      <span className="text-[10px] text-violet-400 hover:text-violet-300 cursor-pointer font-medium mt-1 inline-block">View all assessments &rarr;</span>
                    </Link>
                  </div>
                ) : (
                  <div className="divide-y divide-white/[0.03] max-h-[280px] overflow-y-auto">
                    {tutorQuizzes.slice(0, 8).map((quiz) => {
                      const sc = getSubjectColor(quiz.subject);
                      const SubIcon = getSubjectIcon(quiz.subject);
                      return (
                        <div key={quiz.id} className="px-5 py-2.5 flex items-center gap-3 hover:bg-white/[0.02] transition-colors group" data-testid={`quiz-tile-${quiz.id}`}>
                          <div className="w-6 h-6 rounded-md flex items-center justify-center border shrink-0" style={{ backgroundColor: `${sc.hex}08`, borderColor: `${sc.hex}18` }}>
                            <SubIcon className="w-3 h-3" style={{ color: sc.hex }} />
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-[11px] font-medium text-slate-200 truncate" data-testid={`quiz-title-${quiz.id}`}>{quiz.title}</p>
                            <p className="text-[10px] text-slate-600">{quiz.subject || "General"}</p>
                          </div>
                          <button
                            onClick={() => { setShowAssignModal(quiz.id); setSelectedStudentIds(new Set()); setDueDate(""); }}
                            className="text-[10px] font-bold text-indigo-400 opacity-0 group-hover:opacity-100 transition-opacity"
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
            </FadeInSection>

            </>)}
          </div>
        )}
      </main>

      {/* ── ASSIGN MODAL ──────────────────────────────────────── */}
      {showAssignModal !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-lg p-4" onClick={() => setShowAssignModal(null)}>
          <div className={`${GP} max-w-lg w-full max-h-[80vh] overflow-y-auto p-6`} onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between gap-3 mb-5">
              <h3 className="text-base font-bold text-slate-100">Assign Assessment</h3>
              <button onClick={() => setShowAssignModal(null)} className="text-slate-500 hover:text-slate-300 p-1.5 rounded-lg hover:bg-white/[0.04] transition-colors" data-testid="button-close-assign-modal">
                <X className="w-4 h-4" />
              </button>
            </div>
            <p className="text-[11px] text-slate-500 mb-4 font-medium">Select students:</p>
            {adoptedStudents.length === 0 ? (
              <p className="text-sm text-slate-400 text-center py-8">No students yet. Go to the Students tab to add students first.</p>
            ) : (
              <>
                <div className="space-y-1.5 max-h-[50vh] overflow-y-auto">
                  {adoptedStudents.map((student) => {
                    const nameOnly = (student.displayName || "").trim();
                    const studentLabel = nameOnly || "Student";
                    const si = studentLabel.split(" ").map((n: string) => n[0]).filter(Boolean).join("").toUpperCase().slice(0, 2);
                    return (
                      <button
                        key={student.id}
                        onClick={() => toggleStudentSelection(student.id)}
                        className={`w-full min-h-[44px] flex items-center gap-3 px-4 py-2.5 rounded-xl transition-all text-left ${
                          selectedStudentIds.has(student.id)
                            ? "bg-indigo-500/12 border border-indigo-500/25"
                            : "bg-white/[0.02] border border-white/[0.05] hover:bg-white/[0.04]"
                        }`}
                        data-testid={`assign-student-${student.id}`}
                      >
                        <div className={`w-5 h-5 rounded-md border flex items-center justify-center transition-colors ${
                          selectedStudentIds.has(student.id) ? "bg-indigo-500 border-indigo-500" : "border-slate-600"
                        }`}>
                          {selectedStudentIds.has(student.id) && <Check className="w-3 h-3 text-white" />}
                        </div>
                        <div className="w-7 h-7 rounded-lg flex items-center justify-center text-[9px] font-bold text-slate-300 bg-white/[0.04] border border-white/[0.06] shrink-0">
                          {si}
                        </div>
                        <p className="text-[13px] font-medium text-slate-200">{studentLabel}</p>
                      </button>
                    );
                  })}
                </div>
                <div className="mt-4 p-3 rounded-xl bg-white/[0.02] border border-white/[0.05]">
                  <label className="flex items-center gap-2 text-[11px] font-semibold text-slate-400 mb-2">
                    <CalendarDays className="w-3.5 h-3.5 text-violet-400" />
                    Due Date <span className="text-slate-600">(optional)</span>
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
                  className="w-full mt-4 py-3 min-h-[44px] rounded-xl text-sm font-semibold bg-gradient-to-r from-indigo-600 to-violet-600 text-white hover:shadow-[0_0_20px_rgba(99,102,241,0.3)] disabled:opacity-50 disabled:cursor-not-allowed transition-all"
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

interface PlaqueStudent {
  studentId: string;
  studentName: string;
  assigned: number;
  completed: number;
  awaiting: number;
  trend: "improving" | "declining" | "stable";
  weakTopics: string[];
  chip: { text: string; color: string; dot: string };
  completionPct: number;
  recentScores: number[];
  lastScore: number | null;
  coveragePct: number;
  lowestCoverage: string[];
  lastActivity: string | null;
  lastSubmission: { reportId: number; quizTitle: string; score: number } | null;
}

function StudentPlaque({ student: s, insightChip, index = 0 }: { student: PlaqueStudent; insightChip: string | null; index?: number }) {
  const [flipped, setFlipped] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);

  const handleToggle = useCallback(() => setFlipped((p) => !p), []);
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setFlipped((p) => !p); }
  }, []);

  const si = s.studentName.split(" ").map((n: string) => n[0]).filter(Boolean).join("").toUpperCase().slice(0, 2);
  const TrendIcon = s.trend === "declining" ? TrendingDown : s.trend === "improving" ? TrendingUpIcon : Minus;
  const trendColor = s.trend === "declining" ? "text-red-400" : s.trend === "improving" ? "text-emerald-400" : "text-slate-500";
  const avatarGradient = AVATAR_GRADIENTS[index % AVATAR_GRADIENTS.length];

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
      <div className="plaque-inner" style={{ minHeight: "256px" }}>
        {/* ── FRONT ─────────────────────────────────────────── */}
        <div className={`plaque-front ${GP} p-5 h-full flex flex-col`}>
          {/* Identity row */}
          <div className="flex items-start gap-3 mb-4">
            <div
              className="w-11 h-11 rounded-xl flex items-center justify-center text-[11px] font-bold text-white shrink-0 relative"
              style={{ background: avatarGradient, boxShadow: "0 4px 14px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.15)", border: "1px solid rgba(255,255,255,0.15)" }}
            >
              {si}
              <span className={`absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-slate-900 ${s.chip.dot}`} />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-[13px] font-semibold text-slate-100 truncate leading-tight">{s.studentName}</p>
              <div className="flex items-center gap-2 mt-1">
                <Badge className={`text-[8px] font-bold border px-1.5 py-0 leading-[18px] ${s.chip.color}`}>{s.chip.text}</Badge>
                <TrendIcon className={`w-3.5 h-3.5 ${trendColor}`} />
              </div>
            </div>
          </div>

          {/* Metrics */}
          {s.assigned === 0 && s.completed === 0 ? (
            /* Empty state for students with no work */
            <div className="flex-1 flex flex-col items-center justify-center text-center py-3">
              <div className="w-9 h-9 rounded-xl flex items-center justify-center bg-slate-800/40 border border-white/[0.05] mb-2.5">
                <BookOpen className="w-4 h-4 text-slate-600" />
              </div>
              <p className="text-[11px] text-slate-500 font-medium mb-1">No assignments yet</p>
              <Link href="/tutor/assessments">
                <span className="text-[10px] text-violet-400 hover:text-violet-300 font-semibold cursor-pointer transition-colors">
                  Assign work &rarr;
                </span>
              </Link>
            </div>
          ) : (
            <div className="space-y-3.5 flex-1">
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-[9px] text-slate-500 font-bold uppercase tracking-[0.08em]">Workload</span>
                </div>
                <WorkloadBar assigned={s.assigned} completed={s.completed} awaiting={s.awaiting} />
              </div>

              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-[9px] text-slate-500 font-bold uppercase tracking-[0.08em]">Completion</span>
                  <span className={`text-[10px] font-bold tabular-nums ${s.coveragePct >= 75 ? "glow-green" : s.coveragePct >= 50 ? "glow-amber" : "text-cyan-400"}`}>{s.coveragePct}%</span>
                </div>
                <div className="h-[6px] rounded-full bg-slate-800/50 overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all duration-700 progress-shimmer"
                    style={{
                      width: `${s.coveragePct}%`,
                      background: s.coveragePct >= 60
                        ? "linear-gradient(90deg, #4f46e5, #8b5cf6, #4f46e5)"
                        : s.coveragePct >= 30
                          ? "linear-gradient(90deg, #d97706, #fbbf24, #d97706)"
                          : "linear-gradient(90deg, #64748b, #94a3b8, #64748b)",
                    }}
                  />
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[9px] text-slate-500 font-bold uppercase tracking-[0.08em]">Performance</span>
                  {s.lastScore !== null && (
                    <span className={`text-[11px] font-bold tabular-nums ${s.lastScore >= 75 ? "glow-green" : s.lastScore >= 50 ? "glow-amber" : "glow-red"}`}>{s.lastScore}%</span>
                  )}
                </div>
                <MiniSparkline scores={s.recentScores} />
              </div>
            </div>
          )}
        </div>

        {/* ── BACK ──────────────────────────────────────────── */}
        <div className={`plaque-back ${GP} p-5 h-full flex flex-col overflow-y-auto`}>
          <p className="text-[10px] font-bold text-slate-500 uppercase tracking-[0.1em] mb-3">{s.studentName}</p>

          {/* Weak subjects with micro bars */}
          {s.weakTopics.length > 0 && (
            <div className="mb-3">
              <p className="text-[8px] text-slate-600 font-bold uppercase tracking-[0.1em] mb-2">Weak Subjects</p>
              <div className="space-y-1.5">
                {s.weakTopics.slice(0, 3).map((t, i) => (
                  <div key={t} className="flex items-center gap-2">
                    <span className="text-[9px] text-slate-600 font-bold w-3 shrink-0">{i + 1}</span>
                    <span className="text-[10px] text-slate-300 font-medium truncate flex-1">{t}</span>
                    <div className="w-14 h-[4px] rounded-full bg-slate-800/60 overflow-hidden shrink-0">
                      <div className="h-full rounded-full" style={{ width: `${Math.max(20, 80 - i * 20)}%`, background: "linear-gradient(90deg, #f43f5e, #fb7185)" }} />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Coverage gaps */}
          {s.lowestCoverage.length > 0 && s.weakTopics.length === 0 && (
            <div className="mb-3">
              <p className="text-[8px] text-slate-600 font-bold uppercase tracking-[0.1em] mb-1.5">Gaps</p>
              <p className="text-[10px] text-slate-400 leading-relaxed">{s.lowestCoverage.join(", ")}</p>
            </div>
          )}

          {/* Insight chip */}
          {insightChip && (
            <div className="mb-3 px-2.5 py-2 rounded-lg bg-indigo-500/[0.06] border border-indigo-500/10">
              <p className="text-[10px] text-indigo-300/90 leading-relaxed">{insightChip}</p>
            </div>
          )}

          {/* Timestamps */}
          <div className="text-[10px] text-slate-500 space-y-1 mb-3">
            {s.lastActivity && (
              <p className="flex items-center gap-1.5"><Clock className="w-3 h-3 text-slate-600 shrink-0" /> {formatDistanceToNow(new Date(s.lastActivity), { addSuffix: true })}</p>
            )}
            {s.lastSubmission && (
              <p className="flex items-center gap-1.5"><FileText className="w-3 h-3 text-slate-600 shrink-0" /> {s.lastSubmission.score}% &middot; {s.lastSubmission.quizTitle}</p>
            )}
          </div>

          {/* Action buttons */}
          <div className="mt-auto flex flex-wrap gap-1.5 pt-1">
            <Link href={`/tutor/students/${s.studentId}`}>
              <span className="flex items-center gap-1 px-2.5 py-1.5 min-h-[28px] rounded-lg text-[10px] font-semibold text-indigo-300 bg-indigo-500/10 border border-indigo-500/15 hover:bg-indigo-500/20 transition-all cursor-pointer" data-testid={`link-profile-${s.studentId}`}>
                <Eye className="w-3 h-3" /> Profile
              </span>
            </Link>
            <Link href="/tutor/assessments">
              <span className="flex items-center gap-1 px-2.5 py-1.5 min-h-[28px] rounded-lg text-[10px] font-semibold text-slate-400 bg-white/[0.03] border border-white/[0.06] hover:bg-white/[0.06] transition-all cursor-pointer">
                <Send className="w-3 h-3" /> Assign
              </span>
            </Link>
            {s.lastSubmission && (
              <Link href={`/soma/review/${s.lastSubmission.reportId}`}>
                <span className="flex items-center gap-1 px-2.5 py-1.5 min-h-[28px] rounded-lg text-[10px] font-semibold text-slate-400 bg-white/[0.03] border border-white/[0.06] hover:bg-white/[0.06] transition-all cursor-pointer">
                  <ExternalLink className="w-3 h-3" /> Review
                </span>
              </Link>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
