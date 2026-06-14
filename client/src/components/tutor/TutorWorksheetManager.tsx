import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { authFetch } from "@/lib/supabase";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Paperclip, FileText, Upload, Loader2, Trash2 } from "lucide-react";

interface QuizAttachment {
  id: number;
  filename: string;
  sizeBytes: number;
  mimeType: string;
  createdAt: string;
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
export default function TutorWorksheetManager({ quizId }: { quizId: number }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [selectedFile, setSelectedFile] = useState<File | null>(null);

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
      toast({ title: "Worksheet uploaded" });
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
        <Paperclip className="w-4 h-4 text-violet-400" />
        <h2 className="font-semibold text-foreground text-sm">Worksheets</h2>
        <span className="text-[10px] text-muted-foreground ml-auto">{attachments.length} file{attachments.length === 1 ? "" : "s"}</span>
      </div>

      <p className="text-xs text-muted-foreground">
        Upload the worksheet PDF(s) students will download and complete. Students submit a PDF response that you mark manually — there is no timer or multiple-choice engine for this assessment type.
      </p>

      {storageUnconfigured ? (
        <div className="rounded-xl bg-amber-500/10 border border-amber-500/30 px-4 py-3 text-sm text-amber-300">
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
                    <FileText className="w-4 h-4 text-violet-400 shrink-0" />
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-foreground truncate">{att.filename}</p>
                      <p className="text-xs text-muted-foreground">{formatBytes(att.sizeBytes)}</p>
                    </div>
                  </div>
                  <button
                    data-testid={`worksheet-delete-${att.id}`}
                    onClick={() => deleteMutation.mutate(att.id)}
                    disabled={deleteMutation.isPending}
                    className="text-muted-foreground hover:text-red-400 shrink-0 min-w-[36px] min-h-[36px] flex items-center justify-center rounded-lg transition-colors"
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
              className="text-sm text-foreground/80 file:mr-3 file:rounded-lg file:border-0 file:bg-violet-500/20 file:px-4 file:py-2 file:text-sm file:font-medium file:text-violet-300 hover:file:bg-violet-500/30"
            />
            <Button
              data-testid="worksheet-upload-button"
              onClick={() => selectedFile && uploadMutation.mutate(selectedFile)}
              disabled={!selectedFile || uploadMutation.isPending}
              className="border border-violet-500/40 bg-violet-500/20 text-violet-300 hover:bg-violet-500/30 transition-all min-h-[44px]"
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
    </div>
  );
}
