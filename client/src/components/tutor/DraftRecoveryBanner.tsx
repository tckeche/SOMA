import { FileText, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { describeDraft, type TutorAssessmentDraft } from "@/lib/tutorAssessmentDraft";

// Shown at the top of the builder in new-assessment mode when a tutor has a
// pre-publish local draft from a previous session. Continue restores the
// form values; Delete throws away the draft; Dismiss hides the banner but
// leaves the draft intact (so a refresh surfaces it again).
export function DraftRecoveryBanner({
  draft,
  onContinue,
  onDelete,
  onDismiss,
}: {
  draft: TutorAssessmentDraft;
  onContinue: () => void;
  onDelete: () => void;
  onDismiss: () => void;
}) {
  const label = describeDraft(draft);
  const savedAt = (() => {
    try {
      const d = new Date(draft.savedAt);
      if (Number.isNaN(d.getTime())) return "";
      return d.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
    } catch {
      return "";
    }
  })();

  return (
    <div
      className="glass-card border border-violet-500/30 bg-violet-500/5 p-3 md:p-4 mb-3 flex flex-col md:flex-row md:items-center gap-3"
      role="status"
      aria-live="polite"
      data-testid="draft-recovery-banner"
    >
      <div className="flex items-start gap-3 flex-1 min-w-0">
        <div className="mt-0.5 p-2 rounded-lg bg-violet-500/10 border border-violet-500/20 shrink-0">
          <FileText className="w-4 h-4 text-violet-300" aria-hidden="true" />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-slate-100">
            You have an unfinished assessment draft
          </p>
          <p className="text-xs text-slate-400 truncate">
            <span className="text-slate-300">{label}</span>
            {savedAt && <span className="text-slate-500"> · last edited {savedAt}</span>}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <Button
          size="sm"
          className="bg-violet-500/20 hover:bg-violet-500/30 border border-violet-500/40 text-violet-200 text-xs"
          onClick={onContinue}
          data-testid="button-draft-continue"
        >
          Continue editing
        </Button>
        <Button
          size="sm"
          className="bg-rose-500/10 hover:bg-rose-500/20 border border-rose-500/30 text-rose-300 text-xs"
          onClick={onDelete}
          data-testid="button-draft-delete"
        >
          Delete draft
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="text-slate-500 hover:text-slate-200 hover:bg-white/5"
          onClick={onDismiss}
          aria-label="Dismiss draft recovery banner"
          data-testid="button-draft-dismiss"
        >
          <X className="w-4 h-4" aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}

export default DraftRecoveryBanner;
