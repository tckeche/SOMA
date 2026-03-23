import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useParams, Link } from "wouter";
import { createIdentityHeaders } from "@/lib/identityHeaders";
import { useSupabaseSession } from "@/hooks/use-supabase-session";
import { getSubjectColor, getSubjectIcon } from "@/lib/subjectColors";
import { format } from "date-fns";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import {
  ArrowLeft, MessageSquare, Send, Loader2, BookOpen,
  Trash2, Eye, FileText, Award, Target, CheckCircle2,
} from "lucide-react";
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

const CARD_CLASS = "bg-slate-900/80 backdrop-blur-md border border-slate-800 rounded-2xl p-6 shadow-2xl";

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

function getStatusLabel(a: AssignmentRow): { text: string; color: string } {
  if (a.reportStatus === "completed") return { text: "Submitted", color: "bg-emerald-500/10 text-emerald-400 border-emerald-500/30" };
  if (a.reportStatus === "pending") return { text: "Grading", color: "bg-amber-500/10 text-amber-400 border-amber-500/30" };
  if (a.reportStatus === "failed") return { text: "Failed", color: "bg-red-500/10 text-red-400 border-red-500/30" };
  if (a.assignmentStatus === "completed") return { text: "Done", color: "bg-emerald-500/10 text-emerald-400 border-emerald-500/30" };
  return { text: "Pending", color: "bg-slate-500/10 text-slate-400 border-slate-500/30" };
}

function formatDate(dateStr: string | null) {
  if (!dateStr) return "—";
  return new Date(dateStr).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function TutorStudentDetail() {
  const params = useParams<{ id: string }>();
  const studentId = params.id || "";
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [newComment, setNewComment] = useState("");
  const [revokeQuizId, setRevokeQuizId] = useState<number | null>(null);

  const { userId } = useSupabaseSession();
  const headers = useMemo(() => createIdentityHeaders("x-tutor-id", userId), [userId]);
  const jsonHeaders = useMemo(() => createIdentityHeaders("x-tutor-id", userId, { "Content-Type": "application/json" }), [userId]);

  // Fetch student report (assignments + stats)
  const { data: report, isLoading: reportLoading } = useQuery<StudentReport>({
    queryKey: ["/api/tutor/students", studentId, "report", userId],
    queryFn: async () => {
      const res = await fetch(`/api/tutor/students/${studentId}/report`, { headers });
      if (!res.ok) throw new Error("Failed to load");
      return res.json();
    },
    enabled: !!userId && !!studentId,
  });

  // Fetch private notes
  const { data: comments = [], isLoading: commentsLoading } = useQuery<TutorComment[]>({
    queryKey: ["/api/tutor/students", studentId, "comments"],
    queryFn: async () => {
      const res = await fetch(`/api/tutor/students/${studentId}/comments`, { headers });
      if (!res.ok) return [];
      return res.json();
    },
    enabled: !!userId && !!studentId,
  });

  // Add comment mutation
  const addCommentMutation = useMutation({
    mutationFn: async (comment: string) => {
      const res = await fetch(`/api/tutor/students/${studentId}/comments`, {
        method: "POST",
        headers: jsonHeaders,
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
  });

  // Revoke assignment mutation
  const revokeMutation = useMutation({
    mutationFn: async (quizId: number) => {
      const res = await fetch(`/api/tutor/quizzes/${quizId}/unassign/${studentId}`, {
        method: "DELETE",
        headers,
      });
      if (!res.ok) throw new Error("Failed to revoke");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/tutor/students", studentId, "report"] });
      setRevokeQuizId(null);
      toast({ title: "Assignment revoked" });
    },
  });

  const student = report?.student;
  const stats = report?.stats;
  const assignments = report?.assignments || [];
  const displayName = toProperCase(student?.displayName || student?.email?.split("@")[0] || "Student");
  const initials = displayName.split(" ").map((n: string) => n[0]).filter(Boolean).join("").toUpperCase().slice(0, 2);

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 to-slate-900">
      <header className="border-b border-slate-800/60 bg-slate-950/80 backdrop-blur-xl sticky top-0 z-20">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <Link href="/tutor/students">
            <span className="flex items-center gap-2 text-sm text-slate-400 hover:text-violet-400 transition-colors cursor-pointer">
              <ArrowLeft className="w-4 h-4" />
              Back to Students
            </span>
          </Link>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 py-8 space-y-6">
        {/* Student Header */}
        <div className={CARD_CLASS}>
          <div className="flex items-center gap-4">
            <div
              className="w-14 h-14 rounded-full flex items-center justify-center text-lg font-bold text-white"
              style={{ backgroundColor: "rgba(16,185,129,0.2)", boxShadow: "0 0 20px rgba(16,185,129,0.3)", border: "2px solid #10B981" }}
            >
              {initials}
            </div>
            <div>
              <h2 className="text-xl font-bold text-slate-100">{displayName}</h2>
              <p className="text-xs text-slate-400">{student?.email}</p>
            </div>
          </div>
        </div>

        {/* Stats Ribbon */}
        {reportLoading ? (
          <div className="grid grid-cols-4 gap-4">
            {[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-24 w-full bg-white/5 rounded-xl" />)}
          </div>
        ) : (
          <div className="grid grid-cols-4 gap-4">
            <div className={`${CARD_CLASS} !p-4`}>
              <div className="flex items-center gap-2 mb-2">
                <Award className="w-4 h-4 text-violet-400" />
                <span className="text-xs text-slate-400">Avg Grade</span>
              </div>
              <p className="text-2xl font-bold text-violet-300">{stats?.avgScore !== null ? `${stats?.avgScore}%` : "—"}</p>
            </div>
            <div className={`${CARD_CLASS} !p-4`}>
              <div className="flex items-center gap-2 mb-2">
                <Target className="w-4 h-4 text-cyan-400" />
                <span className="text-xs text-slate-400">Accuracy</span>
              </div>
              <p className="text-2xl font-bold text-cyan-300">{stats?.accuracy !== null ? `${stats?.accuracy}%` : "—"}</p>
            </div>
            <div className={`${CARD_CLASS} !p-4`}>
              <div className="flex items-center gap-2 mb-2">
                <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                <span className="text-xs text-slate-400">Completed</span>
              </div>
              <p className="text-2xl font-bold text-emerald-300">{stats?.totalCompleted ?? 0}<span className="text-sm text-slate-500">/{stats?.totalAssigned ?? 0}</span></p>
            </div>
            <div className={`${CARD_CLASS} !p-4`}>
              <div className="flex items-center gap-2 mb-2">
                <BookOpen className="w-4 h-4 text-amber-400" />
                <span className="text-xs text-slate-400">Quizzes Taken</span>
              </div>
              <p className="text-2xl font-bold text-amber-300">{stats?.totalCompleted ?? 0}</p>
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Assignment Table */}
          <div className="lg:col-span-2 space-y-4">
            <h3 className="text-sm font-semibold text-slate-400 uppercase tracking-wider">Assignment History</h3>

            {reportLoading ? (
              <div className="space-y-3">
                {[1, 2, 3].map((i) => <Skeleton key={i} className="h-16 w-full bg-white/5 rounded-xl" />)}
              </div>
            ) : assignments.length === 0 ? (
              <div className={`${CARD_CLASS} text-center py-10`}>
                <BookOpen className="w-10 h-10 mx-auto text-slate-600 mb-3" />
                <p className="text-sm text-slate-400">No assignments yet</p>
              </div>
            ) : (
              <div className={CARD_CLASS}>
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead>
                      <tr className="border-b border-slate-700/50">
                        <th className="text-left py-3 px-3 text-xs font-semibold text-slate-400 uppercase tracking-wider">Quiz</th>
                        <th className="text-left py-3 px-3 text-xs font-semibold text-slate-400 uppercase tracking-wider">Status</th>
                        <th className="text-right py-3 px-3 text-xs font-semibold text-slate-400 uppercase tracking-wider">Score</th>
                        <th className="text-center py-3 px-3 text-xs font-semibold text-slate-400 uppercase tracking-wider">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {assignments.map((a) => {
                        const status = getStatusLabel(a);
                        const sc = getSubjectColor(a.quizSubject);
                        const SubIcon = getSubjectIcon(a.quizSubject);
                        const pct = a.score !== null && a.maxScore > 0 ? Math.round((a.score / a.maxScore) * 100) : null;
                        return (
                          <tr key={a.assignmentId} className="border-b border-slate-700/30 hover:bg-slate-800/30 transition-colors">
                            <td className="py-3 px-3">
                              <div className="flex items-center gap-3">
                                <div className={`w-8 h-8 rounded-lg flex items-center justify-center border ${sc.border}`} style={{ backgroundColor: `${sc.hex}15` }}>
                                  <SubIcon className="w-4 h-4" style={{ color: sc.hex }} />
                                </div>
                                <div className="min-w-0">
                                  <p className="text-sm font-medium text-slate-200 truncate">{a.quizTitle}</p>
                                  <p className="text-[10px] text-slate-500">{a.quizLevel} {a.dueDate ? `· Due ${formatDate(a.dueDate)}` : ""}</p>
                                </div>
                              </div>
                            </td>
                            <td className="py-3 px-3">
                              <Badge className={`text-xs border ${status.color}`}>
                                {status.text}
                              </Badge>
                            </td>
                            <td className="py-3 px-3 text-right">
                              {pct !== null ? (
                                <div>
                                  <p className={`text-sm font-bold ${pct >= 70 ? "text-emerald-400" : pct >= 40 ? "text-amber-400" : "text-red-400"}`}>{pct}%</p>
                                  <p className="text-[10px] text-slate-500">{a.score}/{a.maxScore}</p>
                                </div>
                              ) : (
                                <span className="text-slate-500">—</span>
                              )}
                            </td>
                            <td className="py-3 px-3">
                              <div className="flex items-center justify-center gap-1">
                                {a.reportId && a.reportStatus === "completed" && (
                                  <>
                                    <Link href={`/soma/review/${a.reportId}`}>
                                      <button className="p-1.5 text-cyan-400 hover:text-cyan-300 hover:bg-cyan-500/10 rounded-lg transition-colors" title="View submitted work">
                                        <Eye className="w-3.5 h-3.5" />
                                      </button>
                                    </Link>
                                    <Link href={`/soma/review/${a.reportId}`}>
                                      <button className="p-1.5 text-violet-400 hover:text-violet-300 hover:bg-violet-500/10 rounded-lg transition-colors" title="Diagnostic Report">
                                        <FileText className="w-3.5 h-3.5" />
                                      </button>
                                    </Link>
                                  </>
                                )}
                                {a.assignmentStatus === "pending" && (
                                  <button
                                    onClick={() => setRevokeQuizId(a.quizId)}
                                    className="p-1.5 text-red-400/60 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-colors"
                                    title="Revoke assignment"
                                  >
                                    <Trash2 className="w-3.5 h-3.5" />
                                  </button>
                                )}
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>

          {/* Private Notes Sidebar */}
          <div className="space-y-4">
            <h3 className="text-sm font-semibold text-slate-400 uppercase tracking-wider flex items-center gap-2">
              <MessageSquare className="w-4 h-4" />
              Private Notes
            </h3>
            <div className={CARD_CLASS}>
              <div className="space-y-3 max-h-[400px] overflow-y-auto mb-4">
                {commentsLoading ? (
                  <Loader2 className="w-5 h-5 text-violet-400 animate-spin mx-auto" />
                ) : comments.length === 0 ? (
                  <p className="text-xs text-slate-500 text-center py-4">No notes yet. Add a private note about this student's progress.</p>
                ) : (
                  comments.map((c) => (
                    <div key={c.id} className="bg-slate-800/40 border border-slate-700/50 rounded-lg p-3">
                      <p className="text-sm text-slate-300 whitespace-pre-wrap">{c.comment}</p>
                      <p className="text-[10px] text-slate-500 mt-1.5">{format(new Date(c.createdAt), "PPp")}</p>
                    </div>
                  ))
                )}
              </div>
              <div className="flex gap-2">
                <textarea
                  value={newComment}
                  onChange={(e) => setNewComment(e.target.value)}
                  placeholder="Add a note..."
                  className="flex-1 bg-slate-800/60 border border-slate-700/50 rounded-lg p-3 text-sm text-slate-200 placeholder:text-slate-500 resize-none min-h-[44px] focus:outline-none focus:border-violet-500/40"
                  rows={2}
                />
                <button
                  onClick={() => { if (newComment.trim()) addCommentMutation.mutate(newComment); }}
                  disabled={!newComment.trim() || addCommentMutation.isPending}
                  className="self-end p-3 rounded-lg bg-violet-500/20 text-violet-300 border border-violet-500/30 hover:bg-violet-500/30 disabled:opacity-40 transition-all min-h-[44px] min-w-[44px]"
                >
                  {addCommentMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                </button>
              </div>
            </div>
          </div>
        </div>
      </main>

      {/* Revoke Confirmation Dialog */}
      <AlertDialog open={revokeQuizId !== null} onOpenChange={(open) => { if (!open) setRevokeQuizId(null); }}>
        <AlertDialogContent className="bg-slate-900 border-slate-700">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-red-300">Revoke Assignment</AlertDialogTitle>
            <AlertDialogDescription className="text-slate-400">
              This will remove this student's access to the quiz. They will no longer see it on their dashboard.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              onClick={() => setRevokeQuizId(null)}
              className="bg-slate-800 text-slate-300 border-slate-700 hover:bg-slate-700"
            >
              Cancel
            </AlertDialogCancel>
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
