import { z } from "zod";
import type { GraphQuestionSpec } from "@shared/schema";

export const graphDiagramFamilySchema = z.enum([
  "line_graph",
  "scatter_best_fit",
  "cumulative_frequency",
  "histogram_frequency_density",
  "bar_chart",
  "divided_bar_chart",
  "pie_chart",
  "box_and_whisker",
  "stem_and_leaf",
  "climate_graph",
  "population_pyramid",
  "choropleth_map",
  "flow_line_map",
  "topographic_profile",
  "triangular_graph",
  "kinematics_graph",
  "titration_curve",
  "stress_strain_curve",
  "log_log_plot",
  "semi_log_plot",
  "flow_chart",
  "timeline",
  "annotated_schematic",
  "economic_curve",
  "labelled_resource_diagram",
]);

export type GraphDiagramFamily = z.infer<typeof graphDiagramFamilySchema>;

export const graphSkillSchema = z.enum([
  "plot",
  "sketch",
  "interpret",
  "compare",
  "calculate_gradient",
  "read_intercept",
  "identify_anomaly",
  "use_error_bars",
  "interpolate",
  "extrapolate",
  "solve_graphically",
]);

export type GraphSkill = z.infer<typeof graphSkillSchema>;

export interface GraphIntentInput {
  prompt?: string;
  objective?: string;
  commandWords?: string[];
  skillType?: string;
  subject: string;
  level: string;
  syllabus?: string;
  syllabusCode?: string;
  topic?: string;
  subtopic?: string;
  paperStyle?: string;
  difficulty?: "easy" | "medium" | "hard";
}

export interface GraphIntent {
  requiresFigure: boolean;
  figureMode: "none" | "pre_printed" | "student_completed" | "partially_completed";
  family: GraphDiagramFamily;
  skills: GraphSkill[];
  reasons: string[];
  subjectTemplate: string;
}

export interface GraphValidationIssue {
  code: string;
  severity: "error" | "warning";
  message: string;
  suggestion?: string;
}

export interface GraphValidationResult {
  pass: boolean;
  issues: GraphValidationIssue[];
  warnings: GraphValidationIssue[];
  fixSuggestions: string[];
  audit: string[];
}

export interface GraphAssessmentPackage {
  questionStem: string;
  studentInstruction: string;
  figureSpec: GraphQuestionSpec;
  dataTable: Array<Record<string, string | number>>;
  answerKey: string;
  modelSolution: string;
  markScheme: {
    method: string[];
    accuracy: string[];
    interpretation: string[];
  };
  validation: GraphValidationResult;
  curriculumAlignment: {
    subject: string;
    level: string;
    syllabus?: string;
    syllabusCode?: string;
    topic?: string;
    subtopic?: string;
  };
  auditMetadata: {
    template: string;
    selectedFamily: GraphDiagramFamily;
    intentReasons: string[];
    appliedFixes: string[];
    acceptanceStatus: "accepted" | "repaired" | "rejected";
  };
}

const COMMAND_WORD_RULES: Array<{ pattern: RegExp; skill: GraphSkill; mode?: GraphIntent["figureMode"] }> = [
  { pattern: /\bplot\b/i, skill: "plot", mode: "student_completed" },
  { pattern: /\bsketch\b/i, skill: "sketch", mode: "student_completed" },
  { pattern: /\bdetermine gradient\b|\bcalculate gradient\b|\bgradient\b/i, skill: "calculate_gradient" },
  { pattern: /\bintercept\b/i, skill: "read_intercept" },
  { pattern: /\banomal(y|ies)\b/i, skill: "identify_anomaly" },
  { pattern: /\berror bars?\b/i, skill: "use_error_bars" },
  { pattern: /\binterpolate\b/i, skill: "interpolate" },
  { pattern: /\bextrapolate\b/i, skill: "extrapolate" },
  { pattern: /\bsolve graphically\b/i, skill: "solve_graphically" },
  { pattern: /\bcompare\b/i, skill: "compare" },
  { pattern: /\bdisplay data as\b|\buse the graph to\b|\bidentify\b/i, skill: "interpret", mode: "pre_printed" },
];

const SUBJECT_FAMILY_GATING: Record<string, GraphDiagramFamily[]> = {
  "igcse mathematics": ["bar_chart", "pie_chart", "stem_and_leaf", "scatter_best_fit", "cumulative_frequency", "histogram_frequency_density", "line_graph"],
  "igcse additional mathematics": ["line_graph", "kinematics_graph", "scatter_best_fit", "cumulative_frequency"],
  "igcse physics": ["scatter_best_fit", "line_graph", "kinematics_graph"],
  "igcse chemistry": ["line_graph", "titration_curve", "scatter_best_fit"],
  "igcse biology": ["line_graph", "bar_chart", "pie_chart", "histogram_frequency_density", "scatter_best_fit"],
  "a level physics": ["scatter_best_fit", "line_graph", "log_log_plot", "semi_log_plot"],
  "a level biology": ["line_graph", "bar_chart", "histogram_frequency_density", "scatter_best_fit"],
  "a level chemistry": ["line_graph", "titration_curve", "scatter_best_fit"],
  "igcse geography": ["bar_chart", "divided_bar_chart", "climate_graph", "scatter_best_fit", "flow_line_map", "topographic_profile", "triangular_graph", "choropleth_map", "population_pyramid"],
  "a level geography": ["bar_chart", "divided_bar_chart", "climate_graph", "scatter_best_fit", "flow_line_map", "topographic_profile", "triangular_graph", "choropleth_map", "population_pyramid"],
};

function normalizedPhase(subject: string, level: string): string {
  return `${level.trim().toLowerCase()} ${subject.trim().toLowerCase()}`;
}

function chooseFamily(input: GraphIntentInput, skills: GraphSkill[], reasons: string[]): GraphDiagramFamily {
  const phase = normalizedPhase(input.subject, input.level);
  const allowed = SUBJECT_FAMILY_GATING[phase] ?? ["line_graph", "bar_chart", "scatter_best_fit", "flow_chart", "timeline", "annotated_schematic", "economic_curve", "labelled_resource_diagram"];
  const hay = `${input.prompt || ""} ${input.objective || ""} ${input.topic || ""} ${input.subtopic || ""}`.toLowerCase();

  const prefer = (family: GraphDiagramFamily, reason: string): GraphDiagramFamily | null => {
    if (allowed.includes(family)) {
      reasons.push(reason);
      return family;
    }
    return null;
  };

  if (/histogram|frequency density/.test(hay)) return prefer("histogram_frequency_density", "Keyword indicates histogram/frequency density task") ?? allowed[0];
  if (/cumulative frequency|ogive/.test(hay)) return prefer("cumulative_frequency", "Keyword indicates cumulative-frequency graph") ?? allowed[0];
  if (/titration|ph curve/.test(hay)) return prefer("titration_curve", "Keyword indicates titration/reaction curve") ?? allowed[0];
  if (/kinematics|velocity-time|displacement-time|acceleration-time|speed-time/.test(hay)) return prefer("kinematics_graph", "Motion-graph keywords detected") ?? allowed[0];
  if (/climate|rainfall|temperature by month/.test(hay)) return prefer("climate_graph", "Climate graph resource requested") ?? allowed[0];
  if (/triangular graph|ternary/.test(hay)) return prefer("triangular_graph", "Triangular graph requested") ?? allowed[0];
  if (/choropleth|map shading/.test(hay)) return prefer("choropleth_map", "Map shading resource requested") ?? allowed[0];
  if (/flow-line|migration map/.test(hay)) return prefer("flow_line_map", "Flow-line map resource requested") ?? allowed[0];
  if (/bar chart|divided bar/.test(hay)) return prefer(/divided/.test(hay) ? "divided_bar_chart" : "bar_chart", "Bar-chart keyword detected") ?? allowed[0];
  if (/scatter|best fit/.test(hay) || skills.includes("calculate_gradient")) return prefer("scatter_best_fit", "Best-fit/gradient requirement detected") ?? allowed[0];

  if (skills.includes("sketch") || skills.includes("solve_graphically")) {
    return prefer("line_graph", "Sketch or graphical-solving behavior requires function line graph") ?? allowed[0];
  }

  reasons.push("No strong keyword match; selected first allowed Cambridge-safe family");
  return allowed[0];
}

export function detectGraphIntent(input: GraphIntentInput): GraphIntent {
  const source = `${input.prompt || ""} ${input.objective || ""} ${input.commandWords?.join(" ") || ""} ${input.skillType || ""}`;
  const skills = new Set<GraphSkill>();
  const reasons: string[] = [];
  let mode: GraphIntent["figureMode"] = "pre_printed";

  for (const rule of COMMAND_WORD_RULES) {
    if (rule.pattern.test(source)) {
      skills.add(rule.skill);
      reasons.push(`Matched command-word rule: ${rule.skill}`);
      if (rule.mode) mode = rule.mode;
    }
  }

  const requiresFigure = /graph|plot|diagram|chart|histogram|scatter|curve|map|profile|resource/i.test(source) || skills.size > 0;
  if (!requiresFigure) {
    return {
      requiresFigure: false,
      figureMode: "none",
      family: "line_graph",
      skills: [],
      reasons: ["No graph/diagram trigger words found"],
      subjectTemplate: `${input.level} ${input.subject} shared-cambridge-default`,
    };
  }

  const family = chooseFamily(input, Array.from(skills), reasons);
  return {
    requiresFigure,
    figureMode: mode,
    family,
    skills: Array.from(skills),
    reasons,
    subjectTemplate: `${input.level} ${input.subject} ${family}`,
  };
}

function formatAxisLabel(quantity: string, unit?: string): string {
  const trimmed = quantity.trim();
  if (!unit || !unit.trim()) return trimmed;
  return `${trimmed} / ${unit.trim()}`;
}

function niceStep(span: number): number {
  if (!Number.isFinite(span) || span <= 0) return 1;
  const rough = span / 8;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const normalised = rough / magnitude;
  const nice = normalised <= 1 ? 1 : normalised <= 2 ? 2 : normalised <= 5 ? 5 : 10;
  return nice * magnitude;
}

export function buildAxisScale(values: number[], opts?: { includeZero?: boolean; allowFalseOrigin?: boolean }): { min: number; max: number; tick: number; gridUtilization: number; usedFalseOrigin: boolean } {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = Math.max(1e-6, max - min);
  const includeZero = opts?.includeZero ?? false;
  const allowFalseOrigin = opts?.allowFalseOrigin ?? true;

  let axisMin = includeZero ? Math.min(0, min) : min;
  let axisMax = includeZero ? Math.max(0, max) : max;

  const canUseFalseOrigin = allowFalseOrigin && min > 0 && (max / Math.max(min, 1e-6) < 4);
  if (canUseFalseOrigin) {
    axisMin = Math.max(0, min - span * 0.15);
  } else {
    axisMin = includeZero ? axisMin : min - span * 0.1;
  }
  axisMax = axisMax + span * 0.1;

  const tick = niceStep(axisMax - axisMin);
  const snappedMin = Math.floor(axisMin / tick) * tick;
  const snappedMax = Math.ceil(axisMax / tick) * tick;
  const util = span / Math.max(1e-6, snappedMax - snappedMin);

  return {
    min: snappedMin,
    max: snappedMax,
    tick,
    gridUtilization: util,
    usedFalseOrigin: canUseFalseOrigin,
  };
}

export function generateDataset(family: GraphDiagramFamily, difficulty: "easy" | "medium" | "hard" = "medium"): Array<Record<string, string | number>> {
  const anomalyOffset = difficulty === "hard" ? 1.2 : difficulty === "medium" ? 0.6 : 0;
  switch (family) {
    case "histogram_frequency_density":
      return [
        { classInterval: "0-10", frequency: 4, width: 10, frequencyDensity: 0.4 },
        { classInterval: "10-20", frequency: 7, width: 10, frequencyDensity: 0.7 },
        { classInterval: "20-35", frequency: 12 + anomalyOffset, width: 15, frequencyDensity: Number(((12 + anomalyOffset) / 15).toFixed(2)) },
        { classInterval: "35-50", frequency: 6, width: 15, frequencyDensity: 0.4 },
      ];
    case "cumulative_frequency":
      return [
        { upperBound: 10, cumulativeFrequency: 3 },
        { upperBound: 20, cumulativeFrequency: 8 },
        { upperBound: 30, cumulativeFrequency: 14 },
        { upperBound: 40, cumulativeFrequency: 18 + (difficulty === "hard" ? 1 : 0) },
        { upperBound: 50, cumulativeFrequency: 20 },
      ];
    case "scatter_best_fit":
    case "line_graph":
    case "kinematics_graph":
      return Array.from({ length: 7 }, (_, i) => {
        const x = i * 2;
        const y = Number((1.8 * x + 4 + (i === 4 ? anomalyOffset : 0)).toFixed(2));
        return { x, y };
      });
    case "bar_chart":
    case "divided_bar_chart":
      return [
        { category: "A", value: 12 },
        { category: "B", value: 18 },
        { category: "C", value: 15 + anomalyOffset },
        { category: "D", value: 9 },
      ];
    case "climate_graph":
      return [
        { month: "Jan", rainfallMm: 85, temperatureC: 26 },
        { month: "Apr", rainfallMm: 120, temperatureC: 29 },
        { month: "Jul", rainfallMm: 210, temperatureC: 31 },
        { month: "Oct", rainfallMm: 140, temperatureC: 28 },
      ];
    default:
      return [
        { x: 0, y: 1 },
        { x: 1, y: 2 },
        { x: 2, y: 3 },
      ];
  }
}

function buildMarkScheme(intent: GraphIntent): GraphAssessmentPackage["markScheme"] {
  const method = [
    "M1: axes labelled with quantity and units where applicable",
    "M1: scale chosen to use at least half of each axis/grid",
  ];
  const accuracy = ["A1: plotting/feature placement within tolerance for level"];
  const interpretation = ["I1: valid extraction/interpretation from generated figure"];

  if (intent.family === "histogram_frequency_density") {
    method.push("M1: bars touch and vertical axis labelled frequency density");
  }
  if (intent.family === "bar_chart" || intent.family === "divided_bar_chart") {
    method.push("M1: equal bar widths with visible gaps between categories");
  }
  if (intent.skills.includes("calculate_gradient")) {
    method.push("M1: gradient triangle method shown with adequate point separation");
    accuracy.push("A1: gradient computed from selected points to expected precision");
  }
  if (intent.skills.includes("use_error_bars")) {
    method.push("M1: error bars drawn in required direction and magnitude");
    interpretation.push("I1: uncertainty conclusion consistent with overlap/non-overlap logic");
  }

  return { method, accuracy, interpretation };
}

export function validateGraphSpecForCambridge(spec: GraphQuestionSpec, intent?: GraphIntent): GraphValidationResult {
  const issues: GraphValidationIssue[] = [];
  const warnings: GraphValidationIssue[] = [];
  const audit: string[] = [];

  const unitLike = /(\(|\/|\bmm\b|\bcm\b|\bm\b|\bs\b|\bkg\b|\bn\b|\b°c\b|\bmol\b|\bpa\b)/i;
  const hasUnitInX = unitLike.test(spec.axisLabels.x);
  const hasUnitInY = unitLike.test(spec.axisLabels.y);

  if (!spec.axisLabels.x?.trim() || !spec.axisLabels.y?.trim()) {
    issues.push({ code: "axis_label_missing", severity: "error", message: "Both axes must be labelled", suggestion: "Provide clear quantity/unit labels on x and y axes" });
  }

  if (intent?.family === "histogram_frequency_density" && !/frequency density/i.test(spec.axisLabels.y)) {
    issues.push({ code: "histogram_y_label", severity: "error", message: "Histogram must use frequency density on vertical axis", suggestion: "Rename y-axis to Frequency density" });
  }

  if ((intent?.family === "bar_chart" || intent?.family === "divided_bar_chart") && spec.plotType !== "points") {
    warnings.push({ code: "bar_plottype_hint", severity: "warning", message: "Bar-style chart should be rendered using bar primitives in UI", suggestion: "Respect bar-width and gap rule during rendering" });
  }

  if (intent?.family === "scatter_best_fit" && spec.plotType !== "scatter" && spec.plotType !== "points") {
    warnings.push({ code: "scatter_plottype", severity: "warning", message: "Scatter best-fit tasks should use point markers", suggestion: "Switch plotType to scatter" });
  }

  const xSpan = spec.xRange[1] - spec.xRange[0];
  const ySpan = spec.yRange[1] - spec.yRange[0];
  if (xSpan <= 0 || ySpan <= 0) {
    issues.push({ code: "invalid_range", severity: "error", message: "Axis range must be increasing", suggestion: "Ensure min < max for xRange/yRange" });
  }

  if (spec.tickInterval <= 0) {
    issues.push({ code: "invalid_tick", severity: "error", message: "Tick interval must be positive", suggestion: "Use a positive tick interval" });
  }

  const utilizationX = Math.abs(xSpan) / (Math.abs(spec.xRange[1]) + Math.abs(spec.xRange[0]) + 1e-6);
  const utilizationY = Math.abs(ySpan) / (Math.abs(spec.yRange[1]) + Math.abs(spec.yRange[0]) + 1e-6);
  if (utilizationX < 0.5 || utilizationY < 0.5) {
    warnings.push({ code: "grid_utilization", severity: "warning", message: "Scale may under-use plotting grid", suggestion: "Adjust range/scale to use more than half of graph area" });
  }

  if (intent?.skills.includes("use_error_bars") && !spec.graphKind?.toLowerCase().includes("error")) {
    warnings.push({ code: "error_bars_expected", severity: "warning", message: "Question intent expects error bars", suggestion: "Set graphKind to include error-bars metadata" });
  }

  if (!hasUnitInX || !hasUnitInY) {
    warnings.push({ code: "units_missing", severity: "warning", message: "Units were not detected in one or both axis labels", suggestion: `Use solidus style labels like ${formatAxisLabel("Time", "s")}` });
  }

  audit.push(`Checked axis labels: x='${spec.axisLabels.x}', y='${spec.axisLabels.y}'`);
  audit.push(`Checked ranges x=${spec.xRange.join(" to ")}, y=${spec.yRange.join(" to ")}`);
  if (intent) audit.push(`Intent family=${intent.family}, skills=${intent.skills.join(",") || "none"}`);

  return {
    pass: issues.length === 0,
    issues,
    warnings,
    fixSuggestions: [...issues, ...warnings].map((i) => i.suggestion).filter((s): s is string => Boolean(s)),
    audit,
  };
}

export function autoFixGraphSpec(spec: GraphQuestionSpec, intent?: GraphIntent): { spec: GraphQuestionSpec; appliedFixes: string[] } {
  const next: GraphQuestionSpec = JSON.parse(JSON.stringify(spec));
  const appliedFixes: string[] = [];

  if (!next.axisLabels?.x || next.axisLabels.x.trim().length === 0) {
    next.axisLabels = { ...next.axisLabels, x: "x" };
    appliedFixes.push("Inserted missing x-axis label");
  }
  if (!next.axisLabels?.y || next.axisLabels.y.trim().length === 0) {
    next.axisLabels = { ...next.axisLabels, y: "y" };
    appliedFixes.push("Inserted missing y-axis label");
  }

  if (next.xRange[0] >= next.xRange[1]) {
    const lo = Math.min(next.xRange[0], next.xRange[1]);
    const hi = Math.max(next.xRange[0], next.xRange[1] + 1);
    next.xRange = [lo, hi];
    appliedFixes.push("Repaired xRange ordering");
  }
  if (next.yRange[0] >= next.yRange[1]) {
    const lo = Math.min(next.yRange[0], next.yRange[1]);
    const hi = Math.max(next.yRange[0], next.yRange[1] + 1);
    next.yRange = [lo, hi];
    appliedFixes.push("Repaired yRange ordering");
  }

  if (!Number.isFinite(next.tickInterval) || next.tickInterval <= 0) {
    next.tickInterval = 1;
    appliedFixes.push("Replaced invalid tickInterval with 1");
  }

  if (intent?.family === "histogram_frequency_density" && !/frequency density/i.test(next.axisLabels.y)) {
    next.axisLabels = { ...next.axisLabels, y: "Frequency density" };
    appliedFixes.push("Relabelled histogram y-axis to Frequency density");
  }

  if (intent?.skills.includes("use_error_bars") && (!next.graphKind || !next.graphKind.toLowerCase().includes("error"))) {
    next.graphKind = `${next.graphKind ? `${next.graphKind}; ` : ""}error-bars-required`;
    appliedFixes.push("Added error-bars-required graphKind tag");
  }

  return { spec: next, appliedFixes };
}

export function validateWithAutoFix(spec: GraphQuestionSpec, intent?: GraphIntent, maxPasses = 2): { spec: GraphQuestionSpec; validation: GraphValidationResult; appliedFixes: string[] } {
  let current = spec;
  const appliedFixes: string[] = [];
  let validation = validateGraphSpecForCambridge(current, intent);

  for (let i = 0; i < maxPasses && !validation.pass; i++) {
    const fixed = autoFixGraphSpec(current, intent);
    current = fixed.spec;
    appliedFixes.push(...fixed.appliedFixes);
    validation = validateGraphSpecForCambridge(current, intent);
  }

  return { spec: current, validation, appliedFixes };
}

export function generateGraphAssessmentPackage(input: GraphIntentInput, baseSpec: GraphQuestionSpec): GraphAssessmentPackage {
  const intent = detectGraphIntent(input);
  const checked = validateWithAutoFix(baseSpec, intent);
  const dataTable = generateDataset(intent.family, input.difficulty ?? "medium");
  const markScheme = buildMarkScheme(intent);

  const questionStem = input.prompt?.trim() || `Cambridge-style ${intent.family.replace(/_/g, " ")} question`;
  const studentInstruction = intent.skills.includes("plot")
    ? "Plot the given data accurately using suitable scales and markers, then answer the question."
    : intent.skills.includes("sketch")
      ? "Sketch the graph showing the essential shape/features and key intercepts."
      : "Use the provided graph/diagram to answer all parts of the question.";

  return {
    questionStem,
    studentInstruction,
    figureSpec: checked.spec,
    dataTable,
    answerKey: "Refer to model solution and mark scheme criteria.",
    modelSolution: "Model solution generated with Cambridge-safe axis, scale, marker and interpretation conventions.",
    markScheme,
    validation: checked.validation,
    curriculumAlignment: {
      subject: input.subject,
      level: input.level,
      syllabus: input.syllabus,
      syllabusCode: input.syllabusCode,
      topic: input.topic,
      subtopic: input.subtopic,
    },
    auditMetadata: {
      template: intent.subjectTemplate,
      selectedFamily: intent.family,
      intentReasons: intent.reasons,
      appliedFixes: checked.appliedFixes,
      acceptanceStatus: checked.validation.pass ? (checked.appliedFixes.length > 0 ? "repaired" : "accepted") : "rejected",
    },
  };
}

export function buildTeacherQuickReview(validation: GraphValidationResult): string[] {
  const checks = [
    validation.pass ? "Axes present and structurally valid" : "Axes/range issues detected",
    validation.warnings.some((w) => w.code === "grid_utilization") ? "Scale may under-use grid" : "Scale uses grid sensibly",
    validation.warnings.some((w) => w.code === "units_missing") ? "Units likely missing on one axis" : "Units present/recognisable",
    validation.issues.some((i) => i.code === "histogram_y_label") ? "Histogram y-axis label incorrect" : "Histogram/bar convention check clear",
    validation.warnings.some((w) => w.code === "error_bars_expected") ? "Error bars expected by intent" : "Error bar expectations satisfied/not required",
  ];
  return checks;
}
