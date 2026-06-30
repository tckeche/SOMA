import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useParams, Link } from "wouter";
import { authFetch } from "@/lib/supabase";
import { formatPersonName } from "@/lib/personName";
import { useSupabaseSession } from "@/hooks/use-supabase-session";
import type { SomaQuiz } from "@shared/schema";
import { defaultDueDateInputValue } from "@shared/dueDate";
import { toProperCase, getInitials } from "@/lib/utils";
import {
  ArrowLeft, BookOpen, Users, Trash2, Plus, FileText,
  Loader2, Check, X, MoreVertical, Archive, ArchiveX,
  CalendarDays, Clock, Search, Mail, Upload, Download, Paperclip, FileCheck,
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
import { ThemeToggle } from "@/components/ThemeToggle";
import TutorFlagsPanel from "@/components/tutor/TutorFlagsPanel";
import AssignmentStatusBadge from "@/components/tutor/AssignmentStatusBadge";
import type { AssignmentStatus } from "@shared/assignmentStatus";

interface StudentAssignment {
  assignmentId: number;
  studentId: string;
  studentName: string;
  studentEmail: string;
  assignmentStatus: string;
  status: "Not Started" | "In Progress" | "Submitted" | "Failed";
  detailedStatus: AssignmentStatus;
  detailedStatusLabel: string;
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

interface QuizAttachment {
  id: number;
  filename: string;
  sizeBytes: number;
  mimeType: string;
  createdAt: string;
}

interface SubmissionUpload {
  id: number;
  studentId: string;
  studentName: string;
  filename: string;
  sizeBytes: number;
  status: "submitted" | "marked";
  score: number | null;
  maxScore: number | null;
  feedback: string | null;
  createdAt: string;
  markedAt: string | null;
}

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

function formatBytes(bytes: number) {
  if (!bytes || bytes < 1024) return `${bytes || 0} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

const CARD_CLASS = "bg-card/80 backdrop-blur-md border border-card-border rounded-2xl p-6 shadow-2xl";
const STANDARD_ACTION_BUTTON_CLASS = "inline-flex items-center justify-center gap-2 px-4 py-2 min-h-[44px] rounded-lg text-sm font-medium border border-primary/40 bg-primary/20 text-primary hover:bg-primary/30 transition-all";

function formatDate(dateStr: string | null) {
  if (!dateStr) return "—";
  return new Date(dateStr).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
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
  const [assignSearch, setAssignSearch] = useState("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [deleteAttachmentId, setDeleteAttachmentId] = useState<number | null>(null);
  const [markUpload, setMarkUpload] = useState<SubmissionUpload | null>(null);
  const [markScore, setMarkScore] = useState("");
  const [markMax, setMarkMax] = useState("");
  const [markFeedback, setMarkFeedback] = useState("");
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
      const payload: { studentIds: string[]; dueDate?: string } = { studentIds };
      if (dueDate) payload.dueDate = new Date(dueDate).toISOString();
      const res = await authFetch(`/api/tutor/quizzes/${quizId}/assign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
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

  // ---- PDF uploads: worksheet attachments + student responses ----
  const attachmentsKey = [`/api/tutor/quizzes/${quizId}/attachments`, userId];
  const responsesKey = [`/api/tutor/quizzes/${quizId}/submission-uploads`, userId];

  const {
    data: attachments = [],
    error: attachmentsError,
  } = useQuery<QuizAttachment[]>({
    queryKey: attachmentsKey,
    queryFn: async () => {
      const res = await authFetch(`/api/tutor/quizzes/${quizId}/attachments`);
      if (res.status === 503) throw new Error("STORAGE_UNCONFIGURED");
      if (!res.ok) throw new Error("Failed to load attachments");
      return res.json();
    },
    enabled: !!userId && quizId > 0,
    retry: false,
  });

  const {
    data: responses = [],
    error: responsesError,
  } = useQuery<SubmissionUpload[]>({
    queryKey: responsesKey,
    queryFn: async () => {
      const res = await authFetch(`/api/tutor/quizzes/${quizId}/submission-uploads`);
      if (res.status === 503) throw new Error("STORAGE_UNCONFIGURED");
      if (!res.ok) throw new Error("Failed to load responses");
      return res.json();
    },
    enabled: !!userId && quizId > 0,
    retry: false,
  });

  const storageUnconfigured =
    (attachmentsError as Error | null)?.message === "STORAGE_UNCONFIGURED" ||
    (responsesError as Error | null)?.message === "STORAGE_UNCONFIGURED";

  const uploadMutation = useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData();
      formData.append("file", file);
      // Multipart: use authFetch (adds Bearer token) but DO NOT set Content-Type
      // so the browser sets the multipart boundary automatically.
      const res = await authFetch(`/api/tutor/quizzes/${quizId}/attachments`, {
        method: "POST",
        body: formData,
      });
      if (res.status === 503) throw new Error("File storage isn't configured on the server yet.");
      if (!res.ok) throw new Error("Upload failed");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/tutor/quizzes/${quizId}/attachments`] });
      setSelectedFile(null);
      toast({ title: "Worksheet uploaded", description: "The attachment was added." });
    },
    onError: (err: Error) => {
      toast({ title: "Upload failed", description: err.message, variant: "destructive" });
    },
  });

  const deleteAttachmentMutation = useMutation({
    mutationFn: async (attachmentId: number) => {
      const res = await authFetch(`/api/tutor/quizzes/${quizId}/attachments/${attachmentId}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("Delete failed");
      return res.json().catch(() => ({}));
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/tutor/quizzes/${quizId}/attachments`] });
      setDeleteAttachmentId(null);
      toast({ title: "Worksheet removed" });
    },
    onError: (err: Error) => {
      toast({ title: "Delete failed", description: err.message, variant: "destructive" });
    },
  });

  const markMutation = useMutation({
    mutationFn: async ({ id, score, maxScore, feedback }: { id: number; score: number; maxScore?: number; feedback?: string }) => {
      const res = await authFetch(`/api/tutor/submission-uploads/${id}/mark`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ score, maxScore, feedback }),
      });
      if (!res.ok) throw new Error("Failed to save mark");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/tutor/quizzes/${quizId}/submission-uploads`] });
      setMarkUpload(null);
      toast({ title: "Marked", description: "The response was marked." });
    },
    onError: (err: Error) => {
      toast({ title: "Marking failed", description: err.message, variant: "destructive" });
    },
  });

  function handleSelectFile(file: File | null) {
    if (!file) {
      setSelectedFile(null);
      return;
    }
    if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
      toast({ title: "Invalid file", description: "Only PDF files are allowed.", variant: "destructive" });
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      toast({ title: "File too large", description: "Maximum file size is 20MB.", variant: "destructive" });
      return;
    }
    setSelectedFile(file);
  }

  // Open a signed-download URL in a new tab. The tab is opened synchronously
  // (before any await) so popup blockers don't swallow it; the opener is nulled
  // manually since passing "noopener" to window.open() returns null.
  async function openSigned(fetchUrl: string) {
    const win = window.open("about:blank", "_blank");
    if (win) {
      try {
        (win as unknown as { opener: unknown }).opener = null;
      } catch {}
    }
    try {
      const res = await authFetch(fetchUrl);
      if (!res.ok) throw new Error("Download failed");
      const { url } = await res.json();
      if (win) win.location.href = url;
      else window.location.href = url;
    } catch (err) {
      if (win) win.close();
      toast({ title: "Download failed", description: (err as Error).message, variant: "destructive" });
    }
  }

  async function downloadAttachment(attachmentId: number) {
    await openSigned(`/api/quizzes/${quizId}/attachments/${attachmentId}/download`);
  }

  async function downloadResponse(id: number) {
    await openSigned(`/api/tutor/submission-uploads/${id}/download`);
  }

  function openMarkDialog(upload: SubmissionUpload) {
    setMarkUpload(upload);
    setMarkScore(upload.score != null ? String(upload.score) : "");
    setMarkMax(upload.maxScore != null ? String(upload.maxScore) : "");
    setMarkFeedback(upload.feedback ?? "");
  }

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
      <div className="min-h-screen bg-gradient-to-br from-background to-background px-6 py-8">
        <div className="max-w-7xl mx-auto">
          <Link href="/tutor/assessments">
            <button className={`${STANDARD_ACTION_BUTTON_CLASS} mb-6`}>
              <ArrowLeft className="w-4 h-4" />
              Back
            </button>
          </Link>
          <div className="flex justify-center py-12">
            <Loader2 className="w-8 h-8 text-primary animate-spin" />
          </div>
        </div>
      </div>
    );
  }

  if (!details) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-background to-background px-6 py-8">
        <div className="max-w-7xl mx-auto">
          <Link href="/tutor/assessments">
            <button className={`${STANDARD_ACTION_BUTTON_CLASS} mb-6`}>
              <ArrowLeft className="w-4 h-4" />
              Back
            </button>
          </Link>
          <div className={`${CARD_CLASS} text-center py-12`}>
            <p className="text-muted-foreground">Quiz not found</p>
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
    <div className="min-h-screen bg-gradient-to-br from-background to-background px-6 py-8">
      <div className="max-w-7xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <Link href="/tutor/assessments">
            <button className={STANDARD_ACTION_BUTTON_CLASS}>
              <ArrowLeft className="w-4 h-4" />
              Back to Assessments
            </button>
          </Link>
          <ThemeToggle />
        </div>

        {/* Quiz Title & Controls */}
        <div className={CARD_CLASS}>
          <div className="flex items-start justify-between mb-6">
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 rounded-xl bg-primary/20 border border-primary/30 flex items-center justify-center">
                <BookOpen className="w-6 h-6 text-primary" />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-foreground">{quiz.title}</h1>
                <p className="text-sm text-muted-foreground">{quiz.topic}</p>
              </div>
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button aria-label="Assessment options" className="p-2 hover:bg-muted/50 rounded-lg transition-colors">
                  <MoreVertical className="w-5 h-5 text-muted-foreground" aria-hidden="true" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent className="bg-muted border-border">
                <DropdownMenuItem
                  className="text-foreground/80 cursor-pointer"
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
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-muted/60 border border-border/50 text-foreground/80 hover:bg-muted transition-all text-sm"
            >
              <CalendarDays className="w-4 h-4 text-primary" />
              {currentDueDate ? `Due: ${formatDate(currentDueDate)}` : "Set Due Date"}
            </button>
            <button
              onClick={() => {
                setShowAssignModal(true);
                setSelectedStudentIds(new Set());
                setAssignDueDate(defaultDueDateInputValue(details?.quiz?.createdAt));
              }}
              className={STANDARD_ACTION_BUTTON_CLASS}
            >
              <Plus className="w-4 h-4" />
              Add Students
            </button>
            <Link href={`/tutor/quizzes/${quizId}/review`}>
              <div className={`${STANDARD_ACTION_BUTTON_CLASS} cursor-pointer`} data-testid="review-questions-link">
                <FileText className="w-4 h-4" />
                Review Questions
              </div>
            </Link>
            {quiz.isArchived && (
              <Badge className="bg-warning/10 text-warning border border-warning/30 text-xs">
                Archived
              </Badge>
            )}
          </div>

          <div className="grid grid-cols-4 gap-4">
            <div className="bg-foreground/5 rounded-xl p-4 border border-border/50">
              <p className="text-2xl font-bold text-foreground">{quiz.level || "—"}</p>
              <p className="text-xs text-muted-foreground mt-1">Level</p>
            </div>
            <div className="bg-foreground/5 rounded-xl p-4 border border-border/50">
              <p className="text-2xl font-bold text-primary">{details.totalAssigned}</p>
              <p className="text-xs text-muted-foreground mt-1">Total Assigned</p>
            </div>
            <div className="bg-foreground/5 rounded-xl p-4 border border-border/50">
              <p className="text-2xl font-bold text-success">{submittedCount}</p>
              <p className="text-xs text-muted-foreground mt-1">Submitted</p>
            </div>
            <div className="bg-foreground/5 rounded-xl p-4 border border-border/50">
              <p className="text-2xl font-bold text-info">{avgGradePct !== null ? `${avgGradePct}%` : "—"}</p>
              <p className="text-xs text-muted-foreground mt-1">Avg Grade</p>
            </div>
          </div>
        </div>

        {/* Student Assignments Table */}
        <div className={CARD_CLASS}>
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-xl font-bold text-foreground flex items-center gap-2">
              <Users className="w-5 h-5" />
              Student Progress
            </h2>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border/50">
                  <th className="text-left py-3 px-4 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                    Student
                  </th>
                  <th className="text-left py-3 px-4 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                    Status
                  </th>
                  <th className="text-left py-3 px-4 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                    Start Time
                  </th>
                  <th className="text-right py-3 px-4 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                    Grade
                  </th>
                  <th className="text-center py-3 px-4 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {assignments.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="py-8 text-center text-muted-foreground">
                      No students assigned to this quiz yet
                    </td>
                  </tr>
                ) : (
                  assignments.map((assignment) => (
                    <tr key={assignment.studentId} className="border-b border-border/30 hover:bg-muted/30 transition-colors">
                      <td className="py-4 px-4">
                        <div className="flex items-center gap-3">
                          <div className={`w-9 h-9 rounded-full flex items-center justify-center text-xs font-bold ${getAvatarColor(assignment.studentId)}`}>
                            {getInitials(assignment.studentName)}
                          </div>
                          <div>
                            <p className="font-medium text-foreground">{toProperCase(assignment.studentName)}</p>
                            <p className="text-xs text-muted-foreground">{assignment.studentEmail}</p>
                          </div>
                        </div>
                      </td>
                      <td className="py-4 px-4">
                        <AssignmentStatusBadge
                          status={assignment.detailedStatus}
                          dueDate={assignment.dueDate}
                        />
                      </td>
                      <td className="py-4 px-4 text-sm text-foreground/80">
                        {formatDate(assignment.startTime)}
                      </td>
                      <td className="py-4 px-4 text-right">
                        {assignment.finalGrade !== null ? (
                          <div>
                            {(() => {
                              const pct = assignment.maxGrade > 0 ? Math.round((assignment.finalGrade / assignment.maxGrade) * 100) : 0;
                              return (
                                <>
                                  <p className={`text-sm font-bold ${pct >= 70 ? "text-success" : pct >= 40 ? "text-warning" : "text-danger"}`}>
                                    {pct}%
                                  </p>
                                  <p className="text-[10px] text-muted-foreground">{assignment.finalGrade}/{assignment.maxGrade}</p>
                                </>
                              );
                            })()}
                          </div>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="py-4 px-4">
                        <div className="flex items-center justify-center gap-2">
                          {assignment.reportId && (assignment.detailedStatus === "submitted" || assignment.detailedStatus === "feedback_ready") && (
                            <Link href={`/soma/review/${assignment.reportId}`}>
                              <button
                                className="p-2 text-info hover:text-info/80 hover:bg-info/10 rounded-lg transition-colors"
                                title="View Diagnostic Report"
                              >
                                <FileText className="w-4 h-4" />
                              </button>
                            </Link>
                          )}
                          <button
                            onClick={() => setRevokeStudentId(assignment.studentId)}
                            className="p-2 text-danger/60 hover:text-danger hover:bg-danger/10 rounded-lg transition-colors"
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

        {/* Worksheets + PDF responses only apply to PDF-format assessments.
            MCQ assessments skip straight to the question-review surfaces. */}
        {quiz.format === "pdf" && (
        <>
        {/* Worksheets / Attachments */}
        <div className={CARD_CLASS}>
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-xl font-bold text-foreground flex items-center gap-2">
              <Paperclip className="w-5 h-5" />
              Worksheets / Attachments
            </h2>
          </div>

          {storageUnconfigured ? (
            <div className="rounded-xl bg-warning/10 border border-warning/30 px-4 py-3 text-sm text-warning">
              File storage isn't configured on the server yet.
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-3 mb-5">
                <input
                  type="file"
                  accept="application/pdf"
                  data-testid="attach-file-input"
                  onChange={(e) => handleSelectFile(e.target.files?.[0] ?? null)}
                  className="text-sm text-foreground/80 file:mr-3 file:rounded-lg file:border-0 file:bg-primary/20 file:px-4 file:py-2 file:text-sm file:font-medium file:text-primary hover:file:bg-primary/30"
                />
                <button
                  data-testid="attach-upload"
                  onClick={() => selectedFile && uploadMutation.mutate(selectedFile)}
                  disabled={!selectedFile || uploadMutation.isPending}
                  className={`${STANDARD_ACTION_BUTTON_CLASS} disabled:opacity-50 disabled:cursor-not-allowed`}
                >
                  {uploadMutation.isPending ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Upload className="w-4 h-4" />
                  )}
                  Upload
                </button>
                {selectedFile && (
                  <span className="text-xs text-muted-foreground truncate max-w-[200px]">
                    {selectedFile.name} ({formatBytes(selectedFile.size)})
                  </span>
                )}
              </div>

              {attachments.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-8">
                  No worksheets uploaded yet.
                </p>
              ) : (
                <div className="space-y-2">
                  {attachments.map((att) => (
                    <div
                      key={att.id}
                      data-testid={`attach-row-${att.id}`}
                      className="flex items-center justify-between gap-3 rounded-xl bg-muted/40 border border-border/50 px-4 py-3"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <FileText className="w-4 h-4 text-primary shrink-0" />
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-foreground truncate">{att.filename}</p>
                          <p className="text-xs text-muted-foreground">{formatBytes(att.sizeBytes)}</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          data-testid={`attach-download-${att.id}`}
                          onClick={() => downloadAttachment(att.id)}
                          className="p-2 text-info hover:text-info/80 hover:bg-info/10 rounded-lg transition-colors"
                          title="Download"
                        >
                          <Download className="w-4 h-4" />
                        </button>
                        <button
                          data-testid={`attach-delete-${att.id}`}
                          onClick={() => setDeleteAttachmentId(att.id)}
                          className="p-2 text-danger/60 hover:text-danger hover:bg-danger/10 rounded-lg transition-colors"
                          title="Delete"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        {/* Student PDF Responses */}
        <div className={CARD_CLASS}>
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-xl font-bold text-foreground flex items-center gap-2">
              <FileCheck className="w-5 h-5" />
              PDF Responses
            </h2>
          </div>

          {storageUnconfigured ? (
            <div className="rounded-xl bg-warning/10 border border-warning/30 px-4 py-3 text-sm text-warning">
              File storage isn't configured on the server yet.
            </div>
          ) : responses.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">
              No PDF responses submitted yet.
            </p>
          ) : (
            <div className="space-y-2">
              {responses.map((resp) => (
                <div
                  key={resp.id}
                  data-testid={`resp-row-${resp.id}`}
                  className="flex items-center justify-between gap-3 rounded-xl bg-muted/40 border border-border/50 px-4 py-3"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div className={`w-9 h-9 rounded-full flex items-center justify-center text-xs font-bold shrink-0 ${getAvatarColor(resp.studentId)}`}>
                      {getInitials(resp.studentName)}
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-foreground truncate">{toProperCase(resp.studentName)}</p>
                      <p className="text-xs text-muted-foreground truncate">{resp.filename}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    {resp.status === "marked" ? (
                      <div className="text-right">
                        <Badge className="bg-success/10 text-success border border-success/30 text-xs">
                          Marked
                        </Badge>
                        <p className="text-xs text-foreground/80 mt-1">
                          {resp.score ?? 0}{resp.maxScore != null ? ` / ${resp.maxScore}` : ""}
                        </p>
                      </div>
                    ) : (
                      <Badge className="bg-warning/10 text-warning border border-warning/30 text-xs">
                        Submitted
                      </Badge>
                    )}
                    <button
                      data-testid={`resp-download-${resp.id}`}
                      onClick={() => downloadResponse(resp.id)}
                      className="p-2 text-info hover:text-info/80 hover:bg-info/10 rounded-lg transition-colors"
                      title="Download"
                    >
                      <Download className="w-4 h-4" />
                    </button>
                    <button
                      data-testid={`resp-mark-${resp.id}`}
                      onClick={() => openMarkDialog(resp)}
                      className={STANDARD_ACTION_BUTTON_CLASS}
                    >
                      <Check className="w-4 h-4" />
                      Mark
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
        </>
        )}

        {/* Student-flagged questions for this assessment */}
        <TutorFlagsPanel quizId={quizId} />
      </div>

      {/* Revoke Confirmation Dialog */}
      <AlertDialog open={revokeStudentId !== null} onOpenChange={(open) => { if (!open) setRevokeStudentId(null); }}>
        <AlertDialogContent className="bg-card border-border">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-danger">Revoke Assignment</AlertDialogTitle>
            <AlertDialogDescription className="text-muted-foreground">
              This will remove the student's access to this quiz. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              onClick={() => setRevokeStudentId(null)}
              className="bg-muted text-foreground/80 border-border hover:bg-muted/80"
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (revokeStudentId) revokeMutation.mutate(revokeStudentId);
              }}
              disabled={revokeMutation.isPending}
              className="bg-danger text-white hover:bg-danger/90"
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

      {/* Delete Attachment Confirmation Dialog */}
      <AlertDialog open={deleteAttachmentId !== null} onOpenChange={(open) => { if (!open) setDeleteAttachmentId(null); }}>
        <AlertDialogContent className="bg-card border-border">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-danger">Delete Worksheet</AlertDialogTitle>
            <AlertDialogDescription className="text-muted-foreground">
              This will permanently remove this worksheet attachment. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              onClick={() => setDeleteAttachmentId(null)}
              className="bg-muted text-foreground/80 border-border hover:bg-muted/80"
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => { if (deleteAttachmentId !== null) deleteAttachmentMutation.mutate(deleteAttachmentId); }}
              disabled={deleteAttachmentMutation.isPending}
              className="bg-danger text-white hover:bg-danger/90"
            >
              {deleteAttachmentMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Mark Response Dialog */}
      {markUpload && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 backdrop-blur-sm p-4" onClick={() => setMarkUpload(null)}>
          <div className="bg-card border border-border rounded-2xl shadow-2xl max-w-md w-full p-6" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-5">
              <h3 className="text-lg font-bold text-foreground flex items-center gap-2">
                <FileCheck className="w-5 h-5 text-primary" />
                Mark Response
              </h3>
              <button onClick={() => setMarkUpload(null)} aria-label="Close dialog" className="text-muted-foreground hover:text-foreground/80 p-1">
                <X className="w-5 h-5" />
              </button>
            </div>
            <p className="text-xs text-muted-foreground mb-4">
              {toProperCase(markUpload.studentName)} — {markUpload.filename}
            </p>
            <div className="grid grid-cols-2 gap-3 mb-4">
              <div>
                <label className="block text-xs font-medium text-foreground/80 mb-1.5">Score</label>
                <input
                  type="number"
                  min={0}
                  data-testid="resp-mark-score"
                  value={markScore}
                  onChange={(e) => setMarkScore(e.target.value)}
                  className="w-full px-3 py-2.5 rounded-lg bg-muted/80 border border-border/50 text-sm text-foreground focus:outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/30"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-foreground/80 mb-1.5">Max Score</label>
                <input
                  type="number"
                  min={1}
                  data-testid="resp-mark-max"
                  value={markMax}
                  onChange={(e) => setMarkMax(e.target.value)}
                  className="w-full px-3 py-2.5 rounded-lg bg-muted/80 border border-border/50 text-sm text-foreground focus:outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/30"
                />
              </div>
            </div>
            <div className="mb-4">
              <label className="block text-xs font-medium text-foreground/80 mb-1.5">Feedback (optional)</label>
              <textarea
                data-testid="resp-mark-feedback"
                value={markFeedback}
                onChange={(e) => setMarkFeedback(e.target.value)}
                rows={4}
                className="w-full px-3 py-2.5 rounded-lg bg-muted/80 border border-border/50 text-sm text-foreground focus:outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/30 resize-none"
              />
            </div>
            <button
              data-testid="resp-mark-save"
              onClick={() => {
                const score = parseInt(markScore, 10);
                const maxScore = parseInt(markMax, 10);
                if (Number.isNaN(score) || score < 0) {
                  toast({ title: "Invalid score", description: "Score must be 0 or greater.", variant: "destructive" });
                  return;
                }
                if (markMax.trim() === "" || Number.isNaN(maxScore) || maxScore <= 0) {
                  toast({ title: "Max score required", description: "Enter a max score greater than 0.", variant: "destructive" });
                  return;
                }
                if (score > maxScore) {
                  toast({ title: "Invalid score", description: "Score cannot exceed the max score.", variant: "destructive" });
                  return;
                }
                markMutation.mutate({ id: markUpload.id, score, maxScore, feedback: markFeedback.trim() || undefined });
              }}
              disabled={markMutation.isPending}
              className="w-full py-3 min-h-[44px] rounded-xl text-sm font-medium bg-primary text-white hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
            >
              {markMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mx-auto" /> : "Save Mark"}
            </button>
          </div>
        </div>
      )}

      {/* Due Date Picker Modal */}
      {showDueDatePicker && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 backdrop-blur-sm p-4" onClick={() => setShowDueDatePicker(false)}>
          <div className="bg-card border border-border rounded-2xl shadow-2xl max-w-sm w-full p-6" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-5">
              <h3 className="text-lg font-bold text-foreground flex items-center gap-2">
                <CalendarDays className="w-5 h-5 text-primary" />
                Change Due Date
              </h3>
              <button onClick={() => setShowDueDatePicker(false)} aria-label="Close dialog" className="text-muted-foreground hover:text-foreground/80 p-1">
                <X className="w-5 h-5" />
              </button>
            </div>
            <p className="text-xs text-muted-foreground mb-4">
              Update the submission deadline for all {assignments.length} assigned student(s).
            </p>
            <input
              type="datetime-local"
              value={newDueDate}
              onChange={(e) => setNewDueDate(e.target.value)}
              className="w-full px-3 py-2.5 rounded-lg bg-muted/80 border border-border/50 text-sm text-foreground focus:outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/30 mb-4"
            />
            <div className="flex gap-3">
              {currentDueDate && (
                <button
                  onClick={() => dueDateMutation.mutate("")}
                  disabled={dueDateMutation.isPending}
                  className="flex-1 py-2.5 rounded-xl text-sm font-medium bg-muted text-foreground/80 border border-border hover:bg-muted/80 transition-all"
                >
                  Remove Date
                </button>
              )}
              <button
                onClick={() => dueDateMutation.mutate(newDueDate)}
                disabled={!newDueDate || dueDateMutation.isPending}
                className="flex-1 py-2.5 rounded-xl text-sm font-medium bg-primary text-white hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
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
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 backdrop-blur-sm p-4" onClick={() => { setShowAssignModal(false); setAssignSearch(""); }}>
          <div className="bg-card border border-border rounded-2xl shadow-2xl max-w-lg w-full max-h-[85vh] overflow-y-auto p-6" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between gap-3 mb-5">
              <h3 className="text-lg font-bold text-foreground">Add Students to Assessment</h3>
              <button onClick={() => { setShowAssignModal(false); setAssignSearch(""); }} aria-label="Close dialog" className="text-muted-foreground hover:text-foreground/80 p-1">
                <X className="w-5 h-5" />
              </button>
            </div>
            <p className="text-xs text-muted-foreground mb-3">Search your students and select who should receive this assessment:</p>
            {availableForAssign.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">
                {adoptedStudents.length === 0
                  ? "You don't have any students yet. Go to the Students page to add students first."
                  : "All your students are already assigned to this assessment."}
              </p>
            ) : (
              <>
                <div className="relative mb-3">
                  <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
                  <input
                    type="text"
                    value={assignSearch}
                    onChange={(e) => setAssignSearch(e.target.value)}
                    placeholder="Search by name or email..."
                    className="w-full h-11 pl-11 pr-4 rounded-xl bg-muted/60 border border-border text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-success/40"
                    data-testid="input-search-assign-details"
                    autoFocus
                  />
                </div>
                {(() => {
                  const q = assignSearch.trim().toLowerCase();
                  const filtered = q
                    ? availableForAssign.filter((s) =>
                        (s.displayName || "").toLowerCase().includes(q) ||
                        (s.email || "").toLowerCase().includes(q),
                      )
                    : availableForAssign;
                  const allVisibleSelected =
                    filtered.length > 0 && filtered.every((s) => selectedStudentIds.has(s.id));
                  const toggleAllVisible = () => {
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
                      <div className="flex items-center justify-between mb-2 text-[11px] text-muted-foreground px-1">
                        <span>
                          {filtered.length} shown · {selectedStudentIds.size} selected
                        </span>
                        {filtered.length > 0 && (
                          <button
                            onClick={toggleAllVisible}
                            className="text-success hover:text-success/80 font-medium"
                            data-testid="button-select-all-assign-details"
                          >
                            {allVisibleSelected ? "Clear selection" : "Select all visible"}
                          </button>
                        )}
                      </div>
                      <div className="space-y-2 max-h-[45vh] overflow-y-auto">
                        {filtered.length === 0 ? (
                          <p className="text-xs text-muted-foreground text-center py-6">No matches for "{assignSearch}"</p>
                        ) : filtered.map((student) => (
                          <button
                            key={student.id}
                            onClick={() => toggleStudentSelection(student.id)}
                            className={`w-full min-h-[52px] flex items-center gap-3 px-4 py-3 rounded-xl transition-all text-left ${
                              selectedStudentIds.has(student.id)
                                ? "bg-success/20 border-2 border-success/60"
                                : "bg-muted/40 border-2 border-border/50 hover:bg-muted/60"
                            }`}
                            data-testid={`assign-student-details-${student.id}`}
                            aria-pressed={selectedStudentIds.has(student.id)}
                          >
                            <div className={`w-6 h-6 rounded-md border-2 flex items-center justify-center shrink-0 ${
                              selectedStudentIds.has(student.id) ? "bg-success border-success" : "border-muted-foreground"
                            }`}>
                              {selectedStudentIds.has(student.id) && <Check className="w-4 h-4 text-white" strokeWidth={3} />}
                            </div>
                            <div className={`w-9 h-9 rounded-full flex items-center justify-center text-[11px] font-bold shrink-0 ${getAvatarColor(student.id)}`}>
                              {getInitials(formatPersonName(student))}
                            </div>
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-medium text-foreground truncate">{formatPersonName(student)}</p>
                              {student.email && (
                                <p className="flex items-center gap-1 text-[11px] text-muted-foreground truncate">
                                  <Mail className="w-3 h-3 shrink-0" />
                                  <span className="truncate">{student.email}</span>
                                </p>
                              )}
                            </div>
                          </button>
                        ))}
                      </div>
                    </>
                  );
                })()}
                <div className="mt-4 p-3 rounded-xl bg-muted/60 border border-border/50">
                  <label className="flex items-center gap-2 text-xs font-medium text-foreground/80 mb-2">
                    <Clock className="w-3.5 h-3.5 text-primary" />
                    Due Date & Time <span className="text-muted-foreground">(defaults to 3 days out)</span>
                  </label>
                  <input
                    type="datetime-local"
                    value={assignDueDate}
                    onChange={(e) => setAssignDueDate(e.target.value)}
                    className="w-full px-3 py-2.5 min-h-[44px] rounded-lg bg-card/80 border border-border/50 text-sm text-foreground focus:outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/30"
                  />
                </div>
                <button
                  onClick={() => assignMutation.mutate({ studentIds: selectedStudentList, dueDate: assignDueDate || undefined })}
                  disabled={selectedStudentList.length === 0 || assignMutation.isPending}
                  className="w-full mt-4 py-3 min-h-[44px] rounded-xl text-sm font-medium bg-success text-white hover:bg-success/90 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
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
