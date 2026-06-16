import { useState, useMemo, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useParams, Link } from "wouter";
import { authFetch } from "@/lib/supabase";
import { formatPersonName } from "@/lib/personName";
import { useSupabaseSession } from "@/hooks/use-supabase-session";
import { getLevelColor, getSubjectIcon } from "@/lib/subjectColors";
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
  ArrowRight, Calendar, Radar as RadarIcon, PlusCircle, Wand2,
} from "lucide-react";
import {
  ResponsiveContainer,
  RadarChart, Radar as RechartsRadar, PolarGrid, PolarAngleAxis, PolarRadiusAxis,
  Tooltip,
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Legend,
  LineChart, Line,
} from "recharts";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel,
  AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { ThemeToggle } from "@/components/ThemeToggle";
import { useChartPalette } from "@/lib/chartTheme";
import { SyllabusInsightsSection, type SubjectInsight } from "@/components/SyllabusInsightsSection";
import MarkdownRenderer from "@/components/MarkdownRenderer";
import { toProperCase, formatDuration, getInitials } from "@/lib/utils";

const GP = "glass-panel-elite";

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

interface StructuredFeedbackItem {
  quizId: number;
  quizTitle: string;
  subject: string | null;
  questionId: number;
  questionStem: string;
  topic: string | null;
  subtopic: string | null;
  awardedMarks: number;
  maxMarks: number;
  percent: number;
  whereFailing: string;
  howToImprove: string;
  completedAt: string | null;
}

interface StudentReport {
  student: { id: string; email: string; displayName: string | null };
  assignments: AssignmentRow[];
  structuredFeedback?: StructuredFeedbackItem[];
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

interface StudentSubject {
  id: number;
  subject: string;
  examBody: string;
  syllabusCode: string;
  level: string;
}

interface SuggestedAssessment {
  id: number;
  purpose: string;
  rationale: string;
  topic: string;
  subtopic: string | null;
  subject: string;
}

function getStatusLabel(a: AssignmentRow): { text: string; color: string } {
  if (a.reportStatus === "completed") return { text: "Submitted", color: "bg-success/10 text-success border-success/15" };
  if (a.reportStatus === "pending") return { text: "Grading", color: "bg-warning/10 text-warning border-warning/15" };
  if (a.reportStatus === "failed") return { text: "Failed", color: "bg-danger/10 text-danger border-danger/15" };
  if (a.assignmentStatus === "completed") return { text: "Done", color: "bg-success/10 text-success border-success/15" };
  return { text: "Pending", color: "bg-muted/10 text-muted-foreground border-muted/15" };
}

function formatPercent(value: number | null | undefined) {
  if (typeof value !== "number" || Number.isNaN(value)) return null;
  return `${Math.round(value)}%`;
}

export default function TutorStudentDetail() {
  const params = useParams<{ id: string }>();
  const studentId = params.id || "";
  const queryClient = useQueryClient();
  const chartPalette = useChartPalette();
  const { toast } = useToast();
  const [newComment, setNewComment] = useState("");
  const [revokeQuizId, setRevokeQuizId] = useState<number | null>(null);
  const [showSummary, setShowSummary] = useState(false);
  const [newSubject, setNewSubject] = useState({ subject: "", examBody: "", syllabusCode: "", level: "" });
  const [selectedSuggestionIds, setSelectedSuggestionIds] = useState<number[]>([]);
  const [profileTab, setProfileTab] = useState<"curriculum" | "assessments">("curriculum");

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

  const { data: subjects = [] } = useQuery<StudentSubject[]>({
    queryKey: ["/api/tutor/students", studentId, "subjects"],
    queryFn: async () => {
      const res = await authFetch(`/api/tutor/students/${studentId}/subjects`);
      if (!res.ok) return [];
      return res.json();
    },
    enabled: !!userId && !!studentId,
  });

  const addSubjectMutation = useMutation({
    mutationFn: async () => {
      const res = await authFetch(`/api/tutor/students/${studentId}/subjects`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(newSubject),
      });
      if (!res.ok) throw new Error((await res.json()).message || "Failed to add subject");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/tutor/students", studentId, "subjects"] });
      setNewSubject({ subject: "", examBody: "", syllabusCode: "", level: "" });
      toast({ title: "Subject added" });
    },
    onError: (err: Error) => toast({ title: "Could not add subject", description: err.message, variant: "destructive" }),
  });

  const deleteSubjectMutation = useMutation({
    mutationFn: async (subjectId: number) => {
      const res = await authFetch(`/api/tutor/students/${studentId}/subjects/${subjectId}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to delete");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/tutor/students", studentId, "subjects"] });
      toast({ title: "Subject removed" });
    },
    onError: () => toast({ title: "Failed to remove subject", variant: "destructive" }),
  });

  const { data: reviewSchedule } = useQuery<{
    dueForReview: Array<{ topic: string; subtopic: string | null; subject: string; understandingPercent: number; daysOverdue: number; attempts: number }>;
    upcoming: Array<{ topic: string; subtopic: string | null; subject: string; understandingPercent: number; daysUntilDue: number }>;
  }>({
    queryKey: ["/api/tutor/students", studentId, "review-schedule"],
    queryFn: async () => {
      const res = await authFetch(`/api/tutor/students/${studentId}/review-schedule`);
      if (!res.ok) return { dueForReview: [], upcoming: [] };
      return res.json();
    },
    enabled: !!userId && !!studentId,
  });

  const { data: masteryData } = useQuery<Array<{ topic: string; subtopic: string | null; understandingPercent: number; attempts: number; confidenceLevel: string; totalQuestions: number; lastTestedAt: string | null }>>({
    queryKey: ["/api/tutor/students", studentId, "mastery"],
    queryFn: async () => {
      const res = await authFetch(`/api/tutor/students/${studentId}/mastery`);
      if (!res.ok) return [];
      return res.json();
    },
    enabled: !!userId && !!studentId,
  });

  const { data: syllabusInsights, isLoading: syllabusInsightsLoading } = useQuery<{ subjects: SubjectInsight[] }>({
    queryKey: ["/api/tutor/students", studentId, "syllabus-insights"],
    queryFn: async () => {
      const res = await authFetch(`/api/tutor/students/${studentId}/syllabus-insights`);
      if (!res.ok) return { subjects: [] };
      return res.json();
    },
    enabled: !!userId && !!studentId,
  });

  const { data: suggestionsData, refetch: refetchSuggestions, isFetching: suggestionsLoading } = useQuery<{ suggestions: SuggestedAssessment[]; basis: any }>({
    queryKey: ["/api/tutor/students", studentId, "suggested-assessments"],
    queryFn: async () => {
      const res = await authFetch(`/api/tutor/students/${studentId}/ai/suggested-assessments`, { method: "POST" });
      if (!res.ok) throw new Error((await res.json()).message || "Suggestion preflight failed");
      return res.json();
    },
    enabled: false,
  });

  const publishSuggestionsMutation = useMutation({
    mutationFn: async () => {
      const res = await authFetch(`/api/tutor/students/${studentId}/ai/publish-suggested`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ suggestionIds: selectedSuggestionIds, questionCount: 30 }),
      });
      if (!res.ok) throw new Error((await res.json()).message || "Failed to publish");
      return res.json();
    },
    onSuccess: (data) => {
      toast({ title: "Assessments published", description: `${data.published} generated assessments were published.` });
      setSelectedSuggestionIds([]);
      queryClient.invalidateQueries({ queryKey: ["/api/tutor/students", studentId, "report"] });
    },
    onError: (err: Error) => toast({ title: "Publish failed", description: err.message, variant: "destructive" }),
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
  const displayName = toProperCase(formatPersonName(student ?? {}));
  const initials = getInitials(displayName);

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

  // ── LEARNING CURVE DATA ──────────────────────────────
  const learningCurveData = useMemo(() => {
    const graded = assignments
      .filter((a) => a.score !== null && a.maxScore > 0 && a.completedAt)
      .sort((a, b) => new Date(a.completedAt!).getTime() - new Date(b.completedAt!).getTime());
    if (graded.length === 0) return { chartData: [], subjects: [] };

    const subjectSet = new Set<string>();
    const dateMap: Record<string, Record<string, number[]>> = {};

    for (const a of graded) {
      const subj = (a.quizSubject || "General").trim();
      subjectSet.add(subj);
      const dateKey = format(new Date(a.completedAt!), "yyyy-MM-dd");
      if (!dateMap[dateKey]) dateMap[dateKey] = {};
      if (!dateMap[dateKey][subj]) dateMap[dateKey][subj] = [];
      dateMap[dateKey][subj].push(Math.round((a.score! / a.maxScore) * 100));
    }

    const subjects = Array.from(subjectSet);
    const chartData = Object.entries(dateMap)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([dateKey, subjScores]) => {
        const point: Record<string, any> = { date: format(new Date(dateKey), "MMM d") };
        for (const subj of subjects) {
          if (subjScores[subj]) {
            const scores = subjScores[subj];
            point[subj] = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
          }
        }
        // Overall average for the day
        const allScores = Object.values(subjScores).flat();
        point.overall = Math.round(allScores.reduce((a, b) => a + b, 0) / allScores.length);
        return point;
      });

    // Add cumulative moving average
    let runningSum = 0;
    let runningCount = 0;
    for (const point of chartData) {
      runningSum += point.overall;
      runningCount++;
      point.movingAvg = Math.round(runningSum / runningCount);
    }

    return { chartData, subjects };
  }, [assignments]);

  const subjectChartColors = chartPalette.series;

  const TrendIcon = overallTrend === "declining" ? TrendingDown : overallTrend === "improving" ? TrendingUp : Minus;
  const trendColor = overallTrend === "declining" ? "text-danger" : overallTrend === "improving" ? "text-success" : "text-muted-foreground";
  const trendBg = overallTrend === "declining" ? "bg-danger/8" : overallTrend === "improving" ? "bg-success/8" : "bg-muted/8";

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-30 border-b border-border/60 backdrop-blur-2xl bg-background/95">
        <div className="max-w-[1440px] mx-auto px-6 lg:px-10 py-3.5 flex items-center justify-between">
          <Link href="/tutor/students">
            <span className="flex items-center gap-2 text-[13px] text-muted-foreground hover:text-primary transition-colors cursor-pointer font-medium" data-testid="link-back-students">
              <ArrowLeft className="w-3.5 h-3.5" />
              Students
            </span>
          </Link>
          <div className="flex items-center gap-3">
            <Link href="/tutor">
              <span className="text-[12px] text-muted-foreground hover:text-foreground transition-colors cursor-pointer font-medium">Dashboard</span>
            </Link>
            <span className="text-muted-foreground">/</span>
            <span className="text-[12px] text-foreground font-medium truncate max-w-[200px]">{displayName}</span>
            <ThemeToggle size="sm" />
          </div>
        </div>
      </header>

      <main className="max-w-[1440px] mx-auto px-6 lg:px-10 py-7 space-y-6">
        {reportError ? (
          <div className="flex flex-col items-center justify-center py-32 gap-4" data-testid="profile-error">
            <AlertTriangle className="w-10 h-10 text-warning/70" />
            <p className="text-sm text-muted-foreground font-medium">Unable to load student data</p>
            <p className="text-xs text-muted-foreground">Check your connection and try refreshing</p>
          </div>
        ) : reportLoading ? (
          <div className="space-y-5 animate-in fade-in duration-300">
            <div className={`${GP} p-6`}>
              <div className="flex items-center gap-4">
                <div className="w-14 h-14 rounded-2xl bg-foreground/[0.05] shimmer-pulse" />
                <div className="flex-1"><div className="h-5 w-40 rounded bg-foreground/[0.05] shimmer-pulse" /><div className="h-3 w-24 rounded bg-foreground/[0.04] mt-2 shimmer-pulse" /></div>
              </div>
              <div className="grid grid-cols-4 gap-3 mt-5">
                {[1,2,3,4].map((i) => <div key={i} className="h-16 rounded-xl bg-foreground/[0.04] shimmer-pulse" />)}
              </div>
            </div>
            <div className={`${GP} p-6`}><div className="h-40 rounded-xl bg-foreground/[0.03] shimmer-pulse" /></div>
          </div>
        ) : (
          <div className="space-y-7 animate-in fade-in duration-500">

            {/* ── HEADER PANEL ──────────────────────────────────── */}
            <div className={GP}>
              <div className="p-6 flex flex-col sm:flex-row sm:items-center gap-5">
                <div className="flex items-center gap-4 flex-1">
                  <div
                    className="w-14 h-14 rounded-2xl flex items-center justify-center text-lg font-bold text-white shrink-0"
                    style={{ background: "linear-gradient(145deg, rgb(79,70,229), rgb(124,58,237))", boxShadow: "0 4px 24px rgba(99,102,241,0.25), inset 0 1px 0 rgba(255,255,255,0.12)", border: "1px solid rgba(255,255,255,0.15)" }}
                  >
                    {initials}
                  </div>
                  <div>
                    <h2 className="text-xl font-bold text-foreground tracking-tight" data-testid="text-student-name">{displayName}</h2>
                    <div className="flex items-center gap-3 mt-1.5 flex-wrap">
                      <div className={`flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-semibold ${trendBg} ${trendColor}`}>
                        <TrendIcon className="w-3 h-3" />
                        {overallTrend}
                      </div>
                      {lastActivity && (
                        <span className="text-[11px] text-muted-foreground font-medium flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          Last active {formatDistanceToNow(new Date(lastActivity), { addSuffix: true })}
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4">
                  <HeaderStat label="Avg Score" value={formatPercent(stats?.avgScore)} color="text-primary" icon={<Award className="w-3.5 h-3.5 text-primary/50" />} />
                  <HeaderStat label="Reliability" value={completionRate !== null ? `${completionRate}%` : null} color="text-success" icon={<Target className="w-3.5 h-3.5 text-success/50" />} />
                  <HeaderStat label="Assessed" value={stats ? `${stats.totalCompleted}/${stats.totalAssigned}` : null} color="text-info" icon={<BookOpen className="w-3.5 h-3.5 text-info/50" />} />
                  <HeaderStat label="Trend" value={overallTrend} color={trendColor} icon={<TrendIcon className="w-3.5 h-3.5 opacity-50" />} />
                </div>
              </div>
            </div>

            {/* ── LEARNING CURVE ──────────────────────────────────── */}
            {learningCurveData.chartData.length >= 2 && (
              <div className={GP}>
                <div className="px-6 pt-5 pb-3 flex items-center justify-between border-b border-border/40">
                  <div className="flex items-center gap-2.5">
                    <div className="w-7 h-7 rounded-lg flex items-center justify-center bg-primary/10 border border-primary/12">
                      <Activity className="w-3.5 h-3.5 text-primary" />
                    </div>
                    <div>
                      <h3 className="text-[13px] font-semibold text-foreground">Learning Curve</h3>
                      <p className="text-[10px] text-muted-foreground font-medium">Score progression over time &middot; {learningCurveData.chartData.length} data points</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    {learningCurveData.subjects.map((subj, i) => (
                      <div key={subj} className="flex items-center gap-1.5">
                        <span className="w-2.5 h-2.5 rounded-full" style={{ background: subjectChartColors[i % subjectChartColors.length] }} />
                        <span className="text-[10px] text-muted-foreground font-medium">{subj}</span>
                      </div>
                    ))}
                    <div className="flex items-center gap-1.5">
                      <span className="w-2.5 h-0.5 rounded-full bg-muted-foreground" />
                      <span className="text-[10px] text-muted-foreground font-medium">Moving Avg</span>
                    </div>
                  </div>
                </div>
                <div className="px-6 py-5">
                  <div style={{ height: 280 }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={learningCurveData.chartData} margin={{ top: 5, right: 10, left: -10, bottom: 0 }}>
                        <defs>
                          {learningCurveData.subjects.map((subj, i) => {
                            const color = subjectChartColors[i % subjectChartColors.length];
                            return (
                              <linearGradient key={subj} id={`lc-grad-${i}`} x1="0" y1="0" x2="0" y2="1">
                                <stop offset="5%" stopColor={color} stopOpacity={0.3} />
                                <stop offset="95%" stopColor={color} stopOpacity={0.02} />
                              </linearGradient>
                            );
                          })}
                        </defs>
                        <CartesianGrid strokeDasharray="3 3" stroke={chartPalette.gridStroke} />
                        <XAxis dataKey="date" tick={{ fill: chartPalette.axisTick, fontSize: 10, fontWeight: 600 }} axisLine={false} tickLine={false} />
                        <YAxis domain={[0, 100]} tick={{ fill: chartPalette.axisTickMuted, fontSize: 10 }} axisLine={false} tickLine={false} tickFormatter={(v) => `${v}%`} />
                        <Tooltip
                          content={({ active, payload, label }: any) => {
                            if (!active || !payload?.length) return null;
                            return (
                              <div className="rounded-xl px-3.5 py-2.5 text-xs border border-border backdrop-blur-xl bg-popover text-popover-foreground">
                                <p className="text-foreground/80 font-semibold mb-1">{label}</p>
                                {payload.map((entry: any, i: number) => (
                                  <div key={i} className="flex items-center gap-2 py-0.5">
                                    <span className="w-2 h-2 rounded-full shrink-0" style={{ background: entry.color || entry.stroke }} />
                                    <span className="text-muted-foreground">{entry.name}:</span>
                                    <span className="font-bold tabular-nums">{entry.value}%</span>
                                  </div>
                                ))}
                              </div>
                            );
                          }}
                        />
                        {learningCurveData.subjects.map((subj, i) => (
                          <Area
                            key={subj}
                            type="monotone"
                            dataKey={subj}
                            stroke={subjectChartColors[i % subjectChartColors.length]}
                            fill={`url(#lc-grad-${i})`}
                            strokeWidth={2}
                            dot={{ r: 3, fill: subjectChartColors[i % subjectChartColors.length] }}
                            connectNulls
                          />
                        ))}
                        <Line
                          type="monotone"
                          dataKey="movingAvg"
                          name="Moving Avg"
                          stroke={chartPalette.axisTickMuted}
                          strokeWidth={1.5}
                          strokeDasharray="6 3"
                          dot={false}
                          connectNulls
                        />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              </div>
            )}

            {/* ── SPACED REPETITION REVIEW SCHEDULE ────────────────── */}
            {reviewSchedule && (reviewSchedule.dueForReview.length > 0 || reviewSchedule.upcoming.length > 0) && (
              <div className={GP}>
                <div className="px-6 pt-5 pb-3 flex items-center justify-between border-b border-border/40">
                  <div className="flex items-center gap-2.5">
                    <div className="w-7 h-7 rounded-lg flex items-center justify-center bg-primary/10 border border-primary/12">
                      <Calendar className="w-3.5 h-3.5 text-primary" />
                    </div>
                    <div>
                      <h3 className="text-[13px] font-semibold text-foreground">Spaced Repetition Schedule</h3>
                      <p className="text-[10px] text-muted-foreground font-medium">Review mastered topics at 7 / 30 / 90 day intervals to prevent forgetting</p>
                    </div>
                  </div>
                  {reviewSchedule.dueForReview.length > 0 && (
                    <Badge className="text-[9px] font-bold border text-warning bg-warning/10 border-warning/20">
                      {reviewSchedule.dueForReview.length} due now
                    </Badge>
                  )}
                </div>
                <div className="px-6 py-4">
                  {reviewSchedule.dueForReview.length > 0 && (
                    <div className="mb-4">
                      <p className="text-[10px] text-warning font-bold uppercase tracking-wider mb-2">Overdue Reviews</p>
                      <div className="space-y-1.5">
                        {reviewSchedule.dueForReview.map((r, i) => (
                          <div key={i} className="flex items-center justify-between rounded-lg border border-warning/15 bg-warning/[0.04] px-3 py-2">
                            <div className="flex items-center gap-2">
                              <Clock className="w-3.5 h-3.5 text-warning" />
                              <span className="text-[12px] text-foreground font-medium">{r.topic}{r.subtopic ? ` > ${r.subtopic}` : ""}</span>
                              <span className="text-[10px] text-muted-foreground">{r.subject}</span>
                            </div>
                            <div className="flex items-center gap-3">
                              <span className={`text-[11px] font-bold tabular-nums ${r.understandingPercent >= 75 ? "text-success" : "text-warning"}`}>
                                {r.understandingPercent}%
                              </span>
                              <span className="text-[10px] text-warning font-medium">
                                {r.daysOverdue > 0 ? `${r.daysOverdue}d overdue` : "Due today"}
                              </span>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {reviewSchedule.upcoming.length > 0 && (
                    <div>
                      <p className="text-[10px] text-muted-foreground font-bold uppercase tracking-wider mb-2">Upcoming Reviews</p>
                      <div className="flex flex-wrap gap-2">
                        {reviewSchedule.upcoming.map((r, i) => (
                          <span key={i} className="text-[10px] px-2 py-1 rounded-md bg-muted/8 text-muted-foreground border border-muted/15">
                            {r.topic}{r.subtopic ? ` > ${r.subtopic}` : ""} — in {r.daysUntilDue}d
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            <div className={GP}>
              {/* Tab header */}
              <div className="flex items-center border-b border-border/60">
                <button
                  onClick={() => setProfileTab("curriculum")}
                  className={`px-5 py-3.5 text-[12px] font-semibold transition-colors border-b-2 ${profileTab === "curriculum" ? "text-primary border-primary" : "text-muted-foreground border-transparent hover:text-foreground/80"}`}
                >
                  Curriculum Profile
                </button>
                <button
                  onClick={() => setProfileTab("assessments")}
                  className={`px-5 py-3.5 text-[12px] font-semibold transition-colors border-b-2 ${profileTab === "assessments" ? "text-success border-success" : "text-muted-foreground border-transparent hover:text-foreground/80"}`}
                >
                  Suggested Assessments
                </button>
              </div>

              <div className="p-5">
                {profileTab === "curriculum" ? (
                  <>
                    <div className="flex items-center justify-between mb-3">
                      <h3 className="text-[14px] font-semibold text-foreground">Student Curriculum Profile</h3>
                      <span className="text-[10px] text-muted-foreground">Required for assessment suggestions</span>
                    </div>
                    <div className="space-y-2 mb-4">
                      {subjects.map((s) => (
                        <div key={s.id} className="flex items-center justify-between rounded-lg border border-border/60 bg-foreground/[0.03] px-3 py-2">
                          <span className="text-[12px] text-foreground/80">
                            <strong>{s.subject}</strong> · {s.examBody} · {s.syllabusCode} · {s.level}
                          </span>
                          <button
                            onClick={() => deleteSubjectMutation.mutate(s.id)}
                            className="p-1 rounded hover:bg-danger/15 text-muted-foreground hover:text-danger transition-colors"
                            title="Remove subject"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      ))}
                      {subjects.length === 0 && <p className="text-[12px] text-warning">No subjects configured. Add at least one subject with exam body, syllabus code, and level before using suggestions.</p>}
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-4 gap-2">
                      <select className="bg-card/60 border border-border/70 rounded-md px-2 py-2 text-[12px] text-foreground" value={newSubject.subject} onChange={(e) => setNewSubject((p) => ({ ...p, subject: e.target.value }))}>
                        <option value="" className="text-muted-foreground">Select Subject</option>
                        {["Mathematics", "Physics", "Chemistry", "Biology", "Economics", "Business Studies", "English", "Computer Science", "Accounting", "Geography", "History"].map((s) => (
                          <option key={s} value={s}>{s}</option>
                        ))}
                      </select>
                      <select className="bg-card/60 border border-border/70 rounded-md px-2 py-2 text-[12px] text-foreground" value={newSubject.examBody} onChange={(e) => setNewSubject((p) => ({ ...p, examBody: e.target.value }))}>
                        <option value="" className="text-muted-foreground">Exam Body</option>
                        {["Cambridge (CAIE)", "Edexcel", "IEB", "AQA", "OCR", "ZIMSEC", "WJEC"].map((b) => (
                          <option key={b} value={b}>{b}</option>
                        ))}
                      </select>
                      <input className="bg-card/60 border border-border/70 rounded-md px-2 py-2 text-[12px]" placeholder="Syllabus code (e.g. 0580)" value={newSubject.syllabusCode} onChange={(e) => setNewSubject((p) => ({ ...p, syllabusCode: e.target.value }))} />
                      <select className="bg-card/60 border border-border/70 rounded-md px-2 py-2 text-[12px] text-foreground" value={newSubject.level} onChange={(e) => setNewSubject((p) => ({ ...p, level: e.target.value }))}>
                        <option value="" className="text-muted-foreground">Level</option>
                        {["IGCSE", "O Level", "AS Level", "A Level", "Grade 10", "Grade 11", "Grade 12", "IB SL", "IB HL"].map((l) => (
                          <option key={l} value={l}>{l}</option>
                        ))}
                      </select>
                    </div>
                    <button onClick={() => addSubjectMutation.mutate()} className="mt-3 inline-flex items-center gap-2 px-3 py-2 rounded-md text-[12px] bg-primary/15 text-primary border border-primary/30">
                      <PlusCircle className="w-4 h-4" /> Add Subject
                    </button>
                  </>
                ) : (
                  <>
                    <h3 className="text-[14px] font-semibold text-foreground mb-1">Create Assessment for {displayName}</h3>
                    <p className="text-[11px] text-muted-foreground mb-4">Analyzes performance history, curriculum metadata, syllabus content, and examiner report misconceptions.</p>

                    {subjects.length === 0 ? (
                      <div className="text-center py-8">
                        <AlertTriangle className="w-8 h-8 mx-auto text-warning/60 mb-2" />
                        <p className="text-[12px] text-warning font-medium">Curriculum profile required</p>
                        <p className="text-[11px] text-muted-foreground mt-1">Switch to the Curriculum Profile tab and add at least one subject.</p>
                      </div>
                    ) : (
                      <>
                        <div className="flex items-center gap-2 mb-4">
                          <button
                            onClick={() => { refetchSuggestions(); setSelectedSuggestionIds([]); }}
                            disabled={suggestionsLoading}
                            className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg text-[12px] font-semibold bg-success/10 text-success border border-success/25 hover:bg-success/20 transition-all disabled:opacity-50"
                          >
                            <Wand2 className="w-4 h-4" />
                            {suggestionsLoading ? "Analyzing student data..." : "Generate Suggested Assessments"}
                          </button>
                          {suggestionsData?.basis?.curriculum && (
                            <span className="text-[10px] text-muted-foreground">
                              {Array.isArray(suggestionsData.basis.curriculum)
                                ? suggestionsData.basis.curriculum.map((c: any) => `${c.subject} (${c.examBody} ${c.syllabusCode})`).join(" · ")
                                : `${suggestionsData.basis.curriculum.examBody} · ${suggestionsData.basis.curriculum.syllabusCode} · ${suggestionsData.basis.curriculum.level}`}
                            </span>
                          )}
                        </div>

                        {/* Suggestion cards with assessment history */}
                        {suggestionsData?.suggestions && suggestionsData.suggestions.length > 0 && (
                          <div className="space-y-3 mb-4">
                            <div className="flex items-center justify-between">
                              <span className="text-[11px] text-muted-foreground font-medium">{suggestionsData.suggestions.length} suggestions generated</span>
                              <button
                                onClick={() => {
                                  const allIds = suggestionsData.suggestions.map((s) => s.id);
                                  setSelectedSuggestionIds(selectedSuggestionIds.length === allIds.length ? [] : allIds);
                                }}
                                className="text-[11px] text-primary hover:text-primary/80 font-medium"
                              >
                                {selectedSuggestionIds.length === suggestionsData.suggestions.length ? "Deselect All" : "Select All"}
                              </button>
                            </div>

                            {suggestionsData.suggestions.map((s) => {
                              const purposeLabels: Record<string, { label: string; color: string; icon: typeof Target }> = {
                                struggling_areas: { label: "Remediation", color: "text-danger bg-danger/10 border-danger/20", icon: TrendingDown },
                                uncovered_content: { label: "New Content", color: "text-info bg-info/10 border-info/20", icon: BookOpen },
                                stretch_strengths: { label: "Challenge", color: "text-success bg-success/10 border-success/20", icon: TrendingUp },
                                spaced_review: { label: "Spaced Review", color: "text-primary bg-primary/10 border-primary/20", icon: Clock },
                              };
                              const purpose = purposeLabels[s.purpose] || { label: s.purpose, color: "text-muted-foreground bg-muted/10 border-muted/20", icon: Target };
                              const PurposeIcon = purpose.icon;
                              const isSelected = selectedSuggestionIds.includes(s.id);

                              // Find mastery data for this topic
                              const topicMastery = masteryData?.find(
                                (m) => m.topic.toLowerCase() === s.topic.toLowerCase() && (!s.subtopic || m.subtopic?.toLowerCase() === s.subtopic.toLowerCase())
                              );

                              return (
                                <label
                                  key={s.id}
                                  className={`block rounded-xl border p-4 cursor-pointer transition-all ${isSelected ? "border-primary/40 bg-primary/[0.06]" : "border-border/60 bg-foreground/[0.03] hover:border-border/60"}`}
                                >
                                  <div className="flex items-start gap-3">
                                    <input
                                      type="checkbox"
                                      className="mt-1 accent-primary"
                                      checked={isSelected}
                                      onChange={(e) => setSelectedSuggestionIds((prev) => e.target.checked ? [...prev, s.id] : prev.filter((id) => id !== s.id))}
                                    />
                                    <div className="flex-1 min-w-0">
                                      <div className="flex items-center gap-2 mb-1.5">
                                        <Badge className={`text-[9px] font-bold border ${purpose.color}`}>
                                          <PurposeIcon className="w-2.5 h-2.5 mr-1" />
                                          {purpose.label}
                                        </Badge>
                                        <span className="text-[13px] font-semibold text-foreground">{s.topic}</span>
                                        {s.subtopic && <span className="text-[11px] text-muted-foreground">{s.subtopic}</span>}
                                      </div>
                                      <p className="text-[11px] text-muted-foreground leading-relaxed mb-2">{s.rationale}</p>

                                      {/* Assessment history for this topic */}
                                      {topicMastery && (
                                        <div className="flex items-center gap-3 text-[10px]">
                                          <span className={`font-bold tabular-nums ${topicMastery.understandingPercent >= 75 ? "text-success" : topicMastery.understandingPercent >= 50 ? "text-warning" : "text-danger"}`}>
                                            {topicMastery.understandingPercent}% mastery
                                          </span>
                                          <span className="text-muted-foreground">|</span>
                                          <span className="text-muted-foreground">{topicMastery.totalQuestions} questions attempted</span>
                                          <span className="text-muted-foreground">|</span>
                                          <span className="text-muted-foreground">{topicMastery.attempts} assessment{topicMastery.attempts !== 1 ? "s" : ""}</span>
                                          <span className="text-muted-foreground">|</span>
                                          <Badge className={`text-[8px] border ${topicMastery.confidenceLevel === "high" ? "text-success bg-success/8 border-success/15" : topicMastery.confidenceLevel === "medium" ? "text-warning bg-warning/8 border-warning/15" : "text-muted-foreground bg-muted/8 border-muted/15"}`}>
                                            {topicMastery.confidenceLevel} confidence
                                          </Badge>
                                        </div>
                                      )}
                                      {!topicMastery && (
                                        <span className="text-[10px] text-muted-foreground">No prior assessment data for this topic</span>
                                      )}
                                    </div>
                                  </div>
                                </label>
                              );
                            })}
                          </div>
                        )}

                        {/* Publish button */}
                        {suggestionsData?.suggestions && suggestionsData.suggestions.length > 0 && (
                          <button
                            disabled={selectedSuggestionIds.length === 0 || publishSuggestionsMutation.isPending}
                            onClick={() => publishSuggestionsMutation.mutate()}
                            className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg text-[12px] font-semibold bg-primary/15 text-primary border border-primary/30 hover:bg-primary/25 transition-all disabled:opacity-40"
                          >
                            {publishSuggestionsMutation.isPending ? (
                              <><Loader2 className="w-4 h-4 animate-spin" /> Generating...</>
                            ) : (
                              <>Publish {selectedSuggestionIds.length} Assessment{selectedSuggestionIds.length !== 1 ? "s" : ""}</>
                            )}
                          </button>
                        )}

                        {/* Remediation & misconception insights */}
                        {suggestionsData?.basis?.remediationTargets && suggestionsData.basis.remediationTargets.length > 0 && (
                          <div className="mt-4 pt-4 border-t border-border/60">
                            <p className="text-[10px] text-muted-foreground font-bold uppercase tracking-wider mb-2">Remediation Targets (below 75%)</p>
                            <div className="flex flex-wrap gap-2">
                              {suggestionsData.basis.remediationTargets.map((r: any, i: number) => (
                                <span key={i} className="text-[10px] px-2 py-1 rounded-md bg-danger/8 text-danger border border-danger/15">
                                  {r.topic}{r.subtopic ? ` > ${r.subtopic}` : ""}: {r.understanding}% ({r.attempts} {r.attempts === 1 ? "attempt" : "attempts"})
                                </span>
                              ))}
                            </div>
                          </div>
                        )}
                      </>
                    )}
                  </>
                )}
              </div>
            </div>

            {/* ── SYLLABUS TOPIC RADAR + PAPER READINESS (new) ────── */}
            <SyllabusInsightsSection
              insights={syllabusInsights}
              isLoading={syllabusInsightsLoading}
              studentFirstName={displayName.split(" ")[0]}
            />

            {/* ── WRITTEN-ANSWER FEEDBACK (structured questions) ───── */}
            {(report?.structuredFeedback?.length ?? 0) > 0 && (
              <div className={GP} data-testid="section-structured-feedback">
                <div className="px-6 pt-5 pb-3 flex items-center justify-between border-b border-border/40">
                  <div className="flex items-center gap-2.5">
                    <div className="w-7 h-7 rounded-lg flex items-center justify-center bg-warning/10 border border-warning/15">
                      <Target className="w-3.5 h-3.5 text-warning" />
                    </div>
                    <div>
                      <h3 className="text-[13px] font-semibold text-foreground">Written-answer feedback</h3>
                      <p className="text-[10px] text-muted-foreground font-medium">Where {displayName.split(" ")[0]} is losing marks on structured questions &middot; and how to improve</p>
                    </div>
                  </div>
                </div>
                <div className="px-6 py-5 flex flex-col gap-3">
                  {report!.structuredFeedback!.map((f) => (
                    <div
                      key={`${f.quizId}-${f.questionId}`}
                      className="rounded-lg border border-border/50 bg-card/40 p-4"
                      data-testid={`structured-feedback-${f.quizId}-${f.questionId}`}
                    >
                      <div className="flex items-center justify-between gap-3 flex-wrap mb-2">
                        <div className="flex items-center gap-2 flex-wrap">
                          {f.topic && <span className="chip chip-brand" style={{ fontSize: 10 }}>{f.topic}</span>}
                          {f.subtopic && <span className="chip" style={{ fontSize: 10 }}>{f.subtopic}</span>}
                          <span className="text-[11px] text-muted-foreground font-medium">{f.subject || f.quizTitle}</span>
                        </div>
                        <span className="chip chip-danger num" style={{ fontSize: 10 }} data-testid={`structured-score-${f.quizId}-${f.questionId}`}>
                          {f.awardedMarks}/{f.maxMarks} marks
                        </span>
                      </div>
                      {f.questionStem && (
                        <div className="text-[12px] text-foreground/90 mb-2 line-clamp-2">
                          <MarkdownRenderer content={f.questionStem} />
                        </div>
                      )}
                      {f.whereFailing && (
                        <div className="mb-1.5">
                          <span className="eyebrow text-warning">Where it fell short</span>
                          <div className="text-[12px] text-foreground/90"><MarkdownRenderer content={f.whereFailing} /></div>
                        </div>
                      )}
                      {f.howToImprove && (
                        <div>
                          <span className="eyebrow text-success">How to improve</span>
                          <div className="text-[12px] text-foreground/90"><MarkdownRenderer content={f.howToImprove} /></div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* ── LEGACY SUBJECT-LEVEL COVERAGE RADAR ───────────── */}
            {topicPerformance.length >= 2 && (
              <div className={GP}>
                <div className="px-6 pt-5 pb-3 flex items-center justify-between border-b border-border/40">
                  <div className="flex items-center gap-2.5">
                    <div className="w-7 h-7 rounded-lg flex items-center justify-center bg-primary/10 border border-primary/12">
                      <RadarIcon className="w-3.5 h-3.5 text-primary" />
                    </div>
                    <div>
                      <h3 className="text-[13px] font-semibold text-foreground">Syllabus Coverage</h3>
                      <p className="text-[10px] text-muted-foreground font-medium">Subject coverage &middot; drill down into topics and subtopics</p>
                    </div>
                  </div>
                </div>
                <div className="px-6 py-5">
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                    {/* Radar Chart */}
                    <div style={{ height: 320 }}>
                      <ResponsiveContainer width="100%" height="100%">
                        <RadarChart data={topicPerformance.map((t) => ({
                          subject: t.topic.length > 12 ? t.topic.slice(0, 12) + "…" : t.topic,
                          fullSubject: t.topic,
                          score: t.average,
                          coverage: Math.min(100, t.assessmentCount * 20),
                          fullMark: 100,
                        }))} cx="50%" cy="50%" outerRadius="70%">
                          <PolarGrid stroke={chartPalette.gridStroke} />
                          <PolarAngleAxis dataKey="subject" tick={{ fill: chartPalette.axisTick, fontSize: 10, fontWeight: 600 }} />
                          <PolarRadiusAxis domain={[0, 100]} tick={{ fill: chartPalette.axisTickMuted, fontSize: 9 }} axisLine={false} />
                          <RechartsRadar name="Score" dataKey="score" stroke={chartPalette.radarStroke} fill={chartPalette.radarArea} strokeWidth={2} dot={{ r: 3, fill: chartPalette.radarStroke }} />
                          <RechartsRadar name="Coverage" dataKey="coverage" stroke={chartPalette.series[1]} fill={chartPalette.series[1] + "22"} strokeWidth={1.5} strokeDasharray="4 3" dot={{ r: 2.5, fill: chartPalette.series[1] }} />
                          <Tooltip content={({ active, payload }: any) => {
                            if (!active || !payload?.length) return null;
                            const d = payload[0]?.payload;
                            return (
                              <div className="rounded-xl px-3.5 py-2.5 text-xs border border-border backdrop-blur-xl bg-popover text-popover-foreground">
                                <p className="text-foreground/80 font-semibold mb-1">{d?.fullSubject || d?.subject}</p>
                                {payload.map((entry: any, i: number) => (
                                  <div key={i} className="flex items-center gap-2 py-0.5">
                                    <span className="w-2 h-2 rounded-full shrink-0" style={{ background: entry.color }} />
                                    <span className="text-muted-foreground">{entry.name}:</span>
                                    <span className="font-bold tabular-nums">{Math.round(entry.value)}%</span>
                                  </div>
                                ))}
                              </div>
                            );
                          }} />
                        </RadarChart>
                      </ResponsiveContainer>
                    </div>

                    {/* Drill-down breakdown */}
                    <div className="space-y-3 max-h-[320px] overflow-y-auto pr-1">
                      {topicPerformance.map((t) => {
                        const coveragePct = Math.min(100, t.assessmentCount * 20);
                        const barColor = t.average >= 70 ? "linear-gradient(90deg, #10b981, #34d399)" : t.average >= 50 ? "linear-gradient(90deg, #f59e0b, #fbbf24)" : "linear-gradient(90deg, #ef4444, #f87171)";
                        const covColor = coveragePct >= 60 ? "linear-gradient(90deg, #06b6d4, #22d3ee)" : coveragePct >= 30 ? "linear-gradient(90deg, #f59e0b, #fbbf24)" : "linear-gradient(90deg, #94a3b8, #cbd5e1)";
                        const TIcon = t.trend === "declining" ? TrendingDown : t.trend === "improving" ? TrendingUp : Minus;
                        const tc = t.trend === "declining" ? "text-danger" : t.trend === "improving" ? "text-success" : "text-muted-foreground";
                        return (
                          <div key={t.topic} className="bg-foreground/[0.03] border border-border/40 rounded-xl p-3.5">
                            <div className="flex items-center justify-between mb-2">
                              <div className="flex items-center gap-2">
                                <span className="text-[12px] font-semibold text-foreground">{t.topic}</span>
                                <TIcon className={`w-3 h-3 ${tc}`} />
                              </div>
                              <span className={`text-[11px] font-bold tabular-nums ${t.average >= 70 ? "text-success" : t.average >= 50 ? "text-warning" : "text-danger"}`}>{t.average}%</span>
                            </div>
                            <div className="space-y-1.5">
                              <div>
                                <div className="flex items-center justify-between mb-0.5">
                                  <span className="text-[9px] text-muted-foreground font-bold uppercase tracking-wider">Performance</span>
                                </div>
                                <div className="h-[5px] rounded-full bg-muted/60 overflow-hidden">
                                  <div className="h-full rounded-full transition-all duration-500" style={{ width: `${t.average}%`, background: barColor }} />
                                </div>
                              </div>
                              <div>
                                <div className="flex items-center justify-between mb-0.5">
                                  <span className="text-[9px] text-muted-foreground font-bold uppercase tracking-wider">Coverage</span>
                                  <span className="text-[9px] text-info font-bold tabular-nums">{coveragePct}%</span>
                                </div>
                                <div className="h-[5px] rounded-full bg-muted/60 overflow-hidden">
                                  <div className="h-full rounded-full transition-all duration-500" style={{ width: `${coveragePct}%`, background: covColor }} />
                                </div>
                              </div>
                              <p className="text-[10px] text-muted-foreground font-medium">{t.assessmentCount} assessment{t.assessmentCount !== 1 ? "s" : ""} &middot; {t.evidence} evidence</p>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* ── SUBJECT PERFORMANCE ────────────────────────────── */}
            <div className={GP}>
              <div className="px-6 pt-5 pb-3 flex items-center justify-between border-b border-border/40">
                <div className="flex items-center gap-2.5">
                  <div className="w-7 h-7 rounded-lg flex items-center justify-center bg-info/10 border border-info/12">
                    <BarChart3 className="w-3.5 h-3.5 text-info" />
                  </div>
                  <div>
                    <h3 className="text-[13px] font-semibold text-foreground">Subject Performance</h3>
                    <p className="text-[10px] text-muted-foreground font-medium">Performance by subject &middot; trend &middot; evidence</p>
                  </div>
                </div>
              </div>

              {topicPerformance.length === 0 ? (
                <div className="px-6 py-14 text-center">
                  <BarChart3 className="w-10 h-10 mx-auto text-muted-foreground mb-3" />
                  <p className="text-sm text-muted-foreground font-medium">No completed assessments yet</p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[640px]">
                    <thead>
                      <tr className="border-b border-border/40">
                        <th className="text-left text-[10px] font-bold text-muted-foreground uppercase tracking-wider px-6 py-3">Subject</th>
                        <th className="text-left text-[10px] font-bold text-muted-foreground uppercase tracking-wider px-3 py-3 w-44">Score</th>
                        <th className="text-center text-[10px] font-bold text-muted-foreground uppercase tracking-wider px-3 py-3 w-16">Attempts</th>
                        <th className="text-center text-[10px] font-bold text-muted-foreground uppercase tracking-wider px-3 py-3 w-16">Trend</th>
                        <th className="text-center text-[10px] font-bold text-muted-foreground uppercase tracking-wider px-3 py-3 w-20">Evidence</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/[0.025]">
                      {topicPerformance.map((t) => {
                        const barGradient = t.average >= 70 ? "linear-gradient(90deg, #10b981, #34d399)" : t.average >= 50 ? "linear-gradient(90deg, #f59e0b, #fbbf24)" : "linear-gradient(90deg, #ef4444, #f87171)";
                        const scoreColor = t.average >= 70 ? "text-success" : t.average >= 50 ? "text-warning" : "text-danger";
                        const TIcon = t.trend === "declining" ? TrendingDown : t.trend === "improving" ? TrendingUp : Minus;
                        const tc = t.trend === "declining" ? "text-danger" : t.trend === "improving" ? "text-success" : "text-muted-foreground";
                        const evColor = t.evidence === "Strong" ? "text-success bg-success/8 border-success/10" : t.evidence === "Moderate" ? "text-warning bg-warning/8 border-warning/10" : "text-muted-foreground bg-muted/8 border-muted/10";
                        return (
                          <tr key={t.topic} className="hover:bg-foreground/[0.02] transition-colors">
                            <td className="px-6 py-3.5">
                              <span className="text-[13px] font-medium text-foreground">{t.topic}</span>
                            </td>
                            <td className="px-3 py-3.5">
                              <div className="flex items-center gap-3">
                                <div className="flex-1 h-2 rounded-full bg-muted/60 overflow-hidden">
                                  <div className="h-full rounded-full transition-all duration-700" style={{ width: `${t.average}%`, background: barGradient }} />
                                </div>
                                <span className={`text-xs font-bold tabular-nums w-9 text-right ${scoreColor}`}>{t.average}%</span>
                              </div>
                            </td>
                            <td className="text-center text-[13px] tabular-nums text-muted-foreground font-medium px-3 py-3.5">{t.assessmentCount}</td>
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
                  <div className="px-6 pt-5 pb-3 border-b border-border/40">
                    <div className="flex items-center gap-2.5">
                      <div className="w-7 h-7 rounded-lg flex items-center justify-center bg-info/10 border border-info/12">
                        <Layers className="w-3.5 h-3.5 text-info" />
                      </div>
                      <div>
                        <h3 className="text-[13px] font-semibold text-foreground">Coverage Matrix</h3>
                        <p className="text-[10px] text-muted-foreground font-medium">Subject depth &middot; assessments &middot; performance</p>
                      </div>
                    </div>
                  </div>

                  {coverageData.length === 0 ? (
                    <div className="px-6 py-14 text-center">
                      <Layers className="w-10 h-10 mx-auto text-muted-foreground mb-3" />
                      <p className="text-sm text-muted-foreground font-medium">No coverage data yet</p>
                    </div>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full min-w-[550px]">
                        <thead>
                          <tr className="border-b border-border/40">
                            <th className="text-left text-[10px] font-bold text-muted-foreground uppercase tracking-wider px-6 py-3">Subject</th>
                            <th className="text-left text-[10px] font-bold text-muted-foreground uppercase tracking-wider px-3 py-3 w-32">Coverage</th>
                            <th className="text-center text-[10px] font-bold text-muted-foreground uppercase tracking-wider px-3 py-3 w-20">Assess.</th>
                            <th className="text-center text-[10px] font-bold text-muted-foreground uppercase tracking-wider px-3 py-3 w-16">Perf.</th>
                            <th className="text-right text-[10px] font-bold text-muted-foreground uppercase tracking-wider px-6 py-3 w-24">Last Seen</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-white/[0.025]">
                          {coverageData.map((c) => {
                            const barColor = c.coveragePct >= 60 ? "linear-gradient(90deg, #06b6d4, #22d3ee)" : c.coveragePct >= 30 ? "linear-gradient(90deg, #f59e0b, #fbbf24)" : "linear-gradient(90deg, #94a3b8, #cbd5e1)";
                            const perfColor = c.performance >= 70 ? "text-success" : c.performance >= 50 ? "text-warning" : "text-danger";
                            return (
                              <tr key={c.topic} className="hover:bg-foreground/[0.02] transition-colors">
                                <td className="px-6 py-3">
                                  <span className="text-[12px] font-medium text-foreground/80">{c.topic}</span>
                                </td>
                                <td className="px-3 py-3">
                                  <div className="flex items-center gap-2">
                                    <div className="flex-1 h-[5px] rounded-full bg-muted/60 overflow-hidden">
                                      <div className="h-full rounded-full" style={{ width: `${c.coveragePct}%`, background: barColor }} />
                                    </div>
                                    <span className="text-[10px] text-info font-bold tabular-nums w-7 text-right">{c.coveragePct}%</span>
                                  </div>
                                </td>
                                <td className="text-center text-[12px] tabular-nums text-muted-foreground font-medium px-3 py-3">{c.assessments}</td>
                                <td className="text-center px-3 py-3">
                                  <span className={`text-[12px] font-bold tabular-nums ${perfColor}`}>{c.performance}%</span>
                                </td>
                                <td className="text-right text-[10px] text-muted-foreground font-medium px-6 py-3">
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
                  <div className="px-6 pt-5 pb-3 border-b border-border/40">
                    <div className="flex items-center gap-2.5">
                      <div className="w-7 h-7 rounded-lg flex items-center justify-center bg-primary/10 border border-primary/12">
                        <MessageSquare className="w-3.5 h-3.5 text-primary" />
                      </div>
                      <h3 className="text-[13px] font-semibold text-foreground">Private Notes</h3>
                    </div>
                  </div>
                  <div className="px-6 py-4">
                    <div className="space-y-2 max-h-[250px] overflow-y-auto mb-4">
                      {commentsLoading ? (
                        <Loader2 className="w-5 h-5 text-primary animate-spin mx-auto" />
                      ) : comments.length === 0 ? (
                        <p className="text-xs text-muted-foreground text-center py-4 font-medium">No notes yet</p>
                      ) : (
                        comments.map((c) => (
                          <div key={c.id} className="bg-foreground/[0.03] border border-border/40 rounded-lg p-3">
                            <p className="text-[13px] text-foreground/80 whitespace-pre-wrap leading-relaxed">{c.comment}</p>
                            <p className="text-[10px] text-muted-foreground mt-1.5 font-medium">{format(new Date(c.createdAt), "PPp")}</p>
                          </div>
                        ))
                      )}
                    </div>
                    <div className="flex gap-2">
                      <textarea
                        value={newComment}
                        onChange={(e) => setNewComment(e.target.value)}
                        placeholder="Add a note..."
                        className="flex-1 bg-background/80 border border-border/60 rounded-lg p-3 text-sm text-foreground placeholder:text-muted-foreground resize-none min-h-[44px] focus:outline-none focus:border-primary/30 focus:ring-1 focus:ring-primary/15"
                        rows={2}
                        data-testid="input-note"
                      />
                      <button
                        onClick={() => { if (newComment.trim()) addCommentMutation.mutate(newComment); }}
                        disabled={!newComment.trim() || addCommentMutation.isPending}
                        className="self-end p-3 rounded-lg bg-primary/15 text-primary border border-primary/20 hover:bg-primary/25 disabled:opacity-40 transition-all min-h-[44px] min-w-[44px]"
                        data-testid="button-save-note"
                      >
                        {addCommentMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                      </button>
                    </div>
                  </div>
                </div>

                {/* Academic Summary */}
                <div className={GP}>
                  <div className="px-6 pt-5 pb-3 border-b border-border/40">
                    <div className="flex items-center gap-2.5">
                      <div className="w-7 h-7 rounded-lg flex items-center justify-center bg-success/10 border border-success/12">
                        <FileText className="w-3.5 h-3.5 text-success" />
                      </div>
                      <h3 className="text-[13px] font-semibold text-foreground">Academic Summary</h3>
                    </div>
                  </div>
                  <div className="px-6 py-4">
                    {!showSummary ? (
                      <button
                        onClick={() => setShowSummary(true)}
                        className="w-full py-3 min-h-[44px] rounded-xl text-sm font-semibold text-success bg-success/10 border border-success/15 hover:bg-success/20 transition-all"
                        data-testid="button-generate-summary"
                      >
                        Generate Summary
                      </button>
                    ) : aiLoading ? (
                      <div className="py-8 text-center">
                        <Loader2 className="w-6 h-6 text-success animate-spin mx-auto mb-2" />
                        <p className="text-xs text-muted-foreground font-medium">Analysing student data...</p>
                      </div>
                    ) : aiSummaryData?.summary ? (
                      <div className="space-y-4 text-[13px] text-foreground/80 leading-relaxed" data-testid="ai-summary-content">
                        <p>{aiSummaryData.summary.narrative}</p>
                        {aiSummaryData.summary.weaknesses && (
                          <div>
                            <p className="text-[10px] text-muted-foreground font-bold uppercase tracking-wider mb-1">Key Weaknesses</p>
                            <p className="text-muted-foreground">{aiSummaryData.summary.weaknesses}</p>
                          </div>
                        )}
                        {aiSummaryData.summary.improvements && (
                          <div>
                            <p className="text-[10px] text-muted-foreground font-bold uppercase tracking-wider mb-1">Recent Improvements</p>
                            <p className="text-muted-foreground">{aiSummaryData.summary.improvements}</p>
                          </div>
                        )}
                        {aiSummaryData.summary.focusAreas?.length > 0 && (
                          <div>
                            <p className="text-[10px] text-muted-foreground font-bold uppercase tracking-wider mb-1">Focus Areas</p>
                            <ul className="list-disc list-inside text-muted-foreground space-y-0.5">
                              {aiSummaryData.summary.focusAreas.map((f, i) => <li key={i}>{f}</li>)}
                            </ul>
                          </div>
                        )}
                        {aiSummaryData.summary.nextSteps && (
                          <div>
                            <p className="text-[10px] text-muted-foreground font-bold uppercase tracking-wider mb-1">Recommended Next Steps</p>
                            <p className="text-muted-foreground">{aiSummaryData.summary.nextSteps}</p>
                          </div>
                        )}
                      </div>
                    ) : (
                      <p className="text-sm text-muted-foreground text-center py-4">Unable to generate summary. Try again later.</p>
                    )}
                  </div>
                </div>
              </div>
            </div>

            {/* ── EVIDENCE HISTORY ──────────────────────────────── */}
            <div className={GP}>
              <div className="px-6 pt-5 pb-3 flex items-center justify-between border-b border-border/40">
                <div className="flex items-center gap-2.5">
                  <div className="w-7 h-7 rounded-lg flex items-center justify-center bg-primary/10 border border-primary/12">
                    <Activity className="w-3.5 h-3.5 text-primary" />
                  </div>
                  <div>
                    <h3 className="text-[13px] font-semibold text-foreground">Evidence History</h3>
                    <p className="text-[10px] text-muted-foreground font-medium">Timeline of assessments &middot; topics &middot; scores</p>
                  </div>
                </div>
              </div>

              {assignments.length === 0 ? (
                <div className="px-6 py-14 text-center">
                  <BookOpen className="w-10 h-10 mx-auto text-muted-foreground mb-3" />
                  <p className="text-sm text-muted-foreground font-medium">No assignments yet</p>
                </div>
              ) : (
                <div className="divide-y divide-white/[0.03]">
                  {assignments.map((a) => {
                    const status = getStatusLabel(a);
                    const sc = getLevelColor(a.quizLevel);
                    const SubIcon = getSubjectIcon(a.quizSubject);
                    const pct = a.score !== null && a.maxScore > 0 ? Math.round((a.score / a.maxScore) * 100) : null;
                    const duration = formatDuration(a.startedAt, a.completedAt);
                    const scoreColor = pct !== null ? (pct >= 70 ? "text-success bg-success/10 border-success/15" : pct >= 40 ? "text-warning bg-warning/10 border-warning/15" : "text-danger bg-danger/10 border-danger/15") : "";
                    return (
                      <div key={a.assignmentId} className="px-6 py-4 flex items-center gap-4 hover:bg-foreground/[0.02] transition-colors group" data-testid={`assignment-${a.assignmentId}`}>
                        <div className={`w-9 h-9 rounded-lg flex items-center justify-center border shrink-0 ${sc.bg} ${sc.border}`}>
                          <SubIcon className={`w-4 h-4 ${sc.label}`} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-[13px] font-medium text-foreground truncate">{a.quizTitle}</p>
                          <div className="flex items-center gap-3 mt-0.5 text-[10px] text-muted-foreground font-medium flex-wrap">
                            {a.quizSubject && <span>{a.quizSubject}</span>}
                            <span>{format(new Date(a.assignedAt), "MMM d, yyyy")}</span>
                            {duration && <span className="text-primary/60">{duration}</span>}
                          </div>
                        </div>
                        <Badge className={`text-[10px] font-bold border ${status.color}`}>{status.text}</Badge>
                        {pct !== null && (
                          <Badge className={`text-xs font-bold px-2.5 py-1 border ${scoreColor}`}>{pct}%</Badge>
                        )}
                        {a.reportId ? (
                          <Link href={`/soma/review/${a.reportId}`}>
                            <span className="text-muted-foreground hover:text-primary transition-colors cursor-pointer">
                              <Eye className="w-4 h-4" />
                            </span>
                          </Link>
                        ) : (
                          <button
                            onClick={() => setRevokeQuizId(a.quizId)}
                            className="text-muted-foreground hover:text-danger transition-colors opacity-0 group-hover:opacity-100"
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
        <AlertDialogContent className="bg-card border-border/50">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-foreground">Revoke Assignment?</AlertDialogTitle>
            <AlertDialogDescription className="text-muted-foreground">
              This will remove the assignment from the student. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="bg-muted text-foreground/80 border-border/50 hover:bg-muted/80">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => revokeQuizId && revokeMutation.mutate(revokeQuizId)}
              className="bg-danger text-white hover:bg-danger/90"
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
    <div className="text-center sm:text-left p-3 rounded-xl bg-foreground/[0.03] border border-border/40">
      <div className="flex items-center gap-1.5 mb-1">
        {icon}
        <p className="text-[9px] text-muted-foreground font-bold uppercase tracking-[0.08em]">{label}</p>
      </div>
      <p className={`text-base font-bold tabular-nums ${color}`}>{value || "—"}</p>
    </div>
  );
}
