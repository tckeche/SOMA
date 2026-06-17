/**
 * Structured/written-answer feedback aggregation.
 *
 * Structured (non-MCQ) questions are AI-marked at submission time and the result
 * is stored on `soma_reports.structuredMarking` keyed by question id. Each entry
 * captures the awarded marks plus two pieces of qualitative feedback:
 *   - `aiUnderstanding`: where the student's thinking landed / what is missing
 *     (i.e. WHERE they are failing in answering the question)
 *   - `aiFeedback`: short corrective feedback (i.e. HOW to answer it better)
 *
 * This helper pulls the student's weak structured answers (effective mark below a
 * threshold) and joins them back to the question so callers can name the topic,
 * subtopic and the exact question alongside the feedback. It is the single source
 * used by the tutor intervention queue, the tutor student report, and the student
 * dashboard so all three surfaces stay consistent.
 */
import type { IStorage } from "../storage";

export interface StructuredWeakAnswer {
  quizId: number;
  quizTitle: string;
  subject: string | null;
  questionId: number;
  questionStem: string;
  topic: string | null;
  subtopic: string | null;
  awardedMarks: number;
  maxMarks: number;
  percent: number;
  /** Where the student's thinking landed / what is missing. */
  whereFailing: string;
  /** Short corrective feedback — how to answer it better. */
  howToImprove: string;
  completedAt: string | null;
}

export interface BuildStructuredFeedbackOptions {
  /** Effective-mark percentage below which an answer is considered weak. */
  weakThreshold?: number;
  /** Maximum number of weak answers to return (most recent + weakest first). */
  limit?: number;
  /**
   * Restrict results to these subjects (case-insensitive). Used to enforce that
   * a tutor only sees written-answer feedback for subjects they have actually
   * assigned the student a quiz in. Pass `undefined`/`null` (the default) for
   * the student's own view, where every subject is theirs to see. An empty
   * array means "no assigned subjects" → no feedback is returned.
   */
  allowedSubjects?: string[] | null;
}

/**
 * Returns the student's weak structured/written answers with the AI feedback
 * already captured at marking time. No new AI calls are made.
 */
export async function buildStructuredFeedback(
  storage: IStorage,
  studentId: string,
  opts: BuildStructuredFeedbackOptions = {},
): Promise<StructuredWeakAnswer[]> {
  const weakThreshold = opts.weakThreshold ?? 60;
  const limit = opts.limit ?? 8;

  // Subject visibility gate. When `allowedSubjects` is provided we only surface
  // feedback for those subjects; quizzes with no subject are never leaked when a
  // gate is in force. `undefined` disables the gate entirely (student's own view).
  const subjectGate = opts.allowedSubjects
    ? new Set(opts.allowedSubjects.map((s) => s.toLowerCase().trim()).filter(Boolean))
    : null;
  if (subjectGate && subjectGate.size === 0) return [];

  const reports = await storage.getSomaReportsByStudentId(studentId);
  const withMarking = reports.filter(
    (r) => r.structuredMarking && Object.keys(r.structuredMarking).length > 0,
  );
  if (withMarking.length === 0) return [];

  const quizIds = Array.from(new Set(withMarking.map((r) => r.quizId)));
  const questionsByQuiz = await storage.getSomaQuestionsByQuizIds(quizIds);

  const out: StructuredWeakAnswer[] = [];
  for (const report of withMarking) {
    // Enforce subject visibility before doing any per-question work.
    if (subjectGate) {
      const subj = (report.quiz?.subject || "").toLowerCase().trim();
      if (!subj || !subjectGate.has(subj)) continue;
    }
    const questions = questionsByQuiz[report.quizId] || [];
    const marking = report.structuredMarking || {};
    for (const [qid, mark] of Object.entries(marking)) {
      if (!mark) continue;
      const maxMarks = Number(mark.maxMarks) || 0;
      if (maxMarks <= 0) continue; // un-markable / not yet graded — skip
      const awardedMarks = Number(mark.tutorMarks ?? mark.aiMarks) || 0;
      const percent = Math.round((awardedMarks / maxMarks) * 100);
      if (percent >= weakThreshold) continue;

      const whereFailing = (mark.aiUnderstanding || "").trim();
      const howToImprove = (mark.aiFeedback || "").trim();
      if (!whereFailing && !howToImprove) continue;

      const question = questions.find((q) => String(q.id) === String(qid));
      out.push({
        quizId: report.quizId,
        quizTitle: report.quiz?.title || "Untitled",
        subject: report.quiz?.subject || null,
        questionId: Number(qid),
        questionStem: question?.stem || "",
        topic: question?.topicTag || null,
        subtopic: question?.subtopicTag || null,
        awardedMarks,
        maxMarks,
        percent,
        whereFailing,
        howToImprove,
        completedAt: report.completedAt ? new Date(report.completedAt).toISOString() : null,
      });
    }
  }

  out.sort((a, b) => {
    const at = a.completedAt ? Date.parse(a.completedAt) : 0;
    const bt = b.completedAt ? Date.parse(b.completedAt) : 0;
    if (bt !== at) return bt - at;
    return a.percent - b.percent;
  });

  return out.slice(0, limit);
}
