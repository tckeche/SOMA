import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { authFetch } from "@/lib/supabase";
import { useToast } from "@/hooks/use-toast";
import {
  Paperclip, FileText, Download, Upload, Loader2, FileCheck,
  CheckCircle2, Clock, AlertTriangle,
} from "lucide-react";

interface QuizAttachment {
  id: number;
  filename: string;
  sizeBytes: number;
  mimeType: string;
  createdAt: string;
}

interface SubmissionUpload {
  id: number;
  filename: string;
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

const STORAGE_UNCONFIGURED = "STORAGE_UNCONFIGURED";

function StorageNotice() {
  return (
    <div className="rounded-xl bg-amber-500/10 border border-amber-500/30 px-4 py-3 text-sm text-amber-300">
      File uploads aren't available right now. Please check back later.
    </div>
  );
}

export default function StudentAssessmentPdfSection({ quizId }: { quizId: number }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [selectedFile, setSelectedFile] = useState<File | null>(null);

  const attachmentsKey = ["/api/quizzes", quizId, "attachments"];
  const submissionKey = ["/api/quizzes", quizId, "submission-upload"];

  const { data: attachments = [], error: attachmentsError } = useQuery<QuizAttachment[]>({
    queryKey: attachmentsKey,
    queryFn: async () => {
      const res = await authFetch(`/api/quizzes/${quizId}/attachments`);
      if (res.status === 503) throw new Error(STORAGE_UNCONFIGURED);
      if (!res.ok) throw new Error("Failed to load worksheets");
      return res.json();
    },
    enabled: quizId > 0,
    retry: false,
  });

  // 404 == "no submission yet", which is a normal state, not an error.
  const { data: submission, error: submissionError } = useQuery<SubmissionUpload | null>({
    queryKey: submissionKey,
    queryFn: async () => {
      const res = await authFetch(`/api/quizzes/${quizId}/submission-upload`);
      if (res.status === 503) throw new Error(STORAGE_UNCONFIGURED);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error("Failed to load your response");
      return res.json();
    },
    enabled: quizId > 0,
    retry: false,
  });

  const storageUnconfigured =
    (attachmentsError as Error | null)?.message === STORAGE_UNCONFIGURED ||
    (submissionError as Error | null)?.message === STORAGE_UNCONFIGURED;

  const uploadMutation = useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData();
      formData.append("file", file);
      // Multipart: authFetch adds the Bearer token but we must NOT set
      // Content-Type so the browser sets the multipart boundary itself.
      const res = await authFetch(`/api/quizzes/${quizId}/submission-upload`, {
        method: "POST",
        body: formData,
      });
      if (res.status === 503) throw new Error("File uploads aren't available right now.");
      if (!res.ok) throw new Error("Upload failed");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: submissionKey });
      setSelectedFile(null);
      toast({ title: "Response uploaded", description: "Your tutor will mark it soon." });
    },
    onError: (err: Error) => {
      toast({ title: "Upload failed", description: err.message, variant: "destructive" });
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

  async function downloadAttachment(attachmentId: number) {
    // Open the tab synchronously (before any await) so popup blockers don't
    // swallow it; null the opener manually since "noopener" makes open() null.
    const win = window.open("about:blank", "_blank");
    if (win) {
      try {
        (win as unknown as { opener: unknown }).opener = null;
      } catch {}
    }
    try {
      const res = await authFetch(`/api/quizzes/${quizId}/attachments/${attachmentId}/download`);
      if (!res.ok) throw new Error("Download failed");
      const { url } = await res.json();
      if (win) win.location.href = url;
      else window.location.href = url;
    } catch (err) {
      if (win) win.close();
      toast({ title: "Download failed", description: (err as Error).message, variant: "destructive" });
    }
  }

  const isMarked = submission?.status === "marked";
  const hasWorksheets = attachments.length > 0;
  // This section is only mounted for PDF-format assessments (the parent gates on
  // quiz.format === "pdf"), so the worksheet list + response upload always apply.
  const showUpload = true;
  const showResponseCard = true;

  if (storageUnconfigured) {
    return (
      <div className="text-left bg-foreground/[0.03] border border-border/30 rounded-xl p-4 md:p-5 mb-6">
        <p className="text-xs uppercase tracking-wider text-muted-foreground mb-3">Worksheets &amp; your response</p>
        <StorageNotice />
      </div>
    );
  }

  return (
    <>
      {hasWorksheets && (
        <div className="text-left bg-foreground/[0.03] border border-border/30 rounded-xl p-4 md:p-5 mb-6">
          <p className="flex items-center gap-2 text-xs uppercase tracking-wider text-muted-foreground mb-3">
            <Paperclip className="w-3.5 h-3.5 text-violet-300" />
            Worksheets
          </p>
          <div className="space-y-2">
            {attachments.map((att) => (
              <div
                key={att.id}
                data-testid={`student-worksheet-row-${att.id}`}
                className="flex items-center justify-between gap-3 rounded-xl bg-foreground/5 border border-border/50 px-4 py-3"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <FileText className="w-4 h-4 text-violet-400 shrink-0" />
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-foreground truncate">{att.filename}</p>
                    <p className="text-xs text-muted-foreground">{formatBytes(att.sizeBytes)}</p>
                  </div>
                </div>
                <button
                  data-testid={`student-worksheet-download-${att.id}`}
                  onClick={() => downloadAttachment(att.id)}
                  className="inline-flex items-center gap-1.5 px-3 py-2 min-h-[40px] rounded-lg text-sm font-medium border border-cyan-500/40 bg-cyan-500/10 text-cyan-300 hover:bg-cyan-500/20 transition-all shrink-0"
                >
                  <Download className="w-4 h-4" />
                  <span className="hidden sm:inline">Download</span>
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {showResponseCard && (
      <div className="text-left bg-foreground/[0.03] border border-border/30 rounded-xl p-4 md:p-5 mb-6">
        <p className="flex items-center gap-2 text-xs uppercase tracking-wider text-muted-foreground mb-3">
          <FileCheck className="w-3.5 h-3.5 text-violet-300" />
          Your response
        </p>

        {submission && (
          <div
            data-testid="student-response-status"
            className="rounded-xl bg-foreground/5 border border-border/50 px-4 py-3 mb-4"
          >
            <div className="flex items-center gap-3 min-w-0">
              <FileText className="w-4 h-4 text-violet-400 shrink-0" />
              <p className="text-sm font-medium text-foreground truncate flex-1">{submission.filename}</p>
              {isMarked ? (
                <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-300 border border-emerald-500/30 shrink-0">
                  <CheckCircle2 className="w-3 h-3" /> Marked
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-300 border border-amber-500/30 shrink-0">
                  <Clock className="w-3 h-3" /> Awaiting marking
                </span>
              )}
            </div>

            {isMarked && (
              <div className="mt-3 pt-3 border-t border-border/40">
                <p
                  data-testid="student-response-score"
                  className="text-2xl font-bold text-emerald-300"
                >
                  {submission.score ?? 0}{submission.maxScore != null ? <span className="text-base text-muted-foreground font-normal"> / {submission.maxScore}</span> : null}
                </p>
                {submission.feedback && (
                  <div className="mt-3">
                    <p className="text-xs uppercase tracking-wider text-muted-foreground mb-1">Feedback</p>
                    <p
                      data-testid="student-response-feedback"
                      className="text-sm text-foreground/90 whitespace-pre-wrap leading-relaxed"
                    >
                      {submission.feedback}
                    </p>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {showUpload && (
          <>
        {isMarked && (
          <div className="flex items-start gap-2 mb-3 text-xs text-amber-300/90">
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <span>Re-uploading will replace your submission and clear the existing mark.</span>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <input
            type="file"
            accept="application/pdf"
            data-testid="student-response-input"
            onChange={(e) => handleSelectFile(e.target.files?.[0] ?? null)}
            className="text-sm text-foreground/80 file:mr-3 file:rounded-lg file:border-0 file:bg-violet-500/20 file:px-4 file:py-2 file:text-sm file:font-medium file:text-violet-300 hover:file:bg-violet-500/30"
          />
          <button
            data-testid="student-response-upload"
            onClick={() => selectedFile && uploadMutation.mutate(selectedFile)}
            disabled={!selectedFile || uploadMutation.isPending}
            className="inline-flex items-center gap-2 px-4 py-2 min-h-[44px] rounded-lg text-sm font-medium border border-violet-500/40 bg-violet-500/20 text-violet-300 hover:bg-violet-500/30 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {uploadMutation.isPending ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Upload className="w-4 h-4" />
            )}
            {submission ? "Re-upload" : "Upload"}
          </button>
          {selectedFile && (
            <span className="text-xs text-muted-foreground truncate max-w-[200px]">
              {selectedFile.name} ({formatBytes(selectedFile.size)})
            </span>
          )}
        </div>
        <p className="text-[11px] text-muted-foreground mt-3">PDF only, up to 20MB.</p>
          </>
        )}
      </div>
      )}
    </>
  );
}
