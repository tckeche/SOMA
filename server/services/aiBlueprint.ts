/**
 * SOMA — Question blueprint planner (Stage 0 of the generation pipeline).
 *
 * The maker used to improvise: it received the topic, syllabus context and a
 * pile of examiner-misconception seeds, and was told "use at least one
 * distractor per question from the seeds." That conflated two different
 * pedagogical goals into every question and left no traceable record of why a
 * given question was asked.
 *
 * The planner separates intent from execution. Before any maker call, we
 * generate a structured plan of N rows — one per question — that says:
 *
 *   - role: is this a SYLLABUS_COVERAGE question (testing a learning
 *     requirement straight from the catalogue) or a MISCONCEPTION_PROBE
 *     (deliberately set up to surface a known examiner-flagged error)?
 *   - learningRequirement / subtopicLabel: which catalogue node grounds this
 *     question. Verbatim from the syllabus so the maker cannot drift.
 *   - commandWord / assessmentObjective: the cognitive level the syllabus
 *     expects (Recall / Apply / Analyse...).
 *   - targetMisconceptionId: when role=MISCONCEPTION_PROBE, the specific
 *     approved seed the question must reproduce. NULL for coverage rows.
 *   - difficulty: easy / medium / hard, matching the requested distribution.
 *   - intent: a single sentence stating what student behaviour the question
 *     is designed to elicit.
 *
 * The plan is then handed to the maker as part of its user prompt. Each
 * generated question is paired 1:1 with a plan row, so when the marker later
 * sees a wrong answer it can attribute it back to (a) the learning
 * requirement and (b) the specific misconception the distractor was probing.
 *
 * Allocation rules: the SOMA purposes (revision, struggling_areas,
 * stretch_strengths, general) shift the coverage / probe ratio because their
 * pedagogical goal is different. Defaults in `allocateRolesByPurpose` below.
 */
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { callGoogle } from "./aiOrchestrator";
import { recordCall, newRequestId } from "../utils/aiTelemetry";
import * as health from "./aiHealth";
import { clampMaxTokens } from "./aiCostGuards";
import { describePrompt, registerPrompt } from "./aiPromptRegistry";
import { validateAgainstSchema } from "./aiContracts";
import {
  formatCopilotContextAsText,
  type CatalogueCopilotContext,
} from "./copilotContext";
import { renderSeedsForPrompt, type ExaminerSeed } from "./examinerDistractorSeeds";

// ─── Public types ──────────────────────────────────────────────────────────

export type BlueprintRole = "syllabus_coverage" | "misconception_probe";

export const BlueprintRowSchema = z.object({
  questionIndex: z.number().int().min(1),
  role: z.enum(["syllabus_coverage", "misconception_probe"]),
  /** Catalogue subtopic label, e.g. "1.1.1 Natural numbers and integers". Empty string when no catalogue context. */
  subtopicLabel: z.string(),
  /** Verbatim learning requirement statement from the catalogue. Empty string when none available. */
  learningRequirement: z.string(),
  /** Cognitive command word from the syllabus when known (Recall / Apply / Analyse / ...). */
  commandWord: z.string().nullable(),
  /** Approved examiner-misconception seed id this question must probe. NULL for coverage rows. */
  targetMisconceptionId: z.number().int().nullable(),
  difficulty: z.enum(["easy", "medium", "hard"]),
  /** One-sentence rationale stating what behaviour the question elicits. */
  intent: z.string().min(1),
});

export const BlueprintSchema = z.object({
  rows: z.array(BlueprintRowSchema).min(1),
});

export type BlueprintRow = z.infer<typeof BlueprintRowSchema>;
export type Blueprint = z.infer<typeof BlueprintSchema>;

export type GenerationPurpose =
  | "revision"
  | "struggling_areas"
  | "stretch_strengths"
  | "general";

export interface BlueprintAllocation {
  coverage: number;
  probe: number;
}

export interface BlueprintInput {
  questionCount: number;
  purpose: GenerationPurpose;
  difficultyDistribution: { easy: number; medium: number; hard: number };
  catalogueContext?: CatalogueCopilotContext;
  examinerSeeds?: ExaminerSeed[];
  topic: string;
  subtopic?: string;
  subject: string;
  syllabus: string;
  level: string;
  tutorPrompt?: string;
}

// ─── Allocation rules ──────────────────────────────────────────────────────

/**
 * Decide how many of the N questions should test syllabus coverage vs probe a
 * known misconception, based on the assignment purpose. Tunable per purpose
 * because the pedagogical goal is different in each case:
 *
 *   - revision: broad sweep of the syllabus, with some misconception probes
 *     to keep the student honest. 70/30.
 *   - struggling_areas: the student is weak here. We want to surface their
 *     specific misconceptions, so probes dominate. 35/65.
 *   - stretch_strengths: student is strong; test depth on the syllabus, fewer
 *     probes (they've moved past the common errors). 80/20.
 *   - general: balanced default. 65/35.
 *
 * If there are zero examiner seeds available, probe count clamps to 0 and
 * everything falls through to coverage — we cannot probe what we don't have
 * an approved misconception for.
 */
export function allocateRolesByPurpose(
  questionCount: number,
  purpose: GenerationPurpose,
  hasSeeds: boolean,
): BlueprintAllocation {
  if (!hasSeeds || questionCount <= 0) {
    return { coverage: questionCount, probe: 0 };
  }
  const ratios: Record<GenerationPurpose, { coverage: number; probe: number }> = {
    revision: { coverage: 0.70, probe: 0.30 },
    struggling_areas: { coverage: 0.35, probe: 0.65 },
    stretch_strengths: { coverage: 0.80, probe: 0.20 },
    general: { coverage: 0.65, probe: 0.35 },
  };
  const r = ratios[purpose];
  // Round probe up so we always exercise the misconception loop on small
  // batches (e.g. 4-question quiz with struggling_areas → probe=3, not 2).
  const probe = Math.min(questionCount, Math.max(1, Math.ceil(questionCount * r.probe)));
  return { coverage: questionCount - probe, probe };
}

/**
 * Convert the percentage-based difficulty distribution into a concrete count
 * per bucket, summing exactly to questionCount.
 */
export function distributeDifficulty(
  questionCount: number,
  pct: { easy: number; medium: number; hard: number },
): { easy: number; medium: number; hard: number } {
  const total = Math.max(1, pct.easy + pct.medium + pct.hard);
  const easy = Math.round((pct.easy / total) * questionCount);
  const hard = Math.round((pct.hard / total) * questionCount);
  const medium = Math.max(0, questionCount - easy - hard);
  return { easy, medium, hard };
}

/**
 * Detect the assignment purpose from the legacy free-text copilotPrompt that
 * tutor copilot still emits, so existing callers get the planner without
 * needing a route change. Looks for "Purpose: <slug>" patterns first.
 */
export function inferPurposeFromPrompt(prompt: string | undefined): GenerationPurpose {
  if (!prompt) return "general";
  const match = prompt.match(/purpose\s*[:=]\s*([a-z_]+)/i);
  const slug = match?.[1]?.toLowerCase();
  if (slug === "revision" || slug === "struggling_areas" || slug === "stretch_strengths") {
    return slug;
  }
  return "general";
}

// ─── Catalogue summary for the planner prompt ──────────────────────────────

/**
 * Build a flat list of (subtopicLabel, learningRequirement, commandWord)
 * options the planner can pick from. The planner uses these verbatim so the
 * maker cannot drift off-syllabus.
 */
export interface CatalogueAnchor {
  subtopicLabel: string;
  learningRequirement: string;
  commandWord: string | null;
}

export function flattenCatalogueAnchors(ctx: CatalogueCopilotContext | undefined): CatalogueAnchor[] {
  if (!ctx) return [];
  const out: CatalogueAnchor[] = [];
  for (const t of ctx.selectedTopics) {
    for (const sub of t.subtopics) {
      const subLabel = `${sub.subtopicNumber} ${sub.title}`;
      // Pull learning requirements from the topic-level list (already
      // deduped by buildTopicPayload), tagging each with this subtopic's
      // label so the planner sees the syllabus structure.
      if (t.learningRequirements.length === 0) {
        out.push({ subtopicLabel: subLabel, learningRequirement: t.topic.title, commandWord: null });
        continue;
      }
      for (const req of t.learningRequirements) {
        out.push({
          subtopicLabel: subLabel,
          learningRequirement: req.statement,
          commandWord: req.commandWord,
        });
      }
    }
    if (t.subtopics.length === 0) {
      const topicLabel = `${t.topic.topicNumber} ${t.topic.title}`;
      for (const req of t.learningRequirements) {
        out.push({
          subtopicLabel: topicLabel,
          learningRequirement: req.statement,
          commandWord: req.commandWord,
        });
      }
    }
  }
  return out;
}

// ─── Prompt construction ───────────────────────────────────────────────────

const PLANNER_PROMPT_ID = "soma.blueprint";
registerPrompt(PLANNER_PROMPT_ID, "v1", "SOMA blueprint planner — per-question intent grid", "planning");

function buildPlannerSystemPrompt(): string {
  return `You are the SOMA blueprint planner. Before any question is written, you produce the intent grid that the maker will follow exactly.

Your output is a list of plan rows, one per question. Each row tells the maker:
  - role: "syllabus_coverage" or "misconception_probe"
  - subtopicLabel: copy verbatim from the catalogue list provided
  - learningRequirement: copy verbatim from the catalogue list provided
  - commandWord: copy from the catalogue when present, else null
  - targetMisconceptionId: when role="misconception_probe", the id of the approved misconception the question must reproduce; null for coverage rows
  - difficulty: matches the requested mix
  - intent: one sentence stating what student behaviour this question elicits

Rules:
  - Coverage rows must be drawn from the supplied catalogue anchors. Do not invent learning requirements.
  - Probe rows must each cite a real misconception id from the supplied list. If the misconception list is empty, do not produce probe rows.
  - Spread coverage rows across as many distinct subtopics / learning requirements as possible — do not pile every question onto one anchor.
  - Probe rows should prefer higher-frequency misconceptions first.
  - Difficulty counts must sum to exactly the requested mix.
  - Total rows must equal the requested questionCount.

Return strictly the JSON object. No prose.`;
}

function renderCatalogueAnchorsForPrompt(anchors: CatalogueAnchor[]): string {
  if (anchors.length === 0) {
    return "Catalogue anchors: none. Use the topic and syllabus name to ground each row.";
  }
  const lines = anchors.map((a, i) => {
    const cmd = a.commandWord ? `[${a.commandWord}] ` : "";
    return `${i + 1}. ${a.subtopicLabel} — ${cmd}${a.learningRequirement}`;
  });
  return ["Catalogue anchors (use these verbatim for coverage rows):", ...lines].join("\n");
}

function renderSeedListForPlanner(seeds: ExaminerSeed[] | undefined): string {
  if (!seeds || seeds.length === 0) return "Approved misconception seeds: none.";
  const lines = seeds.map(
    (s) => `id=${s.id} (${s.frequency}): ${s.misconception} | typical error: ${s.studentError || "—"}`,
  );
  return ["Approved misconception seeds (cite ids verbatim for probe rows):", ...lines].join("\n");
}

export function buildPlannerUserPrompt(input: BlueprintInput, allocation: BlueprintAllocation, difficulty: { easy: number; medium: number; hard: number }, anchors: CatalogueAnchor[]): string {
  const blocks: string[] = [];
  blocks.push(
    `Subject: ${input.subject} | Syllabus: ${input.syllabus} | Level: ${input.level}`,
    `Primary topic: ${input.topic}${input.subtopic ? ` (subtopic focus: ${input.subtopic})` : ""}`,
    `Purpose: ${input.purpose}`,
    `Question count: ${input.questionCount}`,
    `Allocation target: ${allocation.coverage} syllabus_coverage rows, ${allocation.probe} misconception_probe rows`,
    `Difficulty target counts: easy=${difficulty.easy}, medium=${difficulty.medium}, hard=${difficulty.hard}`,
  );
  if (input.tutorPrompt) {
    blocks.push("", `Tutor's free-text guidance: ${input.tutorPrompt.slice(0, 500)}`);
  }
  if (input.catalogueContext) {
    blocks.push("", "Catalogue context (full):", formatCopilotContextAsText(input.catalogueContext));
  }
  blocks.push("", renderCatalogueAnchorsForPrompt(anchors));
  blocks.push("", renderSeedListForPlanner(input.examinerSeeds));
  blocks.push(
    "",
    `Now produce ${input.questionCount} plan rows that satisfy the allocation, difficulty mix, and rules.`,
  );
  return blocks.join("\n");
}

// ─── Planner execution ─────────────────────────────────────────────────────

/**
 * Run the planner LLM call. Tries OpenAI gpt-4o-mini first (cheap, fast,
 * structured-JSON), falls back to Gemini flash, then Claude Haiku.
 *
 * Returns null if every provider fails — callers treat this as "skip planner,
 * use the legacy improvised path" rather than failing the whole generation.
 */
export async function runBlueprintPlanner(
  input: BlueprintInput,
): Promise<Blueprint | null> {
  if (input.questionCount <= 0) return null;

  const hasSeeds = (input.examinerSeeds?.length ?? 0) > 0;
  const allocation = allocateRolesByPurpose(input.questionCount, input.purpose, hasSeeds);
  const difficulty = distributeDifficulty(input.questionCount, input.difficultyDistribution);
  const anchors = flattenCatalogueAnchors(input.catalogueContext);

  // No catalogue anchors AND no seeds → nothing for the planner to ground on.
  // Skip planner; the legacy maker prompt will still receive the same context.
  if (anchors.length === 0 && !hasSeeds) return null;

  const systemPrompt = buildPlannerSystemPrompt();
  const userPrompt = buildPlannerUserPrompt(input, allocation, difficulty, anchors);

  // Try providers in order of cost. Each provider returns parsed Blueprint or
  // throws; we catch and fall through.
  const attempts = [
    { name: "openai", model: "gpt-4o-mini", run: () => callOpenAIPlanner(systemPrompt, userPrompt) },
    { name: "google", model: "gemini-2.5-flash", run: () => callGooglePlanner(systemPrompt, userPrompt) },
    { name: "anthropic", model: "claude-haiku-4-5-20251001", run: () => callClaudePlanner(systemPrompt, userPrompt) },
  ] as const;

  for (const attempt of attempts) {
    const startedAt = Date.now();
    const requestId = newRequestId();
    try {
      const blueprint = await attempt.run();
      const finalised = enforceAllocation(blueprint, input, allocation, difficulty);
      health.recordSuccess(attempt.name, attempt.model, Date.now() - startedAt);
      recordCall({
        requestId,
        provider: attempt.name,
        model: attempt.model,
        taskType: "planning",
        promptVersion: describePrompt(PLANNER_PROMPT_ID)?.version,
        systemPrompt,
        userPrompt,
        startedAt,
        endedAt: Date.now(),
        rawResponse: JSON.stringify(finalised),
        parse: { status: "success" },
        validation: { status: "pass" },
      });
      return finalised;
    } catch (err: any) {
      health.recordFailure(attempt.name, attempt.model, "other");
      recordCall({
        requestId,
        provider: attempt.name,
        model: attempt.model,
        taskType: "planning",
        promptVersion: describePrompt(PLANNER_PROMPT_ID)?.version,
        systemPrompt,
        userPrompt,
        startedAt,
        endedAt: Date.now(),
        parse: { status: "failure", error: err?.message || String(err) },
        validation: { status: "fail", reason: err?.message || String(err) },
        error: err?.message || String(err),
      });
      // Try next provider.
    }
  }
  return null;
}

async function callOpenAIPlanner(systemPrompt: string, userPrompt: string): Promise<Blueprint> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not configured");
  const client = new OpenAI({ apiKey });
  const completion = await client.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0,
    response_format: { type: "json_object" },
    max_tokens: clampMaxTokens(2048, "planning"),
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    // The planner is a small, fast call — fail at 30s so the fallback
    // planner (or the legacy no-plan path) runs instead of stalling.
  }, { timeout: 30_000 });
  const raw = completion.choices[0]?.message?.content || "";
  const validated = validateAgainstSchema(raw, BlueprintSchema);
  if (!validated.ok) throw new Error(`Planner schema gate failed (openai): ${validated.reason}`);
  return validated.value;
}

async function callGooglePlanner(systemPrompt: string, userPrompt: string): Promise<Blueprint> {
  const schema = zodToJsonSchema(BlueprintSchema, "Blueprint");
  const raw = await callGoogle("gemini-2.5-flash", systemPrompt, userPrompt, schema);
  const validated = validateAgainstSchema(raw, BlueprintSchema);
  if (!validated.ok) throw new Error(`Planner schema gate failed (gemini): ${validated.reason}`);
  return validated.value;
}

async function callClaudePlanner(systemPrompt: string, userPrompt: string): Promise<Blueprint> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not configured");
  const anthropic = new Anthropic({ apiKey });
  const wrapped: any = zodToJsonSchema(BlueprintSchema, "Blueprint");
  const inner: any = wrapped?.definitions?.Blueprint ?? zodToJsonSchema(BlueprintSchema);
  const inputSchema: any = { ...inner, type: inner?.type || "object" };
  delete inputSchema.$schema;
  delete inputSchema.$ref;
  const response = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: clampMaxTokens(2048, "planning"),
    temperature: 0,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
    tools: [
      {
        name: "return_blueprint",
        description: "Return the SOMA blueprint plan rows.",
        input_schema: inputSchema,
      },
    ],
    tool_choice: { type: "tool", name: "return_blueprint" },
  }, { timeout: 30_000 });
  const toolBlock = response.content.find((b: any) => b.type === "tool_use");
  if (!toolBlock || toolBlock.type !== "tool_use") {
    throw new Error("Claude planner returned no tool output");
  }
  const validated = validateAgainstSchema((toolBlock as any).input, BlueprintSchema, { repair: false });
  if (!validated.ok) throw new Error(`Planner schema gate failed (claude): ${validated.reason}`);
  return validated.value;
}

// ─── Post-processing: deterministic correction of LLM allocation drift ─────

/**
 * Even with explicit instructions, the LLM occasionally returns the wrong
 * count of probe rows or assigns a probe row a misconception id that isn't on
 * the approved list. We patch deterministically rather than re-prompting:
 *
 *   1. Trim or pad rows to exactly questionCount.
 *   2. For probe rows, drop targetMisconceptionId if it's not in the seed
 *      list; if a probe row ends up without a valid id, demote it to coverage.
 *   3. If we have fewer probes than allocated and there are unused seeds,
 *      promote the lowest-priority coverage rows into probes using the seeds.
 *   4. Re-number questionIndex sequentially.
 *
 * This makes the planner's output safe even when it drifts, without needing
 * a retry loop.
 */
export function enforceAllocation(
  blueprint: Blueprint,
  input: BlueprintInput,
  allocation: BlueprintAllocation,
  _difficulty: { easy: number; medium: number; hard: number },
): Blueprint {
  const seedIds = new Set((input.examinerSeeds ?? []).map((s) => s.id));
  let rows = blueprint.rows.slice(0, input.questionCount).map((r) => {
    let row = { ...r };
    if (row.role === "misconception_probe") {
      if (row.targetMisconceptionId == null || !seedIds.has(row.targetMisconceptionId)) {
        // Try to recover a usable id — pick the first seed not yet used.
        // Otherwise, demote to coverage.
        row = { ...row, targetMisconceptionId: null, role: "syllabus_coverage" };
      }
    } else {
      // Coverage rows should not carry a misconception id.
      row = { ...row, targetMisconceptionId: null };
    }
    return row;
  });

  // Pad if planner returned fewer rows than requested.
  while (rows.length < input.questionCount) {
    rows.push({
      questionIndex: rows.length + 1,
      role: "syllabus_coverage",
      subtopicLabel: input.subtopic || input.topic,
      learningRequirement: "",
      commandWord: null,
      targetMisconceptionId: null,
      difficulty: "medium",
      intent: `Cover the topic "${input.topic}" at medium difficulty.`,
    });
  }

  // Reconcile probe count with allocation. If we have fewer probes than the
  // allocation target and there are unused seeds, upgrade coverage rows.
  const seeds = input.examinerSeeds ?? [];
  const usedSeedIds = new Set(rows.filter((r) => r.targetMisconceptionId != null).map((r) => r.targetMisconceptionId!));
  const unusedSeeds = seeds.filter((s) => !usedSeedIds.has(s.id));
  let probeCount = rows.filter((r) => r.role === "misconception_probe").length;
  for (let i = 0; i < rows.length && probeCount < allocation.probe && unusedSeeds.length > 0; i++) {
    if (rows[i].role === "syllabus_coverage") {
      const seed = unusedSeeds.shift()!;
      rows[i] = {
        ...rows[i],
        role: "misconception_probe",
        targetMisconceptionId: seed.id,
        intent: `Probe the misconception: ${seed.misconception}`.slice(0, 240),
      };
      probeCount += 1;
    }
  }

  // If we have MORE probes than the allocation target, demote the surplus
  // (preferring rows whose seed id we don't actually have) to coverage.
  if (probeCount > allocation.probe) {
    let demote = probeCount - allocation.probe;
    for (let i = rows.length - 1; i >= 0 && demote > 0; i--) {
      if (rows[i].role === "misconception_probe") {
        rows[i] = { ...rows[i], role: "syllabus_coverage", targetMisconceptionId: null };
        demote -= 1;
      }
    }
  }

  rows = rows.map((r, i) => ({ ...r, questionIndex: i + 1 }));
  return { rows };
}

// ─── Render the blueprint into a maker-prompt block ────────────────────────

/**
 * Format the plan as a numbered grid the maker reads alongside its other
 * inputs. Pairs each question slot with its role, anchor, and (for probes)
 * the verbatim misconception text — saving the maker a lookup and reducing
 * the chance it picks the wrong seed.
 */
export function renderBlueprintForMaker(
  blueprint: Blueprint,
  seeds: ExaminerSeed[] | undefined,
): string {
  const seedMap = new Map<number, ExaminerSeed>();
  for (const s of seeds ?? []) seedMap.set(s.id, s);

  const lines: string[] = [
    "QUESTION BLUEPRINT — write each question in this exact order, matching its assigned row.",
    "Every question must follow its row's role, anchor, and difficulty.",
    "",
  ];
  for (const row of blueprint.rows) {
    const cmd = row.commandWord ? `(${row.commandWord}) ` : "";
    const anchor = [row.subtopicLabel, row.learningRequirement].filter(Boolean).join(" — ");
    if (row.role === "misconception_probe" && row.targetMisconceptionId != null) {
      const seed = seedMap.get(row.targetMisconceptionId);
      lines.push(
        `Q${row.questionIndex} [${row.difficulty}] PROBE misconception #${row.targetMisconceptionId}: ${seed?.misconception ?? "(seed text unavailable)"}`,
        `   Anchor: ${cmd}${anchor || "(no catalogue anchor)"}`,
        `   Required student error to surface: ${seed?.studentError || "—"}`,
        `   Correct approach the question must reward: ${seed?.correctApproach || "—"}`,
        `   Intent: ${row.intent}`,
        `   Distractor rule: at least one distractor MUST embody this misconception's typical wrong working verbatim.`,
        "",
      );
    } else {
      lines.push(
        `Q${row.questionIndex} [${row.difficulty}] COVERAGE: ${cmd}${anchor || "(general topic coverage)"}`,
        `   Intent: ${row.intent}`,
        "",
      );
    }
  }
  lines.push(
    "Pairing rule: produce exactly one question per row, in order. Do not merge, drop, or reorder rows.",
    "Coverage questions must stay strictly within the anchor's learning requirement.",
    "Probe questions must reproduce the cited misconception exactly — do not invent a different error.",
  );
  return lines.join("\n");
}
