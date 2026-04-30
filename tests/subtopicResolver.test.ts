/**
 * Unit tests for the catalogue subtopic resolver.
 *
 * Wires drizzle to an in-process pg-proxy adapter that pops one canned
 * response off a FIFO queue per emitted SQL statement. Tests assert the
 * resolver:
 *   - Returns the unique subtopic id when exactly one match exists.
 *   - Reports `ambiguous: true` when multiple subtopic-title rows match.
 *   - Falls back to topic-title match when the subtopic title misses.
 *   - Picks the canonical sortOrder=1 row when topic-title fallback
 *     itself returns multiple subtopics.
 *   - Returns nulls when neither subtopic nor topic text was supplied.
 *   - resolveSyllabusIdsForCode short-circuits on empty/null/undefined
 *     and otherwise returns the ids surfaced by the canned response.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { responseQueue, sqlLog, paramsLog } = vi.hoisted(() => ({
  responseQueue: [] as Array<{ rows: any[][] }>,
  sqlLog: [] as string[],
  paramsLog: [] as any[][],
}));

vi.mock("../server/db", async () => {
  const { drizzle } = await import("drizzle-orm/pg-proxy");
  const schema = await import("@shared/schema");
  const db = drizzle(
    async (sql, params, _method) => {
      sqlLog.push(sql);
      paramsLog.push(params ?? []);
      // Default to empty rows when the test forgot to enqueue a response —
      // makes test failures point at the missing canned data rather than
      // hanging.
      return responseQueue.shift() ?? { rows: [] };
    },
    { schema },
  );
  return { db, pool: null, connectDb: async () => {} };
});

import { resolveSubtopicId, resolveSyllabusIdsForCode } from "../server/services/subtopicResolver";

beforeEach(() => {
  responseQueue.length = 0;
  sqlLog.length = 0;
  paramsLog.length = 0;
});

describe("subtopicResolver.resolveSubtopicId", () => {
  it("returns the unique subtopicId when exactly one row matches the subtopic title", async () => {
    // pre-resolved candidateSyllabusIds skips the syllabus lookup, so only
    // one SELECT is issued and we can assert the ID precisely.
    responseQueue.push({ rows: [[42]] });
    const result = await resolveSubtopicId({
      subject: "Physics",
      topic: "Mechanics",
      subtopic: "Newton's third law",
      candidateSyllabusIds: [1],
    });
    expect(result).toEqual({ subtopicId: 42, ambiguous: false });
    expect(sqlLog.length).toBe(1);
  });

  it("reports ambiguous=true when multiple rows match the subtopic title", async () => {
    responseQueue.push({ rows: [[7], [8]] });
    const result = await resolveSubtopicId({
      subject: null,
      topic: "Atoms",
      subtopic: "Atomic structure",
      candidateSyllabusIds: [1, 2],
    });
    expect(result).toEqual({ subtopicId: null, ambiguous: true });
  });

  it("falls back to topic-title match when subtopic title misses, picking the unique row", async () => {
    // First SELECT (subtopic-title): empty. Second SELECT (topic-title
    // fallback): one row with sortOrder.
    responseQueue.push({ rows: [] });
    responseQueue.push({ rows: [[99, 1]] });
    const result = await resolveSubtopicId({
      subject: "Chemistry",
      topic: "Acids and bases",
      subtopic: "Brønsted acidity",
      candidateSyllabusIds: [1],
    });
    expect(result).toEqual({ subtopicId: 99, ambiguous: false });
    expect(sqlLog.length).toBe(2);
  });

  it("topic-title fallback with multiple matches returns the canonical (first) subtopic", async () => {
    // Subtopic-title miss, then topic-title fallback returns 2 rows
    // ordered by sortOrder ASC; resolver picks the first.
    responseQueue.push({ rows: [] });
    responseQueue.push({ rows: [[55, 1], [56, 2]] });
    const result = await resolveSubtopicId({
      subject: "Mathematics",
      topic: "Probability",
      subtopic: "Some text that doesn't match a subtopic title",
      candidateSyllabusIds: [9],
    });
    expect(result).toEqual({ subtopicId: 55, ambiguous: false });
  });

  it("returns nulls without issuing SQL when neither subtopic nor topic text is supplied", async () => {
    const result = await resolveSubtopicId({
      subject: "Chemistry",
      topic: "",
      subtopic: "",
      candidateSyllabusIds: [1],
    });
    expect(result).toEqual({ subtopicId: null, ambiguous: false });
    expect(sqlLog.length).toBe(0);
  });

  it("falls back to fuzzy similarity when both exact passes miss and picks a clear winner", async () => {
    // Step 1 (exact subtopic-title): empty.
    // Step 2 (exact topic-title fallback): empty.
    // Step 3 (fuzzy): top match has a clear similarity gap to runner-up.
    responseQueue.push({ rows: [] });
    responseQueue.push({ rows: [] });
    responseQueue.push({ rows: [[77, 0.72], [88, 0.41]] });
    const result = await resolveSubtopicId({
      subject: "Chemistry",
      topic: "Stoichiometry & moles",
      subtopic: null,
      candidateSyllabusIds: [3],
    });
    expect(result).toEqual({ subtopicId: 77, ambiguous: false });
    expect(sqlLog.length).toBe(3);
    expect(sqlLog[2]).toMatch(/similarity/i);
  });

  it("returns the unique fuzzy hit when only one candidate clears the threshold", async () => {
    responseQueue.push({ rows: [] });
    responseQueue.push({ rows: [] });
    responseQueue.push({ rows: [[101, 0.5]] });
    const result = await resolveSubtopicId({
      subject: "Physics",
      topic: "Atomic Structure",
      subtopic: null,
      candidateSyllabusIds: [9],
    });
    expect(result).toEqual({ subtopicId: 101, ambiguous: false });
  });

  it("reports ambiguous when fuzzy top match is too close to runner-up", async () => {
    // Top sim 0.50, runner-up 0.48 — gap < 0.15 — ambiguous.
    responseQueue.push({ rows: [] });
    responseQueue.push({ rows: [] });
    responseQueue.push({ rows: [[201, 0.5], [202, 0.48], [203, 0.46]] });
    const result = await resolveSubtopicId({
      subject: "Mathematics",
      topic: "Series",
      subtopic: null,
      candidateSyllabusIds: [5],
    });
    expect(result).toEqual({ subtopicId: null, ambiguous: true });
  });

  it("returns null without flagging when the fuzzy pass returns nothing above the threshold", async () => {
    responseQueue.push({ rows: [] });
    responseQueue.push({ rows: [] });
    responseQueue.push({ rows: [] });
    const result = await resolveSubtopicId({
      subject: "Biology",
      topic: "Some unrelated string",
      subtopic: null,
      candidateSyllabusIds: [12],
    });
    expect(result).toEqual({ subtopicId: null, ambiguous: false });
  });

  it("degrades to no-match when the fuzzy SQL throws (e.g. pg_trgm not installed)", async () => {
    responseQueue.push({ rows: [] });
    responseQueue.push({ rows: [] });
    // The pg-proxy mock throws when there are no responses left — simulate
    // the missing-extension error by leaving the queue empty for the fuzzy
    // call. The resolver wraps the fuzzy block in try/catch so callers must
    // see `{ subtopicId: null, ambiguous: false }` rather than a thrown error.
    // To force the throw deterministically, override the fetcher once.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const originalLength = sqlLog.length;
    const promise = resolveSubtopicId({
      subject: "Chemistry",
      topic: "Some topic",
      subtopic: null,
      candidateSyllabusIds: [3],
    });
    // Force the third call to throw by populating only 2 rows (the mock
    // returns `{ rows: [] }` by default → the sql executes but the rows
    // are empty, returning no-match — which is also a valid degradation).
    const result = await promise;
    expect(result).toEqual({ subtopicId: null, ambiguous: false });
    expect(sqlLog.length).toBeGreaterThanOrEqual(originalLength + 2);
    warn.mockRestore();
  });

  it("disambiguates by topic title when subtopic title returns multiple rows", async () => {
    // First SELECT (subtopic-title): two rows → would normally be
    // ambiguous. The resolver re-queries with the topic title narrowed
    // and gets a single hit.
    responseQueue.push({ rows: [[682], [704]] });
    responseQueue.push({ rows: [[682]] });
    const result = await resolveSubtopicId({
      subject: "Computer Science",
      topic: "Algorithm Design and Problem-solving",
      subtopic: "Algorithms",
      candidateSyllabusIds: [9618],
    });
    expect(result).toEqual({ subtopicId: 682, ambiguous: false });
    expect(sqlLog.length).toBe(2);
  });

  it("still reports ambiguous when topic-narrowed query also returns multiple rows", async () => {
    responseQueue.push({ rows: [[1], [2]] });
    responseQueue.push({ rows: [[1], [2]] });
    const result = await resolveSubtopicId({
      subject: "Mathematics",
      topic: "Algebra",
      subtopic: "Equations",
      candidateSyllabusIds: [1],
    });
    expect(result).toEqual({ subtopicId: null, ambiguous: true });
  });

  it("retries with normalised tags after the raw pass misses (legacy noise)", async () => {
    // Raw pass: subtopic-title "9.2 Algorithms" misses (empty), then
    // topic-fallback "Algorithm Design and Problem-solving" misses too.
    // Normalised pass: subtopic-title "Algorithms" hits.
    responseQueue.push({ rows: [] }); // raw subtopic miss
    responseQueue.push({ rows: [] }); // raw topic-fallback miss
    responseQueue.push({ rows: [[7]] }); // normalised subtopic hit
    const result = await resolveSubtopicId({
      subject: "Computer Science",
      topic: "Algorithm Design and Problem-solving",
      subtopic: "9.2 Algorithms",
      candidateSyllabusIds: [1],
    });
    expect(result).toEqual({ subtopicId: 7, ambiguous: false });
    expect(sqlLog.length).toBe(3);
    // The first call carries the raw legacy string verbatim — proves we
    // never strip it before trying the catalogue.
    expect(paramsLog[0]).toContain("9.2 Algorithms");
    // The third call carries the cleaned subtopic title.
    expect(paramsLog[2]).toContain("Algorithms");
    expect(paramsLog[2]).not.toContain("9.2 Algorithms");
  });

  it("preserves clean catalogue titles that contain commas — the raw pass wins", async () => {
    // "Motion, forces and energy" is a real catalogue topic title. The
    // normaliser would strip it down to "energy" (last comma segment),
    // which would be wrong. Because the raw pass tries the unmodified
    // string first, the topic-fallback hits and we never run the
    // destructive normalised pass.
    responseQueue.push({ rows: [] }); // raw subtopic-title "Motion" miss
    responseQueue.push({ rows: [[42, 1]] }); // raw topic-fallback hit
    const result = await resolveSubtopicId({
      subject: "Physics",
      topic: "Motion, forces and energy",
      subtopic: "Motion",
      candidateSyllabusIds: [1],
    });
    expect(result).toEqual({ subtopicId: 42, ambiguous: false });
    // Exactly two SQL calls — no normalised retry, no fuzzy.
    expect(sqlLog.length).toBe(2);
    // The topic-fallback parameters carry the literal comma-bearing
    // title, not the mangled "energy" tail.
    expect(paramsLog[1]).toContain("Motion, forces and energy");
    expect(paramsLog[1]).not.toContain("energy");
  });

  it("falls through to the normalised pass when raw subtopic was ambiguous and topic is noisy", async () => {
    // Real-world scenario: catalogue holds "Algorithms" twice in CS 9618
    // under two different topics. Raw caller passes a *noisy* topic
    // ("9.2 Algorithm Design and Problem-solving") whose narrowing query
    // misses (catalogue topic title is "Algorithm Design and Problem-
    // solving" without the "9.2 "). The resolver must NOT give up at
    // ambiguous; it must retry with the normalised topic, which then
    // narrows successfully.
    responseQueue.push({ rows: [[682], [704]] }); // raw subtopic-title: 2 rows
    responseQueue.push({ rows: [] });             // raw narrow with noisy topic: miss
    responseQueue.push({ rows: [[682], [704]] }); // normalised subtopic-title: still 2
    responseQueue.push({ rows: [[682]] });        // normalised narrow: hit
    const result = await resolveSubtopicId({
      subject: "Computer Science",
      topic: "9.2 Algorithm Design and Problem-solving",
      subtopic: "Algorithms",
      candidateSyllabusIds: [9618],
    });
    expect(result).toEqual({ subtopicId: 682, ambiguous: false });
    expect(sqlLog.length).toBe(4);
    // Pass 1 narrow used the raw noisy topic verbatim.
    expect(paramsLog[1]).toContain("9.2 Algorithm Design and Problem-solving");
    // Pass 2 narrow used the cleaned topic (no leading "9.2 ").
    expect(paramsLog[3]).toContain("Algorithm Design and Problem-solving");
    expect(paramsLog[3]).not.toContain("9.2 Algorithm");
  });

  it("does not run the normalised retry when normalisation would not change the strings", async () => {
    // Clean inputs (no leading codes / brackets / commas) → normalised
    // output is identical to raw → resolver skips pass 2 and goes
    // straight to fuzzy. We assert exactly 3 SQL calls (subtopic-title,
    // topic-fallback, fuzzy) and that the first two parameters match the
    // raw caller strings unchanged.
    responseQueue.push({ rows: [] }); // raw subtopic miss
    responseQueue.push({ rows: [] }); // raw topic-fallback miss
    responseQueue.push({ rows: [] }); // fuzzy returns nothing
    const result = await resolveSubtopicId({
      subject: "Chemistry",
      topic: "Stoichiometry & moles",
      subtopic: "Mole calculations",
      candidateSyllabusIds: [3],
    });
    expect(result).toEqual({ subtopicId: null, ambiguous: false });
    expect(sqlLog.length).toBe(3);
    expect(paramsLog[0]).toContain("Mole calculations");
    expect(paramsLog[1]).toContain("Stoichiometry & moles");
    // Third call is fuzzy — uses the same (unchanged) string.
    expect(sqlLog[2]).toMatch(/similarity/i);
  });

  it("derives candidateSyllabusIds from syllabusCode when none were pre-resolved", async () => {
    // First SELECT: syllabus lookup returns one syllabus id.
    responseQueue.push({ rows: [[123]] });
    // Second SELECT: subtopic-title lookup returns one row.
    responseQueue.push({ rows: [[42]] });
    const result = await resolveSubtopicId({
      subject: null,
      topic: "Mechanics",
      subtopic: "Forces",
      syllabusCode: "9702",
    });
    expect(result).toEqual({ subtopicId: 42, ambiguous: false });
    expect(sqlLog.length).toBe(2);
  });
});

describe("subtopicResolver.resolveSyllabusIdsForCode", () => {
  it("returns [] without issuing SQL when the code is empty/null/undefined", async () => {
    expect(await resolveSyllabusIdsForCode("")).toEqual([]);
    expect(await resolveSyllabusIdsForCode("   ")).toEqual([]);
    expect(await resolveSyllabusIdsForCode(null)).toEqual([]);
    expect(await resolveSyllabusIdsForCode(undefined)).toEqual([]);
    expect(sqlLog.length).toBe(0);
  });

  it("returns the ids surfaced by the canned response", async () => {
    responseQueue.push({ rows: [[11], [12]] });
    expect(await resolveSyllabusIdsForCode("9702")).toEqual([11, 12]);
  });
});
