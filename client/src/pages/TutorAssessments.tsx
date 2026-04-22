import { useState, useCallback, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import { supabase, authFetch } from "@/lib/supabase";
import { useSupabaseSession } from "@/hooks/use-supabase-session";
import { getSubjectColor, getSubjectIcon } from "@/lib/subjectColors";
import type { SomaQuiz, SomaReport, SomaQuestion, QuizAssignment } from "@shared/schema";
import {
  LogOut, Users, BookOpen, Plus, X, ChevronDown, ChevronUp,
  Loader2, Check, LayoutDashboard, Clock, Award, Timer,
  FileText, Eye, UserPlus, UserMinus, Trash2, AlertTriangle,
  ClockArrowUp, Pencil, Search,
} from "lucide-react";
import DOMPurify from "dompurify";
import { useToast } from "@/hooks/use-toast";
import { emitSomaMutation } from "@/lib/realtimeEvents";
import MarkdownRenderer from "@/components/MarkdownRenderer";
import { formatDuration as baseFormatDuration } from "@/lib/utils";

function formatDuration(
  startedAt: string | Date | null,
  completedAt: string | Date | null,
): string {
  return baseFormatDuration(startedAt, completedAt, "—");
}


interface SomaUser {
  id: string;
  email: string;
  displayName: string | null;
  role: string;
}

interface AssignmentWithStudent extends QuizAssignment {
  student: SomaUser;
}

interface QuizReportsData {
  quiz: SomaQuiz;
  reports: (SomaReport & { quiz: SomaQuiz })[];
  questions: SomaQuestion[];
  maxScore: number;
}

interface QuizAssignmentWithStudent {
  id: number;
  quizId: number;
  studentId: string;
  status: string;
  dueDate: string | null;
  createdAt: string;
  student: SomaUser;
}

const CARD_CLASS = "bg-slate-900/80 backdrop-blur-md border border-slate-800 rounded-2xl p-6 shadow-2xl";

function formatDate(dateStr: string | Date | null): string {
  if (!dateStr) return "—";
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-ZA", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

function scoreColor(score: number, max: number): string {
  if (max === 0) return "text-slate-400";
  const pct = (score / max) * 100;
  if (pct >= 80) return "text-emerald-400";
  if (pct >= 50) return "text-amber-400";
  return "text-red-400";
}

function scoreBg(score: number, max: number): string {
  if (max === 0) return "bg-slate-500/10";
  const pct = (score / max) * 100;
  if (pct >= 80) return "bg-emerald-500/10 border-emerald-500/30";
  if (pct >= 50) return "bg-amber-500/10 border-amber-500/30";
  return "bg-red-500/10 border-red-500/30";
}

function StudentReportCard({ report, maxScore, questions, onViewReport }: {
  report: SomaReport & { quiz: SomaQuiz };
  maxScore: number;
  questions: SomaQuestion[];
  onViewReport: (report: SomaReport) => void;
}) {
  const studentName = report.studentName ?? "Student";
  const score = typeof report.score === "number" ? report.score : 0;
  const pct = maxScore > 0 ? Math.round((score / maxScore) * 100) : 0;
  const duration = formatDuration(report.startedAt, report.completedAt);
  const startedDate = formatDate(report.startedAt);
  const answersObj = (report.answersJson || {}) as Record<string, string>;
  const safeQuestions = questions ?? [];
  const correctCount = safeQuestions.filter(q => answersObj[String(q.id)] === q.correctAnswer).length;
  const initials = studentName
    .split(" ")
    .map((n) => n[0] ?? "")
    .join("")
    .toUpperCase()
    .slice(0, 2) || "?";

  return (
    <div
      className={`rounded-xl border p-4 transition-all hover:bg-slate-800/40 ${scoreBg(report.score, maxScore)}`}
      data-testid={`student-report-${report.id}`}
    >
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <div className="w-9 h-9 rounded-full bg-violet-500/20 border border-violet-500/40 flex items-center justify-center shrink-0">
            <span className="text-xs font-bold text-violet-300">
              {initials}
            </span>
          </div>
          <div className="min-w-0">
            <p className="text-sm font-medium text-slate-200 truncate" data-testid={`report-student-name-${report.id}`}>
              {studentName}
            </p>
            <div className="flex items-center gap-3 text-[11px] text-slate-400 mt-0.5">
              {startedDate !== "—" && (
                <span className="flex items-center gap-1">
                  <Clock className="w-3 h-3" />
                  Started {startedDate}
                </span>
              )}
              {duration !== "—" && (
                <span className="flex items-center gap-1">
                  <Timer className="w-3 h-3 text-violet-400" />
                  {duration}
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <div className="text-right">
            <p className={`text-lg font-bold ${scoreColor(report.score, maxScore)}`} data-testid={`report-score-${report.id}`}>
              {report.score}/{maxScore}
            </p>
            <p className={`text-[10px] font-semibold ${scoreColor(report.score, maxScore)}`}>
              {pct}% — {correctCount}/{questions.length} correct
            </p>
          </div>
          <button
            onClick={() => onViewReport(report)}
            className="flex items-center gap-1.5 px-3 py-2 min-h-[40px] rounded-lg text-xs font-medium bg-violet-500/15 text-violet-300 border border-violet-500/30 hover:bg-violet-500/25 transition-all"
            data-testid={`button-view-report-${report.id}`}
          >
            <Eye className="w-3.5 h-3.5" />
            View
          </button>
        </div>
      </div>
    </div>
  );
}

function ReportDetailModal({ report, questions, maxScore, onClose }: {
  report: SomaReport & { quiz: SomaQuiz };
  questions: SomaQuestion[];
  maxScore: number;
  onClose: () => void;
}) {
  const answersObj = (report.answersJson || {}) as Record<string, string>;
  const score = typeof report.score === "number" ? report.score : 0;
  const pct = maxScore > 0 ? Math.round((score / maxScore) * 100) : 0;
  const duration = formatDuration(report.startedAt, report.completedAt);
  const studentName = report.studentName ?? "Student";
  const quizTitle = report.quiz?.title ?? "Assessment";
  const safeQuestions = questions ?? [];

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 backdrop-blur-sm p-4 overflow-y-auto" onClick={onClose}>
      <div className="bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl max-w-3xl w-full my-8" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-3 p-6 border-b border-slate-800">
          <div>
            <h3 className="text-lg font-bold text-slate-200" data-testid="modal-student-name">{studentName}</h3>
            <p className="text-xs text-slate-400 mt-0.5">{quizTitle}</p>
          </div>
          <div className="flex items-center gap-3">
            <div className="text-right">
              <p className={`text-xl font-bold ${scoreColor(score, maxScore)}`}>{pct}%</p>
              <p className="text-[10px] text-slate-400">{score}/{maxScore} marks</p>
            </div>
            <button onClick={onClose} className="text-slate-400 hover:text-slate-300 p-2 min-h-[44px] min-w-[44px]" data-testid="button-close-report">
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        <div className="p-6 space-y-4">
          <div className="flex flex-wrap gap-3 text-xs">
            {report.startedAt && (
              <span className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800/60 border border-slate-700/50 text-slate-300">
                <Clock className="w-3.5 h-3.5 text-slate-400" />
                Started: {formatDate(report.startedAt)}
              </span>
            )}
            {report.completedAt && (
              <span className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800/60 border border-slate-700/50 text-slate-300">
                <Check className="w-3.5 h-3.5 text-emerald-400" />
                Completed: {formatDate(report.completedAt)}
              </span>
            )}
            {duration !== "—" && (
              <span className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-violet-500/10 border border-violet-500/30 text-violet-300">
                <Timer className="w-3.5 h-3.5" />
                Duration: {duration}
              </span>
            )}
          </div>

          <div className="space-y-3">
            <h4 className="text-sm font-semibold text-slate-300 flex items-center gap-2">
              <FileText className="w-4 h-4 text-violet-400" />
              Questions & Answers
            </h4>
            {safeQuestions.length === 0 && (
              <p className="text-xs text-slate-500 italic">No questions are linked to this report.</p>
            )}
            {safeQuestions.map((q, idx) => {
              const stem = q.stem ?? "";
              const correctAnswer = q.correctAnswer ?? "";
              const explanation = q.explanation ?? "";
              const marks = typeof q.marks === "number" ? q.marks : 0;
              const studentAnswerRaw = answersObj[String(q.id)];
              const studentAnswer = studentAnswerRaw && studentAnswerRaw.length > 0 ? studentAnswerRaw : null;
              const isCorrect = studentAnswer !== null && studentAnswer === correctAnswer;
              return (
                <div
                  key={q.id}
                  className={`rounded-xl border p-4 ${isCorrect ? "bg-emerald-500/5 border-emerald-500/20" : "bg-red-500/5 border-red-500/20"}`}
                  data-testid={`modal-question-${q.id}`}
                >
                  <div className="flex items-start gap-2 mb-2">
                    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded shrink-0 ${isCorrect ? "bg-emerald-500/20 text-emerald-400" : "bg-red-500/20 text-red-400"}`}>
                      Q{idx + 1}
                    </span>
                    <div className="text-sm text-slate-300 flex-1 min-w-0">
                      <MarkdownRenderer content={stem} />
                    </div>
                    <span className="text-[10px] text-slate-500 shrink-0">{marks} mark{marks !== 1 ? "s" : ""}</span>
                  </div>
                  <div className="ml-7 space-y-1.5">
                    <div className="text-xs flex flex-wrap items-baseline gap-1">
                      <span className="text-slate-500">Student:</span>
                      {studentAnswer === null ? (
                        <span className="text-slate-500 italic">Not answered</span>
                      ) : (
                        <span className={`${isCorrect ? "text-emerald-400" : "text-red-400"} inline-block`}>
                          <MarkdownRenderer content={studentAnswer} />
                        </span>
                      )}
                    </div>
                    {!isCorrect && correctAnswer && (
                      <div className="text-xs flex flex-wrap items-baseline gap-1">
                        <span className="text-slate-500">Correct:</span>
                        <span className="text-emerald-400 inline-block">
                          <MarkdownRenderer content={correctAnswer} />
                        </span>
                      </div>
                    )}
                    {explanation && (
                      <div className="text-[11px] text-slate-400 mt-1 italic">
                        <MarkdownRenderer content={explanation} />
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {report.aiFeedbackHtml && (
            <div className="mt-4">
              <h4 className="text-sm font-semibold text-slate-300 flex items-center gap-2 mb-3">
                <Award className="w-4 h-4 text-violet-400" />
                Diagnostic Report
              </h4>
              <div
                className="prose prose-sm prose-invert max-w-none bg-slate-800/40 rounded-xl p-4 border border-slate-700/50 text-slate-300 [&_h3]:text-violet-300 [&_strong]:text-slate-200 [&_li]:text-slate-300"
                dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(report.aiFeedbackHtml) }}
                data-testid="modal-ai-feedback"
              />
            </div>
          )}

          {report.status === "pending" && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-400 text-xs">
              <Loader2 className="w-4 h-4 animate-spin" />
              Diagnostic report is still being generated...
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function TutorAssessments() {
  const queryClient = useQueryClient();
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [showAssignModal, setShowAssignModal] = useState<number | null>(null);
  const [selectedStudentIds, setSelectedStudentIds] = useState<Set<string>>(new Set());
  const [dueDate, setDueDate] = useState("");
  const [expandedQuiz, setExpandedQuiz] = useState<number | null>(null);
  const [viewingReport, setViewingReport] = useState<{ report: SomaReport & { quiz: SomaQuiz }; questions: SomaQuestion[]; maxScore: number } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<{ quizId: number; title: string } | null>(null);
  const [confirmDeleteQuestion, setConfirmDeleteQuestion] = useState<{ questionId: number; stem: string } | null>(null);
  const [reportSortBy, setReportSortBy] = useState<"student" | "time_allocated" | "time_submitted">("time_submitted");
  const [subjectFilter, setSubjectFilter] = useState("");
  const [levelFilter, setLevelFilter] = useState("");
  const [studentFilter, setStudentFilter] = useState("");
  const [quizSortBy, setQuizSortBy] = useState<"latest_submission" | "newest" | "title" | "subject">("latest_submission");
  const [assignmentStatusFilter, setAssignmentStatusFilter] = useState<"all" | "submitted" | "not_submitted">("all");
  const [assignmentStudentFilter, setAssignmentStudentFilter] = useState<string>("all");
  const [allocationDateFilter, setAllocationDateFilter] = useState("");
  const [assignSearch, setAssignSearch] = useState("");
  const [assignResult, setAssignResult] = useState<{
    quizId: number;
    requested: number;
    assigned: number;
    alreadyAssigned: number;
    notAdopted: number;
    failed: number;
    perStudent: Array<{ studentId: string; name: string; email: string | null; status: "assigned" | "already_assigned" | "not_adopted" | "failed" }>;
  } | null>(null);

  const { session, userId, isLoading: authLoading } = useSupabaseSession();
  const displayName = session?.user?.user_metadata?.display_name || session?.user?.email?.split("@")[0] || "Tutor";
  const initials = displayName.split(" ").map((n: string) => n[0]).join("").toUpperCase().slice(0, 2);

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

  const { data: assessmentsOverview = [] } = useQuery<Array<{ quizId: number; assignedStudentIds: string[]; latestSubmissionAt: string | null }>>({
    queryKey: ["/api/tutor/assessments-overview", userId],
    queryFn: async () => {
      if (!userId) return [];
      const res = await authFetch("/api/tutor/assessments-overview");
      if (!res.ok) return [];
      return res.json();
    },
    enabled: !!userId,
    refetchInterval: 15000,
    refetchOnWindowFocus: true,
  });

  const overviewByQuizId = useMemo(() => {
    const map = new Map<number, { assignedStudentIds: string[]; latestSubmissionAt: string | null }>();
    for (const o of assessmentsOverview) map.set(o.quizId, o);
    return map;
  }, [assessmentsOverview]);

  const subjectOptions = useMemo(
    () => Array.from(new Set(tutorQuizzes.map((q) => q.subject).filter((s): s is string => !!s))).sort(),
    [tutorQuizzes],
  );
  const levelOptions = useMemo(
    () => Array.from(new Set(tutorQuizzes.map((q) => q.level).filter((l): l is string => !!l))).sort(),
    [tutorQuizzes],
  );

  const filteredSortedQuizzes = useMemo(() => {
    let list = tutorQuizzes.filter((q) => {
      if (subjectFilter && q.subject !== subjectFilter) return false;
      if (levelFilter && q.level !== levelFilter) return false;
      if (studentFilter) {
        const ov = overviewByQuizId.get(q.id);
        if (!ov || !ov.assignedStudentIds.includes(studentFilter)) return false;
      }
      return true;
    });
    list = [...list];
    list.sort((a, b) => {
      switch (quizSortBy) {
        case "title":
          return (a.title || "").localeCompare(b.title || "");
        case "subject":
          return (a.subject || "").localeCompare(b.subject || "") || (a.title || "").localeCompare(b.title || "");
        case "newest":
          return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
        case "latest_submission":
        default: {
          const at = overviewByQuizId.get(a.id)?.latestSubmissionAt;
          const bt = overviewByQuizId.get(b.id)?.latestSubmissionAt;
          const av = at ? new Date(at).getTime() : 0;
          const bv = bt ? new Date(bt).getTime() : 0;
          if (bv !== av) return bv - av;
          return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
        }
      }
    });
    return list;
  }, [tutorQuizzes, subjectFilter, levelFilter, studentFilter, quizSortBy, overviewByQuizId]);

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

  const { data: quizReportsData, isLoading: reportsLoading } = useQuery<QuizReportsData>({
    queryKey: ["/api/tutor/quizzes", expandedQuiz, "reports"],
    queryFn: async () => {
      const res = await authFetch(`/api/tutor/quizzes/${expandedQuiz}/reports`);
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
    enabled: !!expandedQuiz && !!userId,
  });

  const assignMutation = useMutation({
    mutationFn: async ({ quizId, studentIds, dueDate: dd }: { quizId: number; studentIds: string[]; dueDate?: string }) => {
      const payload: any = { studentIds };
      if (dd) payload.dueDate = new Date(dd).toISOString();
      const res = await authFetch(`/api/tutor/quizzes/${quizId}/assign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error("Failed to assign");
      return res.json();
    },
    onSuccess: (data, variables) => {
      setShowAssignModal(null);
      setSelectedStudentIds(new Set());
      setDueDate("");
      setAssignSearch("");
      setAssignResult({
        quizId: variables.quizId,
        requested: data?.requested ?? 0,
        assigned: data?.assigned ?? 0,
        alreadyAssigned: data?.alreadyAssigned ?? 0,
        notAdopted: data?.notAdopted ?? 0,
        failed: data?.failed ?? 0,
        perStudent: Array.isArray(data?.perStudent) ? data.perStudent : [],
      });
      queryClient.invalidateQueries({ queryKey: ["/api/tutor/quizzes", variables.quizId, "assignments"] });
      queryClient.invalidateQueries({ queryKey: ["/api/tutor/dashboard-stats"] });
      emitSomaMutation({ type: "assessment_assigned", quizId: variables.quizId });
    },
    onError: (err: Error) => {
      toast({ title: "Assignment failed", description: err.message, variant: "destructive" });
    },
  });

  const { data: quizAssignments = [], isLoading: assignmentsLoading } = useQuery<QuizAssignmentWithStudent[]>({
    queryKey: ["/api/tutor/quizzes", expandedQuiz, "assignments"],
    queryFn: async () => {
      const res = await authFetch(`/api/tutor/quizzes/${expandedQuiz}/assignments`);
      if (!res.ok) return [];
      return res.json();
    },
    enabled: !!expandedQuiz && !!userId,
  });

  const unassignMutation = useMutation({
    mutationFn: async ({ quizId, studentId }: { quizId: number; studentId: string }) => {
      const res = await authFetch(`/api/tutor/quizzes/${quizId}/assignments/${studentId}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("Failed to unassign");
      return res.json();
    },
    onSuccess: () => {
      if (expandedQuiz) {
        queryClient.invalidateQueries({ queryKey: ["/api/tutor/quizzes", expandedQuiz, "assignments"] });
        queryClient.invalidateQueries({ queryKey: ["/api/tutor/quizzes", expandedQuiz, "reports"] });
      }
      emitSomaMutation({ type: "status_changed", quizId: expandedQuiz ?? undefined });
    },
  });

  const deleteQuizMutation = useMutation({
    mutationFn: async (quizId: number) => {
      const res = await authFetch(`/api/tutor/quizzes/${quizId}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: "Failed to delete" }));
        throw new Error(err.message);
      }
      return res.json();
    },
    onSuccess: () => {
      setConfirmDelete(null);
      setExpandedQuiz(null);
      queryClient.invalidateQueries({ queryKey: ["/api/tutor/quizzes"] });
      toast({ title: "Assessment deleted", description: "The assessment was removed." });
      emitSomaMutation({ type: "assessment_deleted" });
    },
    onError: (err: Error) => {
      toast({ title: "Delete failed", description: err.message, variant: "destructive" });
    },
  });

  const extendDeadlineMutation = useMutation({
    mutationFn: async (quizId: number) => {
      const res = await authFetch(`/api/tutor/quizzes/${quizId}/assignments/extend`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hours: 24 }),
      });
      if (!res.ok) throw new Error("Failed to extend deadline");
      return res.json();
    },
    onSuccess: () => {
      if (expandedQuiz) {
        queryClient.invalidateQueries({ queryKey: ["/api/tutor/quizzes", expandedQuiz, "assignments"] });
      }
    },
  });

  const deleteQuestionMutation = useMutation({
    mutationFn: async (questionId: number) => {
      const res = await authFetch(`/api/tutor/questions/${questionId}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("Failed to delete question");
      return res.json();
    },
    onSuccess: () => {
      setConfirmDeleteQuestion(null);
      if (expandedQuiz) {
        queryClient.invalidateQueries({ queryKey: ["/api/tutor/quizzes", expandedQuiz, "reports"] });
      }
    },
  });

  const toggleStudentSelection = useCallback((id: string) => {
    setSelectedStudentIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const selectedStudentList = Array.from(selectedStudentIds);

  const handleLogout = async () => {
    await supabase.auth.signOut();
    setLocation("/login");
  };

  const toggleExpand = (quizId: number) => {
    setExpandedQuiz(prev => prev === quizId ? null : quizId);
  };

  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-800/60 bg-slate-950/80 backdrop-blur-xl sticky top-0 z-20">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <Link href="/">
            <div className="flex items-center gap-3 cursor-pointer">
              <img src="/MCEC - White Logo.png" alt="MCEC Logo" loading="lazy" className="h-10 w-auto object-contain" />
              <div>
                <h1 className="text-lg font-extrabold tracking-tight gradient-text leading-none">SOMA</h1>
                <p className="text-[9px] text-slate-500 tracking-[0.25em] uppercase font-semibold mt-0.5">Assessment Platform</p>
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
            <button onClick={handleLogout} className="text-slate-400 hover:text-slate-300 transition-colors p-2 min-h-[44px] min-w-[44px]" aria-label="Log out">
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
      </header>

      <nav className="border-b border-slate-800/40 bg-slate-950/40 backdrop-blur-md">
        <div className="max-w-6xl mx-auto px-6 flex gap-1">
          <Link href="/tutor">
            <span className="flex items-center gap-2 px-4 py-3 text-sm font-medium text-slate-400 hover:text-slate-300 border-b-2 border-transparent transition-all cursor-pointer" data-testid="nav-dashboard">
              <LayoutDashboard className="w-4 h-4" />
              Dashboard
            </span>
          </Link>
          <Link href="/tutor/students">
            <span className="flex items-center gap-2 px-4 py-3 text-sm font-medium text-slate-400 hover:text-slate-300 border-b-2 border-transparent transition-all cursor-pointer" data-testid="nav-students">
              <Users className="w-4 h-4" />
              Students
            </span>
          </Link>
          <span className="flex items-center gap-2 px-4 py-3 text-sm font-medium text-violet-300 border-b-2 border-violet-500 cursor-default" data-testid="nav-assessments">
            <BookOpen className="w-4 h-4" />
            Assessments
          </span>
        </div>
      </nav>

      <main className="max-w-6xl mx-auto px-6 py-8 space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-bold text-slate-100">My Assessments</h2>
            <p className="text-sm text-slate-400 mt-1">{filteredSortedQuizzes.length} of {tutorQuizzes.length} assessment{tutorQuizzes.length !== 1 ? "s" : ""}</p>
          </div>
          <Link href="/tutor/assessments/new">
            <span className="glow-button flex items-center gap-2 px-5 py-2.5 min-h-[44px] rounded-xl text-sm font-semibold cursor-pointer" data-testid="button-create-new">
              <Plus className="w-4 h-4" />
              Create New
            </span>
          </Link>
        </div>

        <div className={`${CARD_CLASS} flex flex-wrap items-end gap-3 p-4`}>
          <div className="flex flex-col gap-1">
            <label className="text-[10px] uppercase tracking-wide text-slate-500">Subject</label>
            <select
              value={subjectFilter}
              onChange={(e) => setSubjectFilter(e.target.value)}
              className="bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-xs text-slate-300 min-w-[140px]"
              data-testid="filter-subject"
            >
              <option value="">All subjects</option>
              {subjectOptions.map((s) => (<option key={s} value={s}>{s}</option>))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[10px] uppercase tracking-wide text-slate-500">Level</label>
            <select
              value={levelFilter}
              onChange={(e) => setLevelFilter(e.target.value)}
              className="bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-xs text-slate-300 min-w-[120px]"
              data-testid="filter-level"
            >
              <option value="">All levels</option>
              {levelOptions.map((l) => (<option key={l} value={l}>{l}</option>))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[10px] uppercase tracking-wide text-slate-500">Student</label>
            <select
              value={studentFilter}
              onChange={(e) => setStudentFilter(e.target.value)}
              className="bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-xs text-slate-300 min-w-[160px]"
              data-testid="filter-student"
            >
              <option value="">All students</option>
              {adoptedStudents.map((s) => (
                <option key={s.id} value={s.id}>{s.displayName || s.email}</option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1 ml-auto">
            <label className="text-[10px] uppercase tracking-wide text-slate-500">Sort by</label>
            <select
              value={quizSortBy}
              onChange={(e) => setQuizSortBy(e.target.value as any)}
              className="bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-xs text-slate-300 min-w-[180px]"
              data-testid="sort-quizzes"
            >
              <option value="latest_submission">Latest submission</option>
              <option value="newest">Newest created</option>
              <option value="title">Title (A–Z)</option>
              <option value="subject">Subject (A–Z)</option>
            </select>
          </div>
          {(subjectFilter || levelFilter || studentFilter) && (
            <button
              type="button"
              onClick={() => { setSubjectFilter(""); setLevelFilter(""); setStudentFilter(""); }}
              className="text-xs text-slate-400 hover:text-slate-200 underline self-end pb-1"
              data-testid="button-clear-filters"
            >
              Clear filters
            </button>
          )}
        </div>

        {authLoading || quizzesLoading ? (
          <div className="flex justify-center py-16">
            <Loader2 className="w-6 h-6 text-violet-500 animate-spin" />
          </div>
        ) : tutorQuizzes.length === 0 ? (
          <div className={`${CARD_CLASS} text-center py-12`}>
            <BookOpen className="w-12 h-12 mx-auto text-slate-600 mb-4" />
            <p className="text-sm text-slate-400">No assessments created yet</p>
          </div>
        ) : filteredSortedQuizzes.length === 0 ? (
          <div className={`${CARD_CLASS} text-center py-12`}>
            <BookOpen className="w-12 h-12 mx-auto text-slate-600 mb-4" />
            <p className="text-sm text-slate-400">No assessments match the current filters</p>
          </div>
        ) : (
          <div className="space-y-3">
            {filteredSortedQuizzes.map((quiz) => {
              const sc = getSubjectColor(quiz.subject);
              const SubIcon = getSubjectIcon(quiz.subject);
              const isExpanded = expandedQuiz === quiz.id;
              const reports = isExpanded && quizReportsData?.quiz?.id === quiz.id ? quizReportsData.reports : [];
              const questions = isExpanded && quizReportsData?.quiz?.id === quiz.id ? quizReportsData.questions : [];
              const maxScore = isExpanded && quizReportsData?.quiz?.id === quiz.id ? quizReportsData.maxScore : 0;
              const avgScore = reports.length > 0 ? Math.round(reports.reduce((s, r) => s + r.score, 0) / reports.length) : 0;
              const avgPct = reports.length > 0 && maxScore > 0 ? Math.round((avgScore / maxScore) * 100) : 0;
              const currentAssignments = isExpanded ? quizAssignments : [];
              const filteredAssignments = currentAssignments.filter((a) => {
                if (assignmentStudentFilter !== "all" && a.studentId !== assignmentStudentFilter) return false;
                if (assignmentStatusFilter === "submitted" && a.status !== "submitted") return false;
                if (assignmentStatusFilter === "not_submitted" && a.status === "submitted") return false;
                if (allocationDateFilter) {
                  const created = new Date(a.createdAt);
                  const selected = new Date(`${allocationDateFilter}T00:00:00`);
                  if (
                    created.getUTCFullYear() !== selected.getUTCFullYear() ||
                    created.getUTCMonth() !== selected.getUTCMonth() ||
                    created.getUTCDate() !== selected.getUTCDate()
                  ) return false;
                }
                return true;
              });

              return (
                <div key={quiz.id} className="bg-slate-900/60 backdrop-blur-md border border-slate-800 rounded-xl overflow-hidden" data-testid={`quiz-card-${quiz.id}`}>
                  <div
                    className="px-5 py-4 cursor-pointer hover:bg-slate-800/30 transition-colors"
                    onClick={() => toggleExpand(quiz.id)}
                    data-testid={`quiz-tile-${quiz.id}`}
                  >
                    <div className="flex items-center gap-4 flex-1 min-w-0">
                      <div className={`w-10 h-10 rounded-xl flex items-center justify-center border ${sc.border} shrink-0`} style={{ backgroundColor: `${sc.hex}15` }}>
                        <SubIcon className="w-5 h-5" style={{ color: sc.hex }} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 mb-0.5">
                          {isExpanded && reports.length > 0 && (
                            <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-violet-500/10 text-violet-300">
                              {reports.length} submission{reports.length !== 1 ? "s" : ""} · avg {avgPct}%
                            </span>
                          )}
                        </div>
                        <h3 className="text-sm font-medium text-slate-200 truncate">{quiz.title}</h3>
                        <p className="text-xs text-slate-400 mt-0.5">{quiz.topic} · {quiz.level}</p>
                      </div>
                      <div className="p-2 text-slate-400">
                        {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                      </div>
                    </div>

                    <div className="flex items-center gap-2 ml-14" onClick={e => e.stopPropagation()}>
                      <button
                        onClick={() => { setShowAssignModal(quiz.id); setSelectedStudentIds(new Set()); setDueDate(""); }}
                        className="flex items-center gap-1.5 px-3 py-2 min-h-[36px] rounded-lg text-xs font-medium bg-emerald-600/20 text-emerald-400 border border-emerald-500/30 hover:bg-emerald-600/30 transition-all"
                        data-testid={`button-assign-${quiz.id}`}
                      >
                        <UserPlus className="w-3.5 h-3.5" />
                        Assign to Students
                      </button>
                      <Link href={`/tutor/assessments/edit/${quiz.id}`}>
                        <span
                          onClick={(e) => e.stopPropagation()}
                          className="flex items-center justify-center p-2 min-h-[40px] min-w-[40px] rounded-lg text-slate-400 hover:text-violet-300 hover:bg-violet-500/10 transition-all"
                          title="Edit assessment"
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </span>
                      </Link>
                      <button
                        onClick={(e) => { e.stopPropagation(); setConfirmDelete({ quizId: quiz.id, title: quiz.title }); }}
                        className="flex items-center justify-center p-2 min-h-[40px] min-w-[40px] rounded-lg text-slate-400 hover:text-red-400 hover:bg-red-500/10 transition-all"
                        title="Delete assessment"
                        data-testid={`button-delete-quiz-${quiz.id}`}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>

                  {isExpanded && (
                    <div className="border-t border-slate-800/60 px-5 py-4 space-y-5">
                      {/* Assigned Students Section */}
                      {(() => {
                        const currentAssignments = expandedQuiz === quiz.id ? quizAssignments : [];
                        const pendingAssignments = filteredAssignments.filter(a => a.status === "pending");
                        if (assignmentsLoading) return null;
                        if (pendingAssignments.length === 0) return null;
                        return (
                          <div>
                            <div className="flex items-center justify-between mb-3">
                              <h4 className="text-sm font-semibold text-slate-300 flex items-center gap-2">
                                <Users className="w-4 h-4 text-violet-400" />
                                Assigned Students
                              </h4>
                              <div className="flex items-center gap-2">
                                <button
                                  onClick={() => extendDeadlineMutation.mutate(quiz.id)}
                                  disabled={extendDeadlineMutation.isPending}
                                  className="flex items-center gap-1.5 px-2.5 py-1.5 min-h-[32px] rounded-lg text-[11px] font-medium bg-amber-500/10 text-amber-400 border border-amber-500/20 hover:bg-amber-500/20 transition-all disabled:opacity-50"
                                  title="Extend all deadlines by 24 hours"
                                  data-testid={`button-extend-deadline-${quiz.id}`}
                                >
                                  <ClockArrowUp className="w-3 h-3" />
                                  {extendDeadlineMutation.isPending ? "Extending..." : "+24h"}
                                </button>
                                <span className="text-xs text-slate-400">
                                  {pendingAssignments.length} pending
                                </span>
                              </div>
                            </div>
                            <div className="flex flex-wrap items-center gap-2 mb-3">
                              <select value={assignmentStudentFilter} onChange={(e) => setAssignmentStudentFilter(e.target.value)} className="bg-slate-900 border border-slate-700 rounded-lg px-2 py-1 text-[11px] text-slate-300">
                                <option value="all">All students</option>
                                {currentAssignments.map((a) => (
                                  <option key={a.studentId} value={a.studentId}>{a.student.displayName || a.student.email}</option>
                                ))}
                              </select>
                              <select value={assignmentStatusFilter} onChange={(e) => setAssignmentStatusFilter(e.target.value as any)} className="bg-slate-900 border border-slate-700 rounded-lg px-2 py-1 text-[11px] text-slate-300">
                                <option value="all">All statuses</option>
                                <option value="submitted">Submitted</option>
                                <option value="not_submitted">Not submitted</option>
                              </select>
                              <input type="date" value={allocationDateFilter} onChange={(e) => setAllocationDateFilter(e.target.value)} className="bg-slate-900 border border-slate-700 rounded-lg px-2 py-1 text-[11px] text-slate-300" />
                            </div>
                            <div className="space-y-1.5">
                              {pendingAssignments.map(assignment => (
                                <div
                                  key={assignment.id}
                                  className="flex items-center justify-between gap-3 px-4 py-2.5 rounded-lg bg-slate-800/40 border border-slate-700/40"
                                  data-testid={`assignment-row-${assignment.id}`}
                                >
                                  <div className="flex items-center gap-3 min-w-0">
                                    <div className="w-8 h-8 rounded-full bg-violet-500/20 border border-violet-500/40 flex items-center justify-center shrink-0">
                                      <span className="text-[10px] font-bold text-violet-300">
                                        {(assignment.student.displayName || assignment.student.email || "?")
                                          .split(" ").map((n: string) => n[0]).join("").toUpperCase().slice(0, 2)}
                                      </span>
                                    </div>
                                    <div className="min-w-0">
                                      <p className="text-sm text-slate-200 truncate">{assignment.student.displayName || "Student"}</p>
                                      <p className="text-[11px] text-slate-400 truncate">{assignment.student.email}</p>
                                    </div>
                                  </div>
                                  <div className="flex items-center gap-2">
                                    {assignment.dueDate && (
                                      <span className="text-[10px] text-slate-400 flex items-center gap-1">
                                        <Clock className="w-3 h-3" />
                                        Due {formatDate(assignment.dueDate)}
                                      </span>
                                    )}
                                    <button
                                      onClick={() => unassignMutation.mutate({ quizId: quiz.id, studentId: assignment.studentId })}
                                      disabled={unassignMutation.isPending}
                                      className="flex items-center gap-1 px-2 py-1.5 min-h-[32px] rounded-lg text-[11px] font-medium bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500/20 transition-all disabled:opacity-50"
                                      title="Unassign student"
                                      data-testid={`button-unassign-${assignment.studentId}`}
                                    >
                                      <UserMinus className="w-3 h-3" />
                                      Revoke
                                    </button>
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        );
                      })()}

                      {/* Questions Section */}
                      {isExpanded && questions.length > 0 && (
                        <div>
                          <h4 className="text-sm font-semibold text-slate-300 flex items-center gap-2 mb-3">
                            <FileText className="w-4 h-4 text-violet-400" />
                            Questions ({questions.length})
                          </h4>
                          <div className="space-y-2">
                            {questions.map((q, idx) => (
                              <div
                                key={q.id}
                                className="flex items-start justify-between gap-3 px-4 py-3 rounded-lg bg-slate-800/40 border border-slate-700/40"
                                data-testid={`question-row-${q.id}`}
                              >
                                <div className="flex items-start gap-2 min-w-0 flex-1">
                                  <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-violet-500/20 text-violet-400 shrink-0 mt-0.5">
                                    Q{idx + 1}
                                  </span>
                                  <div className="min-w-0">
                                    <p className="text-sm text-slate-300 line-clamp-2">{q.stem}</p>
                                    <p className="text-[10px] text-slate-500 mt-1">{q.marks} mark{q.marks !== 1 ? "s" : ""} · {(q.options as string[]).length} options</p>
                                  </div>
                                </div>
                                <button
                                  onClick={() => setConfirmDeleteQuestion({ questionId: q.id, stem: q.stem.slice(0, 60) })}
                                  className="flex items-center justify-center p-1.5 min-h-[28px] min-w-[28px] rounded-lg text-slate-500 hover:text-red-400 hover:bg-red-500/10 transition-all shrink-0"
                                  title="Delete question"
                                  data-testid={`button-delete-question-${q.id}`}
                                >
                                  <Trash2 className="w-3 h-3" />
                                </button>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Student Submissions Section */}
                      <div>
                        <h4 className="text-sm font-semibold text-slate-300 flex items-center gap-2 mb-3">
                          <FileText className="w-4 h-4 text-violet-400" />
                          Student Submissions ({reports.length})
                        </h4>
                        {reportsLoading ? (
                          <div className="flex justify-center py-8">
                            <Loader2 className="w-5 h-5 text-violet-500 animate-spin" />
                          </div>
                        ) : reports.length === 0 ? (
                          <p className="text-xs text-slate-500 py-2">No submissions yet. Students will appear here once they complete this assessment.</p>
                        ) : (
                          <div className="space-y-2">
                            {[...reports].sort((a, b) => {
                              if (reportSortBy === "student") return a.studentName.localeCompare(b.studentName);
                              if (reportSortBy === "time_allocated") {
                                const aDur = a.completedAt && a.startedAt
                                  ? new Date(a.completedAt).getTime() - new Date(a.startedAt).getTime()
                                  : 0;
                                const bDur = b.completedAt && b.startedAt
                                  ? new Date(b.completedAt).getTime() - new Date(b.startedAt).getTime()
                                  : 0;
                                return bDur - aDur;
                              }
                              return new Date(b.completedAt || b.createdAt).getTime() - new Date(a.completedAt || a.createdAt).getTime();
                            }).map(report => (
                              <StudentReportCard
                                key={report.id}
                                report={report}
                                maxScore={maxScore}
                                questions={questions}
                                onViewReport={(r) => setViewingReport({ report: r as any, questions, maxScore })}
                              />
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </main>

      {showAssignModal !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={() => setShowAssignModal(null)}>
          <div className="bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl max-w-lg w-full max-h-[80vh] overflow-y-auto p-6" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between gap-3 mb-5">
              <h3 className="text-lg font-bold text-slate-200">Assign Assessment to Students</h3>
              <button onClick={() => setShowAssignModal(null)} className="text-slate-400 hover:text-slate-300 p-1">
                <X className="w-5 h-5" />
              </button>
            </div>
            <p className="text-xs text-slate-400 mb-3">Search your students and select who should receive this assessment:</p>
            {adoptedStudents.length === 0 ? (
              <p className="text-sm text-slate-400 text-center py-8">You don't have any students yet. Go to the Students page to add students first.</p>
            ) : (
              <>
                <div className="relative mb-3">
                  <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500 pointer-events-none" />
                  <input
                    type="text"
                    value={assignSearch}
                    onChange={(e) => setAssignSearch(e.target.value)}
                    placeholder="Search by name or email..."
                    className="w-full h-11 pl-11 pr-4 rounded-xl bg-slate-800/60 border border-slate-700 text-sm text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-emerald-500/40"
                    data-testid="input-search-assign"
                    autoFocus
                  />
                </div>
                {(() => {
                  const q = assignSearch.trim().toLowerCase();
                  const filtered = q
                    ? adoptedStudents.filter((s) =>
                        (s.displayName || "").toLowerCase().includes(q) ||
                        (s.email || "").toLowerCase().includes(q),
                      )
                    : adoptedStudents;
                  const allVisibleSelected =
                    filtered.length > 0 && filtered.every((s) => selectedStudentIds.has(s.id));
                  const toggleAll = () => {
                    setSelectedStudentIds((prev) => {
                      // When every visible student is already selected, "Clear selection"
                      // clears the entire set so hidden selections from previous searches
                      // aren't silently assigned.
                      if (allVisibleSelected) return new Set();
                      const next = new Set(prev);
                      filtered.forEach((s) => next.add(s.id));
                      return next;
                    });
                  };
                  return (
                    <>
                      <div className="flex items-center justify-between mb-2 text-[11px] text-slate-500 px-1">
                        <span>
                          {filtered.length} shown · {selectedStudentIds.size} selected
                        </span>
                        {filtered.length > 0 && (
                          <button
                            onClick={toggleAll}
                            className="text-emerald-300 hover:text-emerald-200 font-medium"
                            data-testid="button-select-all-assign"
                          >
                            {allVisibleSelected ? "Clear selection" : "Select all visible"}
                          </button>
                        )}
                      </div>
                      <div className="space-y-2 max-h-[40vh] overflow-y-auto">
                        {filtered.length === 0 ? (
                          <p className="text-xs text-slate-500 text-center py-6">No matches for "{assignSearch}"</p>
                        ) : filtered.map((student) => (
                          <button
                            key={student.id}
                            onClick={() => toggleStudentSelection(student.id)}
                            className={`w-full min-h-[52px] flex items-center gap-3 px-4 py-3 rounded-xl transition-all text-left ${
                              selectedStudentIds.has(student.id)
                                ? "bg-emerald-500/20 border-2 border-emerald-500/60"
                                : "bg-slate-800/40 border-2 border-slate-700/50 hover:bg-slate-800/60"
                            }`}
                            data-testid={`assign-student-${student.id}`}
                            aria-pressed={selectedStudentIds.has(student.id)}
                          >
                            <div className={`w-6 h-6 rounded-md border-2 flex items-center justify-center shrink-0 ${
                              selectedStudentIds.has(student.id) ? "bg-emerald-500 border-emerald-500" : "border-slate-500"
                            }`}>
                              {selectedStudentIds.has(student.id) && <Check className="w-4 h-4 text-white" strokeWidth={3} />}
                            </div>
                            <div className="min-w-0">
                              <p className="text-sm font-medium text-slate-100 truncate">{student.displayName || "Student"}</p>
                              <p className="text-xs text-slate-400 truncate">{student.email}</p>
                            </div>
                          </button>
                        ))}
                      </div>
                    </>
                  );
                })()}
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
                  onClick={() => assignMutation.mutate({ quizId: showAssignModal, studentIds: selectedStudentList, dueDate: dueDate || undefined })}
                  disabled={selectedStudentList.length === 0 || assignMutation.isPending}
                  className="w-full mt-4 py-3 min-h-[44px] rounded-xl text-sm font-medium bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
                  data-testid="button-confirm-assign"
                >
                  {assignMutation.isPending ? (
                    <Loader2 className="w-4 h-4 animate-spin mx-auto" />
                  ) : (
                    `Assign to ${selectedStudentList.length} Student${selectedStudentList.length !== 1 ? "s" : ""}`
                  )}
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {assignResult && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={() => setAssignResult(null)}>
          <div className="bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl max-w-lg w-full max-h-[85vh] overflow-y-auto p-6" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between gap-3 mb-4">
              <div>
                <h3 className="text-lg font-bold text-slate-100">Assignment dispatched</h3>
                <p className="text-xs text-slate-400 mt-1">
                  {assignResult.assigned} newly assigned
                  {assignResult.alreadyAssigned > 0 ? ` · ${assignResult.alreadyAssigned} already had it` : ""}
                  {assignResult.failed > 0 ? ` · ${assignResult.failed} failed` : ""}
                </p>
              </div>
              <button onClick={() => setAssignResult(null)} className="text-slate-400 hover:text-slate-300 p-1" aria-label="Close">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="grid grid-cols-3 gap-2 mb-4">
              <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/[0.06] px-3 py-2">
                <p className="text-[10px] uppercase tracking-wide text-emerald-300/80">Newly Assigned</p>
                <p className="text-lg font-bold text-emerald-300">{assignResult.assigned}</p>
              </div>
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/[0.06] px-3 py-2">
                <p className="text-[10px] uppercase tracking-wide text-amber-300/80">Already Had</p>
                <p className="text-lg font-bold text-amber-300">{assignResult.alreadyAssigned}</p>
              </div>
              <div className="rounded-lg border border-rose-500/30 bg-rose-500/[0.06] px-3 py-2">
                <p className="text-[10px] uppercase tracking-wide text-rose-300/80">Failed</p>
                <p className="text-lg font-bold text-rose-300">{assignResult.failed + assignResult.notAdopted}</p>
              </div>
            </div>
            <div className="space-y-1.5 max-h-[45vh] overflow-y-auto">
              {assignResult.perStudent.map((p) => {
                const statusLabel = p.status === "assigned"
                  ? "Sent"
                  : p.status === "already_assigned"
                    ? "Already assigned"
                    : p.status === "not_adopted"
                      ? "Not in your cohort"
                      : "Error";
                const pill =
                  p.status === "assigned"
                    ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/30"
                    : p.status === "already_assigned"
                      ? "bg-amber-500/15 text-amber-300 border-amber-500/30"
                      : "bg-rose-500/15 text-rose-300 border-rose-500/30";
                return (
                  <div
                    key={p.studentId}
                    className="flex items-center justify-between gap-3 rounded-lg border border-slate-800 bg-slate-800/40 px-3 py-2"
                    data-testid={`assign-result-${p.studentId}`}
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-slate-200 truncate">{p.name}</p>
                      {p.email && <p className="text-[11px] text-slate-500 truncate">{p.email}</p>}
                    </div>
                    <span className={`text-[10px] px-2 py-1 rounded-full border font-semibold ${pill}`}>{statusLabel}</span>
                  </div>
                );
              })}
            </div>
            <div className="flex items-center justify-end gap-2 mt-5">
              {(assignResult.failed > 0 || assignResult.notAdopted > 0) && (
                <button
                  onClick={() => {
                    const retryable = assignResult.perStudent
                      .filter((p) => p.status === "failed")
                      .map((p) => p.studentId);
                    if (retryable.length === 0) {
                      setAssignResult(null);
                      return;
                    }
                    assignMutation.mutate({
                      quizId: assignResult.quizId,
                      studentIds: retryable,
                      dueDate: dueDate || undefined,
                    });
                  }}
                  className="px-4 py-2 min-h-[40px] rounded-lg text-xs font-medium text-rose-200 bg-rose-500/10 border border-rose-500/30 hover:bg-rose-500/20"
                  data-testid="button-retry-failed-assignments"
                >
                  Retry failed
                </button>
              )}
              <button
                onClick={() => setAssignResult(null)}
                className="px-4 py-2 min-h-[40px] rounded-lg text-xs font-medium text-slate-200 bg-slate-700 hover:bg-slate-600"
                data-testid="button-close-assign-result"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      {viewingReport && (
        <ReportDetailModal
          report={viewingReport.report}
          questions={viewingReport.questions}
          maxScore={viewingReport.maxScore}
          onClose={() => setViewingReport(null)}
        />
      )}

      {/* Delete Assessment Confirmation Dialog */}
      {confirmDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={() => setConfirmDelete(null)}>
          <div className="bg-slate-900 border border-red-500/30 rounded-2xl shadow-2xl max-w-md w-full p-6" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-full bg-red-500/15 border border-red-500/30 flex items-center justify-center">
                <AlertTriangle className="w-5 h-5 text-red-400" />
              </div>
              <div>
                <h3 className="text-lg font-bold text-slate-200">Delete Assessment</h3>
                <p className="text-xs text-slate-400">This action cannot be undone</p>
              </div>
            </div>
            <p className="text-sm text-slate-300 mb-1">Are you sure you want to permanently delete:</p>
            <p className="text-sm font-semibold text-red-300 mb-4">"{confirmDelete.title}"</p>
            <p className="text-xs text-slate-400 mb-6">This will remove the quiz, all questions, student submissions, and assignments.</p>
            <div className="flex gap-3">
              <button
                onClick={() => setConfirmDelete(null)}
                className="flex-1 py-2.5 min-h-[44px] rounded-xl text-sm font-medium bg-slate-800 text-slate-300 border border-slate-700 hover:bg-slate-700 transition-all"
              >
                Cancel
              </button>
              <button
                onClick={() => deleteQuizMutation.mutate(confirmDelete.quizId)}
                disabled={deleteQuizMutation.isPending}
                className="flex-1 py-2.5 min-h-[44px] rounded-xl text-sm font-medium bg-red-600 text-white hover:bg-red-500 disabled:opacity-50 transition-all"
                data-testid="button-confirm-delete-quiz"
              >
                {deleteQuizMutation.isPending ? (
                  <Loader2 className="w-4 h-4 animate-spin mx-auto" />
                ) : (
                  "Delete Permanently"
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Question Confirmation Dialog */}
      {confirmDeleteQuestion && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={() => setConfirmDeleteQuestion(null)}>
          <div className="bg-slate-900 border border-red-500/30 rounded-2xl shadow-2xl max-w-md w-full p-6" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-full bg-red-500/15 border border-red-500/30 flex items-center justify-center">
                <Trash2 className="w-5 h-5 text-red-400" />
              </div>
              <div>
                <h3 className="text-lg font-bold text-slate-200">Delete Question</h3>
                <p className="text-xs text-slate-400">This action cannot be undone</p>
              </div>
            </div>
            <p className="text-sm text-slate-300 mb-4">"{confirmDeleteQuestion.stem}..."</p>
            <div className="flex gap-3">
              <button
                onClick={() => setConfirmDeleteQuestion(null)}
                className="flex-1 py-2.5 min-h-[44px] rounded-xl text-sm font-medium bg-slate-800 text-slate-300 border border-slate-700 hover:bg-slate-700 transition-all"
              >
                Cancel
              </button>
              <button
                onClick={() => deleteQuestionMutation.mutate(confirmDeleteQuestion.questionId)}
                disabled={deleteQuestionMutation.isPending}
                className="flex-1 py-2.5 min-h-[44px] rounded-xl text-sm font-medium bg-red-600 text-white hover:bg-red-500 disabled:opacity-50 transition-all"
                data-testid="button-confirm-delete-question"
              >
                {deleteQuestionMutation.isPending ? (
                  <Loader2 className="w-4 h-4 animate-spin mx-auto" />
                ) : (
                  "Delete Question"
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
