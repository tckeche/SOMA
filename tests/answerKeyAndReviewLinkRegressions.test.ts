/**
 * Regression guards for two production bugs:
 *
 *   1) Wrong-answer bug — `validateAndCorrectMcqAnswers` used to silently
 *      fall back to `options[0]` when the verifier's correct_answer didn't
 *      match any option, corrupting answer keys (covered by behavioural
 *      tests in `aiPipeline.test.ts`). This file additionally pins the
 *      *plumbing* — the warnings must reach the Builder Co-Pilot UI.
 *
 *   2) "Page not found" bug — the student dashboard's Completed
 *      Assessments list used to navigate to `/soma/review/${quizId}` when
 *      `reportId` was null, which is always a 404. Pin the safe form so
 *      the dangerous `?? row.quizId` fallback can't return.
 */
import { describe, it, expect } from "vitest";
import fs from "fs";

describe("Student-side review link 404 regression guard", () => {
  const source = fs.readFileSync(
    "client/src/components/student/CompletedAssessmentsTab.tsx",
    "utf8",
  );

  it("never falls back to quizId when reportId is missing (would 404)", () => {
    // The exact buggy pattern that was producing /soma/review/<quizId>.
    expect(source).not.toMatch(/row\.reportId\s*\?\?\s*row\.quizId/);
    // Defence in depth — any "?? row.quizId" inside a review link template.
    expect(source).not.toMatch(/\/soma\/review\/\$\{[^}]*\?\?\s*row\.quizId\}/);
  });

  it("guards Review and Report buttons behind a truthy reportId check", () => {
    // The new safe form wraps both buttons in `row.reportId ? (...) : (...)`.
    expect(source).toMatch(/\{row\.reportId\s*\?/);
    // Pending state is shown when no reportId exists yet.
    expect(source).toMatch(/Report pending/);
  });
});

describe("Builder Co-Pilot warning passthrough regression guard", () => {
  const builder = fs.readFileSync("client/src/pages/builder.tsx", "utf8");

  it("renders the amber warnings block driven by m.warnings", () => {
    // The render path that surfaces validator warnings to the tutor.
    expect(builder).toMatch(/m\.warnings\s*&&\s*m\.warnings\.length\s*>\s*0/);
    expect(builder).toMatch(/data-testid=\{`block-warnings-/);
  });

  it("the copilot-chat mutationFn includes warnings in every return path", () => {
    // Locate the copilot-chat mutationFn block (between mutationFn and
    // onSuccess) and assert all return statements thread `warnings` through
    // — otherwise the amber UI block never receives them.
    const start = builder.indexOf("mutationFn: async (message: string) =>");
    expect(start).toBeGreaterThan(-1);
    const end = builder.indexOf("onSuccess:", start);
    expect(end).toBeGreaterThan(start);
    const block = builder.slice(start, end);

    const returns = block.match(/return\s*\{[^}]*\}/g) ?? [];
    expect(returns.length).toBeGreaterThanOrEqual(3);
    for (const ret of returns) {
      expect(ret).toMatch(/warnings\s*:/);
    }
  });
});
