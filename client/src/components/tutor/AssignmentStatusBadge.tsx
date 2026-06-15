import {
  CircleDashed,
  Eye,
  PlayCircle,
  Loader,
  CheckCircle2,
  Sparkles,
  AlertTriangle,
  Clock,
} from "lucide-react";
import {
  ASSIGNMENT_STATUS_META,
  type AssignmentStatus,
} from "@shared/assignmentStatus";

const TONE_CLASSES: Record<string, string> = {
  neutral: "bg-muted/10 text-foreground/80 border-border/30",
  info:    "bg-sky-500/10 text-sky-300 border-sky-500/30",
  active:  "bg-info/10 text-info border-info/30",
  success: "bg-success/10 text-success border-success/30",
  ready:   "bg-teal-500/10 text-teal-300 border-teal-500/30",
  warning: "bg-warning/10 text-warning border-warning/30",
  danger:  "bg-danger/10 text-danger border-danger/30",
};

const ICONS: Record<AssignmentStatus, React.ComponentType<{ className?: string }>> = {
  assigned:       CircleDashed,
  not_opened:     CircleDashed,
  seen:           Eye,
  started:        PlayCircle,
  in_progress:    Loader,
  submitted:      CheckCircle2,
  feedback_ready: Sparkles,
  overdue:        AlertTriangle,
};

export function AssignmentStatusBadge({
  status,
  dueDate,
  className = "",
}: {
  status: AssignmentStatus;
  dueDate?: string | null;
  className?: string;
}) {
  const meta = ASSIGNMENT_STATUS_META[status];
  const Icon = ICONS[status];
  const tone = TONE_CLASSES[meta.tone] || TONE_CLASSES.neutral;
  const spinning = status === "in_progress" ? "animate-[spin_3s_linear_infinite]" : "";
  const due = dueDate ? new Date(dueDate) : null;
  const dueSuffix =
    status === "overdue" && due
      ? ` · due ${due.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`
      : "";

  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[11px] font-medium ${tone} ${className}`}
      data-testid={`status-badge-${status}`}
      role="status"
      aria-label={`Status: ${meta.label}${dueSuffix}`}
    >
      <Icon className={`w-3 h-3 ${spinning}`} aria-hidden="true" />
      <span>{meta.label}{dueSuffix}</span>
    </span>
  );
}

export default AssignmentStatusBadge;
