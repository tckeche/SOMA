/**
 * SMOKE TESTS — examiner-insights review queue
 *
 * Guards against regressions where a SELECT in
 * `server/services/examinerInsightsReview.ts` references a column from a
 * table that hasn't been joined into the FROM/JOIN graph (e.g. selecting
 * `subtopics.title` without `.leftJoin(subtopics, …)`). That class of bug
 * only surfaces at runtime as a Postgres error, so we wire the service to
 * an in-process drizzle pg-proxy adapter whose query callback statically
 * validates every emitted SQL string for unjoined table references and
 * throws if it sees one. Tests then call the public service entry points
 * and assert no error escapes and the returned shape matches
 * `QueueListResult`.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const { sqlLog } = vi.hoisted(() => ({ sqlLog: [] as string[] }));

vi.mock("../server/db", async () => {
  const { drizzle } = await import("drizzle-orm/pg-proxy");
  const schema = await import("@shared/schema");

  const TABLE_REF_RE = /"([a-z_][a-z0-9_]*)"\."[a-z_][a-z0-9_]*"/gi;
  const FROM_JOIN_RE = /(?:\bfrom\b|\bjoin\b)\s+"([a-z_][a-z0-9_]*)"/gi;

  function assertEveryReferencedTableIsJoined(sql: string): void {
    const referenced = new Set<string>();
    for (const m of sql.matchAll(TABLE_REF_RE)) referenced.add(m[1]);
    const present = new Set<string>();
    for (const m of sql.matchAll(FROM_JOIN_RE)) present.add(m[1]);
    for (const t of referenced) {
      if (!present.has(t)) {
        throw new Error(
          `SQL references "${t}" but it is not in any FROM/JOIN clause. ` +
            `This usually means a leftJoin/innerJoin call is missing. SQL: ${sql}`,
        );
      }
    }
  }

  const db = drizzle(
    async (sql, _params, _method) => {
      sqlLog.push(sql);
      assertEveryReferencedTableIsJoined(sql);
      // listQueueForTutor needs a non-empty scope to exercise the second
      // SELECT; return one canned syllabus row for the soma_quizzes scope
      // query, empty rows for every other query (still validates SQL).
      // NB: when only one table is referenced drizzle does not qualify
      // the column (`select "syllabus" from "soma_quizzes"`), so we key
      // on the FROM clause instead of `"table"."col"`.
      const isScopeQuery = /\bfrom\s+"soma_quizzes"/i.test(sql) && /"syllabus"/i.test(sql);
      if (isScopeQuery) {
        return { rows: [["Cambridge IGCSE 0580"]] };
      }
      return { rows: [] };
    },
    { schema },
  );

  return { db, pool: null, connectDb: async () => {} };
});

import {
  listQueue,
  listQueueForTutor,
  type QueueListResult,
  type QueueRow,
} from "../server/services/examinerInsightsReview";

function assertQueueListResultShape(result: unknown): asserts result is QueueListResult {
  expect(result).toBeTypeOf("object");
  expect(result).not.toBeNull();
  const r = result as { rows: unknown; total: unknown };
  expect(Array.isArray(r.rows)).toBe(true);
  expect(typeof r.total).toBe("number");
}

beforeEach(() => {
  sqlLog.length = 0;
});

describe("examinerInsightsReview — listQueue smoke tests", () => {
  it("listQueue() with default (pending) status does not throw and returns QueueListResult shape", async () => {
    const result = await listQueue();
    assertQueueListResultShape(result);
    expect(result.rows).toEqual([]);
    expect(result.total).toBe(0);
    // Both the row select and the count select must have been issued.
    expect(sqlLog.length).toBeGreaterThanOrEqual(2);
  });

  it("listQueue({ status: 'approved' }) does not throw and returns QueueListResult shape", async () => {
    const result = await listQueue({ status: "approved" });
    assertQueueListResultShape(result);
    expect(result.rows).toEqual([]);
    expect(result.total).toBe(0);
  });

  it("emitted SELECT joins the subtopics table whenever it selects subtopics.title", async () => {
    await listQueue();
    const rowSelect = sqlLog.find(
      (s) => /"subtopics"\."title"/i.test(s) && /\bfrom\b/i.test(s),
    );
    expect(rowSelect, "expected a row SELECT containing subtopics.title").toBeDefined();
    expect(rowSelect!).toMatch(/\bjoin\s+"subtopics"/i);
    // Defensive: also ensure the other joined tables are present — these
    // are the ones whose absence would historically surface as a 500.
    expect(rowSelect!).toMatch(/\bjoin\s+"syllabus_documents"/i);
    expect(rowSelect!).toMatch(/\bjoin\s+"soma_users"/i);
  });
});

describe("examinerInsightsReview — listQueueForTutor smoke tests", () => {
  const TUTOR_ID = "00000000-0000-0000-0000-000000000001";

  it("listQueueForTutor(tutorId) with default (pending) status does not throw and returns QueueListResult shape", async () => {
    const result = await listQueueForTutor(TUTOR_ID);
    assertQueueListResultShape(result);
    expect(result.rows).toEqual([]);
    expect(result.total).toBe(0);
    // Scope query against soma_quizzes must run before the queue selects.
    expect(sqlLog[0]).toMatch(/\bfrom\s+"soma_quizzes"/i);
  });

  it("listQueueForTutor(tutorId, { status: 'approved' }) does not throw and returns QueueListResult shape", async () => {
    const result = await listQueueForTutor(TUTOR_ID, { status: "approved" });
    assertQueueListResultShape(result);
    expect(result.rows).toEqual([]);
    expect(result.total).toBe(0);
  });

  it("tutor-scoped row SELECT joins subtopics so subtopicTitle can be hydrated", async () => {
    await listQueueForTutor(TUTOR_ID);
    const rowSelect = sqlLog.find(
      (s) => /"subtopics"\."title"/i.test(s) && /\bfrom\s+"examiner_misconceptions"/i.test(s),
    );
    expect(rowSelect, "expected tutor-scoped row SELECT containing subtopics.title").toBeDefined();
    expect(rowSelect!).toMatch(/\bjoin\s+"subtopics"/i);
  });
});

describe("examinerInsightsReview — QueueRow type contract", () => {
  it("QueueRow includes a nullable subtopicTitle field (compile-time check)", () => {
    // This object is only used to assert at type-check time that the
    // QueueRow shape exposes `subtopicTitle: string | null`. If a future
    // refactor drops the field, tsc will fail this test file in CI.
    const row: QueueRow = {
      id: 1,
      status: "pending",
      board: "Cambridge IGCSE",
      syllabusCode: "0580",
      subject: null,
      topic: "Algebra",
      subtopic: null,
      subtopicId: null,
      subtopicTitle: null,
      misconception: "x",
      studentError: "y",
      correctApproach: "z",
      frequency: "rare",
      sourceQuote: null,
      sourcePage: null,
      confidencePct: null,
      reviewedAt: null,
      reviewedById: null,
      reviewedByDisplayName: null,
      reviewNotes: null,
      documentId: 1,
      documentFilename: null,
      documentType: null,
      extractedAt: new Date(0).toISOString(),
    };
    expect(row.subtopicTitle).toBeNull();
  });
});
