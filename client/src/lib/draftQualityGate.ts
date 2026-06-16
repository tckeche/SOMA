import type { DraftQuestion } from "@shared/schema";

export type DraftQualitySeverity = "warning" | "blocker";

export interface DraftQualityIssue {
  severity: DraftQualitySeverity;
  message: string;
}

export interface DraftQualityResult {
  status: "ready" | "needs_review" | "blocked";
  issues: DraftQualityIssue[];
}

function norm(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function hasDuplicateOptions(options: string[]): boolean {
  const seen = new Set<string>();
  for (const option of options) {
    const key = norm(option);
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
}

function correctAnswerCount(q: DraftQuestion): number {
  const correct = norm(q.correctAnswer || "");
  if (!correct) return 0;
  return q.options.filter((option) => norm(option) === correct).length;
}

export function evaluateDraftQuestionQuality(q: DraftQuestion): DraftQualityResult {
  const issues: DraftQualityIssue[] = [];
  const stem = q.stem?.trim() ?? "";

  if (!stem) {
    issues.push({ severity: "blocker", message: "Question prompt is missing." });
  }
  if (!Number.isFinite(q.marks) || q.marks < 1) {
    issues.push({ severity: "blocker", message: "Question needs at least 1 mark." });
  }

  if (q.questionType === "structured") {
    if (!q.markScheme?.trim()) {
      issues.push({ severity: "blocker", message: "Structured question needs a mark scheme before publishing." });
    } else if (q.markScheme.trim().length < 40) {
      issues.push({ severity: "warning", message: "Mark scheme is very short; check it has enough detail for fair marking." });
    }
  } else {
    if (!Array.isArray(q.options) || q.options.length !== 4) {
      issues.push({ severity: "blocker", message: "MCQ should have exactly 4 options." });
    } else {
      if (q.options.some((option) => !option.trim())) {
        issues.push({ severity: "blocker", message: "Every option needs text." });
      }
      if (hasDuplicateOptions(q.options)) {
        issues.push({ severity: "blocker", message: "Two options look duplicated." });
      }
      const correctCount = correctAnswerCount(q);
      if (correctCount !== 1) {
        issues.push({ severity: "blocker", message: correctCount === 0 ? "Correct answer is not one of the options." : "Correct answer matches more than one option." });
      }
    }
    if (!q.explanation?.trim()) {
      issues.push({ severity: "warning", message: "Explanation is missing; students may not understand the correction." });
    }
  }

  if (!q.topicTag?.trim() && !q.subtopicTag?.trim()) {
    issues.push({ severity: "warning", message: "No topic/subtopic tag found; analytics and revision targeting may be weaker." });
  }

  const hasBlocker = issues.some((issue) => issue.severity === "blocker");
  return {
    status: hasBlocker ? "blocked" : issues.length > 0 ? "needs_review" : "ready",
    issues,
  };
}
