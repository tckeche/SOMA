/**
 * Phase 3.3 — Personal Revision Plan generator.
 *
 * Deterministic. Given a student's mastery map + mark-loss prediction
 * + (optional) exam date + weekly study hours, schedules a sequence of
 * revision sessions across N weeks, prioritising:
 *
 *   1. Topics with high mark-loss × low understanding (the marks-on-the
 *      table principle).
 *   2. Topics with approved examiner insights (high-impact areas
 *      Cambridge has flagged).
 *   3. Topics that are uncovered or untested (risk: blind spots).
 *   4. Newly-tested but-not-yet-mastered (consolidation pass before exam).
 *
 * No LLM in the critical path. Optional AI summary line could be added
 * later as a cached-per-content enrichment, but for now we emit a
 * deterministic 1–2 sentence summary based on the structure.
 */
import type {
  RevisionPlanBody,
  RevisionPlanSession,
  RevisionPlanWeek,
} from "@shared/schema";
import { buildMasteryMap } from "./syllabusMasteryMap";
import { buildMarkLossPrediction, type SubjectPrediction } from "./markLossPredictor";

export interface GeneratePlanOptions {
  studentId: string;
  subject: string;
  syllabusCode: string;
  level: string;
  examDate?: Date | null;
  weekHours?: number;
}

interface CandidateTopic {
  topic: string;
  subtopic: string | null;
  understandingPercent: number;
  totalQuestions: number;
  examinerInsightCount: number;
  predictedLossWeight: number;
  status: "untested" | "covered_untested" | "weak" | "okay" | "strong";
}

const SESSION_MINUTES = 30;
const MIN_WEEKS = 1;
const MAX_WEEKS = 16;

function statusFromMastery(p: { understandingPercent: number; totalQuestions: number; covered?: boolean }): CandidateTopic["status"] {
  if (p.totalQuestions === 0) return p.covered ? "covered_untested" : "untested";
  if (p.understandingPercent < 50) return "weak";
  if (p.understandingPercent < 80) return "okay";
  return "strong";
}

function sessionTypeFor(c: CandidateTopic): RevisionPlanSession["type"] {
  if (c.examinerInsightCount > 0 && c.understandingPercent < 70) return "examiner_misconception";
  if (c.status === "untested" || c.status === "covered_untested") return "concept_recap";
  if (c.status === "weak") return "drill";
  if (c.status === "okay") return "review";
  return "exam_practice";
}

function rationaleFor(c: CandidateTopic): string {
  if (c.examinerInsightCount > 0 && c.understandingPercent < 70) {
    return `Cambridge examiners have flagged common errors here, and you're at ${c.understandingPercent}%. High-leverage area.`;
  }
  if (c.status === "untested") {
    return "You haven't been tested on this yet — get a baseline before the exam.";
  }
  if (c.status === "covered_untested") {
    return "Covered in lessons but not tested. Worth confirming you can apply it.";
  }
  if (c.status === "weak") {
    return `Currently ${c.understandingPercent}% — this is where you'd lose the most marks.`;
  }
  if (c.status === "okay") {
    return `Solid at ${c.understandingPercent}%. Keep it warm with a short review.`;
  }
  return `Strong (${c.understandingPercent}%). Use exam-style questions to lock it in.`;
}

function priority(c: CandidateTopic): number {
  // Lower understanding + higher loss weight + examiner insights → higher priority.
  // Untested topics get a base bump so they don't disappear.
  let p = 0;
  p += (100 - c.understandingPercent); // 0..100
  p += c.predictedLossWeight * 5; // weight a paper's loss heavily
  p += c.examinerInsightCount * 8;
  if (c.status === "untested") p += 30;
  if (c.status === "covered_untested") p += 20;
  return p;
}

/**
 * Number of weeks to plan: derived from exam date if supplied, else 4.
 * Capped at MAX_WEEKS so the plan stays useful, and floored at MIN_WEEKS
 * so we always emit something.
 */
function weekCount(now: Date, examDate: Date | null | undefined): number {
  if (!examDate) return 4;
  const ms = examDate.getTime() - now.getTime();
  if (ms <= 0) return MIN_WEEKS;
  const weeks = Math.ceil(ms / (7 * 24 * 60 * 60 * 1000));
  return Math.max(MIN_WEEKS, Math.min(MAX_WEEKS, weeks));
}

export async function generateRevisionPlan(options: GeneratePlanOptions): Promise<RevisionPlanBody> {
  const weekHours = Math.max(1, Math.min(40, options.weekHours ?? 6));
  const sessionsPerWeek = Math.max(2, Math.min(20, Math.floor((weekHours * 60) / SESSION_MINUTES)));
  const now = new Date();
  const weeks = weekCount(now, options.examDate);

  // 1. Pull the mastery map for the student so we know per-topic state.
  const map = await buildMasteryMap(options.studentId);
  const subjectNode = map.subjects.find(
    (s) =>
      s.subject.toLowerCase() === options.subject.toLowerCase()
      && s.syllabusCode === options.syllabusCode
      && s.level === options.level,
  );

  // 2. Pull mark-loss prediction so we know which topics carry the most weight.
  const prediction = await buildMarkLossPrediction(options.studentId);
  const subjectPrediction: SubjectPrediction | undefined = prediction.subjects.find(
    (s) => s.subject.toLowerCase() === options.subject.toLowerCase()
      && s.syllabusCode === options.syllabusCode
      && s.level === options.level,
  );
  const lossByTopic = new Map<string, number>();
  if (subjectPrediction) {
    for (const p of subjectPrediction.papers) {
      for (const w of p.weakestTopics) {
        const key = w.title.toLowerCase();
        lossByTopic.set(key, (lossByTopic.get(key) ?? 0) + (100 - w.understandingPercent));
      }
    }
  }

  // 3. Build candidate topics. If we have a mastery tree, use leaf-level
  //    granularity. If not (catalogue not ingested), fall back to topic
  //    rows from the mastery map's free-text aggregate.
  const candidates: CandidateTopic[] = [];
  if (subjectNode && subjectNode.topics.length > 0) {
    for (const t of subjectNode.topics) {
      if (t.subtopics.length === 0) {
        const status = statusFromMastery({
          understandingPercent: t.understandingPercent,
          totalQuestions: t.totalQuestions,
        });
        candidates.push({
          topic: t.title,
          subtopic: null,
          understandingPercent: t.understandingPercent,
          totalQuestions: t.totalQuestions,
          examinerInsightCount: t.examinerInsightCount,
          predictedLossWeight: lossByTopic.get(t.title.toLowerCase()) ?? 0,
          status,
        });
        continue;
      }
      for (const s of t.subtopics) {
        const status = statusFromMastery({
          understandingPercent: s.understandingPercent,
          totalQuestions: s.totalQuestions,
          covered: s.covered,
        });
        candidates.push({
          topic: t.title,
          subtopic: s.title,
          understandingPercent: s.understandingPercent,
          totalQuestions: s.totalQuestions,
          examinerInsightCount: s.examinerInsightCount,
          predictedLossWeight: lossByTopic.get(t.title.toLowerCase()) ?? 0,
          status,
        });
      }
    }
  }

  if (candidates.length === 0) {
    // No catalogue and no mastery rows — return an empty plan with a
    // friendly summary rather than fail.
    return {
      examDate: options.examDate ? options.examDate.toISOString() : null,
      weekHours,
      weeks: [],
      summary: "Take a quiz on this subject to unlock your first revision plan.",
      weakAreas: [],
    };
  }

  // 4. Sort by priority, slice to total session budget.
  candidates.sort((a, b) => priority(b) - priority(a));
  const totalSessionBudget = sessionsPerWeek * weeks;
  // Use unique topics first (don't drill the same subtopic twice in row 1
  // even if it has very high priority — repeats only happen once we've
  // covered the breadth).
  const uniqueQueue: CandidateTopic[] = [];
  const seen = new Set<string>();
  for (const c of candidates) {
    const key = `${c.topic}|${c.subtopic ?? ""}`;
    if (!seen.has(key)) {
      uniqueQueue.push(c);
      seen.add(key);
    }
  }
  // Then a consolidation pass (repeat top weakest entries) if we still have budget.
  while (uniqueQueue.length < totalSessionBudget) {
    const next = candidates[uniqueQueue.length % candidates.length];
    if (!next) break;
    uniqueQueue.push(next);
  }

  // 5. Distribute sessions across weeks.
  const planWeeks: RevisionPlanWeek[] = [];
  let cursor = 0;
  for (let w = 1; w <= weeks; w++) {
    const sessions: RevisionPlanSession[] = [];
    for (let i = 0; i < sessionsPerWeek && cursor < uniqueQueue.length; i++, cursor++) {
      const c = uniqueQueue[cursor];
      sessions.push({
        topic: c.topic,
        subtopic: c.subtopic,
        durationMinutes: SESSION_MINUTES,
        type: sessionTypeFor(c),
        rationale: rationaleFor(c),
        understandingPercent: c.understandingPercent,
        examinerInsightCount: c.examinerInsightCount,
      });
    }
    if (sessions.length === 0) break;
    const focusTopics = Array.from(new Set(sessions.map((s) => s.topic))).slice(0, 3);
    planWeeks.push({
      weekNumber: w,
      label: weeks <= 4 ? `Week ${w}` : (w === weeks ? "Final week" : `Week ${w}`),
      focus: focusTopics.join(" · "),
      sessions,
      totalMinutes: sessions.reduce((acc, s) => acc + s.durationMinutes, 0),
    });
  }

  const weakAreas = candidates
    .filter((c) => c.understandingPercent < 60 && c.totalQuestions > 0)
    .slice(0, 5)
    .map((c) => ({ topic: c.subtopic ?? c.topic, understandingPercent: c.understandingPercent }));

  // 6. Plain-English summary.
  const totalSessions = planWeeks.reduce((acc, w) => acc + w.sessions.length, 0);
  const examinerSessions = planWeeks.flatMap((w) => w.sessions).filter((s) => s.type === "examiner_misconception").length;
  const summary = [
    `${totalSessions} ${SESSION_MINUTES}-minute session${totalSessions !== 1 ? "s" : ""} across ${planWeeks.length} week${planWeeks.length !== 1 ? "s" : ""}.`,
    examinerSessions > 0 ? ` ${examinerSessions} target Cambridge examiner-flagged areas.` : "",
    weakAreas.length > 0 ? ` Focuses on your weakest topics first.` : " Builds breadth across your syllabus.",
  ].join("");

  return {
    examDate: options.examDate ? options.examDate.toISOString() : null,
    weekHours,
    weeks: planWeeks,
    summary,
    weakAreas,
  };
}
