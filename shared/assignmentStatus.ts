// Canonical assignment-status taxonomy shared between server and client.
// The eight statuses from the soma PRD. "seen" is part of the taxonomy but is
// only emitted once view-tracking (a last_seen_at column on quiz_assignments)
// ships — until then the server returns "not_opened" for unstarted work.

export type AssignmentStatus =
  | "assigned"
  | "seen"
  | "started"
  | "in_progress"
  | "submitted"
  | "feedback_ready"
  | "overdue"
  | "not_opened";

export interface AssignmentStatusMeta {
  value: AssignmentStatus;
  label: string;
  // Semantic tone used by the badge component to pick colours.
  tone: "neutral" | "info" | "active" | "success" | "ready" | "warning" | "danger";
}

export const ASSIGNMENT_STATUS_META: Record<AssignmentStatus, AssignmentStatusMeta> = {
  assigned:       { value: "assigned",       label: "Assigned",       tone: "neutral" },
  not_opened:     { value: "not_opened",     label: "Not opened",     tone: "neutral" },
  seen:           { value: "seen",           label: "Seen",           tone: "info" },
  started:        { value: "started",        label: "Started",        tone: "info" },
  in_progress:    { value: "in_progress",    label: "In progress",    tone: "active" },
  submitted:      { value: "submitted",      label: "Submitted",      tone: "success" },
  feedback_ready: { value: "feedback_ready", label: "Feedback ready", tone: "ready" },
  overdue:        { value: "overdue",        label: "Overdue",        tone: "danger" },
};

export interface AssignmentStatusInputs {
  dueDate: Date | string | null | undefined;
  report: {
    status: string | null | undefined;
    answersJson: unknown;
    aiFeedbackHtml: string | null | undefined;
    completedAt: Date | string | null | undefined;
  } | null | undefined;
  now?: Date;
}

// Precedence: overdue > feedback_ready > submitted > in_progress > started > not_opened.
// "assigned" / "seen" are reserved for view-tracking (not yet emitted).
export function computeAssignmentStatus(inputs: AssignmentStatusInputs): AssignmentStatus {
  const now = inputs.now ?? new Date();
  const report = inputs.report;
  const isCompleted = !!(report && (report.status === "completed" || report.completedAt));

  const due = inputs.dueDate ? new Date(inputs.dueDate) : null;
  if (!isCompleted && due && due.getTime() < now.getTime()) {
    return "overdue";
  }

  if (isCompleted) {
    if (report?.aiFeedbackHtml && report.aiFeedbackHtml.trim().length > 0) {
      return "feedback_ready";
    }
    return "submitted";
  }

  if (report) {
    // A report row exists — the student has at least opened the quiz runner.
    // If any answer has been recorded, treat as in_progress; otherwise started.
    const answers = report.answersJson;
    const hasAnswers =
      Array.isArray(answers) ? answers.length > 0 :
      (answers && typeof answers === "object") ? Object.keys(answers as object).length > 0 :
      false;
    return hasAnswers ? "in_progress" : "started";
  }

  return "not_opened";
}
