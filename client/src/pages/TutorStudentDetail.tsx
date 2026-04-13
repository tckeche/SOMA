import { useState, useMemo, useEffect, useRef } from "react";
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
  Sparkles, BarChart3, Layers, AlertTriangle, Activity,
  ArrowRight, Calendar, Zap,
} from "lucide-react";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel,
  AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";

const GLASS = "rounded-2xl border border-white/[0.06] bg-gradient-to-b from-slate-900/95 to-[#0c1222]/95 backdrop-blur-xl shadow-[0_8px_32px_rgba(0,0,0,0.4),inset_0_1px_0_rgba(255,255,255,0.04)]";

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
  const [showAISummary, setShowAISummary] = useState(false);

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
      const confidence = v.count >= 5 ? "High" : v.count >= 3 ? "Medium" : "Low";
      return { topic, average: avg, assessmentCount: v.count, trend, confidence, lastAssessed: v.lastDate };
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
      confidence: t.confidence,
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

  const { data: aiSummaryData, isLoading: aiLoading, refetch: fetchAISummary } = useQuery<{ summary: AISummary | null }>({
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
    enabled: showAISummary && !!userId && !!studentId && !reportLoading,
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
    <div className="min-h-screen bg-[#080d1a]">
      <header className="border-b border-white/[0.04] bg-[#0a0f1e]/90 backdrop-blur-2xl sticky top-0 z-20">
        <div className="max-w-[1400px] mx-auto px-6 lg:px-8 py-4 flex items-center justify-between">
          <Link href="/tutor/students">
            <span className="flex items-center gap-2 text-sm text-slate-400 hover:text-violet-400 transition-colors cursor-pointer font-medium" data-testid="link-back-students">
              <ArrowLeft className="w-4 h-4" />
              Back to Students
            </span>
          </Link>
        </div>
      </header>

      <main className="max-w-[1400px] mx-auto px-6 lg:px-8 py-8 space-y-7">
        {reportError ? (
          <div className="flex flex-col items-center justify-center py-32 gap-4" data-testid="profile-error">
            <AlertTriangle className="w-10 h-10 text-amber-400/70" />
            <p className="text-sm text-slate-400 font-medium">Unable to load student data</p>
            <p className="text-xs text-slate-600">Check your connection and try refreshing</p>
          </div>
        ) : reportLoading ? (
          <div className="space-y-6">
            <Skeleton className="h-32 w-full bg-white/5 rounded-2xl" />
            <div className="grid grid-cols-4 gap-4">
              {[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-24 w-full bg-white/5 rounded-2xl" />)}
            </div>
          </div>
        ) : (
          <div className="space-y-7 animate-in fade-in duration-500">

            {/* ── Section A: Student Identity Header ──────────────── */}
            <div className={GLASS}>
              <div className="p-6 flex flex-col sm:flex-row sm:items-center gap-5">
                <div className="flex items-center gap-4 flex-1">
                  <div
                    className="w-16 h-16 rounded-2xl flex items-center justify-center text-xl font-bold text-white shrink-0"
                    style={{ background: "linear-gradient(135deg, rgba(16,185,129,0.25), rgba(6,182,212,0.15))", boxShadow: "0 0 30px rgba(16,185,129,0.2), inset 0 1px 0 rgba(255,255,255,0.1)", border: "1.5px solid rgba(16,185,129,0.3)" }}
                  >
                    {initials}
                  </div>
                  <div>
                    <h2 className="text-2xl font-bold text-slate-100 tracking-tight" data-testid="text-student-name">{displayName}</h2>
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

                <div className="grid grid-cols-4 gap-4 sm:gap-6">
                  <HeaderStat label="Avg Grade" value={formatPercent(stats?.avgScore)} color="text-violet-400" />
                  <HeaderStat label="Accuracy" value={formatPercent(stats?.accuracy)} color="text-cyan-400" />
                  <HeaderStat label="Completed" value={stats ? `${stats.totalCompleted}/${stats.totalAssigned}` : null} color="text-emerald-400" />
                  <HeaderStat label="Completion" value={completionRate !== null ? `${completionRate}%` : null} color="text-amber-400" />
                </div>
              </div>
            </div>

            {/* ── Section B & C: Topic Performance + Coverage ────── */}
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
              <div className="lg:col-span-7">
                <div className={GLASS}>
                  <div className="px-6 pt-5 pb-4 flex items-center justify-between border-b border-white/[0.04]">
                    <div className="flex items-center gap-2.5">
                      <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: "linear-gradient(135deg, rgba(59,130,246,0.12), rgba(99,102,241,0.06))", border: "1px solid rgba(59,130,246,0.12)" }}>
                        <BarChart3 className="w-4 h-4 text-blue-400" />
                      </div>
                      <div>
                        <h3 className="text-[14px] font-semibold text-slate-100">Topic Performance</h3>
                        <p className="text-[11px] text-slate-500 font-medium">Performance analysis by subject area</p>
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
                      <table className="w-full min-w-[600px]">
                        <thead>
                          <tr className="border-b border-white/[0.04]">
                            <th className="text-left text-[10px] font-bold text-slate-500 uppercase tracking-wider px-6 py-3">Topic</th>
                            <th className="text-left text-[10px] font-bold text-slate-500 uppercase tracking-wider px-3 py-3 w-40">Score</th>
                            <th className="text-center text-[10px] font-bold text-slate-500 uppercase tracking-wider px-3 py-3 w-20">Tests</th>
                            <th className="text-center text-[10px] font-bold text-slate-500 uppercase tracking-wider px-3 py-3 w-20">Trend</th>
                            <th className="text-center text-[10px] font-bold text-slate-500 uppercase tracking-wider px-3 py-3 w-20">Evidence</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-white/[0.025]">
                          {topicPerformance.map((t) => {
                            const barGradient = t.average >= 70 ? "linear-gradient(90deg, #10b981, #34d399)" : t.average >= 50 ? "linear-gradient(90deg, #f59e0b, #fbbf24)" : "linear-gradient(90deg, #ef4444, #f87171)";
                            const scoreColor = t.average >= 70 ? "text-emerald-400" : t.average >= 50 ? "text-amber-400" : "text-red-400";
                            const TIcon = t.trend === "declining" ? TrendingDown : t.trend === "improving" ? TrendingUp : Minus;
                            const tc = t.trend === "declining" ? "text-red-400" : t.trend === "improving" ? "text-emerald-400" : "text-slate-600";
                            const confColor = t.confidence === "High" ? "text-emerald-400 bg-emerald-500/8 border-emerald-500/10" : t.confidence === "Medium" ? "text-amber-400 bg-amber-500/8 border-amber-500/10" : "text-slate-400 bg-slate-500/8 border-slate-500/10";
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
                                  <Badge className={`text-[9px] font-bold border ${confColor}`}>{t.confidence}</Badge>
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

              <div className="lg:col-span-5 space-y-6">
                {/* Coverage Intelligence */}
                <div className={GLASS}>
                  <div className="px-6 pt-5 pb-4 border-b border-white/[0.04]">
                    <div className="flex items-center gap-2.5">
                      <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: "linear-gradient(135deg, rgba(6,182,212,0.12), rgba(59,130,246,0.06))", border: "1px solid rgba(6,182,212,0.12)" }}>
                        <Layers className="w-4 h-4 text-cyan-400" />
                      </div>
                      <div>
                        <h3 className="text-[14px] font-semibold text-slate-100">Coverage Intelligence</h3>
                        <p className="text-[11px] text-slate-500 font-medium">Syllabus topic coverage depth</p>
                      </div>
                    </div>
                  </div>

                  {coverageData.length === 0 ? (
                    <div className="px-6 py-12 text-center">
                      <Layers className="w-10 h-10 mx-auto text-slate-700 mb-3" />
                      <p className="text-sm text-slate-400 font-medium">No coverage data yet</p>
                    </div>
                  ) : (
                    <div className="px-6 py-4 space-y-3">
                      {coverageData.map((c) => {
                        const barColor = c.coveragePct >= 60 ? "linear-gradient(90deg, #06b6d4, #22d3ee)" : c.coveragePct >= 30 ? "linear-gradient(90deg, #f59e0b, #fbbf24)" : "linear-gradient(90deg, #94a3b8, #cbd5e1)";
                        return (
                          <div key={c.topic} className="group">
                            <div className="flex items-center justify-between mb-1">
                              <span className="text-[12px] text-slate-300 font-medium truncate">{c.topic}</span>
                              <span className="text-[11px] text-cyan-400 font-bold tabular-nums">{c.coveragePct}%</span>
                            </div>
                            <div className="h-2 rounded-full bg-slate-800/60 overflow-hidden mb-1">
                              <div className="h-full rounded-full transition-all duration-700" style={{ width: `${c.coveragePct}%`, background: barColor }} />
                            </div>
                            <div className="flex items-center gap-3 text-[10px] text-slate-600 font-medium">
                              <span>{c.assessments} assessment{c.assessments !== 1 ? "s" : ""}</span>
                              <span>Perf: {c.performance}%</span>
                              {c.lastAssessed && <span>Last: {format(new Date(c.lastAssessed), "MMM d")}</span>}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* Private Notes */}
                <div className={GLASS}>
                  <div className="px-6 pt-5 pb-4 border-b border-white/[0.04]">
                    <div className="flex items-center gap-2.5">
                      <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: "linear-gradient(135deg, rgba(139,92,246,0.12), rgba(99,102,241,0.06))", border: "1px solid rgba(139,92,246,0.12)" }}>
                        <MessageSquare className="w-4 h-4 text-violet-400" />
                      </div>
                      <h3 className="text-[14px] font-semibold text-slate-100">Private Notes</h3>
                    </div>
                  </div>
                  <div className="px-6 py-4">
                    <div className="space-y-2 max-h-[300px] overflow-y-auto mb-4">
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
              </div>
            </div>

            {/* ── Section D: Assessment History ──────────────────── */}
            <div className={GLASS}>
              <div className="px-6 pt-5 pb-4 flex items-center justify-between border-b border-white/[0.04]">
                <div className="flex items-center gap-2.5">
                  <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: "linear-gradient(135deg, rgba(16,185,129,0.12), rgba(5,150,105,0.06))", border: "1px solid rgba(16,185,129,0.12)" }}>
                    <FileText className="w-4 h-4 text-emerald-400" />
                  </div>
                  <div>
                    <h3 className="text-[14px] font-semibold text-slate-100">Assessment History</h3>
                    <p className="text-[11px] text-slate-500 font-medium">Evidence-based timeline of all assessments</p>
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
                        <div className="w-10 h-10 rounded-lg flex items-center justify-center border shrink-0" style={{ backgroundColor: `${sc.hex}08`, borderColor: `${sc.hex}18` }}>
                          <SubIcon className="w-4 h-4" style={{ color: sc.hex }} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-[13px] font-semibold text-slate-200 truncate">{a.quizTitle}</p>
                          <div className="flex items-center gap-3 text-[10px] text-slate-500 mt-0.5 font-medium flex-wrap">
                            {a.quizSubject && <span>{a.quizSubject}</span>}
                            {a.quizLevel && <span>&middot; {a.quizLevel}</span>}
                            <span>&middot; {format(new Date(a.assignedAt), "MMM d, yyyy")}</span>
                            {duration && <span className="text-violet-400/60">&middot; {duration}</span>}
                          </div>
                        </div>
                        <Badge className={`text-[10px] font-bold border ${status.color}`}>{status.text}</Badge>
                        {pct !== null && (
                          <Badge className={`text-xs font-bold px-2.5 py-1 border ${scoreColor}`}>{pct}%</Badge>
                        )}
                        <div className="flex items-center gap-1 shrink-0">
                          {a.reportId && a.reportStatus === "completed" && (
                            <Link href={`/soma/review/${a.reportId}`}>
                              <button className="p-2 min-h-[36px] min-w-[36px] text-slate-500 hover:text-violet-400 hover:bg-violet-500/10 rounded-lg transition-colors" title="View submission" data-testid={`button-view-report-${a.assignmentId}`}>
                                <Eye className="w-4 h-4" />
                              </button>
                            </Link>
                          )}
                          {a.assignmentStatus === "pending" && (
                            <button
                              onClick={() => setRevokeQuizId(a.quizId)}
                              className="p-2 min-h-[36px] min-w-[36px] text-red-400/40 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-colors"
                              title="Revoke assignment"
                              data-testid={`button-revoke-${a.assignmentId}`}
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* ── Section E: AI Academic Summary ─────────────────── */}
            <div className={GLASS}>
              <div className="px-6 pt-5 pb-4 flex items-center justify-between border-b border-white/[0.04]">
                <div className="flex items-center gap-2.5">
                  <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: "linear-gradient(135deg, rgba(139,92,246,0.12), rgba(168,85,247,0.06))", border: "1px solid rgba(139,92,246,0.12)" }}>
                    <Sparkles className="w-4 h-4 text-violet-400" />
                  </div>
                  <div>
                    <h3 className="text-[14px] font-semibold text-slate-100">AI Academic Summary</h3>
                    <p className="text-[11px] text-slate-500 font-medium">AI-assisted interpretation of real platform data</p>
                  </div>
                </div>
                {!showAISummary && (
                  <button
                    onClick={() => setShowAISummary(true)}
                    className="flex items-center gap-2 px-4 py-2 min-h-[36px] rounded-xl text-[12px] font-semibold text-violet-300 bg-violet-500/10 border border-violet-500/15 hover:bg-violet-500/20 transition-all"
                    data-testid="button-generate-summary"
                  >
                    <Sparkles className="w-3.5 h-3.5" />
                    Generate Summary
                  </button>
                )}
              </div>

              {!showAISummary ? (
                <div className="px-6 py-12 text-center">
                  <Sparkles className="w-10 h-10 mx-auto text-violet-500/20 mb-3" />
                  <p className="text-sm text-slate-400 font-medium">Click "Generate Summary" for an AI-powered analysis</p>
                  <p className="text-xs text-slate-600 mt-1">Based on real assessment data only</p>
                </div>
              ) : aiLoading ? (
                <div className="px-6 py-12 flex flex-col items-center gap-3">
                  <div className="relative">
                    <div className="w-10 h-10 rounded-full border-2 border-violet-500/20 border-t-violet-500 animate-spin" />
                  </div>
                  <p className="text-sm text-slate-500 font-medium">Analysing student data...</p>
                </div>
              ) : aiSummaryData?.summary ? (
                <div className="px-6 py-5 space-y-5">
                  <div className="bg-violet-500/[0.04] border border-violet-500/10 rounded-xl p-4">
                    <p className="text-[13px] text-slate-300 leading-relaxed">{aiSummaryData.summary.narrative}</p>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <SummaryCard icon={AlertTriangle} title="Recurring Weaknesses" text={aiSummaryData.summary.weaknesses} accent="red" />
                    <SummaryCard icon={TrendingUp} title="Improvements" text={aiSummaryData.summary.improvements} accent="emerald" />
                  </div>
                  {aiSummaryData.summary.focusAreas.length > 0 && (
                    <div>
                      <p className="text-[11px] text-slate-500 font-bold uppercase tracking-wider mb-2">Suggested Focus Areas</p>
                      <div className="flex flex-wrap gap-2">
                        {aiSummaryData.summary.focusAreas.map((area) => (
                          <span key={area} className="text-[11px] px-3 py-1.5 rounded-lg bg-indigo-500/8 text-indigo-300 border border-indigo-500/12 font-medium">{area}</span>
                        ))}
                      </div>
                    </div>
                  )}
                  <div className="bg-cyan-500/[0.04] border border-cyan-500/10 rounded-xl p-4">
                    <p className="text-[10px] text-cyan-400 font-bold uppercase tracking-wider mb-1">Recommended Next Steps</p>
                    <p className="text-[13px] text-slate-300 leading-relaxed">{aiSummaryData.summary.nextSteps}</p>
                  </div>
                  <p className="text-[10px] text-slate-600 font-medium text-center">AI interpretation of real platform data. The tutor remains the final decision-maker.</p>
                </div>
              ) : (
                <div className="px-6 py-12 text-center">
                  <AlertTriangle className="w-10 h-10 mx-auto text-amber-500/30 mb-3" />
                  <p className="text-sm text-slate-400 font-medium">Unable to generate summary</p>
                  <button onClick={() => fetchAISummary()} className="text-xs text-violet-400 hover:text-violet-300 mt-2 font-medium" data-testid="button-retry-summary">Retry</button>
                </div>
              )}
            </div>

          </div>
        )}
      </main>

      <AlertDialog open={revokeQuizId !== null} onOpenChange={(open) => { if (!open) setRevokeQuizId(null); }}>
        <AlertDialogContent className="bg-[#0c1222] border-white/[0.06]">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-red-300">Revoke Assignment</AlertDialogTitle>
            <AlertDialogDescription className="text-slate-400">
              This will remove this student's access to the quiz. They will no longer see it on their dashboard.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setRevokeQuizId(null)} className="bg-slate-800 text-slate-300 border-white/[0.06] hover:bg-slate-700">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => { if (revokeQuizId) revokeMutation.mutate(revokeQuizId); }}
              disabled={revokeMutation.isPending}
              className="bg-red-600 text-white hover:bg-red-700"
            >
              {revokeMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : "Revoke"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function HeaderStat({ label, value, color }: { label: string; value: string | null; color: string }) {
  return (
    <div className="text-center">
      <p className={`text-xl font-bold tabular-nums ${color}`}>{value || <span className="text-slate-600">&mdash;</span>}</p>
      <p className="text-[9px] text-slate-500 uppercase tracking-wider font-bold mt-0.5">{label}</p>
    </div>
  );
}

function SummaryCard({ icon: Icon, title, text, accent }: { icon: LucideIcon; title: string; text: string; accent: string }) {
  const colors: Record<string, string> = {
    red: "rgba(239,68,68,0.06)",
    emerald: "rgba(16,185,129,0.06)",
  };
  const borders: Record<string, string> = {
    red: "rgba(239,68,68,0.1)",
    emerald: "rgba(16,185,129,0.1)",
  };
  const textColors: Record<string, string> = {
    red: "text-red-400",
    emerald: "text-emerald-400",
  };
  return (
    <div className="rounded-xl p-4 border" style={{ background: colors[accent], borderColor: borders[accent] }}>
      <div className="flex items-center gap-2 mb-2">
        <Icon className={`w-3.5 h-3.5 ${textColors[accent]}`} />
        <p className={`text-[11px] font-bold uppercase tracking-wider ${textColors[accent]}`}>{title}</p>
      </div>
      <p className="text-[13px] text-slate-300 leading-relaxed">{text}</p>
    </div>
  );
}
