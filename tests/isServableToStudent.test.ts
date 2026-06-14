/**
 * STUDENT PUBLISH-GATE REGRESSION.
 *
 * Only approved questions (or legacy rows whose reviewStatus is null, which the
 * DB defaults to "approved") may be served to students. "needs_review" and
 * "auto_blocked" must never reach a student. This pins the filter helper used by
 * the two student-facing question endpoints.
 */
import { describe, it, expect } from "vitest";

import { isServableToStudent } from "../server/services/questionQuality";

describe("isServableToStudent", () => {
  it("keeps approved questions", () => {
    expect(isServableToStudent({ reviewStatus: "approved" })).toBe(true);
  });

  it("treats legacy null reviewStatus as servable (DB default is approved)", () => {
    expect(isServableToStudent({ reviewStatus: null })).toBe(true);
    expect(isServableToStudent({})).toBe(true);
  });

  it("excludes needs_review", () => {
    expect(isServableToStudent({ reviewStatus: "needs_review" })).toBe(false);
  });

  it("excludes auto_blocked", () => {
    expect(isServableToStudent({ reviewStatus: "auto_blocked" })).toBe(false);
  });
});
