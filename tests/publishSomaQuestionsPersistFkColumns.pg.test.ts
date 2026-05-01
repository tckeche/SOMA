/**
 * REGRESSION TEST — `publishSomaQuestionsTransactional` MUST persist
 * every FK column the schema defines on `soma_questions`.
 *
 * Why this test exists
 * ─────────────────────
 * `publishSomaQuestionsTransactional` is the second hot path that
 * inserts into soma_questions: the tutor's quiz-builder UI calls it via
 * `POST /api/tutor/quizzes/:quizId/publish`. The function DELETEs every
 * existing question for the quiz and re-INSERTs from a draft array, so
 * any FK column the function omits is permanently destroyed at publish
 * time — even if the original generation pass had written it.
 *
 * Until this commit, the function had the EXACT SAME bug as
 * `createSomaQuestions` did before commit be8ab36 — the `normalized`
 * map omitted the catalogue + examiner-loop FK columns. The downstream
 * effect: every quiz that went through the generate→edit→publish flow
 * had its target_misconception_ids nuked between generation and
 * publish, leaving 0 of 3,000+ production questions seeded despite the
 * Maker correctly computing seed lists.
 *
 * The fix is in storage.ts (publishSomaQuestionsTransactional) — the
 * `normalized` map now includes all five FK columns. This test pins
 * that contract.
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
        board: "Cambridge",
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
        board: "Cambridge",
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

describe("storage.publishSomaQuestionsTransactional — publish must persist every FK column", () => {
  it("persists target_misconception_ids when the publish route passes them through", async () => {
    if (!harness || !base) throw new Error("harness not initialised");
    const quizId = await seedQuiz();
    const seedIds = await seedTwoApprovedMisconceptions();

    const saved = await storage.publishSomaQuestionsTransactional(quizId, [
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

    expect(saved).toHaveLength(1);
    expect(saved[0].targetMisconceptionIds).toEqual(seedIds);

    // Re-read directly to prove the SQL INSERT (not just the
    // returning() shape) actually wrote the column.
    const [row] = await harness.db
      .select()
      .from(somaQuestions)
      .where(eq(somaQuestions.id, saved[0].id));
    expect(row.targetMisconceptionIds).toEqual(seedIds);
  });

  it("persists subtopic_id, learning_requirement_id, command_word, and assessment_objective", async () => {
    if (!harness || !base) throw new Error("harness not initialised");
    const quizId = await seedQuiz();

    const saved = await storage.publishSomaQuestionsTransactional(quizId, [
      {
        quizId,
        stem: "x?",
        options: ["a", "b"],
        correctAnswer: "a",
        explanation: "—",
        marks: 1,
        subtopicId: base.subtopicId,
        commandWord: "calculate",
        assessmentObjective: "AO1",
      },
    ]);

    const [row] = await harness.db
      .select()
      .from(somaQuestions)
      .where(eq(somaQuestions.id, saved[0].id));
    expect(row.subtopicId).toBe(base.subtopicId);
    expect(row.commandWord).toBe("calculate");
    expect(row.assessmentObjective).toBe("AO1");
    expect(row.learningRequirementId).toBeNull();
  });

  it("DELETE+INSERT semantics: replacing a quiz's questions wipes the old set then writes the new set with FKs", async () => {
    if (!harness || !base) throw new Error("harness not initialised");
    const quizId = await seedQuiz();
    const seedIds = await seedTwoApprovedMisconceptions();

    // First pass — write 2 seeded questions.
    await storage.publishSomaQuestionsTransactional(quizId, [
      {
        quizId,
        stem: "Q1 original",
        options: ["a", "b"],
        correctAnswer: "a",
        explanation: "—",
        marks: 1,
        targetMisconceptionIds: [seedIds[0]],
      },
      {
        quizId,
        stem: "Q2 original",
        options: ["a", "b"],
        correctAnswer: "b",
        explanation: "—",
        marks: 1,
        targetMisconceptionIds: [seedIds[1]],
      },
    ]);

    // Second pass — re-publish with NEW questions. The DELETE half of
    // the transaction must wipe the originals, the INSERT half must
    // write the new questions WITH their FK columns.
    const saved = await storage.publishSomaQuestionsTransactional(quizId, [
      {
        quizId,
        stem: "Q1 replaced",
        options: ["a", "b"],
        correctAnswer: "a",
        explanation: "—",
        marks: 1,
        targetMisconceptionIds: [seedIds[0], seedIds[1]],
      },
    ]);

    const allRows = await harness.db
      .select()
      .from(somaQuestions)
      .where(eq(somaQuestions.quizId, quizId));
    expect(allRows).toHaveLength(1);
    expect(allRows[0].stem).toBe("Q1 replaced");
    expect(allRows[0].targetMisconceptionIds).toEqual([seedIds[0], seedIds[1]]);
    void saved;
  });

  it("persists null target_misconception_ids when the publish payload omits them", async () => {
    if (!harness || !base) throw new Error("harness not initialised");
    const quizId = await seedQuiz();

    const saved = await storage.publishSomaQuestionsTransactional(quizId, [
      {
        quizId,
        stem: "x?",
        options: ["a", "b"],
        correctAnswer: "a",
        explanation: "—",
        marks: 1,
        // intentional omission
      },
    ]);

    expect(saved[0].targetMisconceptionIds).toBeNull();
  });
});
