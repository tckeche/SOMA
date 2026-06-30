import { graphQuestionSpecSchema, type GraphQuestionSpec } from "@shared/schema";
import { storage } from "../../storage";
import { validateAndCorrectMcqAnswers } from "../../services/aiPipeline";
import { balanceAnswerOptions } from "../../services/assessmentGeneration";
import { listApprovedSeeds } from "../../services/examinerDistractorSeeds";
import { detectGraphIntent, validateWithAutoFix } from "../../services/cambridgeGraphEngine";
import { countWithField, newTraceId, traceLog } from "../../services/quizTraceLog";
import { MAX_QUESTIONS_PER_QUIZ } from "../questionValidation/service";
import { getQuestionForDelete, getQuizForQuestionWrite } from "./policies";
import type { NormalizedQuestionForInsert, RawQuestionInput } from "./types";

export class QuestionManagementError extends Error { constructor(public status: number, message: string) { super(message); } }

function parseBoardAndSyllabusCode(raw: string): { board: string; syllabusCode: string } {
  const [boardRaw, codeRaw] = String(raw || "").split(":");
  return { board: (boardRaw || "").trim(), syllabusCode: (codeRaw || boardRaw || "").trim() };
}

function stringOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function numberOrNull(value: unknown): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function arrayOfNumbersOrNull(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  const ids = Array.from(new Set(value.map(Number).filter((n) => Number.isInteger(n) && n > 0)));
  return ids.length > 0 ? ids : null;
}

function repairGraphSpec(raw: unknown): GraphQuestionSpec | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;

  const asFinite = (v: unknown): number | null => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const asString = (v: unknown): string | undefined => {
    if (typeof v !== "string") return undefined;
    const trimmed = v.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  };
  const normaliseRange = (v: unknown): [number, number] | null => {
    let values: number[] = [];
    if (Array.isArray(v)) values = v.map((item) => asFinite(item)).filter((n): n is number => n !== null);
    else if (v && typeof v === "object") {
      const obj = v as Record<string, unknown>;
      const ordered = [obj.min, obj.max, obj.from, obj.to, obj.start, obj.end, obj.low, obj.high, obj.lower, obj.upper, obj[0], obj[1]].map((item) => asFinite(item)).filter((n): n is number => n !== null);
      values = ordered.length >= 2 ? ordered : Object.values(obj).map((item) => asFinite(item)).filter((n): n is number => n !== null);
    }
    if (values.length < 2) return null;
    let lo = values[0]; let hi = values[1];
    if (lo === hi) { lo -= 1; hi += 1; }
    if (lo > hi) [lo, hi] = [hi, lo];
    return [lo, hi];
  };

  const xRange = normaliseRange(r.xRange ?? r.xrange ?? r.domain ?? r.xDomain);
  const yRange = normaliseRange(r.yRange ?? r.yrange ?? r.range ?? r.yDomain);
  if (!xRange || !yRange) return null;

  const rawPlotType = String(r.plotType || r.plot_type || "");
  const validPlotTypes = ["line", "curve", "scatter", "points"] as const;
  const equationCandidate = asString(r.equation) ?? asString(r.expression) ?? asString(r.formula) ?? asString(r.function) ?? asString(r.fn);
  const plotType: "line" | "curve" | "scatter" | "points" = validPlotTypes.includes(rawPlotType as never) ? (rawPlotType as "line" | "curve" | "scatter" | "points") : equationCandidate || r.curves ? "line" : "points";

  const rawCurves = Array.isArray(r.curves) ? r.curves : r.curves && typeof r.curves === "object" ? Object.entries(r.curves as Record<string, unknown>).map(([key, value]) => {
    if (typeof value === "string") return { equation: value, label: key };
    if (value && typeof value === "object") return { label: key, ...(value as Record<string, unknown>) };
    return null;
  }).filter(Boolean) : undefined;
  const curves = Array.isArray(rawCurves) ? rawCurves.map((c) => {
    if (typeof c === "string") return { equation: c };
    if (!c || typeof c !== "object") return null;
    const curve = c as Record<string, unknown>;
    const curveEquation = asString(curve.equation) ?? asString(curve.expression) ?? asString(curve.formula) ?? asString(curve.function);
    if (!curveEquation) return null;
    return { equation: curveEquation, label: asString(curve.label) ?? asString(curve.name) ?? asString(curve.title), color: asString(curve.color) };
  }).filter((c): c is { equation: string; label?: string; color?: string } => c !== null) : undefined;

  const rawPoints = Array.isArray(r.points) ? r.points : Array.isArray(r.dataPoints) ? r.dataPoints : Array.isArray(r.coordinates) ? r.coordinates : undefined;
  const points = rawPoints?.map((point) => {
    if (Array.isArray(point) && point.length >= 2) {
      const x = asFinite(point[0]); const y = asFinite(point[1]);
      if (x === null || y === null) return null;
      return { x, y };
    }
    if (!point || typeof point !== "object") return null;
    const p = point as Record<string, unknown>;
    const x = asFinite(p.x ?? p.xValue ?? p.x_value ?? p.t);
    const y = asFinite(p.y ?? p.yValue ?? p.y_value ?? p.value);
    if (x === null || y === null) return null;
    const label = asString(p.label) ?? asString(p.name);
    return label ? { x, y, label } : { x, y };
  }).filter((p): p is { x: number; y: number; label?: string } => p !== null);
  if (!equationCandidate && (!curves || curves.length === 0) && (!points || points.length === 0)) return null;

  const rawLabels = r.axisLabels ?? r.axis_labels ?? r.axes ?? r.axis;
  const labelsObj = rawLabels && typeof rawLabels === "object" ? (rawLabels as Record<string, unknown>) : {};
  const axisLabels = { x: asString(labelsObj.x ?? labelsObj.xAxis ?? labelsObj.horizontal ?? labelsObj.h) ?? "x", y: asString(labelsObj.y ?? labelsObj.yAxis ?? labelsObj.vertical ?? labelsObj.v) ?? "y" };
  const tickIntervalCandidate = asFinite(r.tickInterval ?? r.tick_interval ?? r.ticks);
  const tickInterval = tickIntervalCandidate !== null && tickIntervalCandidate > 0 ? tickIntervalCandidate : 1;
  const showGrid = r.showGrid !== false;
  const highlightedPoints = Array.isArray(r.highlightedPoints) ? r.highlightedPoints.map((point) => {
    if (!point || typeof point !== "object") return null;
    const p = point as Record<string, unknown>; const x = asFinite(p.x); const y = asFinite(p.y);
    if (x === null || y === null) return null;
    const label = asString(p.label);
    return label ? { x, y, label } : { x, y };
  }).filter((p): p is { x: number; y: number; label?: string } => p !== null) : undefined;
  const rawAsym = r.asymptotes && typeof r.asymptotes === "object" ? (r.asymptotes as Record<string, unknown>) : null;
  const asymptotes = rawAsym ? { vertical: Array.isArray(rawAsym.vertical) ? rawAsym.vertical.map(Number).filter(Number.isFinite) : [], horizontal: Array.isArray(rawAsym.horizontal) ? rawAsym.horizontal.map(Number).filter(Number.isFinite) : [], oblique: Array.isArray(rawAsym.oblique) ? rawAsym.oblique.map(String).filter(Boolean) : [] } : undefined;
  const rawImplicit = r.implicit && typeof r.implicit === "object" ? (r.implicit as Record<string, unknown>) : null;
  const implicit = rawImplicit && String(rawImplicit.type || "") === "circle" ? { type: "circle" as const, h: Number(rawImplicit.h), k: Number(rawImplicit.k), r: Number(rawImplicit.r) } : rawImplicit && String(rawImplicit.type || "") === "equation" && String(rawImplicit.equation || "").trim() ? { type: "equation" as const, equation: String(rawImplicit.equation) } : undefined;
  const rawParametric = r.parametric && typeof r.parametric === "object" ? (r.parametric as Record<string, unknown>) : null;
  const parametric = rawParametric ? { xEquation: asString(rawParametric.xEquation ?? rawParametric.x ?? rawParametric.xEq) ?? "", yEquation: asString(rawParametric.yEquation ?? rawParametric.y ?? rawParametric.yEq) ?? "", tRange: normaliseRange(rawParametric.tRange ?? [rawParametric.tMin, rawParametric.tMax]) ?? [0, 1] as [number, number] } : undefined;
  const piecewise = Array.isArray(r.piecewise) ? r.piecewise.map((seg: any) => ({ equation: String(seg?.equation || ""), domain: Array.isArray(seg?.domain) ? [Number(seg.domain[0]), Number(seg.domain[1])] as [number, number] : [Number(seg?.xMin), Number(seg?.xMax)] as [number, number], label: seg?.label ? String(seg.label) : undefined })).filter((seg) => seg.equation && Number.isFinite(seg.domain[0]) && Number.isFinite(seg.domain[1]) && seg.domain[0] < seg.domain[1]) : undefined;
  const repaired = { plotType, equation: equationCandidate, label: asString(r.label) ?? asString(r.curveLabel) ?? asString(r.displayLabel), curves: curves && curves.length > 0 ? curves : undefined, points, xRange, yRange, axisLabels, showGrid, tickInterval, highlightedPoints, asymptotes, implicit, parametric: parametric && parametric.xEquation && parametric.yEquation && parametric.tRange[0] < parametric.tRange[1] ? parametric : undefined, piecewise: piecewise && piecewise.length > 0 ? piecewise : undefined, subjectPreset: (() => { const rawSubject = String(r.subjectPreset ?? r.subject ?? "").trim().toLowerCase(); if (!rawSubject) return undefined; const mapping: Record<string, GraphQuestionSpec["subjectPreset"]> = { mathematics: "mathematics", maths: "mathematics", math: "mathematics", physics: "physics", economics: "economics", business: "business", chemistry: "chemistry", biology: "biology" }; return mapping[rawSubject]; })(), graphKind: asString(r.graphKind) ?? asString(r.kind) ?? asString(r.graphType) };
  const parsed = graphQuestionSpecSchema.safeParse(repaired);
  if (!parsed.success) return null;
  const inferredIntent = detectGraphIntent({ prompt: asString(r.prompt_text) ?? asString(r.prompt) ?? asString(r.question), objective: asString(r.objective), commandWords: Array.isArray(r.commandWords) ? r.commandWords.map(String) : undefined, skillType: asString(r.skillType), subject: asString(r.subject) ?? parsed.data.subjectPreset ?? "Mathematics", level: asString(r.level) ?? "IGCSE", syllabus: asString(r.syllabus), syllabusCode: asString(r.syllabusCode), topic: asString(r.topic), subtopic: asString(r.subtopic), paperStyle: asString(r.paperStyle) });
  const checked = validateWithAutoFix(parsed.data, inferredIntent);
  return { ...checked.spec, auditNotes: [...(checked.spec.auditNotes ?? []), ...inferredIntent.reasons, ...checked.validation.audit, ...checked.appliedFixes.map((fix) => `Auto-fix: ${fix}`)], graphFamily: inferredIntent.family, sourceContext: { ...(checked.spec.sourceContext ?? {}), commandWords: inferredIntent.skills, skillType: inferredIntent.skills.join(","), intent: inferredIntent.figureMode }, validationTargets: { ...(checked.spec.validationTargets ?? {}), requireFrequencyDensityLabel: inferredIntent.family === "histogram_frequency_density", requireErrorBars: inferredIntent.skills.includes("use_error_bars"), requireBestFit: inferredIntent.family === "scatter_best_fit" } };
}

function normalizeQuestion(q: RawQuestionInput): NormalizedQuestionForInsert {
  const stem = String(q.prompt_text || q.stem || "");
  if (!stem) throw new QuestionManagementError(400, "Each question must have a prompt_text");
  const rawType = String(q.question_type || q.questionType || (q.graph_spec || q.graphSpec ? "graph" : "multiple_choice"));
  const questionType = rawType === "structured" ? "structured" : rawType === "graph" ? "graph" : "multiple_choice";
  const options = Array.isArray(q.options) ? q.options.map(String) : [];
  const markScheme = stringOrNull(q.mark_scheme ?? q.markScheme);
  let graphSpec: GraphQuestionSpec | null = null;

  if (questionType === "structured") {
    if (!markScheme) throw new QuestionManagementError(400, "Structured questions must have a mark scheme");
  } else {
    if (options.length !== 4) throw new QuestionManagementError(400, "Each question must have exactly 4 options");
    if (questionType === "graph") {
      graphSpec = repairGraphSpec(q.graph_spec ?? q.graphSpec);
      if (!graphSpec) throw new QuestionManagementError(400, "A graph question has an invalid graph spec");
    }
  }

  return {
    stem,
    options,
    correct_answer: String(q.correct_answer ?? q.correctAnswer ?? ""),
    explanation: String(q.explanation || ""),
    marks: Number(q.marks_worth ?? q.marks ?? 1) || 1,
    question_type: questionType,
    graph_spec: graphSpec,
    mark_scheme: markScheme,
    topic_tag: stringOrNull(q.topic_tag ?? q.topicTag),
    subtopic_tag: stringOrNull(q.subtopic_tag ?? q.subtopicTag),
    difficulty_tag: stringOrNull(q.difficulty_tag ?? q.difficultyTag),
    target_misconception_ids: arrayOfNumbersOrNull(q.targetMisconceptionIds ?? q.target_misconception_ids),
    option_rationales: q.optionRationales ?? q.option_rationales ?? null,
    subtopic_id: numberOrNull(q.subtopicId ?? q.subtopic_id),
    learning_requirement_id: numberOrNull(q.learningRequirementId ?? q.learning_requirement_id),
    command_word: stringOrNull(q.commandWord ?? q.command_word),
    assessment_objective: stringOrNull(q.assessmentObjective ?? q.assessment_objective),
    generation_meta: q.generationMeta ?? q.generation_meta ?? null,
    review_status: stringOrNull(q.reviewStatus ?? q.review_status),
  };
}

export async function addQuestions(quizId: number, tutorId: string, questions: unknown) {
  const traceId = newTraceId();
  const owned = await getQuizForQuestionWrite(quizId, tutorId);
  if (!owned.ok) throw new QuestionManagementError(owned.status, owned.message);
  const quiz = owned.quiz;
  if (!Array.isArray(questions) || questions.length === 0) throw new QuestionManagementError(400, "questions array required");
  const questionInputs = questions as RawQuestionInput[];
  traceLog("route.addQuestions.entry", { route: "/api/tutor/quizzes/:quizId/questions", quizId, quizSyllabus: quiz.syllabus, questionsIn: questionInputs.length, clientSentTargetMisconceptionIds: questionInputs.filter((q) => Array.isArray(q?.targetMisconceptionIds) && q.targetMisconceptionIds.length > 0).length }, traceId);

  const normalized = questionInputs.map(normalizeQuestion);
  const existingForCap = await storage.getSomaQuestionsByQuizId(quizId);
  if (existingForCap.length + normalized.length > MAX_QUESTIONS_PER_QUIZ) throw new QuestionManagementError(400, `A quiz can have at most ${MAX_QUESTIONS_PER_QUIZ} questions (already has ${existingForCap.length}, tried to add ${normalized.length}).`);

  const { board, syllabusCode } = parseBoardAndSyllabusCode(quiz.syllabus ?? "");
  const examinerSeeds = await listApprovedSeeds({ board, syllabusCode });
  const seedIds = examinerSeeds.map((s) => s.id);
  const fallbackTargetMisconceptionIds = seedIds.length > 0 ? seedIds : null;
  traceLog("route.addQuestions.seedsLoaded", { quizId, parsedBoard: board, parsedSyllabusCode: syllabusCode, seedCount: examinerSeeds.length, sampleSeedIds: seedIds.slice(0, 5) }, traceId);

  const validated = [...normalized];
  const objectiveIndexes = normalized.map((q, index) => ({ q, index })).filter(({ q }) => q.question_type !== "structured");
  if (objectiveIndexes.length > 0) {
    const balanced = balanceAnswerOptions(objectiveIndexes.map(({ q }) => ({ stem: q.stem, options: q.options, correct_answer: q.correct_answer, explanation: q.explanation, marks: q.marks })));
    const validatedResult = validateAndCorrectMcqAnswers(balanced);
    validatedResult.questions.forEach((q, i) => {
      const sourceIndex = objectiveIndexes[i].index;
      validated[sourceIndex] = { ...validated[sourceIndex], options: q.options, correct_answer: q.correct_answer, explanation: q.explanation, marks: q.marks };
    });
    if (validatedResult.warnings.length > 0) {
      const critical = validatedResult.warnings.filter((w) => !w.autoFixed);
      console.warn(`[ADD_QUESTIONS] quizId=${quizId} validator emitted ${validatedResult.warnings.length} warning(s)` + (critical.length > 0 ? ` (${critical.length} CRITICAL)` : ""), validatedResult.warnings.map((w) => `Q${w.questionIndex} ${w.field}: ${w.issue}`));
    }
  }

  const mapped = validated.map((source) => {
    return {
      quizId,
      stem: source.stem,
      options: source.options,
      correctAnswer: source.correct_answer,
      explanation: source.explanation,
      marks: source.marks,
      questionType: source.question_type,
      graphSpec: source.graph_spec,
      markScheme: source.mark_scheme,
      reviewStatus: source.review_status ?? "approved",
      topicTag: source.topic_tag,
      subtopicTag: source.subtopic_tag,
      difficultyTag: source.difficulty_tag,
      targetMisconceptionIds: source.target_misconception_ids ?? fallbackTargetMisconceptionIds,
      optionRationales: source.option_rationales,
      subtopicId: source.subtopic_id,
      learningRequirementId: source.learning_requirement_id,
      commandWord: source.command_word,
      assessmentObjective: source.assessment_objective,
      generationMeta: source.generation_meta,
    };
  });
  traceLog("route.addQuestions.beforeCreate", { quizId, mappedCount: mapped.length, rowsWithSeeds: countWithField(mapped as unknown as Record<string, unknown>[], "targetMisconceptionIds") }, traceId);
  const saved = await storage.createSomaQuestions(mapped as any);
  traceLog("route.addQuestions.afterCreate", { quizId, savedCount: saved.length, savedRowsWithSeeds: countWithField(saved as unknown as Record<string, unknown>[], "targetMisconceptionIds") }, traceId);
  return saved;
}

export async function deleteQuestion(questionId: number, tutorId: string) {
  const owned = await getQuestionForDelete(questionId, tutorId);
  if (!owned.ok) throw new QuestionManagementError(owned.status, owned.message);
  await storage.deleteSomaQuestion(questionId);
  return { success: true };
}
