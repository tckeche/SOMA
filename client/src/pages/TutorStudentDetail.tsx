import { useState, useMemo, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useParams, Link } from "wouter";
import { authFetch } from "@/lib/supabase";
import { useSupabaseSession } from "@/hooks/use-supabase-session";
import { getSubjectColor, getSubjectIcon } from "@/lib/subjectColors";
import { format, formatDistanceToNow } from "date-fns";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import type { LucideIcon } from "lucide-react";
import {
  ArrowLeft, MessageSquare, Send, Loader2, BookOpen,
  Trash2, Eye, FileText, Award, Target, CheckCircle2,
  TrendingDown, TrendingUp, Minus, Clock, ChevronRight,
  BarChart3, Layers, AlertTriangle, Activity,
  ArrowRight, Calendar,
} from "lucide-react";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel,
  AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";

const GP = "glass-panel-elite";

function toProperCase(str: string): string {
  return str.replace(/\b\w/g, (c) => c.toUpperCase());
}

interface AssignmentRow {
  assignmentId: number;
  quizId: number;
  quizTitle: string;
  quizSubject: string | null;
  quizLevel: string | null;
  assignmentStatus: string;
  dueDate: string | null;
  assignedAt: string;
  reportId: number | null;
  reportStatus: string | null;
  score: number | null;
  maxScore: number;
  startedAt: string | null;
  completedAt: string | null;
}

interface StudentReport {
  student: { id: string; email: string; displayName: string | null };
  assignments: AssignmentRow[];
  stats: {
    totalAssigned: number;
    totalCompleted: number;
    avgScore: number | null;
    accuracy: number | null;
  };
}

interface TutorComment {
  id: number;
  comment: string;
  createdAt: string;
}

interface AISummary {
  narrative: string;
  weaknesses: string;
  improvements: string;
  focusAreas: string[];
  nextSteps: string;
}

function getStatusLabel(a: AssignmentRow): { text: string; color: string } {
  if (a.reportStatus === "completed") return { text: "Submitted", color: "bg-emerald-500/10 text-emerald-400 border-emerald-500/15" };
  if (a.reportStatus === "pending") return { text: "Grading", color: "bg-amber-500/10 text-amber-400 border-amber-500/15" };
  if (a.reportStatus === "failed") return { text: "Failed", color: "bg-red-500/10 text-red-400 border-red-500/15" };
  if (a.assignmentStatus === "completed") return { text: "Done", color: "bg-emerald-500/10 text-emerald-400 border-emerald-500/15" };
  return { text: "Pending", color: "bg-slate-500/10 text-slate-400 border-slate-500/15" };
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

function formatPercent(value: number | null | undefined) {
  if (typeof value !== "number" || Number.isNaN(value)) return null;
  return `${Math.round(value)}%`;
}

export default function TutorStudentDetail() {
  const params = useParams<{ id: string }>();
  const studentId = params.id || "";
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [newComment, setNewComment] = useState("");
  const [revokeQuizId, setRevokeQuizId] = useState<number | null>(null);
  const [showSummary, setShowSummary] = useState(false);

  const { userId } = useSupabaseSession();

  const { data: report, isLoading: reportLoading, isError: reportError } = useQuery<StudentReport>({
    queryKey: ["/api/tutor/students", studentId, "report", userId],
    queryFn: async () => {
      const res = await authFetch(`/api/tutor/students/${studentId}/report`);
      if (!res.ok) throw new Error("Failed to load");
      return res.json();
    },
    enabled: !!userId && !!studentId,
  });

  const { data: comments = [], isLoading: commentsLoading } = useQuery<TutorComment[]>({
    queryKey: ["/api/tutor/students", studentId, "comments"],
    queryFn: async () => {
      const res = await authFetch(`/api/tutor/students/${studentId}/comments`);
      if (!res.ok) return [];
      return res.json();
    },
    enabled: !!userId && !!studentId,
  });

  const addCommentMutation = useMutation({
    mutationFn: async (comment: string) => {
      const res = await authFetch(`/api/tutor/students/${studentId}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ comment }),
      });
      if (!res.ok) throw new Error("Failed to add comment");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/tutor/students", studentId, "comments"] });
      setNewComment("");
      toast({ title: "Note saved" });
    },
    onError: () => { toast({ title: "Failed to save note", variant: "destructive" }); },
  });

  const revokeMutation = useMutation({
    mutationFn: async (quizId: number) => {
      const res = await authFetch(`/api/tutor/quizzes/${quizId}/unassign/${studentId}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to revoke");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/tutor/students", studentId, "report"] });
      setRevokeQuizId(null);
      toast({ title: "Assignment revoked" });
    },
    onError: () => { toast({ title: "Failed to revoke assignment", variant: "destructive" }); },
  });

  const student = report?.student;
  const stats = report?.stats;
  const assignments = report?.assignments || [];
  const displayName = toProperCase(student?.displayName || student?.email?.split("@")[0] || "Student");
  const initials = displayName.split(" ").map((n: string) => n[0]).filter(Boolean).join("").toUpperCase().slice(0, 2);

  const topicPerformance = useMemo(() => {
    const map: Record<string, { score: number; max: number; count: number; scores: number[]; lastDate: string | null }> = {};
    for (const a of assignments) {
      const key = (a.quizSubject || "General").trim();
      if (!map[key]) map[key] = { score: 0, max: 0, count: 0, scores: [], lastDate: null };
      if (typeof a.score === "number" && a.maxScore > 0) {
        const pct = Math.round((a.score / a.maxScore) * 100);
        map[key].score += a.score;
        map[key].max += a.maxScore;
        map[key].count += 1;
        map[key].scores.push(pct);
        const dateStr = a.completedAt || a.assignedAt;
        if (!map[key].lastDate || dateStr > map[key].lastDate!) map[key].lastDate = dateStr;
      }
    }
    return Object.entries(map).map(([topic, v]) => {
      const avg = v.max > 0 ? Math.round((v.score / v.max) * 100) : 0;
      let trend: "improving" | "declining" | "stable" = "stable";
      if (v.scores.length >= 2) {
        const recent = v.scores.slice(-Math.ceil(v.scores.length / 2));
        const earlier = v.scores.slice(0, Math.floor(v.scores.length / 2));
        const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
        const earlierAvg = earlier.length > 0 ? earlier.reduce((a, b) => a + b, 0) / earlier.length : recentAvg;
        if (recentAvg - earlierAvg > 5) trend = "improving";
        else if (earlierAvg - recentAvg > 5) trend = "declining";
      }
      const evidence = v.count >= 5 ? "Strong" : v.count >= 3 ? "Moderate" : "Low";
      return { topic, average: avg, assessmentCount: v.count, trend, evidence, lastAssessed: v.lastDate };
    }).sort((a, b) => a.average - b.average);
  }, [assignments]);

  const coverageData = useMemo(() => {
    return topicPerformance.map((t) => ({
      topic: t.topic,
      coveragePct: Math.min(100, t.assessmentCount * 20),
      questionsAttempted: t.assessmentCount * 5,
      assessments: t.assessmentCount,
      lastAssessed: t.lastAssessed,
      performance: t.average,
      evidence: t.evidence,
    }));
  }, [topicPerformance]);

  const completionRate = stats && stats.totalAssigned > 0
    ? Math.round((stats.totalCompleted / stats.totalAssigned) * 100) : null;

  const overallTrend = useMemo(() => {
    const graded = assignments.filter((a) => a.score !== null && a.maxScore > 0);
    if (graded.length < 2) return "stable" as const;
    const half = Math.floor(graded.length / 2);
    const recent = graded.slice(-half).map((a) => (a.score! / a.maxScore) * 100);
    const earlier = graded.slice(0, half).map((a) => (a.score! / a.maxScore) * 100);
    const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
    const earlierAvg = earlier.reduce((a, b) => a + b, 0) / earlier.length;
    if (recentAvg - earlierAvg > 5) return "improving" as const;
    if (earlierAvg - recentAvg > 5) return "declining" as const;
    return "stable" as const;
  }, [assignments]);

  const { data: aiSummaryData, isLoading: aiLoading } = useQuery<{ summary: AISummary | null }>({
    queryKey: ["/api/tutor/ai/student-summary", studentId],
    queryFn: async () => {
      const res = await authFetch("/api/tutor/ai/student-summary", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          studentName: displayName,
          stats,
          topicPerformance,
          assignments,
        }),
      });
      if (!res.ok) return { summary: null };
      return res.json();
    },
    enabled: showSummary && !!userId && !!studentId && !reportLoading,
    staleTime: 120000,
    refetchOnWindowFocus: false,
  });

  const lastActivity = useMemo(() => {
    const dates = assignments
      .map((a) => a.completedAt || a.assignedAt)
      .filter(Boolean)
      .sort((a, b) => new Date(b).getTime() - new Date(a).getTime());
    return dates[0] || null;
  }, [assignments]);

  const TrendIcon = overallTrend === "declining" ? TrendingDown : overallTrend === "improving" ? TrendingUp : Minus;
  const trendColor = overallTrend === "declining" ? "text-red-400" : overallTrend === "improving" ? "text-emerald-400" : "text-slate-500";
  const trendBg = overallTrend === "declining" ? "bg-red-500/8" : overallTrend === "improving" ? "bg-emerald-500/8" : "bg-slate-500/8";

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-30 border-b border-white/[0.06] backdrop-blur-2xl" style={{ background: "linear-gradient(180deg, rgba(8,13,26,0.92) 0%, rgba(8,13,26,0.85) 100%)" }}>
        <div className="max-w-[1440px] mx-auto px-6 lg:px-10 py-3.5 flex items-center justify-between">
          <Link href="/tutor/students">
            <span className="flex items-center gap-2 text-[13px] text-slate-500 hover:text-violet-400 transition-colors cursor-pointer font-medium" data-testid="link-back-students">
              <ArrowLeft className="w-3.5 h-3.5" />
              Students
            </span>
          </Link>
          <div className="flex items-center gap-3">
            <Link href="/tutor">
              <span className="text-[12px] text-slate-600 hover:text-slate-400 transition-colors cursor-pointer font-medium">Dashboard</span>
            </Link>
            <span className="text-slate-700">/</span>
            <span className="text-[12px] text-slate-400 font-medium truncate max-w-[200px]">{displayName}</span>
          </div>
        </div>
      </header>

      <main className="max-w-[1440px] mx-auto px-6 lg:px-10 py-7 space-y-6">
        {reportError ? (
          <div className="flex flex-col items-center justify-center py-32 gap-4" data-testid="profile-error">
            <AlertTriangle className="w-10 h-10 text-amber-400/70" />
            <p className="text-sm text-slate-400 font-medium">Unable to load student data</p>
            <p className="text-xs text-slate-600">Check your connection and try refreshing</p>
          </div>
        ) : reportLoading ? (
          <div className="space-y-5 animate-in fade-in duration-300">
            <div className={`${GP} p-6`}>
              <div className="flex items-center gap-4">
                <div className="w-14 h-14 rounded-2xl bg-white/[0.04] shimmer-pulse" />
                <div className="flex-1"><div className="h-5 w-40 rounded bg-white/[0.04] shimmer-pulse" /><div className="h-3 w-24 rounded bg-white/[0.03] mt-2 shimmer-pulse" /></div>
              </div>
              <div className="grid grid-cols-4 gap-3 mt-5">
                {[1,2,3,4].map((i) => <div key={i} className="h-16 rounded-xl bg-white/[0.03] shimmer-pulse" />)}
              </div>
            </div>
            <div className={`${GP} p-6`}><div className="h-40 rounded-xl bg-white/[0.02] shimmer-pulse" /></div>
          </div>
        ) : (
          <div className="space-y-7 animate-in fade-in duration-500">

            {/* ── HEADER PANEL ──────────────────────────────────── */}
            <div className={GP}>
              <div className="p-6 flex flex-col sm:flex-row sm:items-center gap-5">
                <div className="flex items-center gap-4 flex-1">
                  <div
                    className="w-14 h-14 rounded-2xl flex items-center justify-center text-lg font-bold text-white/90 shrink-0"
                    style={{ background: "linear-gradient(145deg, rgba(99,102,241,0.25), rgba(139,92,246,0.15))", boxShadow: "0 4px 24px rgba(99,102,241,0.2), inset 0 1px 0 rgba(255,255,255,0.08)", border: "1.5px solid rgba(99,102,241,0.25)" }}
                  >
                    {initials}
                  </div>
                  <div>
                    <h2 className="text-xl font-bold text-slate-100 tracking-tight" data-testid="text-student-name">{displayName}</h2>
                    <div className="flex items-center gap-3 mt-1.5 flex-wrap">
                      <div className={`flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-semibold ${trendBg} ${trendColor}`}>
                        <TrendIcon className="w-3 h-3" />
                        {overallTrend}
                      </div>
                      {lastActivity && (
                        <span className="text-[11px] text-slate-500 font-medium flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          Last active {formatDistanceToNow(new Date(lastActivity), { addSuffix: true })}
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4">
                  <HeaderStat label="Avg Score" value={formatPercent(stats?.avgScore)} color="text-violet-400" icon={<Award className="w-3.5 h-3.5 text-violet-500/50" />} />
                  <HeaderStat label="Reliability" value={completionRate !== null ? `${completionRate}%` : null} color="text-emerald-400" icon={<Target className="w-3.5 h-3.5 text-emerald-500/50" />} />
                  <HeaderStat label="Assessed" value={stats ? `${stats.totalCompleted}/${stats.totalAssigned}` : null} color="text-cyan-400" icon={<BookOpen className="w-3.5 h-3.5 text-cyan-500/50" />} />
                  <HeaderStat label="Trend" value={overallTrend} color={trendColor} icon={<TrendIcon className="w-3.5 h-3.5 opacity-50" />} />
                </div>
              </div>
            </div>

            {/* ── SUBJECT PERFORMANCE ────────────────────────────── */}
            <div className={GP}>
              <div className="px-6 pt-5 pb-3 flex items-center justify-between border-b border-white/[0.04]">
                <div className="flex items-center gap-2.5">
                  <div className="w-7 h-7 rounded-lg flex items-center justify-center bg-blue-500/10 border border-blue-500/12">
                    <BarChart3 className="w-3.5 h-3.5 text-blue-400" />
                  </div>
                  <div>
                    <h3 className="text-[13px] font-semibold text-slate-100">Subject Performance</h3>
                    <p className="text-[10px] text-slate-600 font-medium">Performance by subject &middot; trend &middot; evidence</p>
                  </div>
                </div>
              </div>

              {topicPerformance.length === 0 ? (
                <div className="px-6 py-14 text-center">
                  <BarChart3 className="w-10 h-10 mx-auto text-slate-700 mb-3" />
                  <p className="text-sm text-slate-400 font-medium">No completed assessments yet</p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[640px]">
                    <thead>
                      <tr className="border-b border-white/[0.04]">
                        <th className="text-left text-[10px] font-bold text-slate-500 uppercase tracking-wider px-6 py-3">Subject</th>
                        <th className="text-left text-[10px] font-bold text-slate-500 uppercase tracking-wider px-3 py-3 w-44">Score</th>
                        <th className="text-center text-[10px] font-bold text-slate-500 uppercase tracking-wider px-3 py-3 w-16">Attempts</th>
                        <th className="text-center text-[10px] font-bold text-slate-500 uppercase tracking-wider px-3 py-3 w-16">Trend</th>
                        <th className="text-center text-[10px] font-bold text-slate-500 uppercase tracking-wider px-3 py-3 w-20">Evidence</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/[0.025]">
                      {topicPerformance.map((t) => {
                        const barGradient = t.average >= 70 ? "linear-gradient(90deg, #10b981, #34d399)" : t.average >= 50 ? "linear-gradient(90deg, #f59e0b, #fbbf24)" : "linear-gradient(90deg, #ef4444, #f87171)";
                        const scoreColor = t.average >= 70 ? "text-emerald-400" : t.average >= 50 ? "text-amber-400" : "text-red-400";
                        const TIcon = t.trend === "declining" ? TrendingDown : t.trend === "improving" ? TrendingUp : Minus;
                        const tc = t.trend === "declining" ? "text-red-400" : t.trend === "improving" ? "text-emerald-400" : "text-slate-600";
                        const evColor = t.evidence === "Strong" ? "text-emerald-400 bg-emerald-500/8 border-emerald-500/10" : t.evidence === "Moderate" ? "text-amber-400 bg-amber-500/8 border-amber-500/10" : "text-slate-400 bg-slate-500/8 border-slate-500/10";
                        return (
                          <tr key={t.topic} className="hover:bg-white/[0.01] transition-colors">
                            <td className="px-6 py-3.5">
                              <span className="text-[13px] font-medium text-slate-200">{t.topic}</span>
                            </td>
                            <td className="px-3 py-3.5">
                              <div className="flex items-center gap-3">
                                <div className="flex-1 h-2 rounded-full bg-slate-800/60 overflow-hidden">
                                  <div className="h-full rounded-full transition-all duration-700" style={{ width: `${t.average}%`, background: barGradient }} />
                                </div>
                                <span className={`text-xs font-bold tabular-nums w-9 text-right ${scoreColor}`}>{t.average}%</span>
                              </div>
                            </td>
                            <td className="text-center text-[13px] tabular-nums text-slate-400 font-medium px-3 py-3.5">{t.assessmentCount}</td>
                            <td className="text-center px-3 py-3.5">
                              <TIcon className={`w-4 h-4 mx-auto ${tc}`} />
                            </td>
                            <td className="text-center px-3 py-3.5">
                              <Badge className={`text-[9px] font-bold border ${evColor}`}>{t.evidence}</Badge>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* ── COVERAGE + NOTES ──────────────────────────────── */}
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
              <div className="lg:col-span-7">
                <div className={GP}>
                  <div className="px-6 pt-5 pb-3 border-b border-white/[0.04]">
                    <div className="flex items-center gap-2.5">
                      <div className="w-7 h-7 rounded-lg flex items-center justify-center bg-cyan-500/10 border border-cyan-500/12">
                        <Layers className="w-3.5 h-3.5 text-cyan-400" />
                      </div>
                      <div>
                        <h3 className="text-[13px] font-semibold text-slate-100">Coverage Matrix</h3>
                        <p className="text-[10px] text-slate-600 font-medium">Subject depth &middot; assessments &middot; performance</p>
                      </div>
                    </div>
                  </div>

                  {coverageData.length === 0 ? (
                    <div className="px-6 py-14 text-center">
                      <Layers className="w-10 h-10 mx-auto text-slate-700 mb-3" />
                      <p className="text-sm text-slate-400 font-medium">No coverage data yet</p>
                    </div>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full min-w-[550px]">
                        <thead>
                          <tr className="border-b border-white/[0.04]">
                            <th className="text-left text-[10px] font-bold text-slate-500 uppercase tracking-wider px-6 py-3">Subject</th>
                            <th className="text-left text-[10px] font-bold text-slate-500 uppercase tracking-wider px-3 py-3 w-32">Coverage</th>
                            <th className="text-center text-[10px] font-bold text-slate-500 uppercase tracking-wider px-3 py-3 w-20">Assess.</th>
                            <th className="text-center text-[10px] font-bold text-slate-500 uppercase tracking-wider px-3 py-3 w-16">Perf.</th>
                            <th className="text-right text-[10px] font-bold text-slate-500 uppercase tracking-wider px-6 py-3 w-24">Last Seen</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-white/[0.025]">
                          {coverageData.map((c) => {
                            const barColor = c.coveragePct >= 60 ? "linear-gradient(90deg, #06b6d4, #22d3ee)" : c.coveragePct >= 30 ? "linear-gradient(90deg, #f59e0b, #fbbf24)" : "linear-gradient(90deg, #94a3b8, #cbd5e1)";
                            const perfColor = c.performance >= 70 ? "text-emerald-400" : c.performance >= 50 ? "text-amber-400" : "text-red-400";
                            return (
                              <tr key={c.topic} className="hover:bg-white/[0.01] transition-colors">
                                <td className="px-6 py-3">
                                  <span className="text-[12px] font-medium text-slate-300">{c.topic}</span>
                                </td>
                                <td className="px-3 py-3">
                                  <div className="flex items-center gap-2">
                                    <div className="flex-1 h-[5px] rounded-full bg-slate-800/60 overflow-hidden">
                                      <div className="h-full rounded-full" style={{ width: `${c.coveragePct}%`, background: barColor }} />
                                    </div>
                                    <span className="text-[10px] text-cyan-400 font-bold tabular-nums w-7 text-right">{c.coveragePct}%</span>
                                  </div>
                                </td>
                                <td className="text-center text-[12px] tabular-nums text-slate-400 font-medium px-3 py-3">{c.assessments}</td>
                                <td className="text-center px-3 py-3">
                                  <span className={`text-[12px] font-bold tabular-nums ${perfColor}`}>{c.performance}%</span>
                                </td>
                                <td className="text-right text-[10px] text-slate-500 font-medium px-6 py-3">
                                  {c.lastAssessed ? format(new Date(c.lastAssessed), "MMM d") : "—"}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </div>

              <div className="lg:col-span-5 space-y-5">
                {/* Private Notes */}
                <div className={GP}>
                  <div className="px-6 pt-5 pb-3 border-b border-white/[0.04]">
                    <div className="flex items-center gap-2.5">
                      <div className="w-7 h-7 rounded-lg flex items-center justify-center bg-violet-500/10 border border-violet-500/12">
                        <MessageSquare className="w-3.5 h-3.5 text-violet-400" />
                      </div>
                      <h3 className="text-[13px] font-semibold text-slate-100">Private Notes</h3>
                    </div>
                  </div>
                  <div className="px-6 py-4">
                    <div className="space-y-2 max-h-[250px] overflow-y-auto mb-4">
                      {commentsLoading ? (
                        <Loader2 className="w-5 h-5 text-violet-400 animate-spin mx-auto" />
                      ) : comments.length === 0 ? (
                        <p className="text-xs text-slate-500 text-center py-4 font-medium">No notes yet</p>
                      ) : (
                        comments.map((c) => (
                          <div key={c.id} className="bg-white/[0.02] border border-white/[0.04] rounded-lg p-3">
                            <p className="text-[13px] text-slate-300 whitespace-pre-wrap leading-relaxed">{c.comment}</p>
                            <p className="text-[10px] text-slate-500 mt-1.5 font-medium">{format(new Date(c.createdAt), "PPp")}</p>
                          </div>
                        ))
                      )}
                    </div>
                    <div className="flex gap-2">
                      <textarea
                        value={newComment}
                        onChange={(e) => setNewComment(e.target.value)}
                        placeholder="Add a note..."
                        className="flex-1 bg-[#0c1222]/80 border border-white/[0.06] rounded-lg p-3 text-sm text-slate-200 placeholder:text-slate-600 resize-none min-h-[44px] focus:outline-none focus:border-violet-500/30 focus:ring-1 focus:ring-violet-500/15"
                        rows={2}
                        data-testid="input-note"
                      />
                      <button
                        onClick={() => { if (newComment.trim()) addCommentMutation.mutate(newComment); }}
                        disabled={!newComment.trim() || addCommentMutation.isPending}
                        className="self-end p-3 rounded-lg bg-violet-500/15 text-violet-300 border border-violet-500/20 hover:bg-violet-500/25 disabled:opacity-40 transition-all min-h-[44px] min-w-[44px]"
                        data-testid="button-save-note"
                      >
                        {addCommentMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                      </button>
                    </div>
                  </div>
                </div>

                {/* Academic Summary */}
                <div className={GP}>
                  <div className="px-6 pt-5 pb-3 border-b border-white/[0.04]">
                    <div className="flex items-center gap-2.5">
                      <div className="w-7 h-7 rounded-lg flex items-center justify-center bg-emerald-500/10 border border-emerald-500/12">
                        <FileText className="w-3.5 h-3.5 text-emerald-400" />
                      </div>
                      <h3 className="text-[13px] font-semibold text-slate-100">Academic Summary</h3>
                    </div>
                  </div>
                  <div className="px-6 py-4">
                    {!showSummary ? (
                      <button
                        onClick={() => setShowSummary(true)}
                        className="w-full py-3 min-h-[44px] rounded-xl text-sm font-semibold text-emerald-300 bg-emerald-500/10 border border-emerald-500/15 hover:bg-emerald-500/20 transition-all"
                        data-testid="button-generate-summary"
                      >
                        Generate Summary
                      </button>
                    ) : aiLoading ? (
                      <div className="py-8 text-center">
                        <Loader2 className="w-6 h-6 text-emerald-400 animate-spin mx-auto mb-2" />
                        <p className="text-xs text-slate-500 font-medium">Analysing student data...</p>
                      </div>
                    ) : aiSummaryData?.summary ? (
                      <div className="space-y-4 text-[13px] text-slate-300 leading-relaxed" data-testid="ai-summary-content">
                        <p>{aiSummaryData.summary.narrative}</p>
                        {aiSummaryData.summary.weaknesses && (
                          <div>
                            <p className="text-[10px] text-slate-500 font-bold uppercase tracking-wider mb-1">Key Weaknesses</p>
                            <p className="text-slate-400">{aiSummaryData.summary.weaknesses}</p>
                          </div>
                        )}
                        {aiSummaryData.summary.improvements && (
                          <div>
                            <p className="text-[10px] text-slate-500 font-bold uppercase tracking-wider mb-1">Recent Improvements</p>
                            <p className="text-slate-400">{aiSummaryData.summary.improvements}</p>
                          </div>
                        )}
                        {aiSummaryData.summary.focusAreas?.length > 0 && (
                          <div>
                            <p className="text-[10px] text-slate-500 font-bold uppercase tracking-wider mb-1">Focus Areas</p>
                            <ul className="list-disc list-inside text-slate-400 space-y-0.5">
                              {aiSummaryData.summary.focusAreas.map((f, i) => <li key={i}>{f}</li>)}
                            </ul>
                          </div>
                        )}
                        {aiSummaryData.summary.nextSteps && (
                          <div>
                            <p className="text-[10px] text-slate-500 font-bold uppercase tracking-wider mb-1">Recommended Next Steps</p>
                            <p className="text-slate-400">{aiSummaryData.summary.nextSteps}</p>
                          </div>
                        )}
                      </div>
                    ) : (
                      <p className="text-sm text-slate-500 text-center py-4">Unable to generate summary. Try again later.</p>
                    )}
                  </div>
                </div>
              </div>
            </div>

            {/* ── EVIDENCE HISTORY ──────────────────────────────── */}
            <div className={GP}>
              <div className="px-6 pt-5 pb-3 flex items-center justify-between border-b border-white/[0.04]">
                <div className="flex items-center gap-2.5">
                  <div className="w-7 h-7 rounded-lg flex items-center justify-center bg-indigo-500/10 border border-indigo-500/12">
                    <Activity className="w-3.5 h-3.5 text-indigo-400" />
                  </div>
                  <div>
                    <h3 className="text-[13px] font-semibold text-slate-100">Evidence History</h3>
                    <p className="text-[10px] text-slate-600 font-medium">Timeline of assessments &middot; topics &middot; scores</p>
                  </div>
                </div>
              </div>

              {assignments.length === 0 ? (
                <div className="px-6 py-14 text-center">
                  <BookOpen className="w-10 h-10 mx-auto text-slate-700 mb-3" />
                  <p className="text-sm text-slate-400 font-medium">No assignments yet</p>
                </div>
              ) : (
                <div className="divide-y divide-white/[0.03]">
                  {assignments.map((a) => {
                    const status = getStatusLabel(a);
                    const sc = getSubjectColor(a.quizSubject);
                    const SubIcon = getSubjectIcon(a.quizSubject);
                    const pct = a.score !== null && a.maxScore > 0 ? Math.round((a.score / a.maxScore) * 100) : null;
                    const duration = formatDuration(a.startedAt, a.completedAt);
                    const scoreColor = pct !== null ? (pct >= 70 ? "text-emerald-400 bg-emerald-500/10 border-emerald-500/15" : pct >= 40 ? "text-amber-400 bg-amber-500/10 border-amber-500/15" : "text-red-400 bg-red-500/10 border-red-500/15") : "";
                    return (
                      <div key={a.assignmentId} className="px-6 py-4 flex items-center gap-4 hover:bg-white/[0.01] transition-colors group" data-testid={`assignment-${a.assignmentId}`}>
                        <div className="w-9 h-9 rounded-lg flex items-center justify-center border shrink-0" style={{ backgroundColor: `${sc.hex}08`, borderColor: `${sc.hex}18` }}>
                          <SubIcon className="w-4 h-4" style={{ color: sc.hex }} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-[13px] font-medium text-slate-200 truncate">{a.quizTitle}</p>
                          <div className="flex items-center gap-3 mt-0.5 text-[10px] text-slate-500 font-medium flex-wrap">
                            {a.quizSubject && <span>{a.quizSubject}</span>}
                            <span>{format(new Date(a.assignedAt), "MMM d, yyyy")}</span>
                            {duration && <span className="text-violet-400/60">{duration}</span>}
                          </div>
                        </div>
                        <Badge className={`text-[10px] font-bold border ${status.color}`}>{status.text}</Badge>
                        {pct !== null && (
                          <Badge className={`text-xs font-bold px-2.5 py-1 border ${scoreColor}`}>{pct}%</Badge>
                        )}
                        {a.reportId ? (
                          <Link href={`/soma/review/${a.reportId}`}>
                            <span className="text-slate-600 hover:text-violet-400 transition-colors cursor-pointer">
                              <Eye className="w-4 h-4" />
                            </span>
                          </Link>
                        ) : (
                          <button
                            onClick={() => setRevokeQuizId(a.quizId)}
                            className="text-slate-700 hover:text-red-400 transition-colors opacity-0 group-hover:opacity-100"
                            aria-label="Revoke assignment"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

          </div>
        )}
      </main>

      <AlertDialog open={revokeQuizId !== null} onOpenChange={() => setRevokeQuizId(null)}>
        <AlertDialogContent className="bg-slate-900 border-white/10">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-slate-100">Revoke Assignment?</AlertDialogTitle>
            <AlertDialogDescription className="text-slate-400">
              This will remove the assignment from the student. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="bg-slate-800 text-slate-300 border-white/10 hover:bg-slate-700">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => revokeQuizId && revokeMutation.mutate(revokeQuizId)}
              className="bg-red-600 text-white hover:bg-red-500"
            >
              {revokeMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : "Revoke"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function HeaderStat({ label, value, color, icon }: { label: string; value: string | null; color: string; icon?: React.ReactNode }) {
  return (
    <div className="text-center sm:text-left p-3 rounded-xl bg-white/[0.02] border border-white/[0.04]">
      <div className="flex items-center gap-1.5 mb-1">
        {icon}
        <p className="text-[9px] text-slate-500 font-bold uppercase tracking-[0.08em]">{label}</p>
      </div>
      <p className={`text-base font-bold tabular-nums ${color}`}>{value || "—"}</p>
    </div>
  );
}
