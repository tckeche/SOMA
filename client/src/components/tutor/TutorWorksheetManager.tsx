import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { authFetch } from "@/lib/supabase";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
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
import { Paperclip, FileText, Upload, Loader2, Trash2 } from "lucide-react";

interface QuizAttachment {
  id: number;
  filename: string;
  sizeBytes: number;
  mimeType: string;
  createdAt: string;
  documentRole?: "worksheet" | "exam_paper" | "supporting_resource";
}

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const STORAGE_UNCONFIGURED = "STORAGE_UNCONFIGURED";

function formatBytes(bytes: number) {
  if (!bytes || bytes < 1024) return `${bytes || 0} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

// Tutor-facing worksheet attachment manager for a single quiz. Upload, list
// and delete PDF worksheets. Used by the builder when the assessment format is
// "pdf" — the worksheet IS the assessment that students download and respond to.
export default function TutorWorksheetManager({ quizId, pdfMarkingMode = "manual" }: { quizId: number; pdfMarkingMode?: "manual" | "dual_ai" }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [deleteAttachmentId, setDeleteAttachmentId] = useState<number | null>(null);

  const attachmentsKey = ["/api/tutor/quizzes", quizId, "attachments"];

  const { data: attachments = [], error: attachmentsError } = useQuery<QuizAttachment[]>({
    queryKey: attachmentsKey,
    queryFn: async () => {
      const res = await authFetch(`/api/tutor/quizzes/${quizId}/attachments`);
      if (res.status === 503) throw new Error(STORAGE_UNCONFIGURED);
      if (!res.ok) throw new Error("Failed to load worksheets");
      return res.json();
    },
    enabled: quizId > 0,
    retry: false,
  });

  const storageUnconfigured = (attachmentsError as Error | null)?.message === STORAGE_UNCONFIGURED;

  const uploadMutation = useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("documentRole", pdfMarkingMode === "dual_ai" ? "exam_paper" : "worksheet");
      const res = await authFetch(`/api/tutor/quizzes/${quizId}/attachments`, {
        method: "POST",
        body: formData,
      });
      if (res.status === 503) throw new Error("File uploads aren't available right now.");
      if (!res.ok) throw new Error("Upload failed");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: attachmentsKey });
      setSelectedFile(null);
      toast({ title: pdfMarkingMode === "dual_ai" ? "Exam paper uploaded" : "Worksheet uploaded" });
    },
    onError: (err: Error) => {
      toast({ title: "Upload failed", description: err.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (attachmentId: number) => {
      const res = await authFetch(`/api/tutor/quizzes/${quizId}/attachments/${attachmentId}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("Delete failed");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: attachmentsKey });
      toast({ title: "Worksheet removed" });
    },
    onError: (err: Error) => {
      toast({ title: "Delete failed", description: err.message, variant: "destructive" });
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

  return (
    <div className="glass-card p-4 md:p-5 space-y-4" data-testid="panel-worksheet-manager">
      <div className="flex items-center gap-2">
        <Paperclip className="w-4 h-4 text-primary" />
        <h2 className="font-semibold text-foreground text-sm">{pdfMarkingMode === "dual_ai" ? "Exam paper PDF" : "Worksheets"}</h2>
        <span className="text-[10px] text-muted-foreground ml-auto">{attachments.length} file{attachments.length === 1 ? "" : "s"}</span>
      </div>

      <p className="text-xs text-muted-foreground">
        {pdfMarkingMode === "dual_ai" ? "Upload the exam paper PDF students will complete. You can then prepare and approve a private marking rubric before AI-assisted marking begins." : "Upload the worksheet PDF(s) students will download and complete. Students submit a PDF response that you mark manually — there is no timer or multiple-choice engine for this assessment type."}
      </p>


      {pdfMarkingMode === "dual_ai" && (
        <div className="rounded-xl border border-primary/20 bg-primary/5 p-3 text-xs text-muted-foreground space-y-2">
          <p><strong className="text-foreground">Optional marking scheme</strong> · Private — students cannot view this file.</p>
          <p>Use the PDF marking setup panel after upload to prepare, review and approve the rubric. AI marks are never released until tutor approval.</p>
          <Button type="button" variant="outline" size="sm" onClick={async () => { const res = await authFetch(`/api/tutor/quizzes/${quizId}/pdf-marking/prepare`, { method: "POST" }); if (!res.ok) throw new Error("Prepare failed"); toast({ title: "Rubric preparation queued" }); }}>Prepare marking rubric</Button>
        </div>
      )}

      {storageUnconfigured ? (
        <div className="rounded-xl bg-warning/10 border border-warning/30 px-4 py-3 text-sm text-warning">
          File uploads aren't available right now. Please check back later.
        </div>
      ) : (
        <>
          {attachments.length > 0 && (
            <div className="space-y-2">
              {attachments.map((att) => (
                <div
                  key={att.id}
                  data-testid={`worksheet-row-${att.id}`}
                  className="flex items-center justify-between gap-3 rounded-xl bg-foreground/5 border border-border/50 px-4 py-3"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <FileText className="w-4 h-4 text-primary shrink-0" />
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-foreground truncate">{att.filename}</p>
                      <p className="text-xs text-muted-foreground">{formatBytes(att.sizeBytes)}</p>
                    </div>
                  </div>
                  <button
                    data-testid={`worksheet-delete-${att.id}`}
                    onClick={() => setDeleteAttachmentId(att.id)}
                    disabled={deleteMutation.isPending}
                    className="text-muted-foreground hover:text-danger shrink-0 min-w-[36px] min-h-[36px] flex items-center justify-center rounded-lg transition-colors"
                    title="Remove worksheet"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <input
              type="file"
              accept="application/pdf"
              data-testid="worksheet-file-input"
              onChange={(e) => handleSelectFile(e.target.files?.[0] ?? null)}
              className="text-sm text-foreground/80 file:mr-3 file:rounded-lg file:border-0 file:bg-primary/20 file:px-4 file:py-2 file:text-sm file:font-medium file:text-primary hover:file:bg-primary/30"
            />
            <Button
              data-testid="worksheet-upload-button"
              onClick={() => selectedFile && uploadMutation.mutate(selectedFile)}
              disabled={!selectedFile || uploadMutation.isPending}
              className="border border-primary/40 bg-primary/20 text-primary hover:bg-primary/30 transition-all min-h-[44px]"
            >
              {uploadMutation.isPending ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <Upload className="w-4 h-4 mr-2" />
              )}
              Upload
            </Button>
            {selectedFile && (
              <span className="text-xs text-muted-foreground truncate max-w-[200px]">
                {selectedFile.name} ({formatBytes(selectedFile.size)})
              </span>
            )}
          </div>
          <p className="text-[11px] text-muted-foreground">PDF only, up to 20MB.</p>
        </>
      )}

      <AlertDialog open={deleteAttachmentId !== null} onOpenChange={(open) => { if (!open) setDeleteAttachmentId(null); }}>
        <AlertDialogContent className="bg-card border-border">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-danger">Remove this file?</AlertDialogTitle>
            <AlertDialogDescription className="text-muted-foreground">
              {(() => {
                const name = attachments.find((a) => a.id === deleteAttachmentId)?.filename;
                return name
                  ? `"${name}" will be permanently removed. Students will no longer be able to download it. This cannot be undone.`
                  : "This file will be permanently removed and can't be recovered.";
              })()}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-danger text-white hover:bg-danger/90"
              disabled={deleteMutation.isPending}
              onClick={() => {
                if (deleteAttachmentId !== null) {
                  deleteMutation.mutate(deleteAttachmentId, { onSettled: () => setDeleteAttachmentId(null) });
                }
              }}
            >
              {deleteMutation.isPending ? "Removing…" : "Remove"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
