import { describe, expect, it } from "vitest";
import {
  autoFixGraphSpec,
  buildAxisScale,
  buildTeacherQuickReview,
  detectGraphIntent,
  generateDataset,
  generateGraphAssessmentPackage,
  validateGraphSpecForCambridge,
  validateWithAutoFix,
  type GraphDiagramFamily,
} from "../server/services/cambridgeGraphEngine";

const baseSpec = {
  plotType: "scatter" as const,
  equation: "2*x + 1",
  xRange: [0, 10] as [number, number],
  yRange: [0, 25] as [number, number],
  axisLabels: { x: "Time / s", y: "Distance / m" },
  showGrid: true,
  tickInterval: 1,
};

// ─── Intent Detection ────────────────────────────────────────────────────────

describe("Cambridge graph intent classification", () => {
  it("detects histogram intent and command-word skill", () => {
    const intent = detectGraphIntent({
      prompt: "Plot a histogram and use the graph to identify an anomaly.",
      subject: "Mathematics",
      level: "IGCSE",
    });

    expect(intent.requiresFigure).toBe(true);
    expect(intent.family).toBe("histogram_frequency_density");
    expect(intent.skills).toContain("plot");
    expect(intent.skills).toContain("identify_anomaly");
  });

  it("gates geography map-style requests to map/resource families", () => {
    const intent = detectGraphIntent({
      prompt: "Interpret this choropleth resource diagram.",
      subject: "Geography",
      level: "IGCSE",
    });
    expect(["choropleth_map", "flow_line_map", "topographic_profile", "triangular_graph", "population_pyramid", "bar_chart", "divided_bar_chart", "climate_graph", "scatter_best_fit"]).toContain(intent.family);
  });

  it("returns requiresFigure=false when no graph keywords present", () => {
    const intent = detectGraphIntent({
      prompt: "Solve the quadratic equation.",
      subject: "Mathematics",
      level: "IGCSE",
    });
    expect(intent.requiresFigure).toBe(false);
    expect(intent.figureMode).toBe("none");
    expect(intent.skills).toHaveLength(0);
  });

  it("detects sketch skill and sets student_completed mode", () => {
    const intent = detectGraphIntent({
      prompt: "Sketch the graph of y = x^2.",
      subject: "Mathematics",
      level: "IGCSE",
    });
    expect(intent.requiresFigure).toBe(true);
    expect(intent.skills).toContain("sketch");
    expect(intent.figureMode).toBe("student_completed");
  });

  it("detects gradient skill from command words", () => {
    const intent = detectGraphIntent({
      prompt: "Use the graph to calculate gradient.",
      subject: "Physics",
      level: "IGCSE",
    });
    expect(intent.skills).toContain("calculate_gradient");
  });

  it("detects multiple skills from complex prompt", () => {
    const intent = detectGraphIntent({
      prompt: "Plot the scatter data, draw a best fit line, and extrapolate to find the value at x=20.",
      subject: "Physics",
      level: "IGCSE",
    });
    expect(intent.skills).toContain("plot");
    expect(intent.skills).toContain("extrapolate");
    expect(intent.family).toBe("scatter_best_fit");
  });

  it("uses commandWords input when provided", () => {
    const intent = detectGraphIntent({
      prompt: "",
      commandWords: ["interpolate", "error bars"],
      subject: "Physics",
      level: "A Level",
    });
    expect(intent.skills).toContain("interpolate");
    expect(intent.skills).toContain("use_error_bars");
  });

  it("selects kinematics_graph for velocity-time prompts", () => {
    const intent = detectGraphIntent({
      prompt: "Plot a velocity-time graph for the motion described.",
      subject: "Physics",
      level: "IGCSE",
    });
    expect(intent.family).toBe("kinematics_graph");
  });

  it("selects cumulative_frequency for ogive keywords", () => {
    const intent = detectGraphIntent({
      prompt: "Draw the cumulative frequency curve (ogive).",
      subject: "Mathematics",
      level: "IGCSE",
    });
    expect(intent.family).toBe("cumulative_frequency");
  });

  it("selects titration_curve for chemistry titration", () => {
    const intent = detectGraphIntent({
      prompt: "Sketch the titration curve for NaOH and HCl.",
      subject: "Chemistry",
      level: "IGCSE",
    });
    expect(intent.family).toBe("titration_curve");
  });

  it("falls back to first allowed family for unknown subject", () => {
    const intent = detectGraphIntent({
      prompt: "Plot a graph of the data.",
      subject: "Art",
      level: "GCSE",
    });
    expect(intent.requiresFigure).toBe(true);
    expect(intent.reasons.length).toBeGreaterThan(0);
  });
});

// ─── Axis Scale ──────────────────────────────────────────────────────────────

describe("buildAxisScale", () => {
  it("builds sensible axis scale with >50% utilization for compact ranges", () => {
    const axis = buildAxisScale([12, 13, 14, 14.5, 15], { allowFalseOrigin: true });
    expect(axis.max).toBeGreaterThan(axis.min);
    expect(axis.tick).toBeGreaterThan(0);
    expect(axis.gridUtilization).toBeGreaterThan(0.5);
  });

  it("returns safe defaults for empty array", () => {
    const axis = buildAxisScale([]);
    expect(axis.min).toBe(0);
    expect(axis.max).toBe(10);
    expect(axis.tick).toBe(1);
    expect(axis.gridUtilization).toBe(0);
  });

  it("handles single-value array", () => {
    const axis = buildAxisScale([5]);
    expect(axis.min).toBeLessThanOrEqual(5);
    expect(axis.max).toBeGreaterThanOrEqual(5);
    expect(axis.tick).toBeGreaterThan(0);
  });

  it("handles all-negative values", () => {
    const axis = buildAxisScale([-10, -8, -5, -3]);
    expect(axis.min).toBeLessThanOrEqual(-10);
    expect(axis.max).toBeGreaterThanOrEqual(-3);
    expect(axis.tick).toBeGreaterThan(0);
    expect(axis.usedFalseOrigin).toBe(false);
  });

  it("includes zero when includeZero=true", () => {
    const axis = buildAxisScale([10, 20, 30], { includeZero: true });
    expect(axis.min).toBeLessThanOrEqual(0);
  });

  it("uses false origin for tight high-value ranges", () => {
    const axis = buildAxisScale([90, 92, 95, 98, 100], { allowFalseOrigin: true });
    expect(axis.usedFalseOrigin).toBe(true);
    expect(axis.min).toBeGreaterThan(0);
    expect(axis.gridUtilization).toBeGreaterThan(0.3);
  });

  it("does not use false origin when ratio is wide", () => {
    const axis = buildAxisScale([1, 50, 100], { allowFalseOrigin: true });
    expect(axis.usedFalseOrigin).toBe(false);
  });

  it("does not use false origin when includeZero is true", () => {
    const axis = buildAxisScale([90, 95, 100], { allowFalseOrigin: true, includeZero: true });
    expect(axis.usedFalseOrigin).toBe(false);
    expect(axis.min).toBeLessThanOrEqual(0);
  });

  it("handles Infinity/NaN values gracefully", () => {
    const axis = buildAxisScale([Infinity, -Infinity, NaN]);
    expect(axis.min).toBe(0);
    expect(axis.max).toBe(10);
  });

  it("handles very large values", () => {
    const axis = buildAxisScale([1e9, 1.1e9, 1.2e9]);
    expect(axis.tick).toBeGreaterThan(0);
    expect(axis.max).toBeGreaterThan(axis.min);
  });

  it("handles very small values", () => {
    const axis = buildAxisScale([0.001, 0.002, 0.003]);
    expect(axis.tick).toBeGreaterThan(0);
    expect(axis.max).toBeGreaterThan(axis.min);
  });
});

// ─── Validation ──────────────────────────────────────────────────────────────

describe("Cambridge validation rules", () => {
  it("flags histogram y-axis naming errors", () => {
    const result = validateGraphSpecForCambridge(
      { ...baseSpec, axisLabels: { x: "Height / cm", y: "Frequency" } },
      {
        requiresFigure: true,
        figureMode: "student_completed",
        family: "histogram_frequency_density",
        skills: ["plot"],
        reasons: ["histogram keyword"],
        subjectTemplate: "IGCSE Maths histogram",
      }
    );

    expect(result.pass).toBe(false);
    expect(result.issues.some((issue) => issue.code === "histogram_y_label")).toBe(true);
  });

  it("passes a well-formed spec with no intent", () => {
    const result = validateGraphSpecForCambridge(baseSpec);
    expect(result.pass).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it("flags missing axis labels", () => {
    const result = validateGraphSpecForCambridge({
      ...baseSpec,
      axisLabels: { x: "", y: "Distance / m" },
    });
    expect(result.pass).toBe(false);
    expect(result.issues.some((i) => i.code === "axis_label_missing")).toBe(true);
  });

  it("flags reversed ranges", () => {
    const result = validateGraphSpecForCambridge({
      ...baseSpec,
      xRange: [10, 0] as [number, number],
    });
    expect(result.pass).toBe(false);
    expect(result.issues.some((i) => i.code === "invalid_range")).toBe(true);
  });

  it("flags negative tick interval", () => {
    const result = validateGraphSpecForCambridge({
      ...baseSpec,
      tickInterval: -5,
    });
    expect(result.pass).toBe(false);
    expect(result.issues.some((i) => i.code === "invalid_tick")).toBe(true);
  });

  it("warns about excessive tick count (under-utilized grid)", () => {
    const result = validateGraphSpecForCambridge({
      ...baseSpec,
      xRange: [0, 100] as [number, number],
      yRange: [0, 100] as [number, number],
      tickInterval: 1,
    });
    expect(result.warnings.some((w) => w.code === "grid_utilization")).toBe(true);
  });

  it("does not false-positive on grid utilization for reasonable scales", () => {
    const result = validateGraphSpecForCambridge({
      ...baseSpec,
      xRange: [90, 100] as [number, number],
      yRange: [0, 15] as [number, number],
      tickInterval: 1,
    });
    expect(result.warnings.some((w) => w.code === "grid_utilization")).toBe(false);
  });

  it("warns about missing units in axis labels", () => {
    const result = validateGraphSpecForCambridge({
      ...baseSpec,
      axisLabels: { x: "Time", y: "Distance" },
    });
    expect(result.warnings.some((w) => w.code === "units_missing")).toBe(true);
  });

  it("warns when scatter intent but non-scatter plotType", () => {
    const result = validateGraphSpecForCambridge(
      { ...baseSpec, plotType: "line" as any },
      {
        requiresFigure: true,
        figureMode: "student_completed",
        family: "scatter_best_fit",
        skills: ["plot"],
        reasons: [],
        subjectTemplate: "",
      }
    );
    expect(result.warnings.some((w) => w.code === "scatter_plottype")).toBe(true);
  });

  it("warns when error bars are expected but not tagged", () => {
    const result = validateGraphSpecForCambridge(
      baseSpec,
      {
        requiresFigure: true,
        figureMode: "pre_printed",
        family: "scatter_best_fit",
        skills: ["use_error_bars"],
        reasons: [],
        subjectTemplate: "",
      }
    );
    expect(result.warnings.some((w) => w.code === "error_bars_expected")).toBe(true);
  });

  it("includes audit trail entries", () => {
    const result = validateGraphSpecForCambridge(baseSpec);
    expect(result.audit.length).toBeGreaterThan(0);
    expect(result.audit.some((a) => a.includes("axis labels"))).toBe(true);
  });
});

// ─── Auto-fix ────────────────────────────────────────────────────────────────

describe("autoFixGraphSpec", () => {
  it("auto-fixes histogram y-axis label and passes after repair", () => {
    const intent = {
      requiresFigure: true as const,
      figureMode: "student_completed" as const,
      family: "histogram_frequency_density" as const,
      skills: ["plot"] as const,
      reasons: ["histogram keyword"],
      subjectTemplate: "IGCSE Maths histogram",
    };
    const repaired = validateWithAutoFix(
      { ...baseSpec, axisLabels: { x: "Class interval", y: "Frequency" } },
      intent,
      2
    );

    expect(repaired.spec.axisLabels.y).toBe("Frequency density");
    expect(repaired.validation.pass).toBe(true);
  });

  it("fixes reversed x and y ranges", () => {
    const fixed = autoFixGraphSpec({
      ...baseSpec,
      xRange: [10, 0] as [number, number],
      yRange: [25, 5] as [number, number],
    });
    expect(fixed.spec.xRange[0]).toBeLessThan(fixed.spec.xRange[1]);
    expect(fixed.spec.yRange[0]).toBeLessThan(fixed.spec.yRange[1]);
    expect(fixed.appliedFixes).toContain("Repaired xRange ordering");
    expect(fixed.appliedFixes).toContain("Repaired yRange ordering");
  });

  it("fixes equal range values (zero span)", () => {
    const fixed = autoFixGraphSpec({
      ...baseSpec,
      xRange: [5, 5] as [number, number],
    });
    expect(fixed.spec.xRange[0]).toBeLessThan(fixed.spec.xRange[1]);
  });

  it("replaces invalid tickInterval", () => {
    const fixed = autoFixGraphSpec({ ...baseSpec, tickInterval: -1 });
    expect(fixed.spec.tickInterval).toBe(1);
    expect(fixed.appliedFixes).toContain("Replaced invalid tickInterval with 1");
  });

  it("inserts missing axis labels", () => {
    const fixed = autoFixGraphSpec({
      ...baseSpec,
      axisLabels: { x: "", y: "" },
    });
    expect(fixed.spec.axisLabels.x).toBe("x");
    expect(fixed.spec.axisLabels.y).toBe("y");
  });

  it("adds error-bars-required tag when intent expects it", () => {
    const fixed = autoFixGraphSpec(baseSpec, {
      requiresFigure: true,
      figureMode: "pre_printed",
      family: "scatter_best_fit",
      skills: ["use_error_bars"],
      reasons: [],
      subjectTemplate: "",
    });
    expect(fixed.spec.graphKind).toContain("error-bars-required");
  });

  it("returns zero fixes when spec is already valid", () => {
    const fixed = autoFixGraphSpec(baseSpec);
    expect(fixed.appliedFixes).toHaveLength(0);
    expect(fixed.spec.xRange).toEqual(baseSpec.xRange);
  });

  it("handles multi-pass repair via validateWithAutoFix", () => {
    const result = validateWithAutoFix(
      { ...baseSpec, xRange: [5, 1] as [number, number], yRange: [10, 2] as [number, number], tickInterval: -1, axisLabels: { x: "", y: "" } },
      {
        requiresFigure: true,
        figureMode: "pre_printed",
        family: "scatter_best_fit",
        skills: ["use_error_bars"],
        reasons: ["error bars command word"],
        subjectTemplate: "A Level Physics practical",
      }
    );

    expect(result.spec.xRange[0]).toBeLessThan(result.spec.xRange[1]);
    expect(result.spec.tickInterval).toBe(1);
    expect(result.appliedFixes.length).toBeGreaterThan(0);
  });
});

// ─── Dataset Generation ──────────────────────────────────────────────────────

describe("generateDataset", () => {
  it("returns practical dataset variants including outlier-ready scatter data", () => {
    const easy = generateDataset("scatter_best_fit", "easy");
    const hard = generateDataset("scatter_best_fit", "hard");

    expect(easy.length).toBeGreaterThan(3);
    expect(hard.length).toBeGreaterThan(3);
    expect(hard).not.toEqual(easy);
  });

  it("returns histogram data with frequency density", () => {
    const data = generateDataset("histogram_frequency_density", "medium");
    expect(data.length).toBeGreaterThan(0);
    expect(data[0]).toHaveProperty("frequencyDensity");
    expect(data[0]).toHaveProperty("classInterval");
  });

  it("returns cumulative frequency data with upper bounds", () => {
    const data = generateDataset("cumulative_frequency", "medium");
    expect(data.length).toBeGreaterThan(0);
    expect(data[0]).toHaveProperty("upperBound");
    expect(data[0]).toHaveProperty("cumulativeFrequency");
  });

  it("returns bar chart data with categories", () => {
    const data = generateDataset("bar_chart", "medium");
    expect(data.length).toBeGreaterThan(0);
    expect(data[0]).toHaveProperty("category");
    expect(data[0]).toHaveProperty("value");
  });

  it("returns climate graph data with temperature and rainfall", () => {
    const data = generateDataset("climate_graph", "medium");
    expect(data.length).toBeGreaterThan(0);
    expect(data[0]).toHaveProperty("month");
    expect(data[0]).toHaveProperty("rainfallMm");
    expect(data[0]).toHaveProperty("temperatureC");
  });

  it("returns default xy data for unrecognized families", () => {
    const data = generateDataset("pie_chart" as GraphDiagramFamily, "medium");
    expect(data.length).toBeGreaterThan(0);
    expect(data[0]).toHaveProperty("x");
    expect(data[0]).toHaveProperty("y");
  });

  it("produces different data for different difficulties", () => {
    const easy = generateDataset("histogram_frequency_density", "easy");
    const hard = generateDataset("histogram_frequency_density", "hard");
    expect(easy).not.toEqual(hard);
  });
});

// ─── Package Generation ──────────────────────────────────────────────────────

describe("Assessment package generation", () => {
  it("generates full assessment package with mark scheme and audit metadata", () => {
    const pkg = generateGraphAssessmentPackage(
      {
        prompt: "Plot the data and determine gradient.",
        subject: "Physics",
        level: "IGCSE",
        syllabus: "Cambridge",
        syllabusCode: "0625",
        topic: "Forces and motion",
        difficulty: "medium",
      },
      baseSpec
    );

    expect(pkg.questionStem.length).toBeGreaterThan(10);
    expect(pkg.studentInstruction.toLowerCase()).toContain("plot");
    expect(pkg.markScheme.method.length).toBeGreaterThan(1);
    expect(pkg.auditMetadata.intentReasons.length).toBeGreaterThan(0);
    expect(pkg.validation.audit.length).toBeGreaterThan(0);
  });

  it("generates sketch instruction for sketch-type prompts", () => {
    const pkg = generateGraphAssessmentPackage(
      { prompt: "Sketch the curve y = sin(x).", subject: "Mathematics", level: "IGCSE" },
      baseSpec
    );
    expect(pkg.studentInstruction.toLowerCase()).toContain("sketch");
  });

  it("generates interpret instruction for non-plot/sketch prompts", () => {
    const pkg = generateGraphAssessmentPackage(
      { prompt: "Use the graph to determine the rate of reaction.", subject: "Chemistry", level: "IGCSE" },
      baseSpec
    );
    expect(pkg.studentInstruction.toLowerCase()).toContain("provided");
  });

  it("uses prompt as questionStem when provided", () => {
    const pkg = generateGraphAssessmentPackage(
      { prompt: "My custom question stem", subject: "Mathematics", level: "IGCSE" },
      baseSpec
    );
    expect(pkg.questionStem).toBe("My custom question stem");
  });

  it("generates fallback stem when no prompt provided", () => {
    const pkg = generateGraphAssessmentPackage(
      { subject: "Mathematics", level: "IGCSE" },
      baseSpec
    );
    expect(pkg.questionStem).toContain("Cambridge-style");
  });

  it("reports accepted status for already-valid spec", () => {
    const pkg = generateGraphAssessmentPackage(
      { prompt: "Plot scatter data", subject: "Physics", level: "IGCSE" },
      baseSpec
    );
    expect(pkg.auditMetadata.acceptanceStatus).toBe("accepted");
  });

  it("reports repaired status when auto-fix was needed", () => {
    const pkg = generateGraphAssessmentPackage(
      { prompt: "Plot a histogram", subject: "Mathematics", level: "IGCSE" },
      { ...baseSpec, axisLabels: { x: "Class", y: "Frequency" } }
    );
    expect(pkg.auditMetadata.acceptanceStatus).toBe("repaired");
  });

  it("includes curriculum alignment from input", () => {
    const pkg = generateGraphAssessmentPackage(
      { prompt: "Plot graph", subject: "Physics", level: "A Level", syllabus: "Cambridge", syllabusCode: "9702", topic: "Mechanics" },
      baseSpec
    );
    expect(pkg.curriculumAlignment.subject).toBe("Physics");
    expect(pkg.curriculumAlignment.level).toBe("A Level");
    expect(pkg.curriculumAlignment.syllabusCode).toBe("9702");
  });

  it("adds gradient mark scheme items for gradient skill", () => {
    const pkg = generateGraphAssessmentPackage(
      { prompt: "Plot the data and determine the gradient.", subject: "Physics", level: "IGCSE" },
      baseSpec
    );
    expect(pkg.markScheme.method.some((m) => m.toLowerCase().includes("gradient"))).toBe(true);
    expect(pkg.markScheme.accuracy.some((a) => a.toLowerCase().includes("gradient"))).toBe(true);
  });
});

// ─── Teacher Quick Review ────────────────────────────────────────────────────

describe("buildTeacherQuickReview", () => {
  it("builds quick teacher review checklist", () => {
    const validation = validateGraphSpecForCambridge(baseSpec);
    const checks = buildTeacherQuickReview(validation);
    expect(checks.length).toBeGreaterThanOrEqual(5);
  });

  it("reports issues accurately in checklist", () => {
    const validation = validateGraphSpecForCambridge({
      ...baseSpec,
      axisLabels: { x: "Time", y: "Distance" },
    });
    const checks = buildTeacherQuickReview(validation);
    expect(checks.some((c) => c.includes("Units likely missing"))).toBe(true);
  });

  it("reports pass status for valid spec", () => {
    const validation = validateGraphSpecForCambridge(baseSpec);
    const checks = buildTeacherQuickReview(validation);
    expect(checks.some((c) => c.includes("structurally valid"))).toBe(true);
  });
});
