import { describe, expect, it } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import fs from "fs";
import { balanceAnswerOptions, buildCopilotSummary, buildSyllabusChunks, scoreSyllabusChunks } from "../server/services/assessmentGeneration";
import GraphPlot from "@/components/GraphPlot";

describe("balanced answer option randomisation", () => {
  it("always returns exactly 4 options, keeps the correct option present, and preserves correct_answer text", () => {
    const questions = Array.from({ length: 8 }, (_, index) => ({
      options: [`correct-${index}`, `b-${index}`, `c-${index}`, `d-${index}`],
      correct_answer: `correct-${index}`,
    }));
    const balanced = balanceAnswerOptions(questions);
    balanced.forEach((question, index) => {
      expect(question.options).toHaveLength(4);
      expect(question.correct_answer).toBe(`correct-${index}`);
      expect(question.options).toContain(`correct-${index}`);
    });
  });

  it("returns the question unchanged when correct_answer is not in options (no 5-option bug)", () => {
    const question = {
      options: ["a", "b", "c", "d"],
      correct_answer: "not-present",
    };
    const [result] = balanceAnswerOptions([question]);
    expect(result.options).toHaveLength(4);
    expect(result.options).toEqual(["a", "b", "c", "d"]);
    expect(result.correct_answer).toBe("not-present");
  });

  it("keeps exactly 4 options without crashing when options contain a duplicate of the correct text", () => {
    const question = {
      options: ["dup", "dup", "c", "d"],
      correct_answer: "dup",
    };
    const [result] = balanceAnswerOptions([question]);
    expect(result.options).toHaveLength(4);
    expect(result.options.filter((o) => o === "dup")).toHaveLength(2);
    expect(result.correct_answer).toBe("dup");
  });

  it("reorders option_rationales with the same permutation so they stay aligned to options", () => {
    const questions = Array.from({ length: 8 }, (_, index) => ({
      options: [`a-${index}`, `b-${index}`, `c-${index}`, `d-${index}`],
      correct_answer: `a-${index}`,
      option_rationales: [
        { option: `a-${index}`, text: "ra" },
        { option: `b-${index}`, text: "rb" },
        { option: `c-${index}`, text: "rc" },
        { option: `d-${index}`, text: "rd" },
      ],
    }));
    const balanced = balanceAnswerOptions(questions);
    balanced.forEach((question) => {
      expect(question.option_rationales).toHaveLength(4);
      question.options.forEach((opt, i) => {
        expect(question.option_rationales![i].option).toBe(opt);
      });
    });
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
    // Equation text is prettified in the visible SVG label
    // prettyEquation("y = 2*x + 1") → "2x + 1" (strips "y =", converts 2*x → 2x)
    expect(html).toContain("2x + 1");
    // Raw JS must not appear in the VISIBLE italic label (may appear in sr-only/desc for accessibility)
    const italicParts = [...html.matchAll(/font-style="italic"[^>]*>([^<]+)</g)].map(m => m[1]);
    const visibleLabel = italicParts.find(t => t.includes("y =") || t.includes("2x"));
    expect(visibleLabel).not.toMatch(/2\*x/);
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

  it("uses spec.label verbatim instead of raw JS equation in the visible SVG label", () => {
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
    // The clean label appears in the visible SVG text element (italic, upper-right)
    expect(html).toContain("sin x°");
    // The visible italic text element must NOT contain raw JS notation
    // (raw equation is preserved only in sr-only/desc accessibility elements — that's expected)
    const svgTextMatch = html.match(/font-style="italic"[^>]*>([^<]+)</);
    expect(svgTextMatch?.[1]).not.toMatch(/Math\./);
  });

  it("prettyEquation converts Math.sin(x * Math.PI / 180) to sin x° in the visible SVG label", () => {
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
    // The visible equation label shows prettified text (not raw JS)
    expect(html).toContain("sin x°");
    // The visible italic text element (the equation label) must not contain raw JS
    // Note: raw equation intentionally preserved in sr-only/desc for accessibility
    const italicElements = [...html.matchAll(/font-style="italic"[^>]*>([^<]+)</g)].map(m => m[1]);
    const equationLabelEl = italicElements.find(t => t.includes("y ="));
    expect(equationLabelEl).toContain("sin x°");
    expect(equationLabelEl).not.toMatch(/Math\./);
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

  it("defaults to dark mode but keeps the light-mode toggle available in the app shell", () => {
    const mainSource = fs.readFileSync("client/src/main.tsx", "utf8");
    const dashboardSource = fs.readFileSync("client/src/pages/StudentDashboard.tsx", "utf8");
    // Dark remains the default entry experience for the premium redesign…
    expect(mainSource).toContain('defaultTheme="dark"');
    // …but the theme is no longer force-locked, so the dual-theme toggle works.
    expect(mainSource).not.toContain("forcedTheme");
    // The light/dark toggle is wired into the dashboard shell.
    expect(dashboardSource).toContain("ThemeToggle");
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
