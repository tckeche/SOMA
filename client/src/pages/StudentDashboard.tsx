import { useState, useMemo, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import { supabase, authFetch } from "@/lib/supabase";
import { useSupabaseSession } from "@/hooks/use-supabase-session";
import { getSubjectColor, getSubjectIcon } from "@/lib/subjectColors";
import DOMPurify from "dompurify";
import type { SomaQuiz } from "@shared/schema";
import { PieChart, Pie, Cell, ResponsiveContainer } from "recharts";
import { format } from "date-fns";
import {
  LogOut, BookOpen, Clock, ArrowRight, CheckCircle2,
  Loader2, AlertTriangle, Sparkles,
  Eye, FileText, Calendar,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";

interface ReportWithQuiz {
  id: number;
  quizId: number;
  studentId: string | null;
  studentName: string;
  score: number;
  maxScore: number;
  status: string;
  aiFeedbackHtml: string | null;
  createdAt: string;
  quiz: SomaQuiz;
}

function toProperCase(str: string): string {
  return str.replace(/\b\w/g, (c) => c.toUpperCase());
}


const CARD_CLASS = "bg-slate-900/80 backdrop-blur-md border border-slate-800 rounded-2xl p-6 shadow-2xl";
const SECTION_LABEL = "text-slate-400 text-xs font-semibold tracking-wider uppercase";

function DonutCard({ subject, percentage, color }: { subject: string; percentage: number; color: string }) {
  const data = [
    { value: percentage },
    { value: 100 - percentage },
  ];
  return (
    <div
      className={CARD_CLASS}
      style={{
        background: `linear-gradient(145deg, rgba(15,23,42,0.9), rgba(30,41,59,0.7))`,
        boxShadow: `0 8px 32px rgba(0,0,0,0.4), 0 2px 8px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.05), 0 0 40px ${color}10`,
      }}
      data-testid={`card-donut-${subject}`}
    >
      <div className="flex flex-col items-center">
        <div
          className="w-32 h-32 relative"
          style={{
            filter: `drop-shadow(0 4px 12px ${color}30)`,
            transform: "perspective(400px) rotateX(5deg)",
          }}
        >
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <defs>
                <linearGradient id={`grad-${subject}`} x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0%" stopColor={color} stopOpacity={1} />
                  <stop offset="100%" stopColor={color} stopOpacity={0.6} />
                </linearGradient>
              </defs>
              <Pie
                data={data}
                cx="50%"
                cy="50%"
                innerRadius={36}
                outerRadius={56}
                startAngle={90}
                endAngle={-270}
                dataKey="value"
                stroke="none"
                cornerRadius={4}
              >
                <Cell fill={`url(#grad-${subject})`} />
                <Cell fill="rgba(255,255,255,0.04)" />
              </Pie>
            </PieChart>
          </ResponsiveContainer>
          <div className="absolute inset-0 flex items-center justify-center">
            <span
              className="text-xl font-bold text-white"
              style={{ textShadow: `0 0 20px ${color}60, 0 2px 4px rgba(0,0,0,0.5)` }}
              data-testid={`text-donut-value-${subject}`}
            >
              {Math.round(percentage)}%
            </span>
          </div>
        </div>
        <p className={`${SECTION_LABEL} mt-3`} style={{ color }}>{subject}</p>
      </div>
    </div>
  );
}

export default function StudentDashboard() {
  const queryClient = useQueryClient();
  const [, setLocation] = useLocation();
  const [subjectFilter, setSubjectFilter] = useState<string>("all");
  const [levelFilter, setLevelFilter] = useState<string>("all");
  const [showAllAvailable, setShowAllAvailable] = useState(false);
  const [showAllCompleted, setShowAllCompleted] = useState(false);
  const [analysisPopup, setAnalysisPopup] = useState<{ title: string; html: string } | null>(null);
  const [loadingAnalysisId, setLoadingAnalysisId] = useState<string | null>(null);

  const { session, userId } = useSupabaseSession();

  const fetchAnalysis = useCallback(async (item: { quizId: number; title: string }) => {
    const cacheKey = `ai_analysis_soma_${item.quizId}`;
    const cached = localStorage.getItem(cacheKey);
    if (cached) {
      setAnalysisPopup({ title: item.title, html: cached });
      return;
    }

    const displayName = toProperCase(session?.user?.user_metadata?.display_name || session?.user?.email?.split("@")[0] || "Student");
    const parts = displayName.split(" ");
    const firstName = parts[0] || "Student";
    const lastName = parts.slice(1).join(" ") || "User";

    setLoadingAnalysisId(`soma-${item.quizId}`);
    try {
      const res = await fetch("/api/student/analyze-quiz", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ quizId: item.quizId, firstName, lastName }),
      });
      const contentType = res.headers.get("content-type") || "";
      if (!res.ok || !contentType.includes("application/json")) {
        throw new Error("Analysis not available");
      }
      const data = await res.json();
      if (data.analysis) {
        localStorage.setItem(cacheKey, data.analysis);
        setAnalysisPopup({ title: item.title, html: data.analysis });
      }
    } catch {
    } finally {
      setLoadingAnalysisId(null);
    }
  }, [session]);

  const displayName = toProperCase(session?.user?.user_metadata?.display_name || session?.user?.email?.split("@")[0] || "Student");

  const { data: somaQuizzes, isLoading: somaLoading } = useQuery<SomaQuiz[]>({
    queryKey: ["/api/quizzes/available", userId],
    queryFn: async () => {
      if (!userId) return [];
      const res = await authFetch("/api/quizzes/available");
      if (!res.ok) return [];
      return res.json();
    },
    enabled: !!userId,
    refetchInterval: 15000,
    refetchOnWindowFocus: true,
  });

  const { data: reports = [], isLoading: reportsLoading } = useQuery<ReportWithQuiz[]>({
    queryKey: ["/api/student/reports", userId],
    queryFn: async () => {
      if (!userId) return [];
      const res = await authFetch("/api/student/reports");
      if (!res.ok) return [];
      return res.json();
    },
    enabled: !!userId,
    refetchInterval: 15000,
    refetchOnWindowFocus: true,
  });

  const subjectStats = useMemo(() => {
    const map: Record<string, { totalScore: number; maxPossibleScore: number }> = {};
    reports.forEach((r) => {
      // Prefer standardized subject, fall back to topic, then "General"
      const subj = r.quiz.subject || r.quiz.topic || "General";
      if (!map[subj]) map[subj] = { totalScore: 0, maxPossibleScore: 0 };
      map[subj].maxPossibleScore += r.maxScore || 0;
      map[subj].totalScore += r.score;
    });
    return Object.entries(map).map(([subject, { totalScore, maxPossibleScore }]) => ({
      subject,
      percentage: maxPossibleScore > 0 ? Math.round((totalScore / maxPossibleScore) * 100) : 0,
    }));
  }, [reports]);

  const bestSubject = useMemo(() => {
    if (!subjectStats.length) return null;
    return subjectStats.reduce((best, curr) => curr.percentage > best.percentage ? curr : best);
  }, [subjectStats]);

  const availableQuizzes = useMemo(() => {
    // Backend already filters for published + pending assignments — no frontend filter needed
    return (somaQuizzes || [])
      .map((q: SomaQuiz & { isAssigned?: boolean; dueDate?: string }) => ({
        id: q.id,
        title: q.title,
        subject: q.subject || q.topic || "General",
        level: q.level || "",
        isAssigned: q.isAssigned || false,
        dueDate: q.dueDate || null,
      }));
  }, [somaQuizzes]);

  const allSubjects = useMemo(() => {
    const set = new Set<string>();
    availableQuizzes.forEach((q) => set.add(q.subject));
    return Array.from(set).sort();
  }, [availableQuizzes]);

  const allLevels = useMemo(() => {
    const set = new Set<string>();
    availableQuizzes.forEach((q) => { if (q.level) set.add(q.level); });
    return Array.from(set).sort();
  }, [availableQuizzes]);

  const filteredQuizzes = useMemo(() => {
    return availableQuizzes.filter((q) => {
      if (subjectFilter !== "all" && q.subject !== subjectFilter) return false;
      if (levelFilter !== "all" && q.level !== levelFilter) return false;
      return true;
    });
  }, [availableQuizzes, subjectFilter, levelFilter]);

  const completedItems = useMemo(() => {
    return reports.map((r) => ({
      id: r.id,
      quizId: r.quizId,
      title: r.quiz.title,
      subject: r.quiz.subject || r.quiz.topic || "General",
      score: r.score,
      maxScore: r.maxScore || 1,
      status: r.status,
      feedbackHtml: r.aiFeedbackHtml,
      date: r.createdAt,
    })).sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  }, [reports]);

  const retryMutation = useMutation({
    mutationFn: async (reportId: number) => {
      const res = await authFetch(`/api/soma/reports/${reportId}/retry`, { method: "POST" });
      if (!res.ok) throw new Error("Retry failed");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/student/reports", userId] });
    },
  });

  const handleLogout = async () => {
    await supabase.auth.signOut();
    setLocation("/login");
  };

  const now = new Date();
  const avatarRingColor = bestSubject ? getSubjectColor(bestSubject.subject).hex : "#8B5CF6";
  const initials = displayName.split(" ").map((n: string) => n[0]).join("").toUpperCase().slice(0, 2);
  const isLoading = somaLoading || reportsLoading;

  const visibleAvailable = showAllAvailable ? filteredQuizzes : filteredQuizzes.slice(0, 4);
  const visibleCompleted = showAllCompleted ? completedItems : completedItems.slice(0, 5);

  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-800/60 bg-slate-950/80 backdrop-blur-xl sticky top-0 z-20">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <Link href="/">
            <div className="flex items-center gap-3 cursor-pointer" data-testid="link-dashboard-home">
              <img src="/MCEC - White Logo.png" alt="MCEC Logo" loading="lazy" className="h-10 w-auto object-contain" />
              <div>
                <h1 className="text-lg font-bold gradient-text" data-testid="text-dashboard-title">SOMA</h1>
                <p className="text-[10px] text-slate-400 tracking-widest uppercase">Student Dashboard</p>
              </div>
            </div>
          </Link>

          <div className="flex items-center gap-4">
            <div className="flex items-center gap-3">
              <div
                className="w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold text-white"
                style={{ backgroundColor: "rgba(139,92,246,0.3)", boxShadow: `0 0 16px ${avatarRingColor}50`, border: `2px solid ${avatarRingColor}` }}
                data-testid="avatar-user"
              >
                {initials}
              </div>
              <div className="hidden sm:block">
                <p className="text-sm font-medium text-slate-200" data-testid="text-user-name">{displayName}</p>
                <p className="text-[10px] text-slate-400">{session?.user?.email}</p>
              </div>
            </div>
            <button
              onClick={handleLogout}
              className="text-slate-400 hover:text-slate-300 transition-colors p-2 min-h-[44px] min-w-[44px]"
              aria-label="Log out"
              data-testid="button-logout"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 py-8 space-y-8">
        {isLoading ? (
          <div className="space-y-6" data-testid="dashboard-skeleton-loading">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {[1, 2, 3, 4].map((i) => (
                <div key={i} className={`${CARD_CLASS} animate-pulse`}>
                  <div className="flex flex-col items-center gap-3">
                    <div className="w-32 h-32 rounded-full bg-slate-800" />
                    <div className="h-3 w-16 rounded bg-slate-800" />
                  </div>
                </div>
              ))}
            </div>
            <div className="grid md:grid-cols-2 gap-6">
              {[1, 2].map((i) => (
                <div key={i} className={`${CARD_CLASS} animate-pulse`}>
                  <div className="h-4 w-40 mb-5 rounded bg-slate-800" />
                  {[1, 2, 3].map((j) => (
                    <div key={j} className="h-20 w-full mb-3 rounded-xl bg-slate-800" />
                  ))}
                </div>
              ))}
            </div>
          </div>
        ) : (
          <>
            {subjectStats.length > 0 && (
              <section>
                <h2 className={`${SECTION_LABEL} mb-5`} data-testid="text-section-performance">
                  Performance by Subject
                </h2>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  {subjectStats.map((s) => (
                    <DonutCard
                      key={s.subject}
                      subject={s.subject}
                      percentage={s.percentage}
                      color={getSubjectColor(s.subject).hex}
                    />
                  ))}
                </div>
              </section>
            )}

            <div className="grid md:grid-cols-2 gap-6">
              <section className={CARD_CLASS}>
                <h2 className="text-3xl font-bold tracking-wide text-slate-200" data-testid="text-section-available">
                  Your Assessments
                </h2>

                <div className="mt-4 mb-2 overflow-x-auto pb-2 -mx-1 px-1" data-testid="filter-bar">
                  <div className="flex items-center gap-2 min-w-max">
                    <select
                      value={subjectFilter}
                      onChange={(e) => setSubjectFilter(e.target.value)}
                      className="bg-slate-800/60 border border-slate-700 text-slate-300 text-xs px-3 py-2 min-h-[44px] rounded-lg focus:outline-none focus:ring-1 focus:ring-violet-500/50"
                      data-testid="select-subject-filter"
                    >
                      <option value="all">All Subjects</option>
                      {allSubjects.map((s) => <option key={s} value={s}>{s}</option>)}
                    </select>
                    <select
                      value={levelFilter}
                      onChange={(e) => setLevelFilter(e.target.value)}
                      className="bg-slate-800/60 border border-slate-700 text-slate-300 text-xs px-3 py-2 min-h-[44px] rounded-lg focus:outline-none focus:ring-1 focus:ring-violet-500/50"
                      data-testid="select-level-filter"
                    >
                      <option value="all">All Levels</option>
                      {allLevels.map((l) => <option key={l} value={l}>{l}</option>)}
                    </select>
                  </div>
                </div>

                <div className="flex flex-col gap-6 mt-6 mb-10">
                  {filteredQuizzes.length === 0 ? (
                    <div className="bg-slate-800/30 rounded-xl p-8 text-center border border-slate-800/50">
                      <BookOpen className="w-10 h-10 mx-auto text-slate-600 mb-3" />
                      <p className="text-sm text-slate-400">No quizzes assigned to you yet</p>
                      <p className="text-xs text-slate-500 mt-1">Your tutor will assign assessments when they're ready</p>
                    </div>
                  ) : (
                    <>
                      {visibleAvailable.map((q) => {
                        const sc = getSubjectColor(q.subject);
                        const SubjectIcon = getSubjectIcon(q.subject);
                        return (
                          <Link
                            key={q.id}
                            href={`/soma/quiz/${q.id}`}
                          >
                            <div
                              className={`bg-slate-800/40 border rounded-xl p-6 cursor-pointer transition-all duration-300 hover:border-violet-500/40 hover:bg-slate-800/60 hover:shadow-[0_0_24px_rgba(139,92,246,0.08)] group ${q.isAssigned ? "border-violet-500/40 shadow-[0_0_16px_rgba(139,92,246,0.06)]" : "border-slate-700/50"}`}
                              data-testid={`card-available-quiz-${q.id}`}
                            >
                              <div className="flex items-start justify-between gap-3">
                                <div className={`w-10 h-10 rounded-xl ${sc.bg} border ${sc.border} flex items-center justify-center shrink-0`}>
                                  <SubjectIcon className={`w-5 h-5 ${sc.label}`} />
                                </div>
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center gap-2 mb-1.5 flex-wrap">
                                    <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${sc.bg} ${sc.label}`}>
                                      {q.subject}
                                    </span>
                                    {q.level && (
                                      <span className="text-[10px] text-slate-400 px-2 py-0.5 rounded-full bg-slate-800/60">
                                        {q.level}
                                      </span>
                                    )}
                                    {q.isAssigned && (
                                      <span
                                        className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-violet-500/15 text-violet-400 border border-violet-500/30"
                                        data-testid={`badge-assigned-${q.id}`}
                                      >
                                        Assigned to you
                                      </span>
                                    )}
                                    {q.dueDate && (() => {
                                      const due = new Date(q.dueDate);
                                      const isOverdue = due.getTime() < Date.now();
                                      return (
                                        <span
                                          className={`inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full ${
                                            isOverdue
                                              ? "bg-red-500/15 text-red-400 border border-red-500/30"
                                              : "bg-amber-500/10 text-amber-400 border border-amber-500/20"
                                          }`}
                                          data-testid={`badge-due-${q.id}`}
                                        >
                                          <Calendar className="w-3 h-3" />
                                          {isOverdue ? "Overdue" : `Due: ${format(due, "MMM d, h:mm a")}`}
                                        </span>
                                      );
                                    })()}
                                  </div>
                                  <h3 className="text-sm font-medium text-slate-200 truncate" data-testid={`text-available-title-${q.id}`}>
                                    {q.title}
                                  </h3>
                                </div>
                                <ArrowRight className="w-4 h-4 text-slate-600 group-hover:text-violet-400 transition-colors mt-1 flex-shrink-0" />
                              </div>
                            </div>
                          </Link>
                        );
                      })}
                      {filteredQuizzes.length > 4 && (
                        <button
                          onClick={() => setShowAllAvailable(!showAllAvailable)}
                          className="w-full text-center py-2.5 min-h-[44px] text-xs font-medium text-violet-400 hover:text-violet-300 border border-slate-700/50 rounded-xl bg-slate-800/20 hover:bg-slate-800/40 transition-all"
                          data-testid="button-show-more-available"
                        >
                          {showAllAvailable ? "Show Less" : `Show More (${filteredQuizzes.length - 4} more)`}
                        </button>
                      )}
                    </>
                  )}
                </div>
              </section>

              <section className={CARD_CLASS}>
                <h2 className="text-3xl font-bold tracking-wide text-slate-200 mb-5" data-testid="text-section-completed">
                  Completed Quizzes
                </h2>
                <div className="flex flex-col gap-6 mt-6 mb-10">
                  {completedItems.length === 0 ? (
                    <div className="bg-slate-800/30 rounded-xl p-8 text-center border border-slate-800/50">
                      <CheckCircle2 className="w-10 h-10 mx-auto text-slate-600 mb-3" />
                      <p className="text-sm text-slate-400">No completed quizzes yet</p>
                    </div>
                  ) : (
                    <>
                      {visibleCompleted.map((item) => {
                        const sc = getSubjectColor(item.subject);
                        const CompletedSubjectIcon = getSubjectIcon(item.subject);
                        const pct = item.maxScore > 0 ? Math.round((item.score / item.maxScore) * 100) : 0;
                        const isPending = item.status === "pending";
                        const isFailed = item.status === "failed";
                        const hasAiAnalysis = !!item.feedbackHtml && !isPending;
                        const isLoadingThis = loadingAnalysisId === `soma-${item.quizId}`;
                        return (
                          <div
                            key={item.id}
                            className="bg-slate-800/40 border border-slate-700/50 rounded-xl p-6 transition-all duration-300"
                            data-testid={`card-completed-${item.id}`}
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div className={`w-10 h-10 rounded-xl ${sc.bg} border ${sc.border} flex items-center justify-center shrink-0`}>
                                <CompletedSubjectIcon className={`w-5 h-5 ${sc.label}`} />
                              </div>
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 mb-1.5">
                                  <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${sc.bg} ${sc.label}`}>
                                    {item.subject}
                                  </span>
                                  {isPending ? (
                                    <span className="flex items-center gap-1 text-[10px] text-amber-400" data-testid={`status-pending-${item.id}`}>
                                      <Loader2 className="w-3 h-3 animate-spin" />
                                      Your Report is being generated...
                                    </span>
                                  ) : isFailed ? (
                                    <span className="flex items-center gap-1 text-[10px] text-red-400" data-testid={`status-failed-${item.id}`}>
                                      <AlertTriangle className="w-3 h-3" />
                                      Analysis Failed
                                    </span>
                                  ) : (
                                    <span className="flex items-center gap-1 text-[10px] text-emerald-400" data-testid={`status-completed-${item.id}`}>
                                      <CheckCircle2 className="w-3 h-3" />
                                      Graded
                                    </span>
                                  )}
                                  {/* Diagnostic report icon — clickable */}
                                  <button
                                    className={`p-0.5 rounded transition-colors ${
                                      isLoadingThis
                                        ? "text-amber-400 animate-spin cursor-wait"
                                        : isFailed
                                          ? "text-red-500 hover:text-red-400 cursor-pointer"
                                          : hasAiAnalysis
                                            ? "text-emerald-400 hover:text-emerald-300 cursor-pointer"
                                            : "text-amber-500 animate-pulse hover:text-amber-400 cursor-pointer"
                                    }`}
                                    title={isLoadingThis ? "Your Report is being generated..." : hasAiAnalysis ? "View Diagnostic Report" : "Generate Diagnostic Report"}
                                    data-testid={`icon-ai-status-${item.id}`}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      if (isLoadingThis) return;
                                      if (hasAiAnalysis && item.feedbackHtml) {
                                        setAnalysisPopup({ title: item.title, html: item.feedbackHtml });
                                      } else {
                                        fetchAnalysis({ quizId: item.quizId, title: item.title });
                                      }
                                    }}
                                  >
                                    {isLoadingThis ? (
                                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                    ) : (
                                      <FileText className="w-3.5 h-3.5" />
                                    )}
                                  </button>
                                </div>
                                <h3 className="text-sm font-medium text-slate-200 truncate" data-testid={`text-completed-title-${item.id}`}>
                                  {item.title}
                                </h3>
                                <div className="flex items-center gap-3 mt-2 text-[11px] text-slate-400">
                                  <span>{format(new Date(item.date), "MMM d, yyyy")}</span>
                                </div>
                              </div>
                              <div className="text-right flex-shrink-0">
                                <div
                                  className="text-2xl font-bold"
                                  style={{ color: pct >= 70 ? "#10b981" : pct >= 50 ? "#f59e0b" : "#f43f5e", textShadow: `0 0 12px ${pct >= 70 ? "#10b98130" : pct >= 50 ? "#f59e0b30" : "#f43f5e30"}` }}
                                  data-testid={`text-score-${item.id}`}
                                >
                                  {pct}%
                                </div>
                                <div className="text-[10px] text-slate-400">
                                  {item.score}/{item.maxScore}
                                </div>
                                <div className="flex items-center gap-2 mt-1.5 justify-end">
                                  {/* Eye icon to review quiz answers */}
                                  {(
                                    <Link href={`/soma/review/${item.id}`}>
                                      <button
                                        className="text-cyan-400 hover:text-cyan-300 transition-colors p-0.5"
                                        title="Review answers"
                                        data-testid={`button-review-quiz-${item.id}`}
                                      >
                                        <Eye className="w-4 h-4" />
                                      </button>
                                    </Link>
                                  )}
                                  {item.feedbackHtml && !isPending && (
                                    <button
                                      onClick={() => {
                                        const w = window.open("", "_blank");
                                        if (w) {
                                          w.document.write(`
                                            <html><head><title>${item.title} - Report</title>
                                            <style>body{font-family:system-ui;padding:40px;max-width:800px;margin:0 auto;background:#0b0f1a;color:#e2e8f0}h3{color:#a78bfa}ul{padding-left:20px}li{margin-bottom:8px}hr{border-color:#1e293b}</style>
                                            </head><body>${item.feedbackHtml}</body></html>
                                          `);
                                          w.document.close();
                                        }
                                      }}
                                      className="text-[10px] text-violet-400 hover:text-violet-300 block transition-colors"
                                      data-testid={`button-view-report-${item.id}`}
                                    >
                                      View Report →
                                    </button>
                                  )}
                                </div>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                      {completedItems.length > 5 && (
                        <button
                          onClick={() => setShowAllCompleted(!showAllCompleted)}
                          className="w-full text-center py-2.5 min-h-[44px] text-xs font-medium text-violet-400 hover:text-violet-300 border border-slate-700/50 rounded-xl bg-slate-800/20 hover:bg-slate-800/40 transition-all"
                          data-testid="button-show-more-completed"
                        >
                          {showAllCompleted ? "Show Less" : `Show More (${completedItems.length - 5} more)`}
                        </button>
                      )}
                    </>
                  )}
                </div>
              </section>
            </div>

            <section className="flex justify-center pt-2 pb-6">
              <button
                className="group relative inline-flex items-center gap-2.5 px-7 py-3.5 rounded-2xl font-semibold text-sm text-emerald-300 bg-emerald-500/5 border border-emerald-500/20 ring-2 ring-emerald-500/20 hover:bg-emerald-500/10 hover:ring-emerald-500/40 hover:border-emerald-500/40 transition-all duration-300 shadow-[0_0_30px_rgba(16,185,129,0.08)] hover:shadow-[0_0_40px_rgba(16,185,129,0.15)]"
                data-testid="button-consult-ai-tutor"
                onClick={() => setLocation("/soma/chat")}
              >
                <Sparkles className="w-4.5 h-4.5 text-emerald-400 group-hover:animate-pulse" />
                Consult SOMA Tutor
                <ArrowRight className="w-4 h-4 opacity-0 -translate-x-2 group-hover:opacity-100 group-hover:translate-x-0 transition-all duration-300" />
              </button>
            </section>
          </>
        )}
      </main>

      {/* Diagnostic Report Popup Overlay */}
      {analysisPopup && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
          onClick={() => setAnalysisPopup(null)}
        >
          <div
            className="bg-white text-gray-900 rounded-2xl shadow-2xl max-w-2xl w-full max-h-[85vh] overflow-y-auto p-8 relative"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={() => setAnalysisPopup(null)}
              className="absolute top-4 right-4 text-gray-400 hover:text-gray-600 text-xl font-bold"
            >
              &times;
            </button>
            <h2 className="text-lg font-bold text-gray-800 mb-4 pr-8">{analysisPopup.title} — Diagnostic Report</h2>
            <div
              className="prose prose-sm max-w-none"
              dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(analysisPopup.html) }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
