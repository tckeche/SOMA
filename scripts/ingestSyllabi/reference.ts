/**
 * Reference-data seed for the syllabus intelligence layer.
 *
 * Upserts the fixed rows in `examining_bodies`, `levels` and `competencies`.
 * These tables are effectively enums — they change only when the product
 * scope changes (e.g. adding Edexcel) or when competency taxonomy is
 * revised.
 *
 * Idempotent: every call is safe to re-run.
 */

import { eq, inArray } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "@shared/schema";
import { COMPETENCY_CODES } from "@shared/schema";

type DB = NodePgDatabase<typeof schema>;

const { examiningBodies, levels, competencies } = schema;

export const CAMBRIDGE_BODY_SLUG = "cambridge";

const BODIES: Array<{ slug: string; displayName: string; isActive: boolean }> = [
  { slug: CAMBRIDGE_BODY_SLUG, displayName: "Cambridge International", isActive: true },
];

/**
 * Tutor-facing levels. `topBand` groups AS and A2 under a single `A_Level`
 * syllabus row so the resolver (Phase 4) can go (body, level, subject) →
 * syllabus and then filter topics by `levelTier`.
 */
const LEVELS: Array<{ code: string; displayName: string; topBand: string; sortOrder: number }> = [
  { code: "IGCSE", displayName: "IGCSE", topBand: "IGCSE", sortOrder: 10 },
  { code: "AS", displayName: "AS", topBand: "A_Level", sortOrder: 20 },
  { code: "A2", displayName: "A2", topBand: "A_Level", sortOrder: 30 },
];

const COMPETENCY_ROWS: Array<{ code: string; displayName: string; description: string; sortOrder: number }> = [
  { code: "knowledge", displayName: "Knowledge", description: "Recalling facts, definitions, conventions.", sortOrder: 10 },
  { code: "understanding", displayName: "Understanding", description: "Explaining concepts, relationships and models.", sortOrder: 20 },
  { code: "application", displayName: "Application", description: "Applying known methods to a given situation.", sortOrder: 30 },
  { code: "calculation", displayName: "Calculation", description: "Numerical and algebraic computation.", sortOrder: 40 },
  { code: "interpretation", displayName: "Interpretation", description: "Reading meaning from data, graphs and sources.", sortOrder: 50 },
  { code: "analysis", displayName: "Analysis", description: "Breaking down problems and identifying relationships.", sortOrder: 60 },
  { code: "evaluation", displayName: "Evaluation", description: "Weighing evidence and making reasoned judgements.", sortOrder: 70 },
  { code: "problem_solving", displayName: "Problem solving", description: "Structuring and solving unfamiliar problems.", sortOrder: 80 },
  { code: "practical_skills", displayName: "Practical skills", description: "Experimental planning, data collection and technique.", sortOrder: 90 },
  { code: "communication", displayName: "Communication", description: "Clear written, diagrammatic and symbolic expression.", sortOrder: 100 },
];

export interface SeedReferenceResult {
  examiningBodyIdBySlug: Map<string, number>;
  levelIdByCode: Map<string, number>;
  competencyIdByCode: Map<string, number>;
}

/**
 * Insert or update reference rows. Uses `onConflictDoUpdate` against each
 * table's unique index so re-running is a no-op when nothing changed.
 */
export async function seedReferenceData(db: DB): Promise<SeedReferenceResult> {
  // examining_bodies
  for (const row of BODIES) {
    await db.insert(examiningBodies)
      .values(row)
      .onConflictDoUpdate({
        target: examiningBodies.slug,
        set: { displayName: row.displayName, isActive: row.isActive },
      });
  }

  // levels
  for (const row of LEVELS) {
    await db.insert(levels)
      .values(row)
      .onConflictDoUpdate({
        target: levels.code,
        set: { displayName: row.displayName, topBand: row.topBand, sortOrder: row.sortOrder },
      });
  }

  // competencies
  for (const row of COMPETENCY_ROWS) {
    await db.insert(competencies)
      .values(row)
      .onConflictDoUpdate({
        target: competencies.code,
        set: { displayName: row.displayName, description: row.description, sortOrder: row.sortOrder },
      });
  }

  // Build id lookup maps for the caller.
  const bodyRows = await db.select().from(examiningBodies)
    .where(inArray(examiningBodies.slug, BODIES.map((b) => b.slug)));
  const levelRows = await db.select().from(levels)
    .where(inArray(levels.code, LEVELS.map((l) => l.code)));
  const compRows = await db.select().from(competencies)
    .where(inArray(competencies.code, COMPETENCY_ROWS.map((c) => c.code)));

  const examiningBodyIdBySlug = new Map(bodyRows.map((r) => [r.slug, r.id]));
  const levelIdByCode = new Map(levelRows.map((r) => [r.code, r.id]));
  const competencyIdByCode = new Map(compRows.map((r) => [r.code, r.id]));

  // Sanity: every declared code must now exist.
  for (const code of COMPETENCY_CODES) {
    if (!competencyIdByCode.has(code)) {
      throw new Error(`Competency seed missing expected code: ${code}`);
    }
  }
  return { examiningBodyIdBySlug, levelIdByCode, competencyIdByCode };
}
