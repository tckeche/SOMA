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
      className="glass-card border border-primary/30 bg-primary/5 p-3 md:p-4 mb-3 flex flex-col md:flex-row md:items-center gap-3"
      role="status"
      aria-live="polite"
      data-testid="draft-recovery-banner"
    >
      <div className="flex items-start gap-3 flex-1 min-w-0">
        <div className="mt-0.5 p-2 rounded-lg bg-primary/10 border border-primary/20 shrink-0">
          <FileText className="w-4 h-4 text-primary" aria-hidden="true" />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-foreground">
            You have an unfinished assessment draft
          </p>
          <p className="text-xs text-muted-foreground truncate">
            <span className="text-foreground/80">{label}</span>
            {savedAt && <span className="text-muted-foreground"> · last edited {savedAt}</span>}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <Button
          size="sm"
          className="bg-primary/20 hover:bg-primary/30 border border-primary/40 text-primary text-xs"
          onClick={onContinue}
          data-testid="button-draft-continue"
        >
          Continue editing
        </Button>
        <Button
          size="sm"
          className="bg-danger/10 hover:bg-danger/20 border border-danger/30 text-danger text-xs"
          onClick={onDelete}
          data-testid="button-draft-delete"
        >
          Delete draft
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="text-muted-foreground hover:text-foreground hover:bg-foreground/5"
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
