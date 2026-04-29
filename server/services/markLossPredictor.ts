/**
 * Phase 3.2 — Mark-Loss Predictor.
 *
 * For each paper a student is sitting (per their enrolment), predict the
 * expected score and the marks they would lose right now, plus a coarse
 * confidence interval based on how much testing data we have.
 *
 * Method (deterministic, no LLM)
 * ──────────────────────────────
 * 1. Resolve the student's syllabi.
 * 2. For each (syllabus, level), pull all `papers` and their
 *    `paper_topic_mappings`. Each mapping has a qualitative weight:
 *      "primary"  → factor 2
 *      "covered"  → factor 1
 *      "assumes"  → factor 0.5  (prior content; lighter test on this paper)
 * 3. For each topic in the mapping, look up the student's mastery via
 *    `student_topic_mastery` (FK first, then case-insensitive title
 *    fallback). Treat missing mastery as 0% but flag it as "unattempted"
 *    so the confidence band widens.
 * 4. Predicted score = sum(weight_i × understanding_i) / sum(weight_i) ×
 *                      papers.raw_marks
 *    Predicted loss  = papers.raw_marks − predicted score
 *    Confidence band = ±N marks, where N depends on the volume of
 *    actual question evidence behind the prediction.
 *
 * The intent is **directional honesty**, not psychometric precision: a
 * student looking at "you'd score 47/80, ±10" understands they have a
 * lot of variance; a student with 200 attempts in the syllabus and ±3
 * understands the prediction is solid.
 */
import { db } from "../db";
import {
  paperTopicMappings,
  papers,
  studentSubjects,
  studentTopicMastery,
  subjects,
  syllabi,
  topics,
} from "@shared/schema";
import { and, eq, inArray, sql } from "drizzle-orm";

const WEIGHT_FACTOR: Record<string, number> = {
  primary: 2,
  covered: 1,
  assumes: 0.5,
};

interface MasteryLookup {
  understandingPercent: number;
  totalQuestions: number;
}

export interface PaperPrediction {
  paperId: number;
  paperNumber: number;
  code: string | null;
  title: string;
  rawMarks: number;
  predictedScore: number;
  predictedLoss: number;
  confidenceBandMarks: number;
  confidenceLabel: "low" | "medium" | "high";
  attemptedQuestions: number;
  topicsCovered: number;
  topicsTotal: number;
  weakestTopics: Array<{ title: string; understandingPercent: number }>;
}

export interface SubjectPrediction {
  subject: string;
  examBody: string;
  syllabusCode: string;
  level: string;
  papers: PaperPrediction[];
  totalRawMarks: number;
  totalPredictedScore: number;
  totalPredictedLoss: number;
}

export interface MarkLossPayload {
  subjects: SubjectPrediction[];
  generatedAt: string;
}

function fallbackKey(subject: string, topicTitle: string): string {
  return `${subject.toLowerCase().trim()}|${topicTitle.toLowerCase().trim()}`;
}

function confidenceFromAttempts(n: number): { label: "low" | "medium" | "high"; bandPctOfMarks: number } {
  if (n >= 50) return { label: "high", bandPctOfMarks: 7 };
  if (n >= 20) return { label: "medium", bandPctOfMarks: 15 };
  return { label: "low", bandPctOfMarks: 30 };
}

export async function buildMarkLossPrediction(studentId: string): Promise<MarkLossPayload> {
  const empty: MarkLossPayload = { subjects: [], generatedAt: new Date().toISOString() };
  if (!db) return empty;

  const enrolments = await db
    .select({
      subject: studentSubjects.subject,
      examBody: studentSubjects.examBody,
      syllabusCode: studentSubjects.syllabusCode,
      level: studentSubjects.level,
    })
    .from(studentSubjects)
    .where(eq(studentSubjects.studentId, studentId));
  if (enrolments.length === 0) return empty;

  const masteryRows = await db
    .select({
      subtopicId: studentTopicMastery.subtopicId,
      subject: studentTopicMastery.subject,
      topic: studentTopicMastery.topic,
      understandingPercent: studentTopicMastery.understandingPercent,
      totalQuestions: studentTopicMastery.totalQuestions,
    })
    .from(studentTopicMastery)
    .where(eq(studentTopicMastery.studentId, studentId));

  const masteryByKey = new Map<string, MasteryLookup>();
  for (const m of masteryRows) {
    const k = fallbackKey(m.subject, m.topic);
    // Aggregate when multiple rows exist (e.g. legacy + new FK row).
    const existing = masteryByKey.get(k);
    if (!existing) {
      masteryByKey.set(k, {
        understandingPercent: m.understandingPercent,
        totalQuestions: m.totalQuestions,
      });
    } else {
      const totalQ = existing.totalQuestions + m.totalQuestions;
      const weighted = totalQ > 0
        ? (existing.understandingPercent * existing.totalQuestions + m.understandingPercent * m.totalQuestions) / totalQ
        : (existing.understandingPercent + m.understandingPercent) / 2;
      masteryByKey.set(k, { understandingPercent: Math.round(weighted), totalQuestions: totalQ });
    }
  }

  const subjectPredictions: SubjectPrediction[] = [];

  for (const enrol of enrolments) {
    const [syllabusRow] = await db
      .select({ id: syllabi.id })
      .from(syllabi)
      .innerJoin(subjects, eq(subjects.id, syllabi.subjectId))
      .where(and(eq(syllabi.syllabusCode, enrol.syllabusCode), sql`lower(${subjects.name}) = lower(${enrol.subject})`));
    if (!syllabusRow) continue;

    const paperRows = await db
      .select({
        id: papers.id,
        paperNumber: papers.paperNumber,
        code: papers.code,
        title: papers.title,
        rawMarks: papers.rawMarks,
        levelTier: papers.levelTier,
      })
      .from(papers)
      .where(and(eq(papers.syllabusId, syllabusRow.id), eq(papers.levelTier, enrol.level)));
    if (paperRows.length === 0) continue;

    const paperIds = paperRows.map((p) => p.id);
    const mappings = await db
      .select({
        paperId: paperTopicMappings.paperId,
        topicTitle: topics.title,
        weight: paperTopicMappings.weight,
      })
      .from(paperTopicMappings)
      .innerJoin(topics, eq(topics.id, paperTopicMappings.topicId))
      .where(inArray(paperTopicMappings.paperId, paperIds));

    const paperPredictions: PaperPrediction[] = [];
    let subjectRawTotal = 0;
    let subjectPredictedTotal = 0;

    for (const p of paperRows) {
      const myMappings = mappings.filter((m) => m.paperId === p.id);
      if (myMappings.length === 0 || !p.rawMarks) continue;

      let totalWeight = 0;
      let weightedScore = 0;
      let attemptedQuestions = 0;
      let topicsCovered = 0;
      const weakestTopics: Array<{ title: string; understandingPercent: number }> = [];

      for (const m of myMappings) {
        const factor = WEIGHT_FACTOR[m.weight] ?? 1;
        const lookup = masteryByKey.get(fallbackKey(enrol.subject, m.topicTitle));
        const understanding = lookup?.understandingPercent ?? 0;
        const totalQ = lookup?.totalQuestions ?? 0;
        totalWeight += factor;
        weightedScore += factor * understanding;
        if (totalQ > 0) {
          attemptedQuestions += totalQ;
          topicsCovered += 1;
        }
        if (understanding < 60) {
          weakestTopics.push({ title: m.topicTitle, understandingPercent: understanding });
        }
      }

      if (totalWeight === 0) continue;

      const predictedScoreRaw = (weightedScore / totalWeight) * (p.rawMarks / 100);
      const predictedScore = Math.max(0, Math.min(p.rawMarks, Math.round(predictedScoreRaw)));
      const predictedLoss = p.rawMarks - predictedScore;
      const conf = confidenceFromAttempts(attemptedQuestions);
      const confidenceBandMarks = Math.max(1, Math.round((conf.bandPctOfMarks / 100) * p.rawMarks));

      weakestTopics.sort((a, b) => a.understandingPercent - b.understandingPercent);

      paperPredictions.push({
        paperId: p.id,
        paperNumber: p.paperNumber,
        code: p.code,
        title: p.title,
        rawMarks: p.rawMarks,
        predictedScore,
        predictedLoss,
        confidenceBandMarks,
        confidenceLabel: conf.label,
        attemptedQuestions,
        topicsCovered,
        topicsTotal: myMappings.length,
        weakestTopics: weakestTopics.slice(0, 3),
      });

      subjectRawTotal += p.rawMarks;
      subjectPredictedTotal += predictedScore;
    }

    if (paperPredictions.length === 0) continue;

    paperPredictions.sort((a, b) => a.paperNumber - b.paperNumber);

    subjectPredictions.push({
      subject: enrol.subject,
      examBody: enrol.examBody,
      syllabusCode: enrol.syllabusCode,
      level: enrol.level,
      papers: paperPredictions,
      totalRawMarks: subjectRawTotal,
      totalPredictedScore: subjectPredictedTotal,
      totalPredictedLoss: subjectRawTotal - subjectPredictedTotal,
    });
  }

  return {
    subjects: subjectPredictions,
    generatedAt: new Date().toISOString(),
  };
}
