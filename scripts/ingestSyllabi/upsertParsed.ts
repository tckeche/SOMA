/**
 * Persist a `ParsedSyllabus` into topics / subtopics / learning_requirements,
 * with competency rollups (learning_requirement_competencies,
 * subtopic_competencies, topic_competencies) and topic-level levelTiers.
 * Also persists papers and their topic/subtopic mappings for Patterns B
 * (9709) and C (9708 / 9609 / 9706).
 *
 * Idempotency strategy: every upsert is keyed on a natural unique index:
 *   - papers: (syllabus_id, paper_number)
 *   - topics: (syllabus_id, topic_number)
 *   - subtopics: (topic_id, subtopic_number)
 *   - learning_requirements: replaced wholesale per subtopic (cheap, and
 *     keeps the sort_order aligned with the parser output)
 *   - paper_topic_mappings / subtopic_paper_mappings: replaced wholesale
 *     per topic / subtopic
 *   - rollups: full delete-and-reinsert per topic/subtopic
 */

import { and, eq, inArray } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "@shared/schema";
import type { CompetencyCode, LevelTier } from "@shared/schema";
import type { ParsedSyllabus, ParsedTopic, ParsedSubtopic, ParsedStrand, ParsedPaper } from "./parsers";
import { competenciesFor } from "./commandWords";

type DB = NodePgDatabase<typeof schema>;

const {
  papers,
  paperTopicMappings,
  subtopicPaperMappings,
  topics,
  subtopics,
  learningRequirements,
  learningRequirementCompetencies,
  subtopicCompetencies,
  topicCompetencies,
  competencies,
  syllabusStrands,
} = schema;

export interface UpsertParsedResult {
  topicsWritten: number;
  subtopicsWritten: number;
  requirementsWritten: number;
  papersWritten: number;
  paperMappingsWritten: number;
  warnings: string[];
}

export async function upsertParsedSyllabus(
  db: DB,
  syllabusId: number,
  parsed: ParsedSyllabus,
): Promise<UpsertParsedResult> {
  const warnings = [...parsed.warnings];

  const competencyIdByCode = await loadCompetencyIndex(db);
  const strandIdByName = await upsertStrands(db, syllabusId, parsed.strands);
  const paperIdByNumber = await upsertPapers(db, syllabusId, parsed.papers);

  let topicsWritten = 0;
  let subtopicsWritten = 0;
  let requirementsWritten = 0;
  let paperMappingsWritten = 0;

  for (let i = 0; i < parsed.topics.length; i++) {
    const parsedTopic = parsed.topics[i];
    const topicId = await upsertTopic(db, syllabusId, parsedTopic, strandIdByName, i);
    topicsWritten++;

    // Rewrite paper ↔ topic mappings wholesale.
    await db.delete(paperTopicMappings).where(eq(paperTopicMappings.topicId, topicId));
    for (const paperNumber of parsedTopic.paperNumbers ?? []) {
      const paperId = paperIdByNumber.get(paperNumber);
      if (paperId == null) {
        warnings.push(`Topic ${parsedTopic.number} references unknown paper ${paperNumber}`);
        continue;
      }
      await db.insert(paperTopicMappings).values({ paperId, topicId, weight: "covered" });
      paperMappingsWritten++;
    }

    const topicCompetencyTally = new Map<number, number>();

    for (let j = 0; j < parsedTopic.subtopics.length; j++) {
      const parsedSubtopic = parsedTopic.subtopics[j];
      const subtopicId = await upsertSubtopic(db, topicId, parsedSubtopic, j);
      subtopicsWritten++;

      // Rewrite paper ↔ subtopic mappings wholesale.
      await db.delete(subtopicPaperMappings).where(eq(subtopicPaperMappings.subtopicId, subtopicId));
      for (const paperNumber of parsedSubtopic.paperNumbers ?? []) {
        const paperId = paperIdByNumber.get(paperNumber);
        if (paperId == null) {
          warnings.push(`Subtopic ${parsedSubtopic.number} references unknown paper ${paperNumber}`);
          continue;
        }
        await db.insert(subtopicPaperMappings).values({ subtopicId, paperId });
        paperMappingsWritten++;
      }

      const subtopicCompetencyTally = new Map<number, number>();

      // Replace learning requirements wholesale. Cascade deletes the
      // lr_competencies rows, so we can re-link afterwards without orphans.
      await db.delete(learningRequirements).where(eq(learningRequirements.subtopicId, subtopicId));

      for (let k = 0; k < parsedSubtopic.requirements.length; k++) {
        const req = parsedSubtopic.requirements[k];
        const [inserted] = await db.insert(learningRequirements).values({
          subtopicId,
          statement: req.statement,
          commandWord: req.commandWord ?? null,
          notesAndExamples: req.notesAndExamples ?? null,
          sortOrder: k,
        }).returning({ id: learningRequirements.id });
        requirementsWritten++;

        const tags = competenciesFor(req.commandWord);
        const competencyRowIds = resolveCompetencyIds(tags, competencyIdByCode, warnings, parsedSubtopic.number);
        for (const compId of competencyRowIds) {
          await db.insert(learningRequirementCompetencies).values({
            learningRequirementId: inserted.id,
            competencyId: compId,
          });
          subtopicCompetencyTally.set(compId, (subtopicCompetencyTally.get(compId) ?? 0) + 1);
          topicCompetencyTally.set(compId, (topicCompetencyTally.get(compId) ?? 0) + 1);
        }
      }

      // Rewrite per-subtopic rollup.
      await db.delete(subtopicCompetencies).where(eq(subtopicCompetencies.subtopicId, subtopicId));
      for (const [compId, weight] of subtopicCompetencyTally) {
        await db.insert(subtopicCompetencies).values({ subtopicId, competencyId: compId, weight });
      }
    }

    // Rewrite per-topic rollup + levelTiers derived from its subtopics.
    await db.delete(topicCompetencies).where(eq(topicCompetencies.topicId, topicId));
    for (const [compId, weight] of topicCompetencyTally) {
      await db.insert(topicCompetencies).values({ topicId, competencyId: compId, weight });
    }
    await db.update(topics)
      .set({ levelTiers: deriveTopicLevelTiers(parsedTopic) })
      .where(eq(topics.id, topicId));
  }

  // Clean up orphan topics: anything in the DB for this syllabus that is not
  // in the parser output (happens when a syllabus edition drops a topic).
  const dbTopicNumbers = new Set(parsed.topics.map((t) => t.number));
  const existing = await db.select({ id: topics.id, number: topics.topicNumber })
    .from(topics).where(eq(topics.syllabusId, syllabusId));
  const orphanIds = existing.filter((r) => !dbTopicNumbers.has(r.number)).map((r) => r.id);
  if (orphanIds.length) {
    await db.delete(topics).where(inArray(topics.id, orphanIds));
    warnings.push(`Removed ${orphanIds.length} topic rows no longer present in the syllabus`);
  }

  // Clean up orphan papers similarly.
  const parsedPaperNumbers = new Set(parsed.papers.map((p) => p.number));
  const existingPapers = await db.select({ id: papers.id, number: papers.paperNumber })
    .from(papers).where(eq(papers.syllabusId, syllabusId));
  const orphanPaperIds = existingPapers.filter((r) => !parsedPaperNumbers.has(r.number)).map((r) => r.id);
  if (orphanPaperIds.length) {
    await db.delete(papers).where(inArray(papers.id, orphanPaperIds));
    warnings.push(`Removed ${orphanPaperIds.length} paper rows no longer present in the syllabus`);
  }

  return {
    topicsWritten,
    subtopicsWritten,
    requirementsWritten,
    papersWritten: paperIdByNumber.size,
    paperMappingsWritten,
    warnings,
  };
}

async function loadCompetencyIndex(db: DB): Promise<Map<string, number>> {
  const rows = await db.select({ id: competencies.id, code: competencies.code }).from(competencies);
  return new Map(rows.map((r) => [r.code, r.id]));
}

async function upsertStrands(
  db: DB,
  syllabusId: number,
  parsedStrands: ParsedStrand[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const s of parsedStrands) {
    const existing = await db.select().from(syllabusStrands).where(and(
      eq(syllabusStrands.syllabusId, syllabusId),
      eq(syllabusStrands.name, s.name),
    )).limit(1);
    if (existing.length) {
      await db.update(syllabusStrands).set({ sortOrder: s.sortOrder }).where(eq(syllabusStrands.id, existing[0].id));
      out.set(s.name, existing[0].id);
    } else {
      const [inserted] = await db.insert(syllabusStrands).values({
        syllabusId,
        name: s.name,
        sortOrder: s.sortOrder,
      }).returning({ id: syllabusStrands.id });
      out.set(s.name, inserted.id);
    }
  }
  return out;
}

async function upsertPapers(
  db: DB,
  syllabusId: number,
  parsedPapers: ParsedPaper[],
): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  for (const p of parsedPapers) {
    const existing = await db.select().from(papers).where(and(
      eq(papers.syllabusId, syllabusId),
      eq(papers.paperNumber, p.number),
    )).limit(1);
    if (existing.length) {
      await db.update(papers).set({
        title: p.title,
        levelTier: p.levelTier,
        coreOrExtended: p.coreOrExtended ?? null,
      }).where(eq(papers.id, existing[0].id));
      out.set(p.number, existing[0].id);
    } else {
      const [inserted] = await db.insert(papers).values({
        syllabusId,
        paperNumber: p.number,
        title: p.title,
        levelTier: p.levelTier,
        coreOrExtended: p.coreOrExtended ?? null,
      }).returning({ id: papers.id });
      out.set(p.number, inserted.id);
    }
  }
  return out;
}

async function upsertTopic(
  db: DB,
  syllabusId: number,
  parsed: ParsedTopic,
  strandIdByName: Map<string, number>,
  sortOrder: number,
): Promise<number> {
  const strandId = parsed.strandName ? strandIdByName.get(parsed.strandName) ?? null : null;
  const existing = await db.select().from(topics).where(and(
    eq(topics.syllabusId, syllabusId),
    eq(topics.topicNumber, parsed.number),
  )).limit(1);
  if (existing.length) {
    await db.update(topics).set({
      title: parsed.title,
      description: parsed.description ?? null,
      strandId,
      sortOrder,
    }).where(eq(topics.id, existing[0].id));
    return existing[0].id;
  }
  const [inserted] = await db.insert(topics).values({
    syllabusId,
    strandId,
    topicNumber: parsed.number,
    title: parsed.title,
    description: parsed.description ?? null,
    sortOrder,
    levelTiers: [],
  }).returning({ id: topics.id });
  return inserted.id;
}

async function upsertSubtopic(
  db: DB,
  topicId: number,
  parsed: ParsedSubtopic,
  sortOrder: number,
): Promise<number> {
  const existing = await db.select().from(subtopics).where(and(
    eq(subtopics.topicId, topicId),
    eq(subtopics.subtopicNumber, parsed.number),
  )).limit(1);
  if (existing.length) {
    await db.update(subtopics).set({
      title: parsed.title,
      description: parsed.description ?? null,
      levelTier: parsed.levelTier,
      coreOrExtended: parsed.coreOrExtended ?? null,
      sortOrder,
    }).where(eq(subtopics.id, existing[0].id));
    return existing[0].id;
  }
  const [inserted] = await db.insert(subtopics).values({
    topicId,
    subtopicNumber: parsed.number,
    title: parsed.title,
    description: parsed.description ?? null,
    levelTier: parsed.levelTier,
    coreOrExtended: parsed.coreOrExtended ?? null,
    sortOrder,
  }).returning({ id: subtopics.id });
  return inserted.id;
}

function deriveTopicLevelTiers(parsed: ParsedTopic): LevelTier[] {
  const tiers = new Set<LevelTier>();
  for (const s of parsed.subtopics) tiers.add(s.levelTier);
  return Array.from(tiers);
}

function resolveCompetencyIds(
  codes: CompetencyCode[],
  index: Map<string, number>,
  warnings: string[],
  subtopicNumber: string,
): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  for (const code of codes) {
    const id = index.get(code);
    if (id == null) {
      warnings.push(`Unknown competency code "${code}" encountered on subtopic ${subtopicNumber}`);
      continue;
    }
    if (!seen.has(id)) {
      out.push(id);
      seen.add(id);
    }
  }
  return out;
}
