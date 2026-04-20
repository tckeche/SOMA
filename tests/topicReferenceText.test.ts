import { describe, expect, it } from "vitest";
import {
  buildTopicChunk,
  buildAllTopicChunks,
  type TopicChunkRefs,
} from "../server/services/topicReferenceText";
import type {
  PaperSummaryDto,
  SubtopicContextDto,
  TopicContextDto,
} from "../server/services/syllabusCatalogue";

const refs: TopicChunkRefs = {
  examiningBody: { slug: "cambridge", displayName: "Cambridge" },
  level: { code: "AS", displayName: "AS Level" },
  subject: { slug: "mathematics", name: "Mathematics" },
  syllabusCode: "9709",
  syllabusTitle: "Cambridge International AS & A Level Mathematics",
};

const paperAS: PaperSummaryDto = { id: 1, paperNumber: 1, code: "9709/1", title: "Pure 1", levelTier: "AS", coreOrExtended: null };
const paperA2: PaperSummaryDto = { id: 2, paperNumber: 3, code: "9709/3", title: "Pure 3", levelTier: "A2", coreOrExtended: null };

function sub(partial: Partial<SubtopicContextDto> & Pick<SubtopicContextDto, "id" | "subtopicNumber" | "title" | "levelTier">): SubtopicContextDto {
  return {
    description: null,
    coreOrExtended: null,
    sortOrder: 0,
    requirements: [],
    papers: [],
    ...partial,
  };
}

const mixedTiersTopic: TopicContextDto = {
  id: 42,
  topicNumber: "PM",
  title: "Pure Mathematics",
  description: null,
  levelTiers: ["AS", "A2"],
  sortOrder: 1,
  strandName: "Pure",
  subtopics: [
    sub({
      id: 101, subtopicNumber: "2.1", title: "Quadratic equations", levelTier: "AS", sortOrder: 1,
      requirements: [
        { id: 1, statement: "Solve quadratic equations by completing the square.", commandWord: "solve", notesAndExamples: null, sortOrder: 1, competencies: [] },
        { id: 2, statement: "Use the discriminant to classify roots.", commandWord: "use", notesAndExamples: "Including b²−4ac analysis", sortOrder: 2, competencies: [] },
      ],
      papers: [paperAS],
    }),
    sub({
      id: 102, subtopicNumber: "10.1", title: "Differential equations", levelTier: "A2", sortOrder: 2,
      requirements: [
        { id: 3, statement: "Solve first-order linear ODEs.", commandWord: "solve", notesAndExamples: null, sortOrder: 1, competencies: [] },
      ],
      papers: [paperA2],
    }),
  ],
  papers: [paperAS, paperA2],
  competencies: [
    { code: "AO1", displayName: "Knowledge and understanding", weight: 40 },
    { code: "AO2", displayName: "Application", weight: 60 },
  ],
};

describe("buildTopicChunk", () => {
  it("emits an AS chunk with only AS subtopics, requirements, and papers", () => {
    const chunk = buildTopicChunk({ ...refs, topic: mixedTiersTopic, tier: "AS" });
    expect(chunk).not.toBeNull();
    expect(chunk!.tier).toBe("AS");
    expect(chunk!.topicId).toBe(42);
    expect(chunk!.text).toContain("Stage: AS");
    expect(chunk!.text).toContain("2.1 Quadratic equations");
    expect(chunk!.text).not.toContain("10.1 Differential equations");
    expect(chunk!.text).toContain("Solve quadratic equations");
    expect(chunk!.text).not.toContain("first-order linear ODEs");
    expect(chunk!.text).toContain("P1 (9709/1) [AS]");
    expect(chunk!.text).not.toContain("[A2]");
    expect(chunk!.paperNumbers).toEqual([1]);
  });

  it("emits an A2 chunk mirroring the same partition for the other tier", () => {
    const chunk = buildTopicChunk({ ...refs, level: { code: "A2", displayName: "A2 Level" }, topic: mixedTiersTopic, tier: "A2" });
    expect(chunk).not.toBeNull();
    expect(chunk!.text).toContain("Stage: A2");
    expect(chunk!.text).toContain("10.1 Differential equations");
    expect(chunk!.text).not.toContain("2.1 Quadratic equations");
    expect(chunk!.paperNumbers).toEqual([3]);
  });

  it("returns null for a tier the topic doesn't cover", () => {
    const igcseOnlyTopic: TopicContextDto = { ...mixedTiersTopic, subtopics: mixedTiersTopic.subtopics.filter((s) => s.levelTier === "AS") };
    const chunk = buildTopicChunk({ ...refs, topic: igcseOnlyTopic, tier: "A2" });
    expect(chunk).toBeNull();
  });

  it("is deterministic — same inputs → same hash", () => {
    const a = buildTopicChunk({ ...refs, topic: mixedTiersTopic, tier: "AS" });
    const b = buildTopicChunk({ ...refs, topic: mixedTiersTopic, tier: "AS" });
    expect(a!.contentHash).toBe(b!.contentHash);
    expect(a!.text).toBe(b!.text);
  });

  it("hash changes when content changes", () => {
    const a = buildTopicChunk({ ...refs, topic: mixedTiersTopic, tier: "AS" });
    const mutated: TopicContextDto = {
      ...mixedTiersTopic,
      subtopics: mixedTiersTopic.subtopics.map((s) =>
        s.levelTier === "AS"
          ? { ...s, title: "Quadratic equations (revised)" }
          : s,
      ),
    };
    const b = buildTopicChunk({ ...refs, topic: mutated, tier: "AS" });
    expect(a!.contentHash).not.toBe(b!.contentHash);
  });

  it("extracts meaningful keywords (lowercased, no stopwords, no digits-only)", () => {
    const chunk = buildTopicChunk({ ...refs, topic: mixedTiersTopic, tier: "AS" });
    expect(chunk!.keywords).toContain("quadratic");
    expect(chunk!.keywords).toContain("equations");
    expect(chunk!.keywords).toContain("discriminant");
    expect(chunk!.keywords).not.toContain("the");
    expect(chunk!.keywords).not.toContain("to");
    expect(chunk!.keywords.every((k) => !/^\d+$/.test(k))).toBe(true);
    expect(chunk!.keywords.every((k) => k.length >= 3)).toBe(true);
  });

  it("dedupes papers and keeps tier-matched entries first", () => {
    const chunk = buildTopicChunk({ ...refs, topic: mixedTiersTopic, tier: "AS" });
    // Even though mixedTiersTopic has paperAS appearing via subtopic + topic,
    // the chunk should only carry it once.
    expect(chunk!.text.match(/P1 \(9709\/1\)/g)?.length).toBe(1);
  });

  it("sorts competencies by weight descending in the chunk text", () => {
    const chunk = buildTopicChunk({ ...refs, topic: mixedTiersTopic, tier: "AS" });
    const ao1Idx = chunk!.text.indexOf("AO1");
    const ao2Idx = chunk!.text.indexOf("AO2");
    expect(ao2Idx).toBeGreaterThan(-1);
    expect(ao1Idx).toBeGreaterThan(ao2Idx);
  });

  it("snapshot: full AS chunk for the mixed topic", () => {
    const chunk = buildTopicChunk({ ...refs, topic: mixedTiersTopic, tier: "AS" });
    expect(chunk!.text).toMatchInlineSnapshot(`
      "# PM Pure Mathematics

      Examining body: Cambridge (cambridge)
      Level: AS Level (AS)
      Subject: Mathematics (mathematics)
      Syllabus: 9709 — Cambridge International AS & A Level Mathematics
      Stage: AS
      Strand: Pure
      Assessed on: P1 (9709/1) [AS]
      Keywords: pure, mathematics, quadratic, equations, solve, completing, square, discriminant, classify, roots, 4ac, analysis

      ## Subtopics
      - 2.1 Quadratic equations [AS]

      ## Learning requirements
      - (solve) Solve quadratic equations by completing the square.
      - (use) Use the discriminant to classify roots.
          Notes: Including b²−4ac analysis

      ## Competencies
      - AO2 Application (weight=60)
      - AO1 Knowledge and understanding (weight=40)"
    `);
  });
});

describe("buildAllTopicChunks", () => {
  it("emits one chunk per (topic, tier) pair the topic covers", () => {
    const chunks = buildAllTopicChunks(refs, [mixedTiersTopic]);
    expect(chunks).toHaveLength(2);
    const tiers = chunks.map((c) => c.tier).sort();
    expect(tiers).toEqual(["A2", "AS"]);
  });

  it("skips topics with no content in any listed tier", () => {
    const empty: TopicContextDto = { ...mixedTiersTopic, subtopics: [], levelTiers: [] };
    const chunks = buildAllTopicChunks(refs, [empty]);
    expect(chunks).toHaveLength(0);
  });
});
