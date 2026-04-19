import { describe, it, expect } from "vitest";
import {
  computeAssignmentStatus,
  ASSIGNMENT_STATUS_META,
} from "../shared/assignmentStatus";

const NOW = new Date("2026-04-19T12:00:00Z");
const YESTERDAY = new Date("2026-04-18T12:00:00Z");
const TOMORROW = new Date("2026-04-20T12:00:00Z");

describe("computeAssignmentStatus", () => {
  it("returns not_opened when no report exists", () => {
    expect(
      computeAssignmentStatus({ dueDate: TOMORROW, report: null, now: NOW }),
    ).toBe("not_opened");
  });

  it("returns started when a report exists with no answers", () => {
    expect(
      computeAssignmentStatus({
        dueDate: TOMORROW,
        report: { status: "pending", answersJson: null, aiFeedbackHtml: null, completedAt: null },
        now: NOW,
      }),
    ).toBe("started");
  });

  it("returns started for an empty answers array", () => {
    expect(
      computeAssignmentStatus({
        dueDate: null,
        report: { status: "pending", answersJson: [], aiFeedbackHtml: null, completedAt: null },
        now: NOW,
      }),
    ).toBe("started");
  });

  it("returns in_progress when at least one answer is recorded (array form)", () => {
    expect(
      computeAssignmentStatus({
        dueDate: null,
        report: {
          status: "pending",
          answersJson: [{ questionId: 1, answer: "x = 4" }],
          aiFeedbackHtml: null,
          completedAt: null,
        },
        now: NOW,
      }),
    ).toBe("in_progress");
  });

  it("returns in_progress when at least one answer is recorded (object form)", () => {
    expect(
      computeAssignmentStatus({
        dueDate: null,
        report: { status: "pending", answersJson: { "1": "x = 4" }, aiFeedbackHtml: null, completedAt: null },
        now: NOW,
      }),
    ).toBe("in_progress");
  });

  it("returns submitted when completed but no feedback yet", () => {
    expect(
      computeAssignmentStatus({
        dueDate: TOMORROW,
        report: { status: "completed", answersJson: [{}], aiFeedbackHtml: null, completedAt: NOW },
        now: NOW,
      }),
    ).toBe("submitted");
  });

  it("returns submitted when aiFeedbackHtml is only whitespace", () => {
    expect(
      computeAssignmentStatus({
        dueDate: TOMORROW,
        report: { status: "completed", answersJson: [{}], aiFeedbackHtml: "   ", completedAt: NOW },
        now: NOW,
      }),
    ).toBe("submitted");
  });

  it("returns feedback_ready when completed and aiFeedbackHtml is populated", () => {
    expect(
      computeAssignmentStatus({
        dueDate: TOMORROW,
        report: {
          status: "completed",
          answersJson: [{}],
          aiFeedbackHtml: "<p>Great work on linear equations…</p>",
          completedAt: NOW,
        },
        now: NOW,
      }),
    ).toBe("feedback_ready");
  });

  it("returns overdue when dueDate has passed and not submitted", () => {
    expect(
      computeAssignmentStatus({
        dueDate: YESTERDAY,
        report: null,
        now: NOW,
      }),
    ).toBe("overdue");
  });

  it("returns overdue over in_progress when past due", () => {
    expect(
      computeAssignmentStatus({
        dueDate: YESTERDAY,
        report: { status: "pending", answersJson: [{}], aiFeedbackHtml: null, completedAt: null },
        now: NOW,
      }),
    ).toBe("overdue");
  });

  it("does NOT return overdue if already submitted, even past due date", () => {
    expect(
      computeAssignmentStatus({
        dueDate: YESTERDAY,
        report: { status: "completed", answersJson: [{}], aiFeedbackHtml: null, completedAt: YESTERDAY },
        now: NOW,
      }),
    ).toBe("submitted");
  });

  it("treats a report with completedAt set but status missing as completed", () => {
    expect(
      computeAssignmentStatus({
        dueDate: null,
        report: { status: null, answersJson: [{}], aiFeedbackHtml: null, completedAt: YESTERDAY },
        now: NOW,
      }),
    ).toBe("submitted");
  });
});

describe("ASSIGNMENT_STATUS_META", () => {
  it("has a label and tone for every status", () => {
    const statuses = [
      "assigned", "seen", "started", "in_progress",
      "submitted", "feedback_ready", "overdue", "not_opened",
    ] as const;
    for (const s of statuses) {
      expect(ASSIGNMENT_STATUS_META[s].label).toBeTruthy();
      expect(ASSIGNMENT_STATUS_META[s].tone).toBeTruthy();
    }
  });
});
