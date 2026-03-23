import { useState, useMemo, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import { supabase } from "@/lib/supabase";
import { createIdentityHeaders } from "@/lib/identityHeaders";
import { useSupabaseSession } from "@/hooks/use-supabase-session";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import type { SomaQuiz, SomaUser } from "@shared/schema";
import {
  LogOut, Users, BookOpen, Plus, UserPlus, X,
  Loader2, Check, ChevronDown, Sparkles, AlertTriangle, Trash2, Eye,
  LayoutDashboard, ChevronRight, Timer, Clock, Send, Award,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { format } from "date-fns";
import { getSubjectColor, getSubjectIcon } from "@/lib/subjectColors";
import { PieChart, Pie, Cell, ResponsiveContainer } from "recharts";

const CARD_CLASS = "bg-slate-900/80 backdrop-blur-md border border-slate-800 rounded-2xl p-6 shadow-2xl";
const SECTION_LABEL = "text-slate-400 text-xs font-semibold tracking-wider uppercase";

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

function DonutCard({ subject, percentage, color }: { subject: string; percentage: number; color: string }) {
  const data = [
    { value: percentage },
    { value: 100 - percentage },
  ];
  const SubIcon = getSubjectIcon(subject);
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
          className="w-28 h-28 relative"
          style={{
            filter: `drop-shadow(0 4px 12px ${color}30)`,
            transform: "perspective(400px) rotateX(5deg)",
          }}
        >
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <defs>
                <linearGradient id={`grad-tutor-${subject}`} x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0%" stopColor={color} stopOpacity={1} />
                  <stop offset="100%" stopColor={color} stopOpacity={0.6} />
                </linearGradient>
              </defs>
              <Pie
                data={data}
                cx="50%"
                cy="50%"
                innerRadius={32}
                outerRadius={48}
                startAngle={90}
                endAngle={-270}
                dataKey="value"
                stroke="none"
                cornerRadius={4}
              >
                <Cell fill={`url(#grad-tutor-${subject})`} />
                <Cell fill="rgba(255,255,255,0.04)" />
              </Pie>
            </PieChart>
          </ResponsiveContainer>
          <div className="absolute inset-0 flex items-center justify-center">
            <span
              className="text-lg font-bold text-white"
              style={{ textShadow: `0 0 20px ${color}60, 0 2px 4px rgba(0,0,0,0.5)` }}
              data-testid={`text-donut-value-${subject}`}
            >
              {Math.round(percentage)}%
            </span>
          </div>
        </div>
        <div className="flex items-center gap-1.5 mt-3">
          <SubIcon className="w-3.5 h-3.5" style={{ color }} />
          <p className={`${SECTION_LABEL}`} style={{ color }}>{subject}</p>
        </div>
      </div>
    </div>
  );
}

export default function TutorDashboard() {
  const queryClient = useQueryClient();
  const [, setLocation] = useLocation();
  const [showAssignModal, setShowAssignModal] = useState<number | null>(null);
  const [selectedStudentIds, setSelectedStudentIds] = useState<Set<string>>(new Set());
  const [deleteQuizId, setDeleteQuizId] = useState<number | null>(null);
  const [dueDate, setDueDate] = useState("");

  const { session, userId } = useSupabaseSession();
  const displayName = session?.user?.user_metadata?.display_name || session?.user?.email?.split("@")[0] || "Tutor";
  const headers = useMemo(() => createIdentityHeaders("x-tutor-id", userId), [userId]);
  const initials = displayName.split(" ").map((n: string) => n[0]).join("").toUpperCase().slice(0, 2);

  const { data: stats, isLoading } = useQuery<DashboardStats>({
    queryKey: ["/api/tutor/dashboard-stats", userId],
    queryFn: async () => {
      const res = await fetch("/api/tutor/dashboard-stats", { headers });
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
      const res = await fetch("/api/tutor/quizzes", { headers });
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
      const res = await fetch("/api/tutor/students", { headers });
      if (!res.ok) return [];
      return res.json();
    },
    enabled: !!userId,
    refetchInterval: 15000,
    refetchOnWindowFocus: true,
  });

  const assignMutation = useMutation({
    mutationFn: async ({ quizId, studentIds, dueDate: dd }: { quizId: number; studentIds: string[]; dueDate?: string }) => {
      const payload: any = { studentIds };
      if (dd) payload.dueDate = new Date(dd).toISOString();
      const res = await fetch(`/api/tutor/quizzes/${quizId}/assign`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error("Failed to assign");
      return res.json();
    },
    onSuccess: () => {
      setShowAssignModal(null);
      setSelectedStudentIds(new Set());
      setDueDate("");
      queryClient.invalidateQueries({ queryKey: ["/api/tutor/dashboard-stats"] });
    },
  });

  // Delete quiz mutation
  const deleteQuizMutation = useMutation({
    mutationFn: async (quizId: number) => {
      const res = await fetch(`/api/tutor/quizzes/${quizId}`, {
        method: "DELETE",
        headers,
      });
      if (!res.ok) throw new Error("Failed to delete");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/tutor/quizzes"] });
      setDeleteQuizId(null);
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


  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-800/60 bg-slate-950/80 backdrop-blur-xl sticky top-0 z-20">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
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

      <nav className="border-b border-slate-800/40 bg-slate-950/40 backdrop-blur-md">
        <div className="max-w-6xl mx-auto px-6 flex gap-1">
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

      <main className="max-w-6xl mx-auto px-6 py-8 space-y-8">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-bold text-slate-100">Dashboard</h2>
            <p className="text-sm text-slate-400 mt-1">Cohort overview and recent activity</p>
          </div>
          <Link href="/tutor/assessments/new">
            <span
              className="glow-button flex items-center gap-2 px-5 py-2.5 min-h-[44px] rounded-xl text-sm font-semibold cursor-pointer"
              data-testid="button-create-assessment"
            >
              <Plus className="w-4 h-4" />
              Create Assessment
            </span>
          </Link>
        </div>

        {isLoading ? (
          <div className="flex justify-center py-20">
            <Loader2 className="w-8 h-8 text-violet-500 animate-spin" />
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <StatCard icon={Users} label="Students" value={stats?.totalStudents ?? 0} color="#8B5CF6" />
              <StatCard icon={BookOpen} label="Assessments" value={stats?.totalQuizzes ?? 0} color="#10B981" />
              <StatCard icon={Send} label="Assigned" value={stats?.pendingAssignments?.length ?? 0} color="#F59E0B" />
              <StatCard icon={Award} label="Cohort Avg" value={overallAvg !== null ? `${overallAvg}%` : "—"} color="#3B82F6" />
            </div>

            {(stats?.cohortAverages?.length ?? 0) > 0 && (
              <section>
                <h3 className={`${SECTION_LABEL} mb-4`}>Cohort Performance by Subject</h3>
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
                  {stats!.cohortAverages.map((ca) => {
                    const sc = getSubjectColor(ca.subject);
                    return <DonutCard key={ca.subject} subject={ca.subject} percentage={ca.average} color={sc.hex} />;
                  })}
                </div>
              </section>
            )}

            <section>
              <div className="flex items-center justify-between mb-4">
                <h3 className={SECTION_LABEL}>My Assessments</h3>
                <Link href="/tutor/assessments">
                  <span className="text-xs text-violet-400 hover:text-violet-300 cursor-pointer flex items-center gap-1" data-testid="link-view-all-assessments">
                    View All <ChevronRight className="w-3 h-3" />
                  </span>
                </Link>
              </div>

              {quizzesLoading ? (
                <div className="flex justify-center py-8">
                  <Loader2 className="w-6 h-6 text-violet-500 animate-spin" />
                </div>
              ) : tutorQuizzes.length === 0 ? (
                <div className={`${CARD_CLASS} text-center py-10`}>
                  <BookOpen className="w-10 h-10 mx-auto text-slate-600 mb-3" />
                  <p className="text-sm text-slate-400">No assessments yet</p>
                  <p className="text-xs text-slate-500 mt-1">Create your first assessment to get started</p>
                </div>
              ) : (
                <div className="grid gap-3 sm:grid-cols-2">
                  {tutorQuizzes.map((quiz) => {
                    const sc = getSubjectColor(quiz.subject);
                    const SubIcon = getSubjectIcon(quiz.subject);
                    return (
                      <div
                        key={quiz.id}
                        className="bg-slate-900/60 backdrop-blur-md border border-slate-800 rounded-xl px-5 py-4 group hover:border-slate-700 transition-all"
                        data-testid={`quiz-tile-${quiz.id}`}
                      >
                        <div className="flex items-center gap-3 mb-3">
                          <div className={`w-9 h-9 rounded-lg flex items-center justify-center border ${sc.border}`} style={{ backgroundColor: `${sc.hex}15` }}>
                            <SubIcon className="w-4 h-4" style={{ color: sc.hex }} />
                          </div>
                          <div className="flex-1 min-w-0">
                            <h4 className="text-sm font-medium text-slate-200 truncate" data-testid={`quiz-title-${quiz.id}`}>{quiz.title}</h4>
                            <div className="flex items-center gap-2 mt-0.5">
                              <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${sc.bg} ${sc.label}`}>{quiz.subject || "General"}</span>
                              {quiz.level && <span className="text-[10px] text-slate-500">{quiz.level}</span>}
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => { setShowAssignModal(quiz.id); setSelectedStudentIds(new Set()); setDueDate(""); }}
                            className="flex-1 flex items-center justify-center gap-1.5 py-2 min-h-[36px] rounded-lg text-xs font-medium bg-emerald-600/20 text-emerald-400 border border-emerald-500/30 hover:bg-emerald-600/30 transition-all"
                            data-testid={`button-assign-${quiz.id}`}
                          >
                            <UserPlus className="w-3.5 h-3.5" />
                            Assign to Students
                          </button>
                          <Link href={`/tutor/assessments`}>
                            <span className="flex items-center justify-center gap-1.5 py-2 px-3 min-h-[36px] rounded-lg text-xs font-medium bg-slate-800/60 text-slate-300 border border-slate-700/50 hover:bg-slate-800/80 transition-all cursor-pointer" data-testid={`button-details-${quiz.id}`}>
                              <Eye className="w-3.5 h-3.5" />
                              Details
                            </span>
                          </Link>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>

            <section>
              <div className="flex items-center justify-between mb-4">
                <h3 className={SECTION_LABEL}>Recent Submissions</h3>
              </div>
              {(stats?.recentSubmissions?.length ?? 0) === 0 ? (
                <div className={`${CARD_CLASS} text-center py-10`}>
                  <Sparkles className="w-10 h-10 mx-auto text-slate-600 mb-3" />
                  <p className="text-sm text-slate-400">No submissions yet</p>
                  <p className="text-xs text-slate-500 mt-1">Student assessment results will appear here</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {stats!.recentSubmissions.map((sub, idx) => {
                    const sc = getSubjectColor(sub.subject);
                    const SubIcon = getSubjectIcon(sub.subject);
                    const duration = formatDuration(sub.startedAt, sub.completedAt);
                    return (
                      <Link key={idx} href={`/soma/review/${sub.reportId}`}>
                        <div
                          className="flex items-center gap-4 bg-slate-900/60 backdrop-blur-md border border-slate-800 rounded-xl px-5 py-3.5 cursor-pointer hover:bg-slate-800/50 hover:border-slate-700 transition-all group"
                          data-testid={`submission-${idx}`}
                        >
                          <div className={`w-9 h-9 rounded-lg flex items-center justify-center border ${sc.border}`} style={{ backgroundColor: `${sc.hex}15` }}>
                            <SubIcon className="w-4 h-4" style={{ color: sc.hex }} />
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm text-slate-200">
                              <span className="font-medium">{sub.studentName}</span>
                              <span className="text-slate-500"> completed </span>
                              <span className="text-slate-300">{sub.quizTitle}</span>
                            </p>
                            <div className="flex items-center gap-3 text-[10px] text-slate-500 mt-0.5">
                              <span>{format(new Date(sub.createdAt), "PPp")}</span>
                              {duration && (
                                <span className="flex items-center gap-1 text-violet-400">
                                  <Timer className="w-3 h-3" />
                                  {duration}
                                </span>
                              )}
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            <Badge
                              className={`text-xs font-bold px-2.5 py-1 border ${
                                sub.score >= 70
                                  ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/30"
                                  : sub.score >= 40
                                  ? "bg-amber-500/10 text-amber-400 border-amber-500/30"
                                  : "bg-red-500/10 text-red-400 border-red-500/30"
                              }`}
                              data-testid={`score-${idx}`}
                            >
                              {sub.score}%
                            </Badge>
                            <Eye className="w-4 h-4 text-slate-500 group-hover:text-violet-400 transition-colors" />
                          </div>
                        </div>
                      </Link>
                    );
                  })}
                </div>
              )}
            </section>

            <section>
              <div className="flex items-center justify-between mb-4">
                <h3 className={SECTION_LABEL}>Pending Assignments</h3>
              </div>

              {(stats?.pendingAssignments?.length ?? 0) === 0 ? (
                <div className={`${CARD_CLASS} text-center py-10`}>
                  <Send className="w-10 h-10 mx-auto text-slate-600 mb-3" />
                  <p className="text-sm text-slate-400">No pending assignments</p>
                  <p className="text-xs text-slate-500 mt-1">Use the "Assign to Students" button above to assign assessments</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {stats!.pendingAssignments.map((pa, idx) => {
                    const sc = getSubjectColor(pa.subject);
                    const SubIcon = getSubjectIcon(pa.subject);
                    const isOverdue = pa.dueDate && new Date(pa.dueDate) < new Date();
                    return (
                      <div
                        key={pa.assignmentId}
                        className="flex items-center gap-4 bg-slate-900/60 backdrop-blur-md border border-slate-800 rounded-xl px-5 py-3.5"
                        data-testid={`pending-assignment-${idx}`}
                      >
                        <div className={`w-9 h-9 rounded-lg flex items-center justify-center border ${sc.border}`} style={{ backgroundColor: `${sc.hex}15` }}>
                          <SubIcon className="w-4 h-4" style={{ color: sc.hex }} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm text-slate-200">
                            <span className="font-medium">{pa.studentName}</span>
                            <span className="text-slate-500"> — </span>
                            <span className="text-slate-300">{pa.quizTitle}</span>
                          </p>
                          <div className="flex items-center gap-3 text-[10px] text-slate-500 mt-0.5">
                            <span>Assigned {format(new Date(pa.createdAt), "PPp")}</span>
                            {pa.dueDate && (
                              <span className={`flex items-center gap-1 ${isOverdue ? "text-red-400" : "text-amber-400"}`}>
                                <Clock className="w-3 h-3" />
                                Due {format(new Date(pa.dueDate), "PPp")}
                              </span>
                            )}
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <Badge className="text-[10px] font-semibold px-2 py-0.5 bg-amber-500/10 text-amber-400 border border-amber-500/30">
                            Not Started
                          </Badge>
                          {isOverdue && (
                            <AlertTriangle className="w-4 h-4 text-red-400" />
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          </>
        )}
      </main>

      {showAssignModal !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={() => setShowAssignModal(null)}>
          <div className="bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl max-w-lg w-full max-h-[80vh] overflow-y-auto p-6" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between gap-3 mb-5">
              <h3 className="text-lg font-bold text-slate-200">Assign Assessment to Students</h3>
              <button onClick={() => setShowAssignModal(null)} className="text-slate-400 hover:text-slate-300 p-1" data-testid="button-close-assign-modal">
                <X className="w-5 h-5" />
              </button>
            </div>
            <p className="text-xs text-slate-400 mb-4">Select from your adopted students to assign this assessment:</p>
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

      {/* Delete Quiz Confirmation Dialog */}
      <AlertDialog open={deleteQuizId !== null}>
        <AlertDialogContent className="bg-slate-900 border-slate-700">
          <AlertDialogHeader>
            <div className="flex items-center gap-3 mb-2">
              <div className="w-10 h-10 rounded-lg bg-red-500/20 border border-red-500/40 flex items-center justify-center">
                <AlertTriangle className="w-5 h-5 text-red-400" />
              </div>
              <AlertDialogTitle className="text-red-300">Delete Quiz</AlertDialogTitle>
            </div>
            <AlertDialogDescription className="text-slate-400">
              This action cannot be undone. All quiz data and student assignments will be deleted permanently.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="bg-slate-800 text-slate-300 border-slate-700 hover:bg-slate-700">
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (deleteQuizId) deleteQuizMutation.mutate(deleteQuizId);
              }}
              disabled={deleteQuizMutation.isPending}
              className="bg-red-600 text-white hover:bg-red-700"
            >
              {deleteQuizMutation.isPending ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                "Delete"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function StatCard({ icon: Icon, label, value, color }: { icon: any; label: string; value: string | number; color: string }) {
  return (
    <div
      className={CARD_CLASS}
      style={{ borderColor: `${color}20` }}
      data-testid={`stat-${label.toLowerCase()}`}
    >
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ backgroundColor: `${color}15`, border: `1px solid ${color}30` }}>
          <Icon className="w-5 h-5" style={{ color }} />
        </div>
        <div>
          <p className="text-xl font-bold text-slate-100">{value}</p>
          <p className="text-[10px] text-slate-400 uppercase tracking-wider">{label}</p>
        </div>
      </div>
    </div>
  );
}
