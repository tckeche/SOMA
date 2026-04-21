/**
 * Syllabus insights — per-student "coverage-by-topic" radar + "paper readiness"
 * heatmap.
 *
 * Data sources (graceful degradation when any are missing):
 *   - studentSubjects       — what the student is enrolled in
 *   - syllabusTopicInventory — canonical topic list per (board, syllabusCode)
 *   - studentTopicMastery   — understanding% per (topic, subtopic)
 *   - papers + paperTopicMappings + topics — paper structure (intelligence layer)
 *
 * Topic names are matched case-insensitively between mastery and the topic
 * list since both come from free-text ingestion paths. Papers that can't be
 * resolved (syllabus not in the intelligence layer yet) simply return an
 * empty list for that subject — the UI hides the heatmap card in that case.
 */
import type { IStorage } from "../storage";
import { resolveSyllabus } from "./syllabusCatalogue";
import { db } from "../db";
import { and, eq, inArray } from "drizzle-orm";
import { papers, paperTopicMappings, topics } from "@shared/schema";

export interface TopicInsight {
  topic: string;
  understandingPercent: number;
  masteryAchieved: boolean;
  attempted: boolean;
  totalQuestions: number;
}

export interface PaperInsight {
  paperNumber: number;
  code: string | null;
  title: string;
  readinessPercent: number;
  mappedTopics: number;
  attemptedTopics: number;
  weakTopics: Array<{ topic: string; understandingPercent: number }>;
}

export interface SubjectInsight {
  subject: string;
  examBody: string;
  syllabusCode: string;
  level: string;
  topics: TopicInsight[];
  papers: PaperInsight[];
}

export interface SyllabusInsightsPayload {
  subjects: SubjectInsight[];
}

export async function buildSyllabusInsights(
  storage: IStorage,
  studentId: string,
): Promise<SyllabusInsightsPayload> {
  const [studentSubjects, mastery] = await Promise.all([
    storage.listStudentSubjects(studentId),
    storage.listStudentTopicMastery(studentId),
  ]);

  const masteryByKey = new Map<string, { understandingPercent: number; masteryAchieved: boolean; totalQuestions: number }>();
  for (const m of mastery) {
    const key = `${m.subject.toLowerCase()}|${m.topic.toLowerCase()}`;
    const existing = masteryByKey.get(key);
    // Aggregate subtopic rows up to topic level — take the weighted avg by
    // totalQuestions so "mostly attempted subtopic" dominates a never-tested
    // one.
    if (existing) {
      const combinedQs = existing.totalQuestions + m.totalQuestions;
      const weightedPct = combinedQs > 0
        ? Math.round((existing.understandingPercent * existing.totalQuestions + m.understandingPercent * m.totalQuestions) / combinedQs)
        : Math.round((existing.understandingPercent + m.understandingPercent) / 2);
      masteryByKey.set(key, {
        understandingPercent: weightedPct,
        masteryAchieved: existing.masteryAchieved || m.masteryAchieved,
        totalQuestions: combinedQs,
      });
    } else {
      masteryByKey.set(key, {
        understandingPercent: m.understandingPercent,
        masteryAchieved: m.masteryAchieved,
        totalQuestions: m.totalQuestions,
      });
    }
  }

  const subjectInsights: SubjectInsight[] = [];

  for (const enrollment of studentSubjects) {
    const inventory = await storage.listSyllabusTopicInventory({
      board: enrollment.examBody,
      syllabusCode: enrollment.syllabusCode,
      subject: enrollment.subject,
    });

    const topicNames = new Set<string>();
    for (const row of inventory) topicNames.add(row.topic);

    // Also surface any mastery topics that aren't in the inventory so tested
    // topics never disappear from the radar.
    for (const m of mastery) {
      if (m.subject.toLowerCase() === enrollment.subject.toLowerCase()) topicNames.add(m.topic);
    }

    const topicInsights: TopicInsight[] = Array.from(topicNames).map((topic) => {
      const hit = masteryByKey.get(`${enrollment.subject.toLowerCase()}|${topic.toLowerCase()}`);
      return {
        topic,
        understandingPercent: hit?.understandingPercent ?? 0,
        masteryAchieved: hit?.masteryAchieved ?? false,
        attempted: (hit?.totalQuestions ?? 0) > 0,
        totalQuestions: hit?.totalQuestions ?? 0,
      };
    }).sort((a, b) => a.topic.localeCompare(b.topic));

    const paperInsights = await buildPaperInsights(enrollment, masteryByKey);

    subjectInsights.push({
      subject: enrollment.subject,
      examBody: enrollment.examBody,
      syllabusCode: enrollment.syllabusCode,
      level: enrollment.level,
      topics: topicInsights,
      papers: paperInsights,
    });
  }

  return { subjects: subjectInsights };
}

async function buildPaperInsights(
  enrollment: { subject: string; examBody: string; syllabusCode: string; level: string },
  masteryByKey: Map<string, { understandingPercent: number; masteryAchieved: boolean; totalQuestions: number }>,
): Promise<PaperInsight[]> {
  if (!db) return [];
  const syllabus = await resolveSyllabus(
    enrollment.examBody.toLowerCase(),
    enrollment.level,
    enrollment.subject.toLowerCase(),
  ).catch(() => null);
  if (!syllabus) return [];

  const paperRows = await db
    .select({
      id: papers.id,
      paperNumber: papers.paperNumber,
      code: papers.code,
      title: papers.title,
      levelTier: papers.levelTier,
    })
    .from(papers)
    .where(and(eq(papers.syllabusId, syllabus.id), eq(papers.levelTier, enrollment.level)));

  if (paperRows.length === 0) return [];

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

  const byPaper = new Map<number, Array<{ topicTitle: string; weight: string }>>();
  for (const row of mappings) {
    const list = byPaper.get(row.paperId) ?? [];
    list.push({ topicTitle: row.topicTitle, weight: row.weight });
    byPaper.set(row.paperId, list);
  }

  return paperRows
    .map((p) => {
      const mapped = byPaper.get(p.id) ?? [];
      // "primary" topics weight 2, "covered"/"assumes" weight 1.
      let totalWeight = 0;
      let weightedSum = 0;
      let attempted = 0;
      const weakTopics: Array<{ topic: string; understandingPercent: number }> = [];
      for (const m of mapped) {
        const w = m.weight === "primary" ? 2 : 1;
        const hit = masteryByKey.get(`${enrollment.subject.toLowerCase()}|${m.topicTitle.toLowerCase()}`);
        const pct = hit?.understandingPercent ?? 0;
        totalWeight += w;
        weightedSum += w * pct;
        if ((hit?.totalQuestions ?? 0) > 0) attempted += 1;
        if (hit && hit.understandingPercent < 60) {
          weakTopics.push({ topic: m.topicTitle, understandingPercent: hit.understandingPercent });
        }
      }
      const readiness = totalWeight > 0 ? Math.round(weightedSum / totalWeight) : 0;
      weakTopics.sort((a, b) => a.understandingPercent - b.understandingPercent);
      return {
        paperNumber: p.paperNumber,
        code: p.code,
        title: p.title,
        readinessPercent: readiness,
        mappedTopics: mapped.length,
        attemptedTopics: attempted,
        weakTopics: weakTopics.slice(0, 3),
      };
    })
    .sort((a, b) => a.paperNumber - b.paperNumber);
}
