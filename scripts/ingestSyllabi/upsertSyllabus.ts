/**
 * Syllabus-level upsert: one `syllabi` row per CatalogueEntry, with the
 * associated `subjects` row created on demand.
 *
 * Idempotency: keyed on (examiningBodyId, syllabusCode). Re-running the
 * ingestion with an unchanged PDF produces a no-op — the contentHash match
 * short-circuits before the upsert.
 *
 * Papers are NOT written here. Paper extraction depends on the pattern
 * parsers (Phase 3b), because the paper list and its level tiering come
 * from the structured text rather than the filename.
 */

import { and, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "@shared/schema";
import type { CatalogueEntry } from "./catalogue";

type DB = NodePgDatabase<typeof schema>;

const { subjects, syllabi } = schema;

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export interface UpsertSyllabusResult {
  syllabusId: number;
  subjectId: number;
  /** true if the row was newly created or refreshed; false if hash matched. */
  wroteRow: boolean;
}

/**
 * Get-or-create a `subjects` row scoped to the examining body.
 */
export async function getOrCreateSubject(db: DB, examiningBodyId: number, subjectName: string): Promise<number> {
  const slug = slugify(subjectName);
  const existing = await db.select().from(subjects).where(and(
    eq(subjects.examiningBodyId, examiningBodyId),
    eq(subjects.slug, slug),
  )).limit(1);
  if (existing.length) return existing[0].id;

  const [inserted] = await db.insert(subjects).values({
    examiningBodyId,
    name: subjectName,
    slug,
  }).returning({ id: subjects.id });
  return inserted.id;
}

/**
 * Create or refresh the syllabi row for a catalogue entry.
 * - If a row exists with the same contentHash we leave it alone (idempotent).
 * - Otherwise we upsert, update the hash, and return wroteRow=true so the
 *   caller knows to re-run the content parsers.
 */
export async function upsertSyllabus(
  db: DB,
  examiningBodyId: number,
  entry: CatalogueEntry,
): Promise<UpsertSyllabusResult> {
  const subjectId = await getOrCreateSubject(db, examiningBodyId, entry.subject);

  const existing = await db.select().from(syllabi).where(and(
    eq(syllabi.examiningBodyId, examiningBodyId),
    eq(syllabi.syllabusCode, entry.syllabusCode),
  )).limit(1);

  const title = buildSyllabusTitle(entry);
  const values: schema.InsertSyllabus = {
    examiningBodyId,
    subjectId,
    topBand: entry.topBand,
    syllabusCode: entry.syllabusCode,
    title,
    yearsValidFrom: entry.yearsValidFrom,
    yearsValidTo: entry.yearsValidTo,
    sourceFile: entry.sourceFile,
    contentHash: entry.contentHash,
    successorSyllabusCode: entry.successorSyllabusCode,
    isActive: true,
  };

  if (!existing.length) {
    const [inserted] = await db.insert(syllabi).values(values).returning({ id: syllabi.id });
    return { syllabusId: inserted.id, subjectId, wroteRow: true };
  }

  const current = existing[0];
  if (current.contentHash === entry.contentHash && current.subjectId === subjectId) {
    // Fast path — same PDF and same mapping, nothing to do.
    return { syllabusId: current.id, subjectId, wroteRow: false };
  }

  await db.update(syllabi)
    .set({
      ...values,
      updatedAt: new Date(),
    })
    .where(eq(syllabi.id, current.id));

  return { syllabusId: current.id, subjectId, wroteRow: true };
}

function buildSyllabusTitle(entry: CatalogueEntry): string {
  const bandLabel = entry.topBand === "A_Level" ? "AS & A Level" : "IGCSE";
  return `Cambridge International ${bandLabel} ${entry.subject} ${entry.syllabusCode}`;
}
