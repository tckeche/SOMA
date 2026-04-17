import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { authFetch } from "@/lib/supabase";
import { Flag, Loader2, Check, X } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface Props {
  questionId: number;
  quizId: number;
  reportId?: number;
}

interface FlagsResponse {
  flags: Array<{ id: number; questionId: number; quizId: number; resolvedAt: string | null; reason: string | null }>;
}

export default function FlagQuestionButton({ questionId, quizId, reportId }: Props) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");

  const { data, isLoading } = useQuery<FlagsResponse>({
    queryKey: ["/api/student/flags"],
    queryFn: async () => {
      const res = await authFetch("/api/student/flags");
      if (!res.ok) return { flags: [] };
      return res.json();
    },
    staleTime: 30_000,
  });

  const myFlag = data?.flags.find((f) => f.questionId === questionId && !f.resolvedAt);
  const isFlagged = !!myFlag;

  const flagMutation = useMutation({
    mutationFn: async (payload: { reason?: string }) => {
      const res = await authFetch("/api/student/flags", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ questionId, quizId, reportId, reason: payload.reason }),
      });
      if (!res.ok) throw new Error("Failed to flag question");
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/student/flags"] });
      setOpen(false);
      setReason("");
      toast({
        title: "Flagged for your tutor",
        description: "Your tutor will see this question and can take a look. Keep going — you can come back to it after the quiz.",
      });
    },
    onError: () => {
      toast({ title: "Couldn't flag", description: "Please try again in a moment.", variant: "destructive" });
    },
  });

  const unflagMutation = useMutation({
    mutationFn: async () => {
      const res = await authFetch(`/api/student/flags/${questionId}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to unflag");
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/student/flags"] });
      toast({ title: "Flag removed", description: "Your tutor won't be notified about this one." });
    },
  });

  if (isLoading) {
    return (
      <button
        type="button"
        disabled
        className="inline-flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg border border-orange-500/30 bg-orange-500/5 text-orange-300 opacity-60 min-h-[40px]"
        data-testid="button-flag-loading"
      >
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
      </button>
    );
  }

  return (
    <div className="relative inline-block">
      <button
        type="button"
        onClick={() => {
          if (isFlagged) {
            unflagMutation.mutate();
          } else {
            setOpen((v) => !v);
          }
        }}
        className={`inline-flex items-center gap-1.5 text-xs px-3 py-2 min-h-[40px] rounded-lg border transition-colors font-medium ${
          isFlagged
            ? "bg-orange-500/15 border-orange-500/50 text-orange-300 hover:bg-orange-500/25"
            : "bg-orange-500/5 border-orange-500/30 text-orange-300 hover:bg-orange-500/15 hover:border-orange-500/50"
        }`}
        title={isFlagged ? "Click to remove flag" : "Flag this question for your tutor"}
        aria-pressed={isFlagged}
        data-testid="button-flag-question"
      >
        <Flag className={`w-3.5 h-3.5 ${isFlagged ? "fill-orange-300" : ""}`} />
        {isFlagged ? "Flagged" : "Flag for tutor"}
      </button>

      {open && !isFlagged && (
        <div
          className="absolute right-0 top-full mt-2 w-72 rounded-xl border border-orange-500/30 bg-slate-900 p-3 shadow-2xl z-30"
          data-testid="flag-popover"
        >
          <p className="text-xs font-semibold text-orange-300 mb-1">Flag this question</p>
          <p className="text-[11px] text-slate-400 mb-2">
            Optional: tell your tutor what's confusing. They'll review it after class.
          </p>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            maxLength={500}
            placeholder="e.g. Stem feels ambiguous, options seem similar…"
            className="w-full rounded-lg bg-slate-950/60 border border-slate-700 text-xs text-slate-100 px-2 py-1.5 focus:outline-none focus:border-orange-500/40"
            data-testid="textarea-flag-reason"
          />
          <div className="flex items-center justify-end gap-2 mt-2">
            <button
              type="button"
              onClick={() => { setOpen(false); setReason(""); }}
              className="inline-flex items-center gap-1 text-[11px] text-slate-400 hover:text-slate-200 px-2 py-1 rounded"
              data-testid="button-flag-cancel"
            >
              <X className="w-3 h-3" /> Cancel
            </button>
            <button
              type="button"
              onClick={() => flagMutation.mutate({ reason: reason.trim() || undefined })}
              disabled={flagMutation.isPending}
              className="inline-flex items-center gap-1 text-[11px] font-medium text-orange-200 bg-orange-500/20 border border-orange-500/40 px-2.5 py-1 rounded hover:bg-orange-500/30 disabled:opacity-60"
              data-testid="button-flag-confirm"
            >
              {flagMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
              Send to tutor
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
