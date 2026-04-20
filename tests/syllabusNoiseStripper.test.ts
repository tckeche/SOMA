import { describe, expect, it } from "vitest";
import {
  stripSyllabusNoise,
  stripSyllabusNoiseDetailed,
} from "../server/services/syllabusNoiseStripper";

describe("stripSyllabusNoise", () => {
  it("drops running headers, page numbers, and copyright lines", () => {
    const input = [
      "Cambridge IGCSE Mathematics 0580 syllabus for 2025, 2026 and 2027.",
      "Page 12 of 48",
      "© UCLES 2024",
      "1 Number",
      "Candidates should be able to identify and use natural numbers.",
      "Page 13",
      "IGCSE is a registered trademark.",
    ].join("\n");
    const out = stripSyllabusNoise(input);
    expect(out).toContain("1 Number");
    expect(out).toContain("Candidates should be able to identify");
    expect(out).not.toContain("Cambridge IGCSE Mathematics 0580 syllabus");
    expect(out).not.toContain("Page 12 of 48");
    expect(out).not.toContain("Page 13");
    expect(out).not.toContain("© UCLES");
    expect(out).not.toMatch(/registered trademark/i);
  });

  it("removes registration / admin section headers", () => {
    const input = [
      "2 Topics",
      "Candidates should be able to use vectors.",
      "How to register candidates",
      "Making entries",
      "Administrative guidance",
      "3 Further topics",
    ].join("\n");
    const out = stripSyllabusNoise(input);
    expect(out).toContain("2 Topics");
    expect(out).toContain("3 Further topics");
    expect(out).not.toMatch(/How to register candidates/i);
    expect(out).not.toMatch(/Administrative guidance/i);
    expect(out).not.toMatch(/Making entries/i);
  });

  it("drops standalone numeric / page-number lines but keeps 'chapter 2' style prose", () => {
    const input = [
      "12",
      "12/48",
      "Chapter 2",
      "2",
      "Use logarithms to solve equations.",
    ].join("\n");
    const out = stripSyllabusNoise(input);
    expect(out).toContain("Chapter 2");
    expect(out).toContain("Use logarithms to solve equations.");
    const lines = out.split("\n").map((l) => l.trim());
    expect(lines).not.toContain("12");
    expect(lines).not.toContain("12/48");
    expect(lines).not.toContain("2");
  });

  it("drops bullet-glyph-only shell lines", () => {
    const input = ["•", "-   •", "Real content here."].join("\n");
    const out = stripSyllabusNoise(input);
    expect(out).toBe("Real content here.");
  });

  it("collapses runs of blank lines to at most one blank line by default", () => {
    const input = "Line A\n\n\n\n\nLine B";
    const out = stripSyllabusNoise(input);
    expect(out).toBe("Line A\n\nLine B");
  });

  it("is idempotent", () => {
    const input = [
      "Cambridge IGCSE Mathematics 0580 syllabus for 2025.",
      "Page 1",
      "Topic 1: Number",
      "© UCLES 2024",
      "",
      "Candidates should be able to add.",
    ].join("\n");
    const once = stripSyllabusNoise(input);
    const twice = stripSyllabusNoise(once);
    expect(twice).toBe(once);
  });

  it("accepts extra drop patterns", () => {
    const out = stripSyllabusNoise(
      ["Topic 1", "INTERNAL DRAFT", "Content"].join("\n"),
      { extraDropPatterns: [/^INTERNAL DRAFT$/] },
    );
    expect(out).toContain("Topic 1");
    expect(out).toContain("Content");
    expect(out).not.toContain("INTERNAL DRAFT");
  });

  it("detailed helper reports kept/dropped counts", () => {
    const input = ["Page 1", "Topic 1", "© UCLES 2024", "Content line"].join("\n");
    const result = stripSyllabusNoiseDetailed(input);
    expect(result.cleaned).toContain("Topic 1");
    expect(result.cleaned).toContain("Content line");
    expect(result.droppedCount).toBeGreaterThanOrEqual(2);
    expect(result.keptCount).toBeGreaterThanOrEqual(2);
  });
});
