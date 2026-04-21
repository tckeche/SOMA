/**
 * Phase 6 — Copilot context wiring.
 *
 * The tutor builder (Phase 5) already collects a catalogue-keyed selection:
 * examining body slug + level code + subject slug + optional topic ids. The
 * downstream copilot + SOMA pipeline previously received only free-text
 * subject/level/syllabus strings, which loses everything the catalogue knows —
 * subtopics, learning requirements, competencies, paper coverage.
 *
 * This module bridges the two: it composes the existing syllabusCatalogue
 * primitives into a single `CatalogueCopilotContext` payload, with an
 * assemble-from-DTOs pure function that the snapshot tests can exercise
 * without hitting the DB.
 *
 * Design notes:
 *
 *   * Identifiers (ids) are preserved alongside slugs/codes so adding Edexcel
 *     / AQA later is a seed-only change. The catalogue-driven callers pass
 *     ids through; the legacy free-text callers keep working because the
 *     aiPipeline context still carries the string fields.
 *
 *   * `selectedTopics` is the rich path (tutor picked specific topics).
 *     `subjectDigest` is the fallback path (no topic selected → hand the LLM
 *     a subject-level summary so it still has scoping signal).
 *
 *   * `formatCopilotContextAsText` renders the context into a prompt-friendly
 *     digest. The Maker/Checker/Polisher inject this as a USER-message block,
 *     not the system prompt, to keep cached system prompts stable.
 */
import {
  getTopicContext,
  listSubjectsForBodyLevel,
  listTopics,
  listExaminingBodies,
  listLevelsForBody,
  resolveSyllabus,
  type CompetencyWeightDto,
  type ExaminingBodyDto,
  type LevelDto,
  type PaperSummaryDto,
  type SubjectDto,
  type SubtopicContextDto,
  type SyllabusDto,
  type TopicContextDto,
  type TopicListItemDto,
} from "./syllabusCatalogue";

// ---------------------------------------------------------------------------
// Public payload shape — snapshot-friendly.
// ---------------------------------------------------------------------------

export interface CopilotBodyRef {
  id: number;
  slug: string;
  displayName: string;
}

export interface CopilotLevelRef {
  id: number;
  code: string;
  displayName: string;
}

export interface CopilotSubjectRef {
  id: number;
  slug: string;
  name: string;
}

export interface CopilotPaperRef {
  paperNumber: number;
  code: string | null;
  title: string;
  levelTier: string;
}

export interface CopilotSubtopicRef {
  subtopicNumber: string;
  title: string;
  levelTier: string;
  coreOrExtended: string | null;
}

export interface CopilotRequirementRef {
  statement: string;
  commandWord: string | null;
  notesAndExamples: string | null;
}

export interface CopilotTopicPayload {
  topic: {
    id: number;
    topicNumber: string;
    title: string;
  };
  subtopics: CopilotSubtopicRef[];
  learningRequirements: CopilotRequirementRef[];
  competencies: CompetencyWeightDto[];
  papers: CopilotPaperRef[];
}

export interface CopilotSubjectDigest {
  topics: Array<{ topicNumber: string; title: string; subtopicCount: number }>;
  papers: CopilotPaperRef[];
  competencyWeights: CompetencyWeightDto[];
}

export interface CatalogueCopilotContext {
  examiningBody: CopilotBodyRef;
  level: CopilotLevelRef;
  subject: CopilotSubjectRef;
  syllabusCode: string;
  syllabusTitle: string;
  timeLimitMinutes: number | null;
  /** Populated when the tutor picked one or more topics. */
  selectedTopics: CopilotTopicPayload[];
  /** Populated when no topic was selected (subject-level fallback). */
  subjectDigest: CopilotSubjectDigest | null;
}

// ---------------------------------------------------------------------------
// Pure assembler. Tests drive this directly with fixture DTOs.
// ---------------------------------------------------------------------------

function toPaperRef(p: PaperSummaryDto): CopilotPaperRef {
  return {
    paperNumber: p.paperNumber,
    code: p.code,
    title: p.title,
    levelTier: p.levelTier,
  };
}

function dedupePapers(papers: CopilotPaperRef[]): CopilotPaperRef[] {
  const seen = new Map<string, CopilotPaperRef>();
  for (const p of papers) {
    const key = `${p.paperNumber}::${p.code ?? ""}::${p.levelTier}`;
    if (!seen.has(key)) seen.set(key, p);
  }
  return Array.from(seen.values()).sort((a, b) => {
    if (a.levelTier !== b.levelTier) return a.levelTier.localeCompare(b.levelTier);
    return a.paperNumber - b.paperNumber;
  });
}

function dedupeCompetencies(rows: CompetencyWeightDto[]): CompetencyWeightDto[] {
  const seen = new Map<string, CompetencyWeightDto>();
  for (const row of rows) {
    const existing = seen.get(row.code);
    if (!existing || row.weight > existing.weight) seen.set(row.code, row);
  }
  return Array.from(seen.values()).sort((a, b) => b.weight - a.weight || a.code.localeCompare(b.code));
}

/**
 * Build a CopilotTopicPayload from a TopicContextDto and a level tier filter.
 *
 * `levelTierFilter` mirrors the Phase 5 rule: an A-Level syllabus has both AS
 * and A2 subtopics in one topic row; when the tutor picked level="AS" we only
 * want AS material to surface to the LLM. IGCSE passes "IGCSE" and pulls
 * everything flagged for that tier.
 */
export function buildTopicPayload(
  topicCtx: TopicContextDto,
  levelTierFilter: string | null,
  selectedSubtopicIds?: number[] | null,
): CopilotTopicPayload {
  const subsInTier = levelTierFilter
    ? topicCtx.subtopics.filter((s) => s.levelTier === levelTierFilter)
    : topicCtx.subtopics;
  const tieredSubs: SubtopicContextDto[] = subsInTier.length > 0 ? subsInTier : topicCtx.subtopics;
  // If the tutor narrowed to specific subtopics, only keep those that match.
  // Empty intersection means "no narrowing for this topic" → use the full tier.
  const subtopicFilter = (selectedSubtopicIds ?? []).filter((n) => Number.isInteger(n) && n > 0);
  const filtered = subtopicFilter.length > 0
    ? tieredSubs.filter((s) => subtopicFilter.includes(s.id))
    : tieredSubs;
  const subs: SubtopicContextDto[] = filtered.length > 0 ? filtered : tieredSubs;

  const requirements: CopilotRequirementRef[] = [];
  const requirementKeys = new Set<string>();
  const papers: CopilotPaperRef[] = [];

  for (const sub of subs) {
    for (const req of sub.requirements) {
      const key = req.statement.trim().toLowerCase();
      if (!key || requirementKeys.has(key)) continue;
      requirementKeys.add(key);
      requirements.push({
        statement: req.statement,
        commandWord: req.commandWord,
        notesAndExamples: req.notesAndExamples,
      });
    }
    for (const p of sub.papers) papers.push(toPaperRef(p));
  }
  for (const p of topicCtx.papers) {
    if (levelTierFilter && p.levelTier !== levelTierFilter) continue;
    papers.push(toPaperRef(p));
  }

  return {
    topic: {
      id: topicCtx.id,
      topicNumber: topicCtx.topicNumber,
      title: topicCtx.title,
    },
    subtopics: subs.map((s) => ({
      subtopicNumber: s.subtopicNumber,
      title: s.title,
      levelTier: s.levelTier,
      coreOrExtended: s.coreOrExtended,
    })),
    learningRequirements: requirements,
    competencies: topicCtx.competencies,
    papers: dedupePapers(papers),
  };
}

export interface AssembleCopilotContextInput {
  body: ExaminingBodyDto;
  level: LevelDto;
  subject: SubjectDto;
  syllabus: SyllabusDto;
  timeLimitMinutes?: number | null;
  topicContexts?: TopicContextDto[];
  /** When set, narrows each topic's subtopic list to these ids (preserves topics that have no match). */
  selectedSubtopicIds?: number[];
  /** Used when topicContexts is empty → subject-level digest fallback. */
  subjectTopics?: TopicListItemDto[];
}

export function assembleCopilotContext(
  input: AssembleCopilotContextInput,
): CatalogueCopilotContext {
  const tier = input.level.code;
  const topicContexts = input.topicContexts ?? [];
  const subFilter = input.selectedSubtopicIds ?? [];

  const selectedTopics = topicContexts.map((tc) => buildTopicPayload(tc, tier, subFilter));

  let subjectDigest: CopilotSubjectDigest | null = null;
  if (selectedTopics.length === 0) {
    const topicsList = input.subjectTopics ?? [];
    const allPapers: CopilotPaperRef[] = [];
    for (const t of topicsList) {
      for (const p of t.papers) allPapers.push(toPaperRef(p));
    }
    subjectDigest = {
      topics: topicsList.map((t) => ({
        topicNumber: t.topicNumber,
        title: t.title,
        subtopicCount: 0,
      })),
      papers: dedupePapers(allPapers),
      competencyWeights: [],
    };
  }

  return {
    examiningBody: {
      id: input.body.id,
      slug: input.body.slug,
      displayName: input.body.displayName,
    },
    level: {
      id: input.level.id,
      code: input.level.code,
      displayName: input.level.displayName,
    },
    subject: {
      id: input.subject.id,
      slug: input.subject.slug,
      name: input.subject.name,
    },
    syllabusCode: input.syllabus.syllabusCode,
    syllabusTitle: input.syllabus.title,
    timeLimitMinutes:
      typeof input.timeLimitMinutes === "number" && input.timeLimitMinutes > 0
        ? input.timeLimitMinutes
        : null,
    selectedTopics,
    subjectDigest,
  };
}

// ---------------------------------------------------------------------------
// DB loader. Thin composition of existing catalogue primitives.
// ---------------------------------------------------------------------------

export interface LoadCopilotContextParams {
  bodySlug: string;
  levelCode: string;
  subjectSlug: string;
  selectedTopicIds?: number[];
  selectedSubtopicIds?: number[];
  timeLimitMinutes?: number | null;
}

/**
 * Fetches the full context payload. Returns null if any of body/level/subject/
 * syllabus cannot be resolved — the caller should fall back to the legacy
 * free-text context path in that case (keeps backwards compatibility for
 * pre-Phase-5 drafts that still flow through the generator).
 */
export async function loadCopilotContext(
  params: LoadCopilotContextParams,
): Promise<CatalogueCopilotContext | null> {
  const [bodies, levels] = await Promise.all([
    listExaminingBodies(),
    listLevelsForBody(params.bodySlug),
  ]);
  const body = bodies.find((b) => b.slug === params.bodySlug);
  if (!body) return null;
  const level = levels.find((l) => l.code === params.levelCode);
  if (!level) return null;

  const [subjects, syllabus] = await Promise.all([
    listSubjectsForBodyLevel(params.bodySlug, params.levelCode),
    resolveSyllabus(params.bodySlug, params.levelCode, params.subjectSlug),
  ]);
  const subject = subjects.find((s) => s.slug === params.subjectSlug);
  if (!subject || !syllabus) return null;

  const ids = (params.selectedTopicIds ?? []).filter((n) => Number.isInteger(n) && n > 0);

  const [topicContexts, subjectTopics] = await Promise.all([
    ids.length > 0 ? getTopicContext(ids) : Promise.resolve<TopicContextDto[]>([]),
    ids.length === 0
      ? listTopics(params.bodySlug, params.levelCode, params.subjectSlug)
      : Promise.resolve<TopicListItemDto[]>([]),
  ]);

  return assembleCopilotContext({
    body,
    level,
    subject,
    syllabus,
    timeLimitMinutes: params.timeLimitMinutes ?? null,
    topicContexts,
    selectedSubtopicIds: params.selectedSubtopicIds,
    subjectTopics,
  });
}

// ---------------------------------------------------------------------------
// Prompt serialisation.
// ---------------------------------------------------------------------------

/**
 * Render the context as a compact text block that slots into a user message.
 * Kept deterministic so the payload-shape snapshot test can pin it.
 */
export function formatCopilotContextAsText(ctx: CatalogueCopilotContext): string {
  const header = [
    `Examining body: ${ctx.examiningBody.displayName} (${ctx.examiningBody.slug})`,
    `Level: ${ctx.level.displayName} (${ctx.level.code})`,
    `Subject: ${ctx.subject.name} (${ctx.subject.slug})`,
    `Syllabus: ${ctx.syllabusCode} — ${ctx.syllabusTitle}`,
  ];
  if (ctx.timeLimitMinutes) header.push(`Time limit: ${ctx.timeLimitMinutes} minutes`);

  const lines: string[] = [...header, ""];

  if (ctx.selectedTopics.length > 0) {
    lines.push(`Selected topics (${ctx.selectedTopics.length}):`);
    for (const t of ctx.selectedTopics) {
      lines.push(`  • ${t.topic.topicNumber} ${t.topic.title}`);
      if (t.subtopics.length > 0) {
        lines.push(`    Subtopics:`);
        for (const sub of t.subtopics) {
          const tier = sub.coreOrExtended ? ` [${sub.levelTier}/${sub.coreOrExtended}]` : ` [${sub.levelTier}]`;
          lines.push(`      - ${sub.subtopicNumber} ${sub.title}${tier}`);
        }
      }
      if (t.learningRequirements.length > 0) {
        lines.push(`    Learning requirements:`);
        for (const req of t.learningRequirements) {
          const cmd = req.commandWord ? `(${req.commandWord}) ` : "";
          lines.push(`      - ${cmd}${req.statement}`);
        }
      }
      if (t.competencies.length > 0) {
        const sortedComps = [...t.competencies].sort(
          (a, b) => b.weight - a.weight || a.code.localeCompare(b.code),
        );
        const comps = sortedComps
          .map((c) => `${c.code} ${c.displayName} (w=${c.weight})`)
          .join(", ");
        lines.push(`    Competencies: ${comps}`);
      }
      if (t.papers.length > 0) {
        const papers = t.papers
          .map((p) => `P${p.paperNumber}${p.code ? ` (${p.code})` : ""} [${p.levelTier}]`)
          .join(", ");
        lines.push(`    Papers: ${papers}`);
      }
    }
  } else if (ctx.subjectDigest) {
    lines.push(`Subject-level digest (no specific topic picked):`);
    lines.push(`  Topics (${ctx.subjectDigest.topics.length}):`);
    for (const t of ctx.subjectDigest.topics) {
      lines.push(`    • ${t.topicNumber} ${t.title}`);
    }
    if (ctx.subjectDigest.papers.length > 0) {
      const papers = ctx.subjectDigest.papers
        .map((p) => `P${p.paperNumber}${p.code ? ` (${p.code})` : ""} [${p.levelTier}]`)
        .join(", ");
      lines.push(`  Papers: ${papers}`);
    }
  }

  return lines.join("\n");
}
