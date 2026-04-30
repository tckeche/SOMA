/**
 * Service: catalogue inventory for closed-set AI prompts.
 *
 * `extractAndStoreMisconceptions` (and any future extractor that needs to
 * tag free-text against the syllabus catalogue) needs the *closed* set of
 * topics + subtopics that legitimately belong to a particular syllabus
 * code. Without this constraint the LLM hallucinates a generic math
 * taxonomy onto every subject — Phase 16 confirmed every Accounting,
 * Economics, English etc. row in the existing 3,485 examiner-misconception
 * dataset has a fabricated "Algebra"/"Calculus"/"Trigonometry" topic
 * because the prompt was open-ended.
 *
 * This module deliberately exposes a flat shape (topicId, topicTitle,
 * subtopics: { id, title }[]) instead of the richer DTOs in
 * `syllabusCatalogue.ts` because the LLM prompt only needs literals to
 * pick from, and at-insert resolution only needs ids to stamp.
 *
 * Returns an empty array when the syllabus code isn't catalogued; callers
 * MUST treat that as "fall back to the unconstrained extractor" rather
 * than blocking ingestion of syllabi that haven't been migrated to the
 * normalised catalogue yet.
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { subtopics, syllabi, topics } from "@shared/schema";

export interface AllowedSubtopic {
  id: number;
  title: string;
}

export interface AllowedTopic {
  topicId: number;
  topicTitle: string;
  subtopics: AllowedSubtopic[];
}

/**
 * List the catalogue topics + subtopics that belong to the given
 * syllabus code (e.g. "9706" → all Accounting topics). Multiple syllabus
 * rows can share a code in principle (different boards or tiers), so
 * results from every matching syllabus are merged and deduplicated by
 * topicId.
 *
 * Empty array when the code is unknown, blank, or db is unavailable.
 */
export async function listAllowedTopicsForSyllabusCode(
  syllabusCode: string | null | undefined,
): Promise<AllowedTopic[]> {
  if (!db) return [];
  const code = (syllabusCode ?? "").trim();
  if (!code) return [];

  const sylRows = await db
    .select({ id: syllabi.id })
    .from(syllabi)
    .where(eq(syllabi.syllabusCode, code));
  if (sylRows.length === 0) return [];
  const sylIds = sylRows.map((r) => r.id);

  const topicRows = await db
    .select({
      id: topics.id,
      title: topics.title,
      sortOrder: topics.sortOrder,
      topicNumber: topics.topicNumber,
    })
    .from(topics)
    .where(inArray(topics.syllabusId, sylIds))
    .orderBy(asc(topics.sortOrder), asc(topics.topicNumber));
  if (topicRows.length === 0) return [];

  const topicIds = topicRows.map((r) => r.id);
  const subRows = await db
    .select({
      id: subtopics.id,
      title: subtopics.title,
      topicId: subtopics.topicId,
      sortOrder: subtopics.sortOrder,
      subtopicNumber: subtopics.subtopicNumber,
    })
    .from(subtopics)
    .where(inArray(subtopics.topicId, topicIds))
    .orderBy(asc(subtopics.sortOrder), asc(subtopics.subtopicNumber));

  const subsByTopic = new Map<number, AllowedSubtopic[]>();
  for (const r of subRows) {
    const list = subsByTopic.get(r.topicId) ?? [];
    list.push({ id: r.id, title: r.title });
    subsByTopic.set(r.topicId, list);
  }

  // Merge by topic title across syllabi sharing the same code.
  // Two distinct topic rows that share a title (e.g. different tiers under
  // the same code) collapse into one entry; their subtopics union.
  const byTitle = new Map<string, AllowedTopic>();
  for (const t of topicRows) {
    const key = t.title.trim().toLowerCase();
    const existing = byTitle.get(key);
    const subs = subsByTopic.get(t.id) ?? [];
    if (!existing) {
      byTitle.set(key, {
        topicId: t.id,
        topicTitle: t.title,
        subtopics: dedupSubtopicsByTitle(subs),
      });
    } else {
      const merged = dedupSubtopicsByTitle([...existing.subtopics, ...subs]);
      existing.subtopics = merged;
    }
  }

  return Array.from(byTitle.values());
}

function dedupSubtopicsByTitle(subs: AllowedSubtopic[]): AllowedSubtopic[] {
  const seen = new Map<string, AllowedSubtopic>();
  for (const s of subs) {
    const key = s.title.trim().toLowerCase();
    if (!seen.has(key)) seen.set(key, s);
  }
  return Array.from(seen.values());
}

/**
 * Look up an exact (case-insensitive, trimmed) topic + optional subtopic
 * pair against an inventory loaded for some syllabus code. Returns
 * `{ topicId, subtopicId }` when both match a closed-set entry,
 * `subtopicId: null` when only the topic matches and the subtopic was
 * absent or unrecognised, or `null` when the topic itself isn't in the
 * inventory.
 *
 * Used by the extractor as a fast path: when the LLM picked from the
 * closed set we know the FK without going through `subtopicResolver`.
 */
export function lookupInInventory(
  inventory: AllowedTopic[],
  topicTitle: string | null | undefined,
  subtopicTitle: string | null | undefined,
): { topicId: number; subtopicId: number | null } | null {
  const topicKey = (topicTitle ?? "").trim().toLowerCase();
  if (!topicKey) return null;
  const topic = inventory.find((t) => t.topicTitle.trim().toLowerCase() === topicKey);
  if (!topic) return null;

  const subKey = (subtopicTitle ?? "").trim().toLowerCase();
  if (!subKey) return { topicId: topic.topicId, subtopicId: null };
  const sub = topic.subtopics.find((s) => s.title.trim().toLowerCase() === subKey);
  return { topicId: topic.topicId, subtopicId: sub?.id ?? null };
}
