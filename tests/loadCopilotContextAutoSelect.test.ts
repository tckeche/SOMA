/**
 * Phase 9 — loader-level test for semantic auto-select.
 *
 * We stub the catalogue module (listExaminingBodies, listLevelsForBody, …) and
 * the DB db() handle so no real Postgres or OpenAI call is made. The point of
 * this test is to verify the *branching* inside loadCopilotContext:
 *
 *   1. when selectedTopicIds is empty and queryText is present, it calls the
 *      semanticSearch runner with the right params,
 *   2. it uses the returned topic ids as if they'd been selected,
 *   3. it attaches `autoSelectedFromQuery` metadata to the resulting context,
 *   4. it falls through to the subject-level digest when semantic search
 *      throws (missing API key, no embeddings, etc.).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ExaminingBodyDto,
  LevelDto,
  PaperSummaryDto,
  SubjectDto,
  SyllabusDto,
  TopicContextDto,
  TopicListItemDto,
} from "../server/services/syllabusCatalogue";

const cambridge: ExaminingBodyDto = { id: 1, slug: "cambridge", displayName: "Cambridge" };
const asLevel: LevelDto = { id: 10, code: "AS", displayName: "AS Level", topBand: "A-Level", sortOrder: 2 };
const mathSubject: SubjectDto = { id: 100, slug: "mathematics", name: "Mathematics" };
const syllabus9709: SyllabusDto = {
  id: 500, examiningBodyId: 1, subjectId: 100, topBand: "A-Level",
  syllabusCode: "9709", title: "Cambridge International AS & A Level Mathematics",
  yearsValidFrom: 2020, yearsValidTo: 2025,
};

const paperP1: PaperSummaryDto = { id: 900, paperNumber: 1, code: "9709/1", title: "Pure 1", levelTier: "AS", coreOrExtended: null };

const functionsTopic: TopicContextDto = {
  id: 42,
  topicNumber: "2",
  title: "Functions",
  description: null,
  levelTiers: ["AS"],
  sortOrder: 2,
  strandName: "Pure",
  subtopics: [
    {
      id: 100, subtopicNumber: "2.1", title: "Functions (domain/range)", description: null,
      levelTier: "AS", coreOrExtended: null, sortOrder: 1,
      requirements: [
        { id: 1, statement: "Define domain and range.", commandWord: "define", notesAndExamples: null, sortOrder: 1, competencies: [] },
      ],
      papers: [paperP1],
    },
  ],
  papers: [paperP1],
  competencies: [],
};

const digestTopic: TopicListItemDto = {
  id: 99, topicNumber: "10", title: "Vectors",
  description: null, levelTiers: ["AS"], sortOrder: 10, strandName: null, papers: [paperP1],
};

vi.mock("../server/services/syllabusCatalogue", () => ({
  listExaminingBodies: vi.fn(async () => [cambridge]),
  listLevelsForBody: vi.fn(async () => [asLevel]),
  listSubjectsForBodyLevel: vi.fn(async () => [mathSubject]),
  resolveSyllabus: vi.fn(async () => syllabus9709),
  getTopicContext: vi.fn(async (ids: number[]) =>
    ids.includes(42) ? [functionsTopic] : [],
  ),
  listTopics: vi.fn(async () => [digestTopic]),
}));

import { loadCopilotContext } from "../server/services/copilotContext";

describe("loadCopilotContext — Phase 9 semantic auto-select", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls semanticSearch with the tutor prompt when no topics were selected", async () => {
    const runner = vi.fn(async () => ({
      hits: [
        { topicId: 42, tier: "AS", score: 0.91, cosineScore: 0.89, keywordBoost: 0.02 },
      ],
    }));

    const ctx = await loadCopilotContext({
      bodySlug: "cambridge",
      levelCode: "AS",
      subjectSlug: "mathematics",
      queryText: "domain and range of functions",
      semanticSearch: runner,
    });

    expect(runner).toHaveBeenCalledWith(expect.objectContaining({
      bodySlug: "cambridge",
      levelCode: "AS",
      subjectSlug: "mathematics",
      queryText: "domain and range of functions",
      topK: 5,
    }));
    expect(ctx).not.toBeNull();
    expect(ctx!.selectedTopics.map((t) => t.topic.id)).toEqual([42]);
    expect(ctx!.subjectDigest).toBeNull();
    expect(ctx!.autoSelectedFromQuery).toEqual({
      queryText: "domain and range of functions",
      hits: [{ topicId: 42, score: 0.91 }],
    });
  });

  it("skips semantic search when topics were explicitly selected", async () => {
    const runner = vi.fn();
    const ctx = await loadCopilotContext({
      bodySlug: "cambridge",
      levelCode: "AS",
      subjectSlug: "mathematics",
      selectedTopicIds: [42],
      queryText: "should be ignored because topics are explicit",
      semanticSearch: runner,
    });
    expect(runner).not.toHaveBeenCalled();
    expect(ctx!.selectedTopics[0].topic.id).toBe(42);
    expect(ctx!.autoSelectedFromQuery).toBeUndefined();
  });

  it("falls through to the subject digest when semantic search throws", async () => {
    const runner = vi.fn(async () => {
      throw new Error("OPENAI_API_KEY not configured");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const ctx = await loadCopilotContext({
      bodySlug: "cambridge",
      levelCode: "AS",
      subjectSlug: "mathematics",
      queryText: "vectors in three dimensions",
      semanticSearch: runner,
    });

    expect(runner).toHaveBeenCalled();
    expect(ctx!.selectedTopics).toEqual([]);
    expect(ctx!.subjectDigest).not.toBeNull();
    expect(ctx!.subjectDigest!.topics[0]?.topicNumber).toBe("10");
    expect(ctx!.autoSelectedFromQuery).toBeUndefined();
    warn.mockRestore();
  });

  it("falls through to the subject digest when semantic search returns no hits", async () => {
    const runner = vi.fn(async () => ({ hits: [] }));
    const ctx = await loadCopilotContext({
      bodySlug: "cambridge",
      levelCode: "AS",
      subjectSlug: "mathematics",
      queryText: "obscure prompt with no matches",
      semanticSearch: runner,
    });
    expect(ctx!.selectedTopics).toEqual([]);
    expect(ctx!.subjectDigest).not.toBeNull();
    expect(ctx!.autoSelectedFromQuery).toBeUndefined();
  });

  it("does not run semantic search when queryText is empty / whitespace", async () => {
    const runner = vi.fn();
    const ctx = await loadCopilotContext({
      bodySlug: "cambridge",
      levelCode: "AS",
      subjectSlug: "mathematics",
      queryText: "   ",
      semanticSearch: runner,
    });
    expect(runner).not.toHaveBeenCalled();
    expect(ctx!.subjectDigest).not.toBeNull();
  });
});
