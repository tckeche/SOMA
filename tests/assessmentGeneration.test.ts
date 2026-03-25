import { describe, expect, it } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import fs from "fs";
import { balanceAnswerOptions, buildCopilotSummary, buildSyllabusChunks, scoreSyllabusChunks } from "../server/services/assessmentGeneration";
import GraphPlot from "@/components/GraphPlot";

describe("balanced answer option randomisation", () => {
  it("balances correct answer positions across A/B/C/D while preserving correctness", () => {
    const questions = Array.from({ length: 8 }, (_, index) => ({
      options: [`correct-${index}`, `b-${index}`, `c-${index}`, `d-${index}`],
      correct_answer: `correct-${index}`,
    }));
    const balanced = balanceAnswerOptions(questions);
    const counts = [0, 0, 0, 0];
    balanced.forEach((question, index) => {
      const position = question.options.indexOf(`correct-${index}`);
      expect(position).toBeGreaterThanOrEqual(0);
      counts[position] += 1;
    });
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
  });
});

describe("syllabus chunking and retrieval", () => {
  it("chunks syllabus text and retrieves relevant sections", () => {
    const chunks = buildSyllabusChunks("Algebra functions equations. Geometry circles angles. Probability distributions expected value.".repeat(10), 120);
    expect(chunks.length).toBeGreaterThan(1);
    const relevant = scoreSyllabusChunks(chunks, "circles and angles");
    expect(relevant.join(" ").toLowerCase()).toContain("circles");
  });
});

describe("copilot summary output", () => {
  it("includes expected summary fields", () => {
    const summary = buildCopilotSummary({
      drafts: [{ question_type: "graph", topic_tag: "Algebra", subtopic_tag: "Linear graphs", difficulty_tag: "Mixed" }],
      syllabusContextLabel: "Cambridge IGCSE 0580",
    });
    expect(summary.numberOfQuestionsAdded).toBe(1);
    expect(summary.questionTypesUsed).toContain("graph");
    expect(summary.topicsCovered).toContain("Algebra");
    expect(summary.subtopicsCovered).toContain("Linear graphs");
    expect(summary.difficultyMix).toContain("Mixed");
    expect(summary.syllabusContextUsed).toContain("Cambridge IGCSE 0580");
  });
});

describe("graph question rendering and theme/button safeguards", () => {
  it("renders a graph spec without breaking question layout", () => {
    const html = renderToStaticMarkup(React.createElement(GraphPlot, {
      spec: {
        plotType: "line",
        equation: "y = 2*x + 1",
        xRange: [-5, 5],
        yRange: [-5, 15],
        axisLabels: { x: "x", y: "y" },
        showGrid: true,
        tickInterval: 1,
      },
    }));
    expect(html).toContain("Cartesian graph");
    expect(html).toContain("svg");
    // Equation label rendered italic on single-curve graph
    // React serializes fontStyle prop as font-style in SVG HTML output
    expect(html).toContain("font-style");
    // Equation text is prettified — raw JS multiplication (*) becomes implicit
    // prettyEquation("y = 2*x + 1") → "2x + 1" (strips "y =", converts 2*x → 2x)
    expect(html).toContain("2x + 1");
    // Raw JS expression must NOT appear verbatim on the graph
    expect(html).not.toContain("2*x + 1");
    // Unique clip/marker IDs — must NOT use bare hardcoded "plot-clip" or "arrowhead"
    expect(html).not.toContain('"plot-clip"');
    expect(html).not.toContain('"arrowhead"');
  });

  it("renders two GraphPlot instances in the same tree with distinct SVG IDs (no conflicts)", () => {
    const spec = {
      plotType: "line" as const,
      equation: "x^2",
      xRange: [-3, 3] as [number, number],
      yRange: [-1, 10] as [number, number],
      axisLabels: { x: "x", y: "y" },
      showGrid: false,
      tickInterval: 1,
    };
    // Render BOTH in the same tree so useId() increments its counter across instances
    const html = renderToStaticMarkup(
      React.createElement(
        React.Fragment,
        null,
        React.createElement(GraphPlot, { spec }),
        React.createElement(GraphPlot, { spec }),
      )
    );
    // Extract all clip IDs
    const clipIds = [...html.matchAll(/id="(plot-clip-[^"]+)"/g)].map(m => m[1]);
    expect(clipIds.length).toBe(2);
    expect(clipIds[0]).not.toBe(clipIds[1]);
    // Legacy hardcoded IDs must not appear
    expect(html).not.toContain('"plot-clip"');
    expect(html).not.toContain('"arrowhead"');
  });

  it("uses spec.label verbatim instead of raw JS equation when label is provided", () => {
    const html = renderToStaticMarkup(React.createElement(GraphPlot, {
      spec: {
        plotType: "line",
        equation: "Math.sin(x * Math.PI / 180)",
        label: "y = sin x°",
        xRange: [0, 360],
        yRange: [-1.5, 1.5],
        axisLabels: { x: "x (deg)", y: "y" },
        showGrid: true,
        tickInterval: 90,
      },
    }));
    // The clean label should appear, not the raw JS
    expect(html).toContain("sin x°");
    expect(html).not.toContain("Math.sin");
    expect(html).not.toContain("Math.PI");
  });

  it("prettyEquation converts Math.sin(x * Math.PI / 180) to sin x° when no label", () => {
    const html = renderToStaticMarkup(React.createElement(GraphPlot, {
      spec: {
        plotType: "line",
        equation: "Math.sin(x * Math.PI / 180)",
        xRange: [0, 360],
        yRange: [-1.5, 1.5],
        axisLabels: { x: "x (deg)", y: "y" },
        showGrid: true,
        tickInterval: 90,
      },
    }));
    // Prettified — raw JS must not appear
    expect(html).toContain("sin x°");
    expect(html).not.toContain("Math.sin");
    expect(html).not.toContain("Math.PI");
  });

  it("shows a fallback when graphSpec is invalid", () => {
    const html = renderToStaticMarkup(React.createElement(GraphPlot, {
      spec: {
        plotType: "line",
        equation: "",       // no equation
        xRange: [5, 1],    // invalid (min > max)
        yRange: [-5, 5],
        axisLabels: { x: "x", y: "y" },
        showGrid: false,
        tickInterval: 1,
      } as any,
    }));
    expect(html).toContain("invalid or incomplete");
    expect(html).not.toContain("Cartesian graph");
  });

  it("forces dark mode and removes the light-mode toggle from the app shell", () => {
    const mainSource = fs.readFileSync("client/src/main.tsx", "utf8");
    const appSource = fs.readFileSync("client/src/App.tsx", "utf8");
    expect(mainSource).toContain('forcedTheme="dark"');
    expect(appSource).not.toContain("ThemeToggle");
  });

  it("keeps Back / Exit Preview / Exit Assessment buttons on the shared default size", () => {
    const builderSource = fs.readFileSync("client/src/pages/builder.tsx", "utf8");
    const quizSource = fs.readFileSync("client/src/pages/soma-quiz.tsx", "utf8");
    expect(builderSource).toContain('data-testid="button-back-admin"');
    expect(builderSource).toContain('size="default"');
    expect(quizSource).toContain('data-testid="button-exit-preview"');
    expect(quizSource).toContain('data-testid="button-soma-back"');
  });
});
