// Helpers for rendering assessment tabs/cards: a compact creation date and a
// computed display name built from level, subject, and curriculum subtopics.

// Compact "23 Jun" date used on assessment tabs/cards.
export function formatDateShort(dateStr: string | Date | null): string {
  if (!dateStr) return "—";
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

// Paper codes (P1, Paper 2, …) are NOT subtopics and must never appear in the
// computed assessment name.
export function isPaperCode(s: string): boolean {
  const t = s.trim();
  return /^p\s*\d+$/i.test(t) || /^paper\s*\d+$/i.test(t);
}

export type AssessmentNameInput = {
  level?: string | null;
  subject?: string | null;
  topics?: string[] | null;
  topic?: string | null;
  title?: string | null;
};

// Curriculum subtopics for a quiz, drawn from the `topics` array (falling back to
// the legacy single `topic` string), with paper codes stripped out.
export function subtopicSegments(quiz: AssessmentNameInput): string[] {
  const fromArray = Array.isArray(quiz.topics) ? quiz.topics : [];
  let segs = fromArray.map((t) => String(t ?? "").trim()).filter(Boolean);
  if (segs.length === 0 && quiz.topic) {
    segs = String(quiz.topic).split(/[,/;]+/).map((t) => t.trim()).filter(Boolean);
  }
  return segs.filter((s) => !isPaperCode(s));
}

// "Functions", "Functions & Quadratics", "Functions, Quadratics & Series", or
// "Assorted Topics" when there are more than three subtopics.
export function joinSubtopics(segs: string[]): string {
  if (segs.length === 0) return "";
  if (segs.length > 3) return "Assorted Topics";
  if (segs.length === 1) return segs[0];
  return `${segs.slice(0, -1).join(", ")} & ${segs[segs.length - 1]}`;
}

// PRIMARY display name for an assessment tab/card. This is the quiz's *actual*
// name — what the tutor titled it — so tiles are identified by name, not by a
// generic "level subject - topics" string. The level/subject/topics belong on a
// secondary label (see assessmentSecondaryLabel) rather than the headline.
//
// We only fall back to a computed "level subject - topics" string when the quiz
// genuinely has no title.
export function assessmentDisplayName(quiz: AssessmentNameInput): string {
  const title = quiz.title ? String(quiz.title).trim() : "";
  if (title) return title;
  return assessmentSecondaryLabel(quiz) || "Assessment";
}

// SECONDARY label for an assessment tile: the level + subject + curriculum
// subtopics, e.g. "AS Pure Mathematics · Functions, Quadratics & Series". Shown
// beneath the quiz name to help identify the subject/level at a glance. Returns
// "" when there's nothing meaningful to show.
export function assessmentSecondaryLabel(quiz: AssessmentNameInput): string {
  const head = [quiz.level, quiz.subject]
    .map((x) => (x ? String(x).trim() : ""))
    .filter(Boolean)
    .join(" ");
  const subtopics = joinSubtopics(subtopicSegments(quiz));
  if (head && subtopics) return `${head} · ${subtopics}`;
  return head || subtopics || "";
}
