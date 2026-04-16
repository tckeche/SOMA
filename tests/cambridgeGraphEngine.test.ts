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
});

describe("Cambridge axis and validation rules", () => {
  it("builds sensible axis scale with >50% utilization for compact ranges", () => {
    const axis = buildAxisScale([12, 13, 14, 14.5, 15], { allowFalseOrigin: true });
    expect(axis.max).toBeGreaterThan(axis.min);
    expect(axis.tick).toBeGreaterThan(0);
    expect(axis.gridUtilization).toBeGreaterThan(0.5);
  });

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
});

describe("Dataset suite and package generation", () => {
  it("returns practical dataset variants including outlier-ready scatter data", () => {
    const easy = generateDataset("scatter_best_fit", "easy");
    const hard = generateDataset("scatter_best_fit", "hard");

    expect(easy.length).toBeGreaterThan(3);
    expect(hard.length).toBeGreaterThan(3);
    expect(hard).not.toEqual(easy);
  });

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

  it("builds quick teacher review checklist", () => {
    const validation = validateGraphSpecForCambridge(baseSpec);
    const checks = buildTeacherQuickReview(validation);
    expect(checks.length).toBeGreaterThanOrEqual(5);
  });

  it("supports explicit auto-fix helper", () => {
    const fixed = autoFixGraphSpec(
      { ...baseSpec, xRange: [5, 1], yRange: [10, 2], tickInterval: -1, axisLabels: { x: "", y: "" } },
      {
        requiresFigure: true,
        figureMode: "pre_printed",
        family: "scatter_best_fit",
        skills: ["use_error_bars"],
        reasons: ["error bars command word"],
        subjectTemplate: "A Level Physics practical",
      }
    );

    expect(fixed.spec.xRange[0]).toBeLessThan(fixed.spec.xRange[1]);
    expect(fixed.spec.tickInterval).toBe(1);
    expect(fixed.appliedFixes.length).toBeGreaterThan(0);
  });
});
