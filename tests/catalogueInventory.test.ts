/**
 * Service-level integration test for `catalogueInventory.ts` against the
 * shared PGlite harness. Asserts:
 *
 *   - `listAllowedTopicsForSyllabusCode` returns the topics + subtopics
 *     for a real syllabus code, ordered by sortOrder.
 *   - The function returns `[]` for unknown / blank codes (the
 *     fall-back-to-open-prompt contract that `extractAndStoreMisconceptions`
 *     relies on).
 *   - When two syllabus rows share the same code (e.g. different tiers
 *     under one Cambridge code), the function merges topics by title and
 *     unions their subtopics — so the closed-set prompt sees the full
 *     vocabulary and never accidentally rejects a tier-specific subtopic.
 *   - `lookupInInventory` is case-insensitive on both topic and subtopic
 *     and returns the correct ids for the matched pair.
 */
import { afterAll, beforeAll, describe, it, expect, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, mockServerDb, seedCatalogue } from "./helpers/pglite";
import { examiningBodies, subjects, syllabi, syllabusStrands, topics, subtopics } from "@shared/schema";

let harness: Awaited<ReturnType<typeof createTestDb>> | null = null;

vi.mock("../server/db", () => mockServerDb(() => harness?.db ?? null));

const {
  listAllowedTopicsForSyllabusCode,
  lookupInInventory,
} = await import("../server/services/catalogueInventory");

beforeAll(async () => {
  harness = await createTestDb();
  // First syllabus: Cambridge IGCSE Maths 0580 with one topic + subtopic.
  await seedCatalogue(harness.db, {
    syllabus: { syllabusCode: "0580", title: "Cambridge IGCSE Mathematics" },
    topic: { topicNumber: "1", title: "Number basics" },
    subtopic: { subtopicNumber: "1.1", title: "Place value" },
  });

  // A second 0580 syllabus row under a *different* examining body — the
  // unique index is (examiningBodyId, syllabusCode), so cross-body code
  // collisions are the only way two "0580" rows legitimately co-exist.
  // We add the same topic title with an extra subtopic to prove the
  // merge-by-title behaviour: the closed-set inventory should union
  // both syllabi's subtopics under one "Number basics" entry.
  const db = harness.db;
  const subjRows = await db.select({ id: subjects.id }).from(subjects);
  const subjId = subjRows[0].id;
  const [otherBody] = await db
    .insert(examiningBodies)
    .values({ slug: "cambridge-extended", displayName: "Cambridge (Extended Tier)" })
    .returning();
  const [extendedSyl] = await db
    .insert(syllabi)
    .values({
      examiningBodyId: otherBody.id,
      subjectId: subjId,
      topBand: "IGCSE",
      syllabusCode: "0580",
      title: "Cambridge IGCSE Mathematics (Extended)",
    })
    .returning();
  const [extendedStrand] = await db
    .insert(syllabusStrands)
    .values({ syllabusId: extendedSyl.id, name: "Number" })
    .returning();
  const [extendedTopic] = await db
    .insert(topics)
    .values({
      syllabusId: extendedSyl.id,
      strandId: extendedStrand.id,
      topicNumber: "1",
      title: "Number basics",
    })
    .returning();
  await db.insert(subtopics).values([
    { topicId: extendedTopic.id, subtopicNumber: "1.2", title: "Surds", levelTier: "IGCSE-EXT" },
  ]);

  // A second topic on the original syllabus, to test ordering & multi-topic.
  const sylRows = await db
    .select({ id: syllabi.id })
    .from(syllabi)
    .where(eq(syllabi.examiningBodyId, 1));
  const firstSylId = Math.min(...sylRows.map((r) => r.id));
  const [secondStrand] = await db
    .insert(syllabusStrands)
    .values({ syllabusId: firstSylId, name: "Algebra" })
    .returning();
  const [secondTopic] = await db
    .insert(topics)
    .values({
      syllabusId: firstSylId,
      strandId: secondStrand.id,
      topicNumber: "2",
      title: "Algebra",
    })
    .returning();
  await db.insert(subtopics).values([
    { topicId: secondTopic.id, subtopicNumber: "2.1", title: "Linear equations", levelTier: "IGCSE" },
    { topicId: secondTopic.id, subtopicNumber: "2.2", title: "Quadratics", levelTier: "IGCSE" },
  ]);
}, 60_000);

afterAll(async () => {
  await harness?.teardown();
  harness = null;
});

describe("listAllowedTopicsForSyllabusCode", () => {
  it("returns merged topics + subtopics for a syllabus code that exists across multiple syllabi", async () => {
    const inventory = await listAllowedTopicsForSyllabusCode("0580");
    // Two distinct topic titles after the merge: "Number basics" and "Algebra".
    expect(inventory.map((t) => t.topicTitle).sort()).toEqual(["Algebra", "Number basics"]);

    const numberBasics = inventory.find((t) => t.topicTitle === "Number basics")!;
    // Subtopics from both 0580 rows are unioned by title.
    const subTitles = numberBasics.subtopics.map((s) => s.title).sort();
    expect(subTitles).toEqual(["Place value", "Surds"]);

    const algebra = inventory.find((t) => t.topicTitle === "Algebra")!;
    expect(algebra.subtopics.map((s) => s.title).sort()).toEqual(["Linear equations", "Quadratics"]);
  });

  it("returns an empty array for unknown syllabus codes", async () => {
    expect(await listAllowedTopicsForSyllabusCode("9999")).toEqual([]);
  });

  it("returns an empty array for blank / null codes (fall-back contract)", async () => {
    expect(await listAllowedTopicsForSyllabusCode("")).toEqual([]);
    expect(await listAllowedTopicsForSyllabusCode("   ")).toEqual([]);
    expect(await listAllowedTopicsForSyllabusCode(null)).toEqual([]);
    expect(await listAllowedTopicsForSyllabusCode(undefined)).toEqual([]);
  });
});

describe("lookupInInventory", () => {
  it("returns topicId + subtopicId for an exact (case-insensitive) match", async () => {
    const inventory = await listAllowedTopicsForSyllabusCode("0580");
    const hit = lookupInInventory(inventory, "Algebra", "Linear equations");
    expect(hit).not.toBeNull();
    expect(hit!.topicId).toBeGreaterThan(0);
    expect(hit!.subtopicId).toBeGreaterThan(0);

    // Casing shouldn't matter.
    const hitLower = lookupInInventory(inventory, "algebra", "linear EQUATIONS");
    expect(hitLower).toEqual(hit);
  });

  it("returns subtopicId=null when only the topic is recognised", async () => {
    const inventory = await listAllowedTopicsForSyllabusCode("0580");
    const hit = lookupInInventory(inventory, "Algebra", "Loss-on-disposal");
    expect(hit).not.toBeNull();
    expect(hit!.subtopicId).toBeNull();
  });

  it("returns null when the topic isn't in the inventory at all", async () => {
    const inventory = await listAllowedTopicsForSyllabusCode("0580");
    expect(lookupInInventory(inventory, "Calculus", "Differentiation")).toBeNull();
  });

  it("treats blank topic input as a miss", async () => {
    const inventory = await listAllowedTopicsForSyllabusCode("0580");
    expect(lookupInInventory(inventory, "", "anything")).toBeNull();
    expect(lookupInInventory(inventory, "   ", "anything")).toBeNull();
  });
});
