import { describe, expect, it } from "vitest";
import {
  assembleCopilotContext,
  buildTopicPayload,
  formatCopilotContextAsText,
} from "../server/services/copilotContext";
import type {
  ExaminingBodyDto,
  LevelDto,
  PaperSummaryDto,
  SubjectDto,
  SubtopicContextDto,
  SyllabusDto,
  TopicContextDto,
  TopicListItemDto,
} from "../server/services/syllabusCatalogue";

// ---------------------------------------------------------------------------
// Fixtures — mirror real Cambridge data shapes without needing a DB.
// ---------------------------------------------------------------------------

const cambridge: ExaminingBodyDto = { id: 1, slug: "cambridge", displayName: "Cambridge" };
const asLevel: LevelDto = { id: 10, code: "AS", displayName: "AS Level", topBand: "A-Level", sortOrder: 2 };
const a2Level: LevelDto = { id: 11, code: "A2", displayName: "A2 Level", topBand: "A-Level", sortOrder: 3 };
const igcseLevel: LevelDto = { id: 12, code: "IGCSE", displayName: "IGCSE", topBand: "IGCSE", sortOrder: 1 };

const mathSubject: SubjectDto = { id: 100, slug: "mathematics", name: "Mathematics" };
const physicsSubject: SubjectDto = { id: 101, slug: "physics", name: "Physics" };
const igcseMathSubject: SubjectDto = { id: 102, slug: "mathematics", name: "Mathematics" };

const syllabus9709: SyllabusDto = {
  id: 500, examiningBodyId: 1, subjectId: 100, topBand: "A-Level",
  syllabusCode: "9709", title: "Cambridge International AS & A Level Mathematics",
  yearsValidFrom: 2020, yearsValidTo: 2025,
};
const syllabus9702: SyllabusDto = {
  id: 501, examiningBodyId: 1, subjectId: 101, topBand: "A-Level",
  syllabusCode: "9702", title: "Cambridge International AS & A Level Physics",
  yearsValidFrom: 2022, yearsValidTo: 2024,
};
const syllabus0580: SyllabusDto = {
  id: 502, examiningBodyId: 1, subjectId: 102, topBand: "IGCSE",
  syllabusCode: "0580", title: "Cambridge IGCSE Mathematics",
  yearsValidFrom: 2023, yearsValidTo: 2025,
};

function makeSubtopic(partial: Partial<SubtopicContextDto> & { id: number; subtopicNumber: string; title: string; levelTier: string }): SubtopicContextDto {
  return {
    id: partial.id,
    subtopicNumber: partial.subtopicNumber,
    title: partial.title,
    description: partial.description ?? null,
    levelTier: partial.levelTier,
    coreOrExtended: partial.coreOrExtended ?? null,
    sortOrder: partial.sortOrder ?? 0,
    requirements: partial.requirements ?? [],
    papers: partial.papers ?? [],
  };
}

const paperP1: PaperSummaryDto = { id: 900, paperNumber: 1, code: "9709/1", title: "Pure Mathematics 1", levelTier: "AS", coreOrExtended: null };
const paperP3: PaperSummaryDto = { id: 901, paperNumber: 3, code: "9709/3", title: "Pure Mathematics 3", levelTier: "A2", coreOrExtended: null };

// Realistic 9709 Topic 2: Functions has AS-tier subtopics; Topic 10 (A2) has
// A2-tier subtopics. We put both under a single TopicContextDto to exercise
// the AS/A2 partitioning logic in buildTopicPayload.
const pureMathsTopicMixedTiers: TopicContextDto = {
  id: 3001,
  topicNumber: "PM",
  title: "Pure Mathematics",
  description: null,
  levelTiers: ["AS", "A2"],
  sortOrder: 1,
  strandName: "Pure",
  subtopics: [
    makeSubtopic({
      id: 4001, subtopicNumber: "2.1", title: "Functions (domain/range)", levelTier: "AS",
      requirements: [
        { id: 50, statement: "Define domain and range of a function.", commandWord: "define", notesAndExamples: null, sortOrder: 1, competencies: [] },
      ],
      papers: [paperP1],
    }),
    makeSubtopic({
      id: 4002, subtopicNumber: "10.1", title: "Differential equations", levelTier: "A2",
      requirements: [
        { id: 51, statement: "Solve first-order linear ODEs.", commandWord: "solve", notesAndExamples: null, sortOrder: 1, competencies: [] },
      ],
      papers: [paperP3],
    }),
  ],
  papers: [paperP1, paperP3],
  competencies: [
    { code: "AO1", displayName: "Knowledge and understanding", weight: 40 },
    { code: "AO2", displayName: "Application", weight: 60 },
  ],
};

// 9702 Physics mechanics topic with AS + A2 subtopics.
const physicsPaper1: PaperSummaryDto = { id: 910, paperNumber: 2, code: "9702/2", title: "AS Structured", levelTier: "AS", coreOrExtended: null };
const physicsPaper4: PaperSummaryDto = { id: 911, paperNumber: 4, code: "9702/4", title: "A Level Structured", levelTier: "A2", coreOrExtended: null };

const physicsMechanicsMixed: TopicContextDto = {
  id: 3101,
  topicNumber: "4",
  title: "Dynamics",
  description: null,
  levelTiers: ["AS", "A2"],
  sortOrder: 4,
  strandName: null,
  subtopics: [
    makeSubtopic({
      id: 4101, subtopicNumber: "4.1", title: "Newton's laws of motion", levelTier: "AS",
      requirements: [{ id: 60, statement: "State each of Newton's laws.", commandWord: "state", notesAndExamples: null, sortOrder: 1, competencies: [] }],
      papers: [physicsPaper1],
    }),
    makeSubtopic({
      id: 4102, subtopicNumber: "4.2", title: "Linear momentum", levelTier: "AS",
      requirements: [{ id: 61, statement: "Apply conservation of momentum.", commandWord: "apply", notesAndExamples: null, sortOrder: 2, competencies: [] }],
      papers: [physicsPaper1],
    }),
    makeSubtopic({
      id: 4103, subtopicNumber: "4.3", title: "Centripetal force and motion in a circle", levelTier: "A2",
      requirements: [{ id: 62, statement: "Derive expression for centripetal acceleration.", commandWord: "derive", notesAndExamples: null, sortOrder: 1, competencies: [] }],
      papers: [physicsPaper4],
    }),
  ],
  papers: [physicsPaper1, physicsPaper4],
  competencies: [],
};

// IGCSE 0580 topic — single-tier.
const igcsePaper: PaperSummaryDto = { id: 920, paperNumber: 2, code: "0580/2", title: "Non-calculator (Core)", levelTier: "IGCSE", coreOrExtended: "Core" };

const igcseAlgebra: TopicContextDto = {
  id: 3201,
  topicNumber: "2",
  title: "Algebra and graphs",
  description: "Core and extended algebra",
  levelTiers: ["IGCSE"],
  sortOrder: 2,
  strandName: "Algebra",
  subtopics: [
    makeSubtopic({
      id: 4201, subtopicNumber: "2.1", title: "Manipulation of algebraic expressions", levelTier: "IGCSE", coreOrExtended: "Core",
      requirements: [{ id: 70, statement: "Simplify linear expressions.", commandWord: "simplify", notesAndExamples: null, sortOrder: 1, competencies: [] }],
      papers: [igcsePaper],
    }),
    makeSubtopic({
      id: 4202, subtopicNumber: "2.2", title: "Quadratic equations", levelTier: "IGCSE", coreOrExtended: "Extended",
      requirements: [{ id: 71, statement: "Solve quadratic equations by factorisation and formula.", commandWord: "solve", notesAndExamples: null, sortOrder: 2, competencies: [] }],
      papers: [igcsePaper],
    }),
  ],
  papers: [igcsePaper],
  competencies: [{ code: "AO1", displayName: "Recall", weight: 50 }],
};

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

describe("buildTopicPayload — AS/A2 tier partitioning for 9709 Mathematics", () => {
  it("keeps only AS-tier subtopics when filtered by AS", () => {
    const payload = buildTopicPayload(pureMathsTopicMixedTiers, "AS");
    expect(payload.subtopics.map((s) => s.subtopicNumber)).toEqual(["2.1"]);
    expect(payload.subtopics.every((s) => s.levelTier === "AS")).toBe(true);
    expect(payload.learningRequirements.map((r) => r.statement)).toContain("Define domain and range of a function.");
    expect(payload.learningRequirements.map((r) => r.statement)).not.toContain("Solve first-order linear ODEs.");
    expect(payload.papers.map((p) => p.levelTier)).toEqual(["AS"]);
  });

  it("keeps only A2-tier subtopics when filtered by A2", () => {
    const payload = buildTopicPayload(pureMathsTopicMixedTiers, "A2");
    expect(payload.subtopics.map((s) => s.subtopicNumber)).toEqual(["10.1"]);
    expect(payload.subtopics.every((s) => s.levelTier === "A2")).toBe(true);
    expect(payload.learningRequirements.map((r) => r.statement)).toContain("Solve first-order linear ODEs.");
    expect(payload.papers.map((p) => p.levelTier)).toEqual(["A2"]);
  });
});

describe("buildTopicPayload — AS/A2 tier partitioning for 9702 Physics", () => {
  it("keeps AS mechanics (Newton + momentum) and drops A2 circular motion under AS filter", () => {
    const payload = buildTopicPayload(physicsMechanicsMixed, "AS");
    const subs = payload.subtopics.map((s) => s.subtopicNumber);
    expect(subs).toEqual(["4.1", "4.2"]);
    expect(subs).not.toContain("4.3");
    const reqs = payload.learningRequirements.map((r) => r.statement);
    expect(reqs).toContain("State each of Newton's laws.");
    expect(reqs).toContain("Apply conservation of momentum.");
    expect(reqs).not.toContain("Derive expression for centripetal acceleration.");
  });

  it("keeps only A2 circular motion under A2 filter", () => {
    const payload = buildTopicPayload(physicsMechanicsMixed, "A2");
    const subs = payload.subtopics.map((s) => s.subtopicNumber);
    expect(subs).toEqual(["4.3"]);
  });

  it("falls back to the unfiltered list when no tier matches", () => {
    // Defensive: if a topic carries zero tier-matching subtopics the filter
    // should not strip it to emptiness — the LLM still needs something.
    const payload = buildTopicPayload(physicsMechanicsMixed, "IGCSE");
    expect(payload.subtopics.length).toBe(physicsMechanicsMixed.subtopics.length);
  });
});

describe("buildTopicPayload — IGCSE 0580 topic", () => {
  it("includes both Core and Extended subtopics under the IGCSE tier", () => {
    const payload = buildTopicPayload(igcseAlgebra, "IGCSE");
    const cores = payload.subtopics.map((s) => s.coreOrExtended);
    expect(cores).toContain("Core");
    expect(cores).toContain("Extended");
    expect(payload.subtopics.every((s) => s.levelTier === "IGCSE")).toBe(true);
    expect(payload.papers[0]?.code).toBe("0580/2");
  });
});

describe("assembleCopilotContext — id-keyed references", () => {
  it("preserves body/level/subject ids alongside slugs so non-Cambridge bodies can be added by seed only", () => {
    const ctx = assembleCopilotContext({
      body: cambridge,
      level: asLevel,
      subject: mathSubject,
      syllabus: syllabus9709,
      topicContexts: [pureMathsTopicMixedTiers],
      timeLimitMinutes: 90,
    });
    expect(ctx.examiningBody).toEqual({ id: 1, slug: "cambridge", displayName: "Cambridge" });
    expect(ctx.level).toEqual({ id: 10, code: "AS", displayName: "AS Level" });
    expect(ctx.subject).toEqual({ id: 100, slug: "mathematics", name: "Mathematics" });
    expect(ctx.syllabusCode).toBe("9709");
    expect(ctx.timeLimitMinutes).toBe(90);
  });

  it("returns a subject digest when no topics were selected", () => {
    const subjectTopics: TopicListItemDto[] = [
      { id: 3201, topicNumber: "1", title: "Number", description: null, levelTiers: ["IGCSE"], sortOrder: 1, strandName: null, papers: [igcsePaper] },
      { id: 3202, topicNumber: "2", title: "Algebra and graphs", description: null, levelTiers: ["IGCSE"], sortOrder: 2, strandName: null, papers: [igcsePaper] },
    ];
    const ctx = assembleCopilotContext({
      body: cambridge,
      level: igcseLevel,
      subject: igcseMathSubject,
      syllabus: syllabus0580,
      subjectTopics,
    });
    expect(ctx.selectedTopics).toEqual([]);
    expect(ctx.subjectDigest).not.toBeNull();
    expect(ctx.subjectDigest!.topics.map((t) => t.topicNumber)).toEqual(["1", "2"]);
    expect(ctx.subjectDigest!.papers[0]?.code).toBe("0580/2");
  });
});

describe("formatCopilotContextAsText — snapshot of payload shape", () => {
  it("renders a stable AS 9709 digest", () => {
    const ctx = assembleCopilotContext({
      body: cambridge,
      level: asLevel,
      subject: mathSubject,
      syllabus: syllabus9709,
      topicContexts: [pureMathsTopicMixedTiers],
      timeLimitMinutes: 90,
    });
    const text = formatCopilotContextAsText(ctx);
    expect(text).toMatchInlineSnapshot(`
      "Examining body: Cambridge (cambridge)
      Level: AS Level (AS)
      Subject: Mathematics (mathematics)
      Syllabus: 9709 — Cambridge International AS & A Level Mathematics
      Time limit: 90 minutes

      Selected topics (1):
        • PM Pure Mathematics
          Subtopics:
            - 2.1 Functions (domain/range) [AS]
          Learning requirements:
            - (define) Define domain and range of a function.
          Competencies: AO2 Application (w=60), AO1 Knowledge and understanding (w=40)
          Papers: P1 (9709/1) [AS]"
    `);
  });

  it("renders a stable 9702 A2 physics digest", () => {
    const ctx = assembleCopilotContext({
      body: cambridge,
      level: a2Level,
      subject: physicsSubject,
      syllabus: syllabus9702,
      topicContexts: [physicsMechanicsMixed],
    });
    const text = formatCopilotContextAsText(ctx);
    expect(text).toContain("Syllabus: 9702");
    expect(text).toContain("Level: A2 Level (A2)");
    expect(text).toContain("4.3 Centripetal force and motion in a circle [A2]");
    expect(text).not.toContain("Newton's laws");
  });

  it("renders a subject digest when no topics were selected", () => {
    const subjectTopics: TopicListItemDto[] = [
      { id: 3201, topicNumber: "1", title: "Number", description: null, levelTiers: ["IGCSE"], sortOrder: 1, strandName: null, papers: [igcsePaper] },
      { id: 3202, topicNumber: "2", title: "Algebra and graphs", description: null, levelTiers: ["IGCSE"], sortOrder: 2, strandName: null, papers: [igcsePaper] },
    ];
    const ctx = assembleCopilotContext({
      body: cambridge,
      level: igcseLevel,
      subject: igcseMathSubject,
      syllabus: syllabus0580,
      subjectTopics,
    });
    const text = formatCopilotContextAsText(ctx);
    expect(text).toContain("Subject-level digest (no specific topic picked)");
    expect(text).toContain("• 1 Number");
    expect(text).toContain("• 2 Algebra and graphs");
    expect(text).toContain("P2 (0580/2) [IGCSE]");
  });

  it("renders the auto-select note when topics came from a semantic query", () => {
    // Phase 9: when topics were auto-picked by semantic search over the tutor's
    // prompt, the serialised text tells the LLM (and tutor) which topics we
    // matched so they can redirect if we got it wrong.
    const ctx = assembleCopilotContext({
      body: cambridge,
      level: asLevel,
      subject: mathSubject,
      syllabus: syllabus9709,
      topicContexts: [pureMathsTopicMixedTiers],
    });
    ctx.autoSelectedFromQuery = {
      queryText: "functions and their inverses",
      hits: [{ topicId: 3001, score: 0.834 }],
    };
    const text = formatCopilotContextAsText(ctx);
    expect(text).toContain(
      'Note: topics auto-selected from tutor prompt "functions and their inverses" → #3001 (score=0.834)',
    );
    expect(text).toContain("Selected topics (1):");
  });
});
