import { describe, it, expect } from "vitest";
import {
  formatDateShort,
  isPaperCode,
  subtopicSegments,
  joinSubtopics,
  assessmentDisplayName,
  assessmentSecondaryLabel,
} from "../client/src/lib/assessmentNaming";

describe("formatDateShort", () => {
  // Use local-time Date constructors so the assertions are deterministic
  // regardless of the runtime timezone (the formatter renders in local time).
  it("renders a compact '23 Jun' style date", () => {
    expect(formatDateShort(new Date(2026, 5, 23, 10, 30))).toBe("23 Jun");
  });

  it("returns em dash for null / empty / invalid dates", () => {
    expect(formatDateShort(null)).toBe("—");
    expect(formatDateShort("")).toBe("—");
    expect(formatDateShort("not-a-date")).toBe("—");
  });

  it("accepts a Date instance", () => {
    expect(formatDateShort(new Date(2026, 0, 5))).toBe("5 Jan");
  });
});

describe("isPaperCode", () => {
  it("matches paper codes in various forms", () => {
    expect(isPaperCode("P1")).toBe(true);
    expect(isPaperCode("p2")).toBe(true);
    expect(isPaperCode("P 3")).toBe(true);
    expect(isPaperCode("Paper 2")).toBe(true);
    expect(isPaperCode("paper4")).toBe(true);
    expect(isPaperCode("  P1  ")).toBe(true);
  });

  it("does not match real subtopics", () => {
    expect(isPaperCode("Functions")).toBe(false);
    expect(isPaperCode("Pure Mathematics")).toBe(false);
    expect(isPaperCode("Probability")).toBe(false);
  });
});

describe("subtopicSegments", () => {
  it("uses the topics array and strips paper codes", () => {
    expect(
      subtopicSegments({ topics: ["Functions", "P1", "Quadratics"] }),
    ).toEqual(["Functions", "Quadratics"]);
  });

  it("trims and drops empty entries", () => {
    expect(subtopicSegments({ topics: ["  Series ", "", "  "] })).toEqual([
      "Series",
    ]);
  });

  it("falls back to the legacy single topic string", () => {
    expect(
      subtopicSegments({ topics: [], topic: "Functions, Quadratics; Series" }),
    ).toEqual(["Functions", "Quadratics", "Series"]);
  });

  it("returns an empty list when nothing usable is present", () => {
    expect(subtopicSegments({ topics: [], topic: "P1" })).toEqual([]);
    expect(subtopicSegments({})).toEqual([]);
  });
});

describe("joinSubtopics", () => {
  it("handles one, two, and three subtopics", () => {
    expect(joinSubtopics(["Functions"])).toBe("Functions");
    expect(joinSubtopics(["Functions", "Quadratics"])).toBe(
      "Functions & Quadratics",
    );
    expect(joinSubtopics(["Functions", "Quadratics", "Series"])).toBe(
      "Functions, Quadratics & Series",
    );
  });

  it("collapses more than three into 'Assorted Topics'", () => {
    expect(
      joinSubtopics(["A", "B", "C", "D"]),
    ).toBe("Assorted Topics");
  });

  it("returns empty string for no subtopics", () => {
    expect(joinSubtopics([])).toBe("");
  });
});

describe("assessmentDisplayName", () => {
  it("uses the quiz's actual title as the primary name", () => {
    expect(assessmentDisplayName({ title: "My Custom Quiz" })).toBe(
      "My Custom Quiz",
    );
  });

  it("prefers the title even when level/subject/topics are present", () => {
    // The actual name must win — the level/subject/topics belong on the
    // secondary label, never the headline.
    expect(
      assessmentDisplayName({
        title: "Quadratics Practice",
        level: "AS",
        subject: "Pure Mathematics",
        topics: ["Functions", "Quadratics", "Series"],
      }),
    ).toBe("Quadratics Practice");
  });

  it("falls back to a composed level/subject/subtopics name when there is no title", () => {
    expect(
      assessmentDisplayName({
        level: "AS",
        subject: "Pure Mathematics",
        topics: ["Functions", "Quadratics", "Series"],
      }),
    ).toBe("AS Pure Mathematics · Functions, Quadratics & Series");
  });

  it("falls back gracefully when level/subject are missing", () => {
    expect(
      assessmentDisplayName({ level: null, subject: null, topics: ["Functions"] }),
    ).toBe("Functions");
  });

  it("uses a default when nothing usable is present", () => {
    expect(assessmentDisplayName({})).toBe("Assessment");
  });
});

describe("assessmentSecondaryLabel", () => {
  it("composes level, subject and subtopics with a middot separator", () => {
    expect(
      assessmentSecondaryLabel({
        level: "AS",
        subject: "Pure Mathematics",
        topics: ["Functions", "Quadratics", "Series"],
      }),
    ).toBe("AS Pure Mathematics · Functions, Quadratics & Series");
  });

  it("shows 'Assorted Topics' when more than three subtopics", () => {
    expect(
      assessmentSecondaryLabel({
        level: "AS",
        subject: "Pure Mathematics",
        topics: ["A", "B", "C", "D"],
      }),
    ).toBe("AS Pure Mathematics · Assorted Topics");
  });

  it("excludes paper codes from the label", () => {
    expect(
      assessmentSecondaryLabel({
        level: "A2",
        subject: "Physics",
        topics: ["P1", "Mechanics"],
      }),
    ).toBe("A2 Physics · Mechanics");
  });

  it("uses just the head when there are no usable subtopics", () => {
    expect(
      assessmentSecondaryLabel({ level: "AS", subject: "Pure Mathematics", topics: ["P1"] }),
    ).toBe("AS Pure Mathematics");
  });

  it("returns an empty string when there is nothing to show", () => {
    expect(assessmentSecondaryLabel({})).toBe("");
  });
});
