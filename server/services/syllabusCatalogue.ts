/**
 * Syllabus catalogue service — Phase 4 of the Cambridge syllabus intelligence
 * layer. Reads the normalised tables populated by scripts/ingestSyllabi and
 * exposes the three primitives the tutor UI (Phase 5) needs:
 *
 *   resolveSyllabus(body, level, subject)
 *   listTopics(body, level, subject)
 *   getTopicContext(topicIds[])
 *
 * The functions return plain data suitable for JSON serialisation and are
 * pure reads — no side effects. Callers are responsible for authorisation.
 */

import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import { db } from "../db";
import {
  competencies,
  examiningBodies,
  learningRequirementCompetencies,
  learningRequirements,
  levels,
  paperTopicMappings,
  papers,
  subjects,
  subtopicPaperMappings,
  subtopics,
  syllabi,
  syllabusStrands,
  topicCompetencies,
  topics,
  type LevelTier,
} from "@shared/schema";

// ---------------------------------------------------------------------------
// Return shapes. Exposed for route handlers and downstream consumers.
// ---------------------------------------------------------------------------

export interface ExaminingBodyDto {
  id: number;
  slug: string;
  displayName: string;
}

export interface LevelDto {
  id: number;
  code: string;
  displayName: string;
  topBand: string;
  sortOrder: number;
}

export interface SubjectDto {
  id: number;
  slug: string;
  name: string;
}

export interface SyllabusDto {
  id: number;
  examiningBodyId: number;
  subjectId: number;
  topBand: string;
  syllabusCode: string;
  title: string;
  yearsValidFrom: number | null;
  yearsValidTo: number | null;
}

export interface PaperSummaryDto {
  id: number;
  paperNumber: number;
  code: string | null;
  title: string;
  levelTier: string;
  coreOrExtended: string | null;
}

export interface SubtopicListItemDto {
  id: number;
  subtopicNumber: string;
  title: string;
  levelTier: string;
  coreOrExtended: string | null;
  sortOrder: number;
}

export interface TopicListItemDto {
  id: number;
  topicNumber: string;
  title: string;
  description: string | null;
  levelTiers: string[];
  sortOrder: number;
  strandName: string | null;
  papers: PaperSummaryDto[];
  subtopics: SubtopicListItemDto[];
}

export interface CompetencyWeightDto {
  code: string;
  displayName: string;
  weight: number;
}

export interface RequirementDto {
  id: number;
  statement: string;
  commandWord: string | null;
  notesAndExamples: string | null;
  sortOrder: number;
  competencies: Array<{ code: string; displayName: string }>;
}

export interface SubtopicContextDto {
  id: number;
  subtopicNumber: string;
  title: string;
  description: string | null;
  levelTier: string;
  coreOrExtended: string | null;
  sortOrder: number;
  requirements: RequirementDto[];
  papers: PaperSummaryDto[];
}

export interface TopicContextDto {
  id: number;
  topicNumber: string;
  title: string;
  description: string | null;
  levelTiers: string[];
  sortOrder: number;
  strandName: string | null;
  subtopics: SubtopicContextDto[];
  papers: PaperSummaryDto[];
  competencies: CompetencyWeightDto[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requireDb(): NonNullable<typeof db> {
  if (!db) {
    throw new Error("Database not connected — catalogue queries unavailable");
  }
  return db;
}

function paperSummary(row: {
  id: number;
  paperNumber: number;
  code: string | null;
  title: string;
  levelTier: string;
  coreOrExtended: string | null;
}): PaperSummaryDto {
  return {
    id: row.id,
    paperNumber: row.paperNumber,
    code: row.code,
    title: row.title,
    levelTier: row.levelTier,
    coreOrExtended: row.coreOrExtended,
  };
}

// ---------------------------------------------------------------------------
// Dropdown primitives: bodies / levels / subjects
// ---------------------------------------------------------------------------

export async function listExaminingBodies(): Promise<ExaminingBodyDto[]> {
  const handle = requireDb();
  const rows = await handle
    .select({
      id: examiningBodies.id,
      slug: examiningBodies.slug,
      displayName: examiningBodies.displayName,
    })
    .from(examiningBodies)
    .where(eq(examiningBodies.isActive, true))
    .orderBy(asc(examiningBodies.displayName));
  return rows;
}

/**
 * Levels are seeded globally but only the ones with at least one syllabus in
 * the requested body are tutor-relevant. For Cambridge this is the full set
 * ("IGCSE", "AS", "A2"); for other bodies it may be a subset.
 */
export async function listLevelsForBody(bodySlug: string): Promise<LevelDto[]> {
  const handle = requireDb();
  const body = await findBody(bodySlug);
  if (!body) return [];
  const rows = await handle
    .selectDistinct({
      id: levels.id,
      code: levels.code,
      displayName: levels.displayName,
      topBand: levels.topBand,
      sortOrder: levels.sortOrder,
    })
    .from(levels)
    .innerJoin(syllabi, eq(syllabi.topBand, levels.topBand))
    .where(and(eq(syllabi.examiningBodyId, body.id), eq(syllabi.isActive, true)))
    .orderBy(asc(levels.sortOrder), asc(levels.code));
  return rows;
}

export async function listSubjectsForBodyLevel(
  bodySlug: string,
  levelCode: string,
): Promise<SubjectDto[]> {
  const handle = requireDb();
  const body = await findBody(bodySlug);
  if (!body) return [];
  const level = await findLevel(levelCode);
  if (!level) return [];
  const rows = await handle
    .selectDistinct({
      id: subjects.id,
      slug: subjects.slug,
      name: subjects.name,
    })
    .from(subjects)
    .innerJoin(syllabi, eq(syllabi.subjectId, subjects.id))
    .where(
      and(
        eq(subjects.examiningBodyId, body.id),
        eq(syllabi.topBand, level.topBand),
        eq(syllabi.isActive, true),
      ),
    )
    .orderBy(asc(subjects.name));
  return rows;
}

/**
 * Public, unscoped list of all distinct active subject NAMES across the
 * catalogue. Used by the public signup autocomplete — names only, nothing
 * sensitive. Returns a sorted, de-duplicated string array.
 */
export async function listAllSubjectNames(): Promise<string[]> {
  const handle = requireDb();
  const rows = await handle
    .selectDistinct({ name: subjects.name })
    .from(subjects)
    .innerJoin(syllabi, eq(syllabi.subjectId, subjects.id))
    .where(eq(syllabi.isActive, true))
    .orderBy(asc(subjects.name));
  return rows.map((r) => r.name).filter((n): n is string => !!n);
}

// ---------------------------------------------------------------------------
// Syllabus resolution + topic listing
// ---------------------------------------------------------------------------

export async function resolveSyllabus(
  bodySlug: string,
  levelCode: string,
  subjectSlug: string,
): Promise<SyllabusDto | null> {
  const handle = requireDb();
  const body = await findBody(bodySlug);
  if (!body) return null;
  const level = await findLevel(levelCode);
  if (!level) return null;

  const rows = await handle
    .select({
      id: syllabi.id,
      examiningBodyId: syllabi.examiningBodyId,
      subjectId: syllabi.subjectId,
      topBand: syllabi.topBand,
      syllabusCode: syllabi.syllabusCode,
      title: syllabi.title,
      yearsValidFrom: syllabi.yearsValidFrom,
      yearsValidTo: syllabi.yearsValidTo,
    })
    .from(syllabi)
    .innerJoin(subjects, eq(subjects.id, syllabi.subjectId))
    .where(
      and(
        eq(syllabi.examiningBodyId, body.id),
        eq(syllabi.topBand, level.topBand),
        eq(subjects.slug, subjectSlug),
        eq(syllabi.isActive, true),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Topic list filtered to what's actually assessable at the requested level.
 *
 * An A-Level syllabus row carries both AS and A2 topics; we filter by the
 * tutor-facing level code ("IGCSE" / "AS" / "A2") using two complementary
 * signals:
 *
 *   1. `topics.levelTiers` — jsonb array maintained by the ingestion pipeline
 *      as the union of the topic's subtopic tiers.
 *   2. `paperTopicMappings` joined to `papers.levelTier` — catches topics
 *      assessed on an AS/A2 paper even when their subtopic tier tagging is
 *      sparse.
 *
 * A topic qualifies if it matches either signal. The paper list attached to
 * each topic is filtered to the requested tier so the UI shows only the
 * papers relevant to that level.
 */
export async function listTopics(
  bodySlug: string,
  levelCode: string,
  subjectSlug: string,
): Promise<TopicListItemDto[]> {
  const handle = requireDb();
  const syllabus = await resolveSyllabus(bodySlug, levelCode, subjectSlug);
  if (!syllabus) return [];
  const level = await findLevel(levelCode);
  if (!level) return [];

  const tier = level.code as LevelTier;

  const tierInLevelTiers = sql<boolean>`${topics.levelTiers}::jsonb @> ${JSON.stringify([tier])}::jsonb`;

  const topicIdsFromPapers = handle
    .select({ topicId: paperTopicMappings.topicId })
    .from(paperTopicMappings)
    .innerJoin(papers, eq(papers.id, paperTopicMappings.paperId))
    .where(and(eq(papers.syllabusId, syllabus.id), eq(papers.levelTier, tier)));

  const topicRows = await handle
    .select({
      id: topics.id,
      topicNumber: topics.topicNumber,
      title: topics.title,
      description: topics.description,
      levelTiers: topics.levelTiers,
      sortOrder: topics.sortOrder,
      strandId: topics.strandId,
    })
    .from(topics)
    .where(
      and(
        eq(topics.syllabusId, syllabus.id),
        or(tierInLevelTiers, inArray(topics.id, topicIdsFromPapers)),
      ),
    )
    .orderBy(asc(topics.sortOrder), asc(topics.topicNumber));

  if (topicRows.length === 0) return [];

  const topicIds = topicRows.map((r) => r.id);
  const strandIds = topicRows.map((r) => r.strandId).filter((n): n is number => n !== null);
  const papersByTopic = await fetchPapersByTopic(topicIds, tier);
  const strandNameById = await fetchStrandNameMap(strandIds);

  // Pull subtopics for the visible topics so the wizard can render expandable
  // sections. We filter by tier so AS quizzes don't surface A2-only subtopics
  // (and vice-versa); if the tier filter yields nothing for a given topic we
  // fall back to all subtopics so the UI still has something to show.
  const subtopicRows = await handle
    .select({
      id: subtopics.id,
      topicId: subtopics.topicId,
      subtopicNumber: subtopics.subtopicNumber,
      title: subtopics.title,
      levelTier: subtopics.levelTier,
      coreOrExtended: subtopics.coreOrExtended,
      sortOrder: subtopics.sortOrder,
    })
    .from(subtopics)
    .where(inArray(subtopics.topicId, topicIds))
    .orderBy(asc(subtopics.sortOrder), asc(subtopics.subtopicNumber));

  const subtopicsByTopic = new Map<number, SubtopicListItemDto[]>();
  for (const r of subtopicRows) {
    const list = subtopicsByTopic.get(r.topicId) ?? [];
    list.push({
      id: r.id,
      subtopicNumber: r.subtopicNumber,
      title: r.title,
      levelTier: r.levelTier,
      coreOrExtended: r.coreOrExtended,
      sortOrder: r.sortOrder,
    });
    subtopicsByTopic.set(r.topicId, list);
  }
  subtopicsByTopic.forEach((list, tid) => {
    const inTier = list.filter((s: SubtopicListItemDto) => s.levelTier === tier);
    subtopicsByTopic.set(tid, inTier.length > 0 ? inTier : list);
  });

  return topicRows.map((row) => ({
    id: row.id,
    topicNumber: row.topicNumber,
    title: row.title,
    description: row.description,
    levelTiers: row.levelTiers ?? [],
    sortOrder: row.sortOrder,
    strandName: row.strandId ? strandNameById.get(row.strandId) ?? null : null,
    papers: papersByTopic.get(row.id) ?? [],
    subtopics: subtopicsByTopic.get(row.id) ?? [],
  }));
}

// ---------------------------------------------------------------------------
// Full context for a given set of topic ids
// ---------------------------------------------------------------------------

export async function getTopicContext(topicIds: number[]): Promise<TopicContextDto[]> {
  if (topicIds.length === 0) return [];
  const handle = requireDb();

  const topicRows = await handle
    .select({
      id: topics.id,
      topicNumber: topics.topicNumber,
      title: topics.title,
      description: topics.description,
      levelTiers: topics.levelTiers,
      sortOrder: topics.sortOrder,
      strandId: topics.strandId,
    })
    .from(topics)
    .where(inArray(topics.id, topicIds))
    .orderBy(asc(topics.sortOrder), asc(topics.topicNumber));
  if (topicRows.length === 0) return [];

  const foundIds = topicRows.map((r) => r.id);

  const subtopicRows = await handle
    .select({
      id: subtopics.id,
      topicId: subtopics.topicId,
      subtopicNumber: subtopics.subtopicNumber,
      title: subtopics.title,
      description: subtopics.description,
      levelTier: subtopics.levelTier,
      coreOrExtended: subtopics.coreOrExtended,
      sortOrder: subtopics.sortOrder,
    })
    .from(subtopics)
    .where(inArray(subtopics.topicId, foundIds))
    .orderBy(asc(subtopics.sortOrder), asc(subtopics.subtopicNumber));

  const subtopicIds = subtopicRows.map((s) => s.id);
  const [lrRows, lrCompRows, subPaperRows, paperRows, topicPaperRows, topicCompRows, strandNameById] =
    await Promise.all([
      fetchRequirements(subtopicIds),
      fetchRequirementCompetencies(subtopicIds),
      fetchSubtopicPaperIds(subtopicIds),
      fetchPapersByTopic(foundIds, null),
      fetchTopicPapers(foundIds),
      fetchTopicCompetencies(foundIds),
      fetchStrandNameMap(
        topicRows.map((r) => r.strandId).filter((n): n is number => n !== null),
      ),
    ]);

  const allPaperIds = new Set<number>();
  subPaperRows.forEach((pairs: number[]) => pairs.forEach((id) => allPaperIds.add(id)));
  topicPaperRows.forEach((list: PaperSummaryDto[]) => list.forEach((p) => allPaperIds.add(p.id)));
  const paperIndex = await fetchPapersByIds(Array.from(allPaperIds));

  const subtopicsByTopicId = new Map<number, SubtopicContextDto[]>();
  for (const row of subtopicRows) {
    const lrs = (lrRows.get(row.id) ?? []).map((lr): RequirementDto => ({
      id: lr.id,
      statement: lr.statement,
      commandWord: lr.commandWord,
      notesAndExamples: lr.notesAndExamples,
      sortOrder: lr.sortOrder,
      competencies: lrCompRows.get(lr.id) ?? [],
    }));
    const paperIds = subPaperRows.get(row.id) ?? [];
    const subPapers = paperIds
      .map((id) => paperIndex.get(id))
      .filter((p): p is PaperSummaryDto => Boolean(p));
    const list = subtopicsByTopicId.get(row.topicId) ?? [];
    list.push({
      id: row.id,
      subtopicNumber: row.subtopicNumber,
      title: row.title,
      description: row.description,
      levelTier: row.levelTier,
      coreOrExtended: row.coreOrExtended,
      sortOrder: row.sortOrder,
      requirements: lrs,
      papers: subPapers,
    });
    subtopicsByTopicId.set(row.topicId, list);
  }

  return topicRows.map((t): TopicContextDto => ({
    id: t.id,
    topicNumber: t.topicNumber,
    title: t.title,
    description: t.description,
    levelTiers: t.levelTiers ?? [],
    sortOrder: t.sortOrder,
    strandName: t.strandId ? strandNameById.get(t.strandId) ?? null : null,
    subtopics: subtopicsByTopicId.get(t.id) ?? [],
    papers: topicPaperRows.get(t.id) ?? [],
    competencies: topicCompRows.get(t.id) ?? [],
  }));
}

// ---------------------------------------------------------------------------
// Internal lookups
// ---------------------------------------------------------------------------

async function findBody(slug: string) {
  const handle = requireDb();
  const rows = await handle
    .select({ id: examiningBodies.id, slug: examiningBodies.slug })
    .from(examiningBodies)
    .where(and(eq(examiningBodies.slug, slug), eq(examiningBodies.isActive, true)))
    .limit(1);
  return rows[0] ?? null;
}

async function findLevel(code: string) {
  const handle = requireDb();
  const rows = await handle
    .select({ id: levels.id, code: levels.code, topBand: levels.topBand })
    .from(levels)
    .where(eq(levels.code, code))
    .limit(1);
  return rows[0] ?? null;
}

async function fetchStrandNameMap(strandIds: number[]): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  if (strandIds.length === 0) return map;
  const handle = requireDb();
  const rows = await handle
    .select({ id: syllabusStrands.id, name: syllabusStrands.name })
    .from(syllabusStrands)
    .where(inArray(syllabusStrands.id, strandIds));
  for (const row of rows) map.set(row.id, row.name);
  return map;
}

async function fetchPapersByTopic(
  topicIds: number[],
  levelTierFilter: string | null,
): Promise<Map<number, PaperSummaryDto[]>> {
  const map = new Map<number, PaperSummaryDto[]>();
  if (topicIds.length === 0) return map;
  const handle = requireDb();

  const conditions = [inArray(paperTopicMappings.topicId, topicIds)];
  if (levelTierFilter) conditions.push(eq(papers.levelTier, levelTierFilter));

  const rows = await handle
    .select({
      topicId: paperTopicMappings.topicId,
      id: papers.id,
      paperNumber: papers.paperNumber,
      code: papers.code,
      title: papers.title,
      levelTier: papers.levelTier,
      coreOrExtended: papers.coreOrExtended,
    })
    .from(paperTopicMappings)
    .innerJoin(papers, eq(papers.id, paperTopicMappings.paperId))
    .where(and(...conditions))
    .orderBy(asc(papers.paperNumber));

  for (const row of rows) {
    const list = map.get(row.topicId) ?? [];
    list.push(paperSummary(row));
    map.set(row.topicId, list);
  }
  return map;
}

async function fetchTopicPapers(
  topicIds: number[],
): Promise<Map<number, PaperSummaryDto[]>> {
  return fetchPapersByTopic(topicIds, null);
}

async function fetchRequirements(
  subtopicIds: number[],
): Promise<Map<number, Array<{
  id: number;
  statement: string;
  commandWord: string | null;
  notesAndExamples: string | null;
  sortOrder: number;
}>>> {
  const map = new Map<number, Array<{
    id: number;
    statement: string;
    commandWord: string | null;
    notesAndExamples: string | null;
    sortOrder: number;
  }>>();
  if (subtopicIds.length === 0) return map;
  const handle = requireDb();
  const rows = await handle
    .select({
      id: learningRequirements.id,
      subtopicId: learningRequirements.subtopicId,
      statement: learningRequirements.statement,
      commandWord: learningRequirements.commandWord,
      notesAndExamples: learningRequirements.notesAndExamples,
      sortOrder: learningRequirements.sortOrder,
    })
    .from(learningRequirements)
    .where(inArray(learningRequirements.subtopicId, subtopicIds))
    .orderBy(asc(learningRequirements.sortOrder), asc(learningRequirements.id));
  for (const row of rows) {
    const list = map.get(row.subtopicId) ?? [];
    list.push({
      id: row.id,
      statement: row.statement,
      commandWord: row.commandWord,
      notesAndExamples: row.notesAndExamples,
      sortOrder: row.sortOrder,
    });
    map.set(row.subtopicId, list);
  }
  return map;
}

async function fetchRequirementCompetencies(
  subtopicIds: number[],
): Promise<Map<number, Array<{ code: string; displayName: string }>>> {
  const map = new Map<number, Array<{ code: string; displayName: string }>>();
  if (subtopicIds.length === 0) return map;
  const handle = requireDb();
  const rows = await handle
    .select({
      learningRequirementId: learningRequirementCompetencies.learningRequirementId,
      code: competencies.code,
      displayName: competencies.displayName,
    })
    .from(learningRequirementCompetencies)
    .innerJoin(
      learningRequirements,
      eq(learningRequirements.id, learningRequirementCompetencies.learningRequirementId),
    )
    .innerJoin(competencies, eq(competencies.id, learningRequirementCompetencies.competencyId))
    .where(inArray(learningRequirements.subtopicId, subtopicIds))
    .orderBy(asc(competencies.sortOrder));
  for (const row of rows) {
    const list = map.get(row.learningRequirementId) ?? [];
    list.push({ code: row.code, displayName: row.displayName });
    map.set(row.learningRequirementId, list);
  }
  return map;
}

async function fetchSubtopicPaperIds(
  subtopicIds: number[],
): Promise<Map<number, number[]>> {
  const map = new Map<number, number[]>();
  if (subtopicIds.length === 0) return map;
  const handle = requireDb();
  const rows = await handle
    .select({
      subtopicId: subtopicPaperMappings.subtopicId,
      paperId: subtopicPaperMappings.paperId,
    })
    .from(subtopicPaperMappings)
    .where(inArray(subtopicPaperMappings.subtopicId, subtopicIds));
  for (const row of rows) {
    const list = map.get(row.subtopicId) ?? [];
    list.push(row.paperId);
    map.set(row.subtopicId, list);
  }
  return map;
}

async function fetchPapersByIds(paperIds: number[]): Promise<Map<number, PaperSummaryDto>> {
  const map = new Map<number, PaperSummaryDto>();
  if (paperIds.length === 0) return map;
  const handle = requireDb();
  const rows = await handle
    .select({
      id: papers.id,
      paperNumber: papers.paperNumber,
      code: papers.code,
      title: papers.title,
      levelTier: papers.levelTier,
      coreOrExtended: papers.coreOrExtended,
    })
    .from(papers)
    .where(inArray(papers.id, paperIds));
  for (const row of rows) {
    map.set(row.id, paperSummary(row));
  }
  return map;
}

async function fetchTopicCompetencies(
  topicIds: number[],
): Promise<Map<number, CompetencyWeightDto[]>> {
  const map = new Map<number, CompetencyWeightDto[]>();
  if (topicIds.length === 0) return map;
  const handle = requireDb();
  const rows = await handle
    .select({
      topicId: topicCompetencies.topicId,
      code: competencies.code,
      displayName: competencies.displayName,
      weight: topicCompetencies.weight,
    })
    .from(topicCompetencies)
    .innerJoin(competencies, eq(competencies.id, topicCompetencies.competencyId))
    .where(inArray(topicCompetencies.topicId, topicIds))
    .orderBy(asc(competencies.sortOrder));
  for (const row of rows) {
    const list = map.get(row.topicId) ?? [];
    list.push({ code: row.code, displayName: row.displayName, weight: row.weight });
    map.set(row.topicId, list);
  }
  return map;
}
