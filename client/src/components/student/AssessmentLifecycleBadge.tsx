import { AlertCircle, CheckCircle2, Clock, Eye } from "lucide-react";
import type { DashboardAssignmentRow } from "@/types/studentDashboard";

type Lifecycle = {
  label: string;
  detail: string;
  className: string;
  Icon: typeof CheckCircle2;
};

export function getAssessmentLifecycle(row: Pick<DashboardAssignmentRow, "reportId" | "reportStatus" | "reviewRequested" | "scorePercent">): Lifecycle {
  if (!row.reportId) {
    return {
      label: "Report pending",
      detail: "Your submission was received; feedback is still being prepared.",
      className: "bg-muted/60 text-muted-foreground border-border",
      Icon: Clock,
    };
  }
  if (row.reviewRequested || row.reportStatus === "awaiting_review") {
    return {
      label: "Tutor review",
      detail: "A tutor review is needed before this result should be treated as final.",
      className: "bg-warning/15 text-warning border-warning/30",
      Icon: Eye,
    };
  }
  if (row.reportStatus === "failed") {
    return {
      label: "Marking failed",
      detail: "Automatic marking failed. Your tutor may need to review this manually.",
      className: "bg-danger/15 text-danger border-danger/30",
      Icon: AlertCircle,
    };
  }
  if (row.reportStatus && row.reportStatus !== "completed") {
    return {
      label: "Marking",
      detail: "Your result is still being processed.",
      className: "bg-primary/15 text-primary border-primary/30",
      Icon: Clock,
    };
  }
  if (row.scorePercent === null) {
    return {
      label: "Feedback pending",
      detail: "Your score is not ready yet.",
      className: "bg-primary/15 text-primary border-primary/30",
      Icon: Clock,
    };
  }
  return {
    label: "Feedback ready",
    detail: "Your marked result and report are ready to review.",
    className: "bg-success/15 text-success border-success/30",
    Icon: CheckCircle2,
  };
}

export default function AssessmentLifecycleBadge({ row }: { row: DashboardAssignmentRow }) {
  const lifecycle = getAssessmentLifecycle(row);
  const Icon = lifecycle.Icon;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${lifecycle.className}`}
      title={lifecycle.detail}
      data-testid={`assessment-lifecycle-${row.quizId}`}
    >
      <Icon className="h-3 w-3" aria-hidden="true" />
      {lifecycle.label}
    </span>
  );
}
