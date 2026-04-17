import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useParams, Link } from "wouter";
import { authFetch } from "@/lib/supabase";
import { useSupabaseSession } from "@/hooks/use-supabase-session";
import type { SomaQuiz } from "@shared/schema";
import {
  ArrowLeft, BookOpen, Users, Trash2, Plus, FileText,
  Loader2, Check, X, MoreVertical, Archive, ArchiveX,
  CalendarDays, Clock,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import { useToast } from "@/hooks/use-toast";
import TutorFlagsPanel from "@/components/tutor/TutorFlagsPanel";

interface StudentAssignment {
  assignmentId: number;
  studentId: string;
  studentName: string;
  studentEmail: string;
  assignmentStatus: string;
  status: "Not Started" | "In Progress" | "Submitted" | "Failed";
  startTime: string | null;
  submissionTime: string | null;
  finalGrade: number | null;
  maxGrade: number;
  reportId: number | null;
  dueDate: string | null;
}

interface QuizDetails {
  quiz: SomaQuiz;
  assignments: StudentAssignment[];
  totalAssigned: number;
  totalSubmitted: number;
}

interface AdoptedStudent {
  id: string;
  email: string;
  displayName: string | null;
}

const CARD_CLASS = "bg-slate-900/80 backdrop-blur-md border border-slate-800 rounded-2xl p-6 shadow-2xl";
const STANDARD_ACTION_BUTTON_CLASS = "inline-flex items-center justify-center gap-2 px-4 py-2 min-h-[44px] rounded-lg text-sm font-medium border border-violet-500/40 bg-violet-500/20 text-violet-300 hover:bg-violet-500/30 transition-all";

function toProperCase(str: string): string {
  return str.replace(/\b\w/g, (c) => c.toUpperCase());
}

function getStatusColor(status: StudentAssignment["status"]) {
  switch (status) {
    case "Submitted":
      return "bg-emerald-500/10 text-emerald-400 border-emerald-500/30";
    case "In Progress":
      return "bg-blue-500/10 text-blue-400 border-blue-500/30";
    case "Failed":
      return "bg-red-500/10 text-red-400 border-red-500/30";
    default:
      return "bg-slate-500/10 text-slate-400 border-slate-500/30";
  }
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

function getInitials(name: string) {
  return name
    .split(/\s+/)
    .map((w) => w[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

const AVATAR_COLORS = [
  "bg-violet-500/30 text-violet-300",
  "bg-emerald-500/30 text-emerald-300",
  "bg-cyan-500/30 text-cyan-300",
  "bg-amber-500/30 text-amber-300",
  "bg-rose-500/30 text-rose-300",
  "bg-blue-500/30 text-blue-300",
];

function getAvatarColor(id: string) {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

export default function TutorAssessmentDetails() {
  const queryClient = useQueryClient();
  const params = useParams<{ quizId: string }>();
  const quizId = parseInt(params.quizId || "0");
  const [revokeStudentId, setRevokeStudentId] = useState<string | null>(null);
  const [showAssignModal, setShowAssignModal] = useState(false);
  const [selectedStudentIds, setSelectedStudentIds] = useState<Set<string>>(new Set());
  const [showDueDatePicker, setShowDueDatePicker] = useState(false);
  const [newDueDate, setNewDueDate] = useState("");
  const [assignDueDate, setAssignDueDate] = useState("");
  const { toast } = useToast();

  const { userId } = useSupabaseSession();

  const { data: details, isLoading } = useQuery<QuizDetails>({
    queryKey: [`/api/tutor/quizzes/${quizId}/details`, userId],
    queryFn: async () => {
      if (!userId) throw new Error("Not authenticated");
      const res = await authFetch(`/api/tutor/quizzes/${quizId}/details`);
      if (!res.ok) throw new Error("Failed to load details");
      return res.json();
    },
    enabled: !!userId && quizId > 0,
  });

  // Fetch adopted students for the assign modal
  const { data: adoptedStudents = [] } = useQuery<AdoptedStudent[]>({
    queryKey: ["/api/tutor/students", userId],
    queryFn: async () => {
      const res = await authFetch("/api/tutor/students");
      if (!res.ok) throw new Error("Failed to load students");
      return res.json();
    },
    enabled: !!userId && showAssignModal,
  });

  // Revoke assignment mutation
  const revokeMutation = useMutation({
    mutationFn: async (studentId: string) => {
      const res = await authFetch(`/api/tutor/quizzes/${quizId}/assignments/${studentId}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("Failed to revoke");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/tutor/quizzes/${quizId}/details`] });
      setRevokeStudentId(null);
    },
  });

  // Archive toggle mutation
  const archiveMutation = useMutation({
    mutationFn: async () => {
      const res = await authFetch(`/api/tutor/quizzes/${quizId}/archive`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
      });
      if (!res.ok) throw new Error("Failed to toggle archive");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/tutor/quizzes/${quizId}/details`] });
    },
  });

  // Due date update mutation
  const dueDateMutation = useMutation({
    mutationFn: async (dueDate: string) => {
      const res = await authFetch(`/api/tutor/quizzes/${quizId}/due-date`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dueDate: dueDate || null }),
      });
      if (!res.ok) throw new Error("Failed to update due date");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/tutor/quizzes/${quizId}/details`] });
      setShowDueDatePicker(false);
      setNewDueDate("");
    },
  });

  // Assign students mutation
  const assignMutation = useMutation({
    mutationFn: async ({ studentIds, dueDate }: { studentIds: string[]; dueDate?: string }) => {
      const res = await authFetch(`/api/tutor/quizzes/${quizId}/assign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ studentIds, dueDate }),
      });
      if (!res.ok) throw new Error("Failed to assign");
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: [`/api/tutor/quizzes/${quizId}/details`] });
      setShowAssignModal(false);
      setSelectedStudentIds(new Set());
      setAssignDueDate("");
      const count = data?.assigned ?? 0;
      toast({
        title: count > 0 ? "Students assigned" : "Already assigned",
        description: count > 0
          ? `${count} student${count !== 1 ? "s" : ""} assigned successfully.`
          : "All selected students already have an assignment for this quiz.",
        variant: count > 0 ? "default" : "destructive",
      });
    },
    onError: (err: Error) => {
      toast({ title: "Assignment failed", description: err.message, variant: "destructive" });
    },
  });

  function toggleStudentSelection(id: string) {
    setSelectedStudentIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  const selectedStudentList = Array.from(selectedStudentIds);

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-950 to-slate-900 px-6 py-8">
        <div className="max-w-7xl mx-auto">
          <Link href="/tutor/assessments">
            <button className={`${STANDARD_ACTION_BUTTON_CLASS} mb-6`}>
              <ArrowLeft className="w-4 h-4" />
              Back
            </button>
          </Link>
          <div className="flex justify-center py-12">
            <Loader2 className="w-8 h-8 text-violet-500 animate-spin" />
          </div>
        </div>
      </div>
    );
  }

  if (!details) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-950 to-slate-900 px-6 py-8">
        <div className="max-w-7xl mx-auto">
          <Link href="/tutor/assessments">
            <button className={`${STANDARD_ACTION_BUTTON_CLASS} mb-6`}>
              <ArrowLeft className="w-4 h-4" />
              Back
            </button>
          </Link>
          <div className={`${CARD_CLASS} text-center py-12`}>
            <p className="text-slate-400">Quiz not found</p>
          </div>
        </div>
      </div>
    );
  }

  const { quiz, assignments } = details;
  const submittedCount = assignments.filter((a) => a.status === "Submitted").length;
  const graded = assignments.filter((a) => a.finalGrade !== null);
  const avgGradePct = graded.length > 0
    ? Math.round(graded.reduce((sum, a) => {
        const pct = a.maxGrade > 0 ? ((a.finalGrade || 0) / a.maxGrade) * 100 : 0;
        return sum + pct;
      }, 0) / graded.length)
    : null;
  const currentDueDate = assignments.find((a) => a.dueDate)?.dueDate || null;
  const alreadyAssignedIds = new Set(assignments.map((a) => a.studentId));
  const availableForAssign = adoptedStudents.filter((s) => !alreadyAssignedIds.has(s.id));

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 to-slate-900 px-6 py-8">
      <div className="max-w-7xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <Link href="/tutor/assessments">
            <button className={STANDARD_ACTION_BUTTON_CLASS}>
              <ArrowLeft className="w-4 h-4" />
              Back to Assessments
            </button>
          </Link>
        </div>

        {/* Quiz Title & Controls */}
        <div className={CARD_CLASS}>
          <div className="flex items-start justify-between mb-6">
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 rounded-xl bg-violet-500/20 border border-violet-500/30 flex items-center justify-center">
                <BookOpen className="w-6 h-6 text-violet-400" />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-slate-100">{quiz.title}</h1>
                <p className="text-sm text-slate-400">{quiz.topic}</p>
              </div>
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="p-2 hover:bg-slate-800/50 rounded-lg transition-colors">
                  <MoreVertical className="w-5 h-5 text-slate-400" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent className="bg-slate-800 border-slate-700">
                <DropdownMenuItem
                  className="text-slate-300 cursor-pointer"
                  onClick={() => archiveMutation.mutate()}
                >
                  {quiz.isArchived ? (
                    <>
                      <ArchiveX className="w-4 h-4 mr-2" />
                      Unarchive Quiz
                    </>
                  ) : (
                    <>
                      <Archive className="w-4 h-4 mr-2" />
                      Archive Quiz
                    </>
                  )}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          {/* Assignment Parameters - Header Controls */}
          <div className="flex flex-wrap items-center gap-3 mb-6">
            <button
              onClick={() => {
                setShowDueDatePicker(true);
                setNewDueDate(currentDueDate ? new Date(currentDueDate).toISOString().slice(0, 16) : "");
              }}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-slate-800/60 border border-slate-700/50 text-slate-300 hover:bg-slate-700/60 transition-all text-sm"
            >
              <CalendarDays className="w-4 h-4 text-violet-400" />
              {currentDueDate ? `Due: ${formatDate(currentDueDate)}` : "Set Due Date"}
            </button>
            <button
              onClick={() => {
                setShowAssignModal(true);
                setSelectedStudentIds(new Set());
                setAssignDueDate("");
              }}
              className={STANDARD_ACTION_BUTTON_CLASS}
            >
              <Plus className="w-4 h-4" />
              Add Students
            </button>
            {quiz.isArchived && (
              <Badge className="bg-amber-500/10 text-amber-400 border border-amber-500/30 text-xs">
                Archived
              </Badge>
            )}
          </div>

          <div className="grid grid-cols-4 gap-4">
            <div className="bg-white/5 rounded-xl p-4 border border-white/10">
              <p className="text-2xl font-bold text-slate-200">{quiz.level || "—"}</p>
              <p className="text-xs text-slate-400 mt-1">Level</p>
            </div>
            <div className="bg-white/5 rounded-xl p-4 border border-white/10">
              <p className="text-2xl font-bold text-violet-300">{details.totalAssigned}</p>
              <p className="text-xs text-slate-400 mt-1">Total Assigned</p>
            </div>
            <div className="bg-white/5 rounded-xl p-4 border border-white/10">
              <p className="text-2xl font-bold text-emerald-300">{submittedCount}</p>
              <p className="text-xs text-slate-400 mt-1">Submitted</p>
            </div>
            <div className="bg-white/5 rounded-xl p-4 border border-white/10">
              <p className="text-2xl font-bold text-cyan-300">{avgGradePct !== null ? `${avgGradePct}%` : "—"}</p>
              <p className="text-xs text-slate-400 mt-1">Avg Grade</p>
            </div>
          </div>
        </div>

        {/* Student Assignments Table */}
        <div className={CARD_CLASS}>
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-xl font-bold text-slate-200 flex items-center gap-2">
              <Users className="w-5 h-5" />
              Student Progress
            </h2>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-slate-700/50">
                  <th className="text-left py-3 px-4 text-xs font-semibold text-slate-400 uppercase tracking-wider">
                    Student
                  </th>
                  <th className="text-left py-3 px-4 text-xs font-semibold text-slate-400 uppercase tracking-wider">
                    Status
                  </th>
                  <th className="text-left py-3 px-4 text-xs font-semibold text-slate-400 uppercase tracking-wider">
                    Start Time
                  </th>
                  <th className="text-right py-3 px-4 text-xs font-semibold text-slate-400 uppercase tracking-wider">
                    Grade
                  </th>
                  <th className="text-center py-3 px-4 text-xs font-semibold text-slate-400 uppercase tracking-wider">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {assignments.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="py-8 text-center text-slate-400">
                      No students assigned to this quiz yet
                    </td>
                  </tr>
                ) : (
                  assignments.map((assignment) => (
                    <tr key={assignment.studentId} className="border-b border-slate-700/30 hover:bg-slate-800/30 transition-colors">
                      <td className="py-4 px-4">
                        <div className="flex items-center gap-3">
                          <div className={`w-9 h-9 rounded-full flex items-center justify-center text-xs font-bold ${getAvatarColor(assignment.studentId)}`}>
                            {getInitials(assignment.studentName)}
                          </div>
                          <div>
                            <p className="font-medium text-slate-200">{toProperCase(assignment.studentName)}</p>
                            <p className="text-xs text-slate-400">{assignment.studentEmail}</p>
                          </div>
                        </div>
                      </td>
                      <td className="py-4 px-4">
                        <Badge className={`text-xs border ${getStatusColor(assignment.status)}`}>
                          {assignment.status}
                        </Badge>
                      </td>
                      <td className="py-4 px-4 text-sm text-slate-300">
                        {formatDate(assignment.startTime)}
                      </td>
                      <td className="py-4 px-4 text-right">
                        {assignment.finalGrade !== null ? (
                          <div>
                            {(() => {
                              const pct = assignment.maxGrade > 0 ? Math.round((assignment.finalGrade / assignment.maxGrade) * 100) : 0;
                              return (
                                <>
                                  <p className={`text-sm font-bold ${pct >= 70 ? "text-emerald-400" : pct >= 40 ? "text-amber-400" : "text-red-400"}`}>
                                    {pct}%
                                  </p>
                                  <p className="text-[10px] text-slate-500">{assignment.finalGrade}/{assignment.maxGrade}</p>
                                </>
                              );
                            })()}
                          </div>
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                      </td>
                      <td className="py-4 px-4">
                        <div className="flex items-center justify-center gap-2">
                          {assignment.reportId && assignment.status === "Submitted" && (
                            <Link href={`/soma/review/${assignment.reportId}`}>
                              <button
                                className="p-2 text-cyan-400 hover:text-cyan-300 hover:bg-cyan-500/10 rounded-lg transition-colors"
                                title="View Diagnostic Report"
                              >
                                <FileText className="w-4 h-4" />
                              </button>
                            </Link>
                          )}
                          <button
                            onClick={() => setRevokeStudentId(assignment.studentId)}
                            className="p-2 text-red-400/60 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-colors"
                            title="Revoke assignment"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Student-flagged questions for this assessment */}
        <TutorFlagsPanel quizId={quizId} />
      </div>

      {/* Revoke Confirmation Dialog */}
      <AlertDialog open={revokeStudentId !== null} onOpenChange={(open) => { if (!open) setRevokeStudentId(null); }}>
        <AlertDialogContent className="bg-slate-900 border-slate-700">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-red-300">Revoke Assignment</AlertDialogTitle>
            <AlertDialogDescription className="text-slate-400">
              This will remove the student's access to this quiz. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              onClick={() => setRevokeStudentId(null)}
              className="bg-slate-800 text-slate-300 border-slate-700 hover:bg-slate-700"
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (revokeStudentId) revokeMutation.mutate(revokeStudentId);
              }}
              disabled={revokeMutation.isPending}
              className="bg-red-600 text-white hover:bg-red-700"
            >
              {revokeMutation.isPending ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                "Revoke"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Due Date Picker Modal */}
      {showDueDatePicker && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={() => setShowDueDatePicker(false)}>
          <div className="bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl max-w-sm w-full p-6" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-5">
              <h3 className="text-lg font-bold text-slate-200 flex items-center gap-2">
                <CalendarDays className="w-5 h-5 text-violet-400" />
                Change Due Date
              </h3>
              <button onClick={() => setShowDueDatePicker(false)} className="text-slate-400 hover:text-slate-300 p-1">
                <X className="w-5 h-5" />
              </button>
            </div>
            <p className="text-xs text-slate-400 mb-4">
              Update the submission deadline for all {assignments.length} assigned student(s).
            </p>
            <input
              type="datetime-local"
              value={newDueDate}
              onChange={(e) => setNewDueDate(e.target.value)}
              className="w-full px-3 py-2.5 rounded-lg bg-slate-800/80 border border-slate-600/50 text-sm text-slate-200 focus:outline-none focus:border-violet-500/50 focus:ring-1 focus:ring-violet-500/30 [color-scheme:dark] mb-4"
            />
            <div className="flex gap-3">
              {currentDueDate && (
                <button
                  onClick={() => dueDateMutation.mutate("")}
                  disabled={dueDateMutation.isPending}
                  className="flex-1 py-2.5 rounded-xl text-sm font-medium bg-slate-800 text-slate-300 border border-slate-600 hover:bg-slate-700 transition-all"
                >
                  Remove Date
                </button>
              )}
              <button
                onClick={() => dueDateMutation.mutate(newDueDate)}
                disabled={!newDueDate || dueDateMutation.isPending}
                className="flex-1 py-2.5 rounded-xl text-sm font-medium bg-violet-600 text-white hover:bg-violet-500 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
              >
                {dueDateMutation.isPending ? (
                  <Loader2 className="w-4 h-4 animate-spin mx-auto" />
                ) : (
                  "Save"
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Add Students Modal */}
      {showAssignModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={() => setShowAssignModal(false)}>
          <div className="bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl max-w-lg w-full max-h-[80vh] overflow-y-auto p-6" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between gap-3 mb-5">
              <h3 className="text-lg font-bold text-slate-200">Add Students to Assessment</h3>
              <button onClick={() => setShowAssignModal(false)} className="text-slate-400 hover:text-slate-300 p-1">
                <X className="w-5 h-5" />
              </button>
            </div>
            <p className="text-xs text-slate-400 mb-4">Select from your adopted students to assign this assessment:</p>
            {availableForAssign.length === 0 ? (
              <p className="text-sm text-slate-400 text-center py-8">
                {adoptedStudents.length === 0
                  ? "You have no adopted students. Go to the Students tab to adopt students first."
                  : "All your adopted students are already assigned to this quiz."}
              </p>
            ) : (
              <>
                <div className="space-y-2 max-h-[50vh] overflow-y-auto">
                  {availableForAssign.map((student) => (
                    <button
                      key={student.id}
                      onClick={() => toggleStudentSelection(student.id)}
                      className={`w-full min-h-[44px] flex items-center gap-3 px-4 py-3 rounded-xl transition-all text-left ${
                        selectedStudentIds.has(student.id)
                          ? "bg-emerald-500/20 border border-emerald-500/40"
                          : "bg-slate-800/40 border border-slate-700/50 hover:bg-slate-800/60"
                      }`}
                    >
                      <div className={`w-5 h-5 rounded-md border flex items-center justify-center ${
                        selectedStudentIds.has(student.id) ? "bg-emerald-500 border-emerald-500" : "border-slate-600"
                      }`}>
                        {selectedStudentIds.has(student.id) && <Check className="w-3 h-3 text-white" />}
                      </div>
                      <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold ${getAvatarColor(student.id)}`}>
                        {getInitials(student.displayName || student.email)}
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
                    value={assignDueDate}
                    onChange={(e) => setAssignDueDate(e.target.value)}
                    className="w-full px-3 py-2.5 min-h-[44px] rounded-lg bg-slate-900/80 border border-slate-600/50 text-sm text-slate-200 focus:outline-none focus:border-violet-500/50 focus:ring-1 focus:ring-violet-500/30 [color-scheme:dark]"
                  />
                </div>
                <button
                  onClick={() => assignMutation.mutate({ studentIds: selectedStudentList, dueDate: assignDueDate || undefined })}
                  disabled={selectedStudentList.length === 0 || assignMutation.isPending}
                  className="w-full mt-4 py-3 min-h-[44px] rounded-xl text-sm font-medium bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
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
    </div>
  );
}
