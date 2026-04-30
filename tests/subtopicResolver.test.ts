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

const { responseQueue, sqlLog } = vi.hoisted(() => ({
  responseQueue: [] as Array<{ rows: any[][] }>,
  sqlLog: [] as string[],
}));

vi.mock("../server/db", async () => {
  const { drizzle } = await import("drizzle-orm/pg-proxy");
  const schema = await import("@shared/schema");
  const db = drizzle(
    async (sql, _params, _method) => {
      sqlLog.push(sql);
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
