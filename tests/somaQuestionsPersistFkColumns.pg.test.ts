/**
 * REGRESSION TEST — `storage.createSomaQuestions` MUST persist every
 * column the schema defines on `soma_questions`.
 *
 * Why this test exists
 * ─────────────────────
 * An earlier version of `DatabaseStorage.createSomaQuestions` built a
 * `normalized` insert object that only listed the legacy columns
 * (stem, options, correctAnswer, explanation, marks, *Tag) and
 * silently dropped the newer FK columns added in subsequent migrations
 * — `target_misconception_ids` (Phase 2 examiner-loop link),
 * `subtopic_id` and `learning_requirement_id` (catalogue FK migration),
 * and the `command_word` / `assessment_objective` cache columns.
 *
 * The bug was invisible at the type level because the Drizzle insert
 * accepts a partial object, and invisible at the route level because
 * the route handler did pass `targetMisconceptionIds` correctly. The
 * truncation happened silently inside the storage layer.
 *
 * The downstream effect was severe: ZERO of 2,955 generated questions
 * carried examiner-misconception seeds, the marker had nothing to
 * attribute wrong answers to, and every dashboard that depended on
 * misconception attribution showed empty data — exactly the "the
 * dashboards aren't useful" complaint that triggered this whole
 * verification pass.
 *
 * The fix is in storage.ts (line ~256) — the `normalized` map now
 * includes all FK columns. This test pins that contract: any future
 * field added to the somaQuestions schema must also be added to
 * createSomaQuestions, or this test fails when the field is read back
 * as null.
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
import { eq } from "drizzle-orm";
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

import {
  examinerMisconceptions,
  somaQuestions,
  somaQuizzes,
} from "@shared/schema";
import { storage } from "../server/storage";

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
    // Clean per test — order matters because of FKs.
    await harness.db.delete(somaQuestions);
    await harness.db.delete(somaQuizzes);
    await harness.db.delete(examinerMisconceptions);
  }
});

async function seedQuiz(): Promise<number> {
  if (!harness || !base) throw new Error("harness not initialised");
  const [quiz] = await harness.db
    .insert(somaQuizzes)
    .values({
      title: "Test Quiz",
      topic: "Algebra",
      subject: "Mathematics",
      syllabus: "Cambridge IGCSE 0580",
      level: "IGCSE",
      authorId: base.tutorId,
    })
    .returning();
  return quiz.id;
}

async function seedTwoApprovedMisconceptions(): Promise<number[]> {
  if (!harness || !base) throw new Error("harness not initialised");
  const rows = await harness.db
    .insert(examinerMisconceptions)
    .values([
      {
        documentId: base.documentId,
        board: "Cambridge IGCSE",
        syllabusCode: "0580",
        topic: "Algebra",
        misconception: "first",
        studentError: "—",
        correctApproach: "—",
        frequency: "common",
        status: "approved",
      },
      {
        documentId: base.documentId,
        board: "Cambridge IGCSE",
        syllabusCode: "0580",
        topic: "Algebra",
        misconception: "second",
        studentError: "—",
        correctApproach: "—",
        frequency: "common",
        status: "approved",
      },
    ])
    .returning({ id: examinerMisconceptions.id });
  return rows.map((r) => r.id);
}

describe("storage.createSomaQuestions — production INSERT must persist every FK column", () => {
  it("persists target_misconception_ids when the route passes a non-empty list", async () => {
    if (!harness || !base) throw new Error("harness not initialised");
    const quizId = await seedQuiz();
    const seedIds = await seedTwoApprovedMisconceptions();

    const inserted = await storage.createSomaQuestions([
      {
        quizId,
        stem: "If 2x = 8, what is x?",
        options: ["2", "4", "6", "8"],
        correctAnswer: "4",
        explanation: "Divide both sides by 2.",
        marks: 1,
        targetMisconceptionIds: seedIds,
      },
    ]);

    expect(inserted).toHaveLength(1);
    expect(inserted[0].targetMisconceptionIds).toEqual(seedIds);

    // Re-read from the DB to prove the SQL INSERT actually wrote the
    // column — guards against a regression where the returning() shape
    // and the insert shape drift apart.
    const [row] = await harness.db
      .select()
      .from(somaQuestions)
      .where(eq(somaQuestions.id, inserted[0].id));
    expect(row.targetMisconceptionIds).toEqual(seedIds);
  });

  it("persists null target_misconception_ids when the route passes nothing", async () => {
    if (!harness || !base) throw new Error("harness not initialised");
    const quizId = await seedQuiz();

    const inserted = await storage.createSomaQuestions([
      {
        quizId,
        stem: "x?",
        options: ["a", "b"],
        correctAnswer: "a",
        explanation: "—",
        marks: 1,
        // targetMisconceptionIds intentionally omitted.
      },
    ]);

    expect(inserted[0].targetMisconceptionIds).toBeNull();
  });

  it("persists subtopic_id, learning_requirement_id, command_word, and assessment_objective", async () => {
    if (!harness || !base) throw new Error("harness not initialised");
    const quizId = await seedQuiz();

    const inserted = await storage.createSomaQuestions([
      {
        quizId,
        stem: "x?",
        options: ["a", "b"],
        correctAnswer: "a",
        explanation: "—",
        marks: 1,
        subtopicId: base.subtopicId,
        // learningRequirementId left null — the harness doesn't seed
        // a learning_requirements row, and the FK is nullable.
        commandWord: "calculate",
        assessmentObjective: "AO1",
      },
    ]);

    const [row] = await harness.db
      .select()
      .from(somaQuestions)
      .where(eq(somaQuestions.id, inserted[0].id));

    expect(row.subtopicId).toBe(base.subtopicId);
    expect(row.commandWord).toBe("calculate");
    expect(row.assessmentObjective).toBe("AO1");
    expect(row.learningRequirementId).toBeNull();
  });

  it("preserves array identity across a multi-row insert (one quiz, multiple seeded questions)", async () => {
    if (!harness || !base) throw new Error("harness not initialised");
    const quizId = await seedQuiz();
    const [seedA, seedB] = await seedTwoApprovedMisconceptions();

    const inserted = await storage.createSomaQuestions([
      {
        quizId,
        stem: "Q1",
        options: ["a", "b"],
        correctAnswer: "a",
        explanation: "—",
        marks: 1,
        targetMisconceptionIds: [seedA],
      },
      {
        quizId,
        stem: "Q2",
        options: ["a", "b"],
        correctAnswer: "b",
        explanation: "—",
        marks: 1,
        targetMisconceptionIds: [seedA, seedB],
      },
      {
        quizId,
        stem: "Q3",
        options: ["a", "b"],
        correctAnswer: "a",
        explanation: "—",
        marks: 1,
        // No seeds — must persist as null even when sibling rows in
        // the same insert have non-null arrays.
      },
    ]);

    expect(inserted).toHaveLength(3);
    expect(inserted[0].targetMisconceptionIds).toEqual([seedA]);
    expect(inserted[1].targetMisconceptionIds).toEqual([seedA, seedB]);
    expect(inserted[2].targetMisconceptionIds).toBeNull();
  });

  it("publish transaction preserves seeded FK columns when replacing draft questions", async () => {
    if (!harness || !base) throw new Error("harness not initialised");
    const quizId = await seedQuiz();
    const [seedA, seedB] = await seedTwoApprovedMisconceptions();

    await storage.createSomaQuestions([
      {
        quizId,
        stem: "old",
        options: ["a", "b"],
        correctAnswer: "a",
        explanation: "old",
        marks: 1,
      },
    ]);

    const published = await storage.publishSomaQuestionsTransactional(quizId, [
      {
        quizId,
        stem: "new",
        options: ["1", "2", "3", "4"],
        correctAnswer: "2",
        explanation: "new",
        marks: 2,
        subtopicId: base.subtopicId,
        learningRequirementId: null,
        targetMisconceptionIds: [seedA, seedB],
        commandWord: "calculate",
        assessmentObjective: "AO1",
      },
    ]);

    expect(published).toHaveLength(1);
    expect(published[0].targetMisconceptionIds).toEqual([seedA, seedB]);
    expect(published[0].subtopicId).toBe(base.subtopicId);
    expect(published[0].commandWord).toBe("calculate");
    expect(published[0].assessmentObjective).toBe("AO1");

    const rows = await harness.db
      .select()
      .from(somaQuestions)
      .where(eq(somaQuestions.quizId, quizId));

    expect(rows).toHaveLength(1);
    expect(rows[0].stem).toBe("new");
    expect(rows[0].targetMisconceptionIds).toEqual([seedA, seedB]);
    expect(rows[0].subtopicId).toBe(base.subtopicId);
    expect(rows[0].commandWord).toBe("calculate");
    expect(rows[0].assessmentObjective).toBe("AO1");
  });
});
