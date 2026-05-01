/**
 * INTEGRATION TESTS — `listApprovedSeeds` against PGlite.
 *
 * Pins the contract that drives the Maker's distractor seeding:
 *
 *   1. Status filter is non-negotiable: pending and rejected rows
 *      MUST NEVER reach a generated question.
 *   2. When `subtopicIds` is non-empty, only those subtopics are
 *      considered.
 *   3. When `subtopicIds` is empty but `syllabusCode` is present,
 *      the code alone is sufficient — board-label drift between
 *      writes ("Cambridge" vs "Cambridge IGCSE" vs "Cambridge
 *      Syllabus ·") MUST NOT cause silent zero-result queries.
 *      This was the production bug discovered by
 *      scripts/diagnoseQuizSyllabusVsSeeds.ts: every recent quiz
 *      stored syllabus = "Cambridge Syllabus · 0580", the parser
 *      left board = "Cambridge Syllabus ·" with a middle-dot, and
 *      the misconceptions stored board = "Cambridge". The strict
 *      board AND syllabusCode filter found nothing, so the Maker's
 *      seed pool came back empty even though 736 approved seeds
 *      existed for code 0580.
 *   4. When `syllabusCode` is missing but `board` is present, fall
 *      back to the board filter (rare path, used for catch-alls).
 *   5. Frequency ranking (very_common > common > occasional) and
 *      confidence tie-break stay intact regardless of which filter
 *      branch fired.
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";
import {
  createTestDb,
  mockServerDb,
  setupBaseFixtures,
  type BaseFixtureIds,
  type TestDbHarness,
} from "./helpers/examinerInsightsReviewPgHarness";

let harness: TestDbHarness | null = null;
let base: BaseFixtureIds | null = null;

vi.mock("../server/db", () => mockServerDb(() => harness?.db ?? null));

import { examinerMisconceptions } from "@shared/schema";
import { listApprovedSeeds } from "../server/services/examinerDistractorSeeds";

beforeAll(async () => {
  harness = await createTestDb();
  base = await setupBaseFixtures(harness.db);
}, 60_000);

afterAll(async () => {
  await harness?.teardown();
  harness = null;
  base = null;
});

beforeEach(async () => {
  if (harness) {
    await harness.db.delete(examinerMisconceptions);
  }
});

interface SeedRowOverrides {
  status?: "pending" | "approved" | "rejected";
  board?: string;
  syllabusCode?: string;
  topic?: string;
  subtopic?: string | null;
  subtopicId?: number | null;
  misconception?: string;
  frequency?: "very_common" | "common" | "occasional";
  confidence?: number | null;
}

async function insertSeed(overrides: SeedRowOverrides = {}): Promise<number> {
  if (!harness || !base) throw new Error("harness not initialised");
  const [row] = await harness.db
    .insert(examinerMisconceptions)
    .values({
      documentId: base.documentId,
      board: overrides.board ?? "Cambridge",
      syllabusCode: overrides.syllabusCode ?? "0580",
      topic: overrides.topic ?? "Algebra",
      subtopic: overrides.subtopic ?? null,
      subtopicId: overrides.subtopicId === undefined ? base.subtopicId : overrides.subtopicId,
      misconception: overrides.misconception ?? "default",
      studentError: "—",
      correctApproach: "—",
      frequency: overrides.frequency ?? "common",
      status: overrides.status ?? "approved",
      confidence: overrides.confidence ?? 70,
    })
    .returning({ id: examinerMisconceptions.id });
  return row.id;
}

describe("listApprovedSeeds — non-negotiable status filter", () => {
  it("returns only approved rows; pending and rejected MUST NEVER reach the Maker", async () => {
    if (!base) throw new Error("base not initialised");
    const approvedId = await insertSeed({ status: "approved", misconception: "ok" });
    await insertSeed({ status: "pending", misconception: "draft" });
    await insertSeed({ status: "rejected", misconception: "no" });

    const seeds = await listApprovedSeeds({ subtopicIds: [base.subtopicId] });

    expect(seeds.map((s) => s.id)).toEqual([approvedId]);
  });
});

describe("listApprovedSeeds — subtopic-id branch", () => {
  it("filters to the requested subtopicIds when supplied", async () => {
    if (!base) throw new Error("base not initialised");
    const matching = await insertSeed({ subtopicId: base.subtopicId, misconception: "match" });
    await insertSeed({ subtopicId: null, misconception: "unlinked" });

    const seeds = await listApprovedSeeds({ subtopicIds: [base.subtopicId] });
    expect(seeds.map((s) => s.id)).toEqual([matching]);
  });

  it("ignores empty subtopicId arrays and falls through to scope filters", async () => {
    if (!base) throw new Error("base not initialised");
    const id = await insertSeed({
      board: "Cambridge",
      syllabusCode: "0580",
      subtopicId: null,
    });

    const seeds = await listApprovedSeeds({
      subtopicIds: [], // empty — should fall through to syllabusCode
      syllabusCode: "0580",
    });
    expect(seeds.map((s) => s.id)).toEqual([id]);
  });
});

describe("listApprovedSeeds — syllabusCode is the source of truth", () => {
  it("matches when syllabusCode is present, regardless of board label drift", async () => {
    // Three rows on the SAME syllabus code but stored with three
    // different board strings — these all appeared in the production
    // data audit before the fix.
    const ids = await Promise.all([
      insertSeed({ board: "Cambridge", syllabusCode: "0580", misconception: "a", subtopicId: null }),
      insertSeed({ board: "Cambridge IGCSE", syllabusCode: "0580", misconception: "b", subtopicId: null }),
      insertSeed({ board: "Cambridge Syllabus ·", syllabusCode: "0580", misconception: "c", subtopicId: null }),
    ]);

    // Caller passes a board that matches NONE of the three stored
    // values. The pre-fix code would have AND'd this in and returned [].
    const seeds = await listApprovedSeeds({
      board: "Some Other Cambridge Variant",
      syllabusCode: "0580",
    });

    // All three approved rows on syllabus 0580 must come back —
    // the board label is ignored in favour of the unique code.
    expect(seeds.map((s) => s.id).sort()).toEqual(ids.sort());
  });

  it("isolates per syllabusCode — codes are unique enough that board does not matter", async () => {
    const want = await insertSeed({ board: "Cambridge", syllabusCode: "0580", misconception: "want", subtopicId: null });
    await insertSeed({ board: "Cambridge", syllabusCode: "9709", misconception: "other", subtopicId: null });

    const seeds = await listApprovedSeeds({ syllabusCode: "0580" });
    expect(seeds.map((s) => s.id)).toEqual([want]);
  });
});

describe("listApprovedSeeds — board-only fallback", () => {
  it("uses the board filter only when syllabusCode is missing AND no subtopicIds were given", async () => {
    const want = await insertSeed({ board: "Cambridge", syllabusCode: "0580", misconception: "want", subtopicId: null });
    await insertSeed({ board: "Edexcel", syllabusCode: "0580", misconception: "other-board", subtopicId: null });

    const seeds = await listApprovedSeeds({ board: "Cambridge" });
    expect(seeds.map((s) => s.id)).toEqual([want]);
  });
});

describe("listApprovedSeeds — frequency ranking is preserved across all branches", () => {
  it("ranks very_common > common > occasional, with confidence as tie-break", async () => {
    const occasional = await insertSeed({ frequency: "occasional", confidence: 99, subtopicId: null });
    const commonHi = await insertSeed({ frequency: "common", confidence: 70, subtopicId: null });
    const commonLo = await insertSeed({ frequency: "common", confidence: 50, subtopicId: null });
    const veryCommon = await insertSeed({ frequency: "very_common", confidence: 60, subtopicId: null });

    const seeds = await listApprovedSeeds({ syllabusCode: "0580", limit: 4 });

    // very_common first (regardless of confidence rank within tier),
    // then common (higher confidence first), then occasional.
    expect(seeds.map((s) => s.id)).toEqual([veryCommon, commonHi, commonLo, occasional]);
  });
});
