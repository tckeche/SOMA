/**
 * Syllabus intelligence layer — registry + ingestion.
 *
 * The registry is the single read/write interface for the new tables
 * (examining_bodies, curriculum_levels, curriculum_subjects, syllabi, papers,
 *  topics, subtopics, competencies, topic_competencies, subtopic_competencies,
 *  paper_topics). All routes and services call into this module rather than
 * poking the tables directly, so the internal shape of the data can evolve
 * without touching call sites.
 *
 * The ingestion function (`seedCurriculum`) is idempotent — running it
 * repeatedly converges on the seed dataset. It is safe to call at server boot.
 */

import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import {
  examiningBodies,
  curriculumLevels,
  curriculumSubjects,
  syllabi,
  papers,
  topics,
  subtopics,
  competencies,
  topicCompetencies,
  subtopicCompetencies,
  paperTopics,
  syllabusDocuments,
} from "@shared/schema";
import type {
  CurriculumSeed,
  SyllabusSeed,
  TopicSeed,
  LevelCode,
  CompetencyCode,
} from "@shared/curriculum/types";

// ────────────────────────────────────────────────────────────────────────────
// Read types (what callers see)
// ────────────────────────────────────────────────────────────────────────────

export interface BodyView {
  code: string;
  name: string;
}

export interface LevelView {
  code: LevelCode;
  name: string;
  sortOrder: number;
}

export interface SubjectView {
  slug: string;
  name: string;
  syllabusCode: string;
  syllabusTitle: string;
  yearsValid: string | null;
}

export interface TopicView {
  id: number;
  name: string;
  code: string | null;
  description: string | null;
  subtopics: Array<{
    name: string;
    description: string | null;
    learningRequirements: string[];
  }>;
  competencies: Array<{
    code: CompetencyCode;
    name: string;
    weight: number;
  }>;
}

export interface SyllabusContextView {
  examiningBody: string;
  level: LevelCode;
  subject: string;
  syllabusCode: string;
  syllabusTitle: string;
  yearsValid: string | null;
  papers: Array<{
    paperNumber: string;
    code: string | null;
    title: string;
    durationMinutes: number | null;
    marks: number | null;
    description: string | null;
  }>;
  topicOutline: Array<{ name: string; code: string | null }>;
  selectedTopics: TopicView[];
  competencyDistribution: Array<{
    code: CompetencyCode;
    name: string;
    totalWeight: number;
  }>;
}

// ────────────────────────────────────────────────────────────────────────────
// Guards
// ────────────────────────────────────────────────────────────────────────────

function requireDb() {
  if (!db) {
    throw new Error(
      "Curriculum registry requires a database connection. Set SUPABASE_URL and restart.",
    );
  }
  return db;
}

// ────────────────────────────────────────────────────────────────────────────
// Read API
// ────────────────────────────────────────────────────────────────────────────

export async function listBodies(): Promise<BodyView[]> {
  const d = requireDb();
  const rows = await d
    .select({ code: examiningBodies.code, name: examiningBodies.name })
    .from(examiningBodies)
    .where(eq(examiningBodies.isActive, true))
    .orderBy(examiningBodies.sortOrder, examiningBodies.name);
  return rows;
}

export async function listLevels(bodyCode: string): Promise<LevelView[]> {
  const d = requireDb();
  const rows = await d
    .select({
      code: curriculumLevels.code,
      name: curriculumLevels.name,
      sortOrder: curriculumLevels.sortOrder,
    })
    .from(curriculumLevels)
    .innerJoin(examiningBodies, eq(curriculumLevels.bodyId, examiningBodies.id))
    .where(eq(examiningBodies.code, bodyCode))
    .orderBy(curriculumLevels.sortOrder);
  return rows.map((r) => ({ ...r, code: r.code as LevelCode }));
}

/**
 * Return every subject offered by a body for the given level.
 *
 * AS/A2 share syllabus codes (e.g. 9709). A subject is considered to belong
 * to a level if either (a) the syllabus is level-pinned via `syllabi.level_id`
 * (IGCSE case) or (b) the syllabus has at least one paper at that level
 * (AS/A2 case).
 */
export async function listSubjects(
  bodyCode: string,
  levelCode: LevelCode,
): Promise<SubjectView[]> {
  const d = requireDb();
  const rows = await d.execute(sql`
    SELECT DISTINCT
      s.id AS syllabus_id,
      s.code AS syllabus_code,
      s.title AS syllabus_title,
      s.years_valid AS years_valid,
      subj.slug AS subject_slug,
      subj.name AS subject_name
    FROM ${syllabi} s
    INNER JOIN ${examiningBodies} b ON s.body_id = b.id
    INNER JOIN ${curriculumSubjects} subj ON s.subject_id = subj.id
    LEFT JOIN ${curriculumLevels} sl ON s.level_id = sl.id
    LEFT JOIN ${papers} p ON p.syllabus_id = s.id
    LEFT JOIN ${curriculumLevels} pl ON p.level_id = pl.id
    WHERE b.code = ${bodyCode}
      AND (
        sl.code = ${levelCode}
        OR pl.code = ${levelCode}
      )
    ORDER BY subject_name
  `);
  return (rows.rows as any[]).map((r) => ({
    slug: String(r.subject_slug),
    name: String(r.subject_name),
    syllabusCode: String(r.syllabus_code),
    syllabusTitle: String(r.syllabus_title),
    yearsValid: r.years_valid ? String(r.years_valid) : null,
  }));
}

/**
 * Resolve the syllabus row that backs a (body, level, subject) selection.
 *
 * For IGCSE the match is direct. For AS/A2 the syllabus itself may span both
 * levels, so we return the syllabus whose subject matches and which has at
 * least one paper at the requested level.
 */
async function resolveSyllabus(
  bodyCode: string,
  levelCode: LevelCode,
  subjectSlug: string,
): Promise<{ id: number; code: string; title: string; yearsValid: string | null } | null> {
  const d = requireDb();
  const rows = await d.execute(sql`
    SELECT DISTINCT
      s.id AS syllabus_id,
      s.code AS syllabus_code,
      s.title AS syllabus_title,
      s.years_valid AS years_valid
    FROM ${syllabi} s
    INNER JOIN ${examiningBodies} b ON s.body_id = b.id
    INNER JOIN ${curriculumSubjects} subj ON s.subject_id = subj.id
    LEFT JOIN ${curriculumLevels} sl ON s.level_id = sl.id
    LEFT JOIN ${papers} p ON p.syllabus_id = s.id
    LEFT JOIN ${curriculumLevels} pl ON p.level_id = pl.id
    WHERE b.code = ${bodyCode}
      AND subj.slug = ${subjectSlug}
      AND (sl.code = ${levelCode} OR pl.code = ${levelCode})
    LIMIT 1
  `);
  const row = (rows.rows as any[])[0];
  if (!row) return null;
  return {
    id: Number(row.syllabus_id),
    code: String(row.syllabus_code),
    title: String(row.syllabus_title),
    yearsValid: row.years_valid ? String(row.years_valid) : null,
  };
}

/**
 * Topic list for a (body, level, subject), filtered by paper structure.
 *
 * For IGCSE — or any syllabus where `syllabi.level_id` is set — every topic
 * in the syllabus is returned.
 *
 * For AS/A2 — where topics are owned by the shared syllabus but split by
 * paper — only topics that are examined by at least one paper at the given
 * level are returned.
 */
export async function listTopicsForSelection(
  bodyCode: string,
  levelCode: LevelCode,
  subjectSlug: string,
): Promise<Array<{ id: number; name: string; code: string | null; description: string | null }>> {
  const d = requireDb();
  const rows = await d.execute(sql`
    SELECT DISTINCT t.id, t.name, t.code, t.description, t.sort_order
    FROM ${topics} t
    INNER JOIN ${syllabi} s ON t.syllabus_id = s.id
    INNER JOIN ${examiningBodies} b ON s.body_id = b.id
    INNER JOIN ${curriculumSubjects} subj ON s.subject_id = subj.id
    LEFT JOIN ${curriculumLevels} sl ON s.level_id = sl.id
    LEFT JOIN ${paperTopics} pt ON pt.topic_id = t.id
    LEFT JOIN ${papers} p ON pt.paper_id = p.id
    LEFT JOIN ${curriculumLevels} pl ON p.level_id = pl.id
    WHERE b.code = ${bodyCode}
      AND subj.slug = ${subjectSlug}
      AND (
        sl.code = ${levelCode}
        OR pl.code = ${levelCode}
      )
    ORDER BY t.sort_order, t.name
  `);
  return (rows.rows as any[]).map((r) => ({
    id: Number(r.id),
    name: String(r.name),
    code: r.code ? String(r.code) : null,
    description: r.description ? String(r.description) : null,
  }));
}

/**
 * Rich context payload for the copilot.
 *
 * If `selectedTopicNames` is non-empty, the returned `selectedTopics` carries
 * full subtopic + competency detail for those topics. If it is empty, the
 * payload still carries the syllabus header and topic outline so the copilot
 * has broad syllabus coverage.
 */
export async function buildSyllabusContext(input: {
  bodyCode: string;
  levelCode: LevelCode;
  subjectSlug: string;
  selectedTopicNames?: string[];
}): Promise<SyllabusContextView | null> {
  const d = requireDb();
  const syllabus = await resolveSyllabus(input.bodyCode, input.levelCode, input.subjectSlug);
  if (!syllabus) return null;

  const [bodyRow] = await d
    .select({ code: examiningBodies.code, name: examiningBodies.name })
    .from(examiningBodies)
    .where(eq(examiningBodies.code, input.bodyCode));

  const [subjectRow] = await d
    .select({ name: curriculumSubjects.name })
    .from(curriculumSubjects)
    .where(eq(curriculumSubjects.slug, input.subjectSlug));

  // Papers at this level for this syllabus
  const paperRows = await d
    .select({
      id: papers.id,
      paperNumber: papers.paperNumber,
      code: papers.code,
      title: papers.title,
      durationMinutes: papers.durationMinutes,
      marks: papers.marks,
      description: papers.description,
    })
    .from(papers)
    .innerJoin(curriculumLevels, eq(papers.levelId, curriculumLevels.id))
    .where(and(eq(papers.syllabusId, syllabus.id), eq(curriculumLevels.code, input.levelCode)))
    .orderBy(papers.sortOrder, papers.paperNumber);

  // Topic outline visible to the chosen level (via paper_topics or syllabi.level)
  const outlineRaw = await listTopicsForSelection(
    input.bodyCode,
    input.levelCode,
    input.subjectSlug,
  );
  const topicOutline = outlineRaw.map((t) => ({ name: t.name, code: t.code }));

  // Resolve selected topic rows (if any)
  const wantedNames = (input.selectedTopicNames ?? []).filter((x) => x && x.trim());
  const selectedRows = wantedNames.length
    ? outlineRaw.filter((t) => wantedNames.includes(t.name))
    : [];

  const selectedTopics: TopicView[] = [];
  for (const t of selectedRows) {
    const subs = await d
      .select({
        name: subtopics.name,
        description: subtopics.description,
        learningRequirements: subtopics.learningRequirements,
      })
      .from(subtopics)
      .where(eq(subtopics.topicId, t.id))
      .orderBy(subtopics.sortOrder, subtopics.name);

    const comps = await d
      .select({
        code: competencies.code,
        name: competencies.name,
        weight: topicCompetencies.weight,
      })
      .from(topicCompetencies)
      .innerJoin(competencies, eq(topicCompetencies.competencyId, competencies.id))
      .where(eq(topicCompetencies.topicId, t.id))
      .orderBy(competencies.sortOrder);

    selectedTopics.push({
      id: t.id,
      name: t.name,
      code: t.code,
      description: t.description,
      subtopics: subs.map((s) => ({
        name: s.name,
        description: s.description,
        learningRequirements: Array.isArray(s.learningRequirements)
          ? (s.learningRequirements as string[])
          : [],
      })),
      competencies: comps.map((c) => ({
        code: c.code as CompetencyCode,
        name: c.name,
        weight: c.weight,
      })),
    });
  }

  // Rolled-up competency distribution — sum of weights across the topics
  // the copilot will ground on. If the tutor selected topics, use just those;
  // otherwise use every topic at this level.
  const distributionSourceIds = (selectedTopics.length > 0 ? selectedTopics : outlineRaw).map(
    (t) => t.id,
  );
  const distribution: Record<string, { code: CompetencyCode; name: string; totalWeight: number }> =
    {};
  if (distributionSourceIds.length > 0) {
    const rows = await d.execute(sql`
      SELECT c.code, c.name, SUM(tc.weight) AS total_weight
      FROM ${topicCompetencies} tc
      INNER JOIN ${competencies} c ON tc.competency_id = c.id
      WHERE tc.topic_id IN (${sql.join(
        distributionSourceIds.map((id) => sql`${id}`),
        sql`, `,
      )})
      GROUP BY c.code, c.name, c.sort_order
      ORDER BY c.sort_order
    `);
    for (const r of rows.rows as any[]) {
      distribution[String(r.code)] = {
        code: String(r.code) as CompetencyCode,
        name: String(r.name),
        totalWeight: Number(r.total_weight) || 0,
      };
    }
  }

  return {
    examiningBody: bodyRow?.name ?? input.bodyCode,
    level: input.levelCode,
    subject: subjectRow?.name ?? input.subjectSlug,
    syllabusCode: syllabus.code,
    syllabusTitle: syllabus.title,
    yearsValid: syllabus.yearsValid,
    papers: paperRows.map((p) => ({
      paperNumber: p.paperNumber,
      code: p.code,
      title: p.title,
      durationMinutes: p.durationMinutes,
      marks: p.marks,
      description: p.description,
    })),
    topicOutline,
    selectedTopics,
    competencyDistribution: Object.values(distribution),
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Ingestion — idempotent seed of a body's complete syllabus tree.
// ────────────────────────────────────────────────────────────────────────────

/** Result summary for logging and tests. */
export interface SeedSummary {
  body: string;
  levels: number;
  subjects: number;
  syllabi: number;
  papers: number;
  topics: number;
  subtopics: number;
  competencies: number;
  documentsLinked: number;
}

export async function seedCurriculum(seed: CurriculumSeed): Promise<SeedSummary> {
  const d = requireDb();

  // Body
  const [body] = await d
    .insert(examiningBodies)
    .values({ code: seed.body.code, name: seed.body.name, isActive: true, sortOrder: 1 })
    .onConflictDoUpdate({
      target: examiningBodies.code,
      set: { name: seed.body.name, isActive: true },
    })
    .returning();

  // Levels
  const levelIdByCode = new Map<string, number>();
  for (const lvl of seed.levels) {
    const [row] = await d
      .insert(curriculumLevels)
      .values({ bodyId: body.id, code: lvl.code, name: lvl.name, sortOrder: lvl.sortOrder })
      .onConflictDoUpdate({
        target: [curriculumLevels.bodyId, curriculumLevels.code],
        set: { name: lvl.name, sortOrder: lvl.sortOrder },
      })
      .returning();
    levelIdByCode.set(lvl.code, row.id);
  }

  // Competencies (global, one row per code)
  const competencyIdByCode = new Map<string, number>();
  for (const c of seed.competencies) {
    const [row] = await d
      .insert(competencies)
      .values({
        code: c.code,
        name: c.name,
        description: c.description,
        sortOrder: c.sortOrder,
      })
      .onConflictDoUpdate({
        target: competencies.code,
        set: { name: c.name, description: c.description, sortOrder: c.sortOrder },
      })
      .returning();
    competencyIdByCode.set(c.code, row.id);
  }

  const summary: SeedSummary = {
    body: seed.body.code,
    levels: levelIdByCode.size,
    subjects: 0,
    syllabi: 0,
    papers: 0,
    topics: 0,
    subtopics: 0,
    competencies: competencyIdByCode.size,
    documentsLinked: 0,
  };

  // Subjects + syllabi + papers + topics
  for (const syl of seed.syllabi) {
    // Subject
    const [subject] = await d
      .insert(curriculumSubjects)
      .values({ slug: syl.subjectSlug, name: syl.subjectName })
      .onConflictDoUpdate({
        target: curriculumSubjects.slug,
        set: { name: syl.subjectName },
      })
      .returning();
    summary.subjects++;

    // Link to existing ingested PDF, if any
    let documentId: number | null = null;
    if (syl.sourcePath) {
      const [doc] = await d
        .select({ id: syllabusDocuments.id })
        .from(syllabusDocuments)
        .where(eq(syllabusDocuments.originalPath, syl.sourcePath))
        .limit(1);
      if (doc) {
        documentId = doc.id;
        summary.documentsLinked++;
      }
    }

    // Syllabus
    const syllabusLevelId =
      syl.level && levelIdByCode.has(syl.level) ? levelIdByCode.get(syl.level)! : null;
    const [syllabusRow] = await d
      .insert(syllabi)
      .values({
        bodyId: body.id,
        subjectId: subject.id,
        code: syl.code,
        title: syl.title,
        yearsValid: syl.yearsValid ?? null,
        levelId: syllabusLevelId,
        documentId,
        sourcePath: syl.sourcePath ?? null,
        notes: syl.notes ?? null,
      })
      .onConflictDoUpdate({
        target: [syllabi.bodyId, syllabi.code],
        set: {
          subjectId: subject.id,
          title: syl.title,
          yearsValid: syl.yearsValid ?? null,
          levelId: syllabusLevelId,
          documentId,
          sourcePath: syl.sourcePath ?? null,
          notes: syl.notes ?? null,
        },
      })
      .returning();
    summary.syllabi++;

    // Topics
    const topicIdByName = new Map<string, number>();
    for (let i = 0; i < syl.topics.length; i++) {
      const t: TopicSeed = syl.topics[i];
      const [topicRow] = await d
        .insert(topics)
        .values({
          syllabusId: syllabusRow.id,
          code: t.code ?? null,
          name: t.name,
          description: t.description ?? null,
          sortOrder: i,
        })
        .onConflictDoUpdate({
          target: [topics.syllabusId, topics.name],
          set: {
            code: t.code ?? null,
            description: t.description ?? null,
            sortOrder: i,
          },
        })
        .returning();
      topicIdByName.set(t.name, topicRow.id);
      summary.topics++;

      // Topic → competency weights
      if (t.competencyWeights) {
        for (const [code, weight] of Object.entries(t.competencyWeights)) {
          const compId = competencyIdByCode.get(code);
          if (!compId || !weight) continue;
          await d
            .insert(topicCompetencies)
            .values({ topicId: topicRow.id, competencyId: compId, weight })
            .onConflictDoUpdate({
              target: [topicCompetencies.topicId, topicCompetencies.competencyId],
              set: { weight },
            });
        }
      }

      // Subtopics
      for (let j = 0; j < t.subtopics.length; j++) {
        const s = t.subtopics[j];
        const [subtopicRow] = await d
          .insert(subtopics)
          .values({
            topicId: topicRow.id,
            code: s.code ?? null,
            name: s.name,
            description: s.description ?? null,
            learningRequirements: s.learningRequirements ?? [],
            sortOrder: j,
          })
          .onConflictDoUpdate({
            target: [subtopics.topicId, subtopics.name],
            set: {
              code: s.code ?? null,
              description: s.description ?? null,
              learningRequirements: s.learningRequirements ?? [],
              sortOrder: j,
            },
          })
          .returning();
        summary.subtopics++;

        if (s.competencies) {
          for (const code of s.competencies) {
            const compId = competencyIdByCode.get(code);
            if (!compId) continue;
            await d
              .insert(subtopicCompetencies)
              .values({ subtopicId: subtopicRow.id, competencyId: compId })
              .onConflictDoNothing();
          }
        }
      }
    }

    // Papers + paper_topics
    for (let i = 0; i < syl.papers.length; i++) {
      const p = syl.papers[i];
      const levelId = levelIdByCode.get(p.level);
      if (!levelId) continue;
      const [paperRow] = await d
        .insert(papers)
        .values({
          syllabusId: syllabusRow.id,
          levelId,
          paperNumber: p.paperNumber,
          code: `${syl.code}/${p.paperNumber}`,
          title: p.title,
          durationMinutes: p.durationMinutes ?? null,
          marks: p.marks ?? null,
          description: p.description ?? null,
          sortOrder: i,
        })
        .onConflictDoUpdate({
          target: [papers.syllabusId, papers.paperNumber],
          set: {
            levelId,
            code: `${syl.code}/${p.paperNumber}`,
            title: p.title,
            durationMinutes: p.durationMinutes ?? null,
            marks: p.marks ?? null,
            description: p.description ?? null,
            sortOrder: i,
          },
        })
        .returning();
      summary.papers++;

      const topicNames: string[] =
        p.topicNames === "*" ? syl.topics.map((t) => t.name) : p.topicNames;
      for (const tn of topicNames) {
        const topicId = topicIdByName.get(tn);
        if (!topicId) {
          // Paper references a topic that isn't in the syllabus's topic list —
          // log but continue; ingestion stays idempotent.
          continue;
        }
        await d
          .insert(paperTopics)
          .values({ paperId: paperRow.id, topicId })
          .onConflictDoNothing();
      }
    }
  }

  return summary;
}
