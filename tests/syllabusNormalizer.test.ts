/**
 * Unit tests for the syllabus normaliser used by the catalogue matcher and
 * the quiz-save endpoints.
 *
 * Asserts that:
 *   - `extractSyllabusCode` returns the first 4-digit code embedded in noise
 *     and null when none exists.
 *   - `normalizeQuizSyllabusForWrite` collapses whitespace, trims ends, and
 *     turns empty into null while preserving the descriptive label.
 */
import { describe, it, expect } from "vitest";
import {
  extractSyllabusCode,
  normalizeQuizSyllabusForWrite,
} from "../server/services/syllabusNormalizer";

describe("extractSyllabusCode", () => {
  it("returns the bare code unchanged", () => {
    expect(extractSyllabusCode("9709")).toBe("9709");
  });

  it("extracts the code from descriptive prefixes", () => {
    expect(extractSyllabusCode("Cambridge Syllabus · 9709")).toBe("9709");
    expect(extractSyllabusCode("Cambridge (CAIE) 9709")).toBe("9709");
    expect(extractSyllabusCode("Cambridge · mathematics-0580-2028-2030")).toBe("0580");
  });

  it("returns the first code when more than one 4-digit number is present", () => {
    expect(extractSyllabusCode("Cambridge 9709 (was 0580)")).toBe("9709");
  });

  it("prefers a Cambridge-shape code (0xxx / 9xxx) over a year token", () => {
    // Without the Cambridge-shape preference, a year that appears before the
    // code (e.g. "(2019) ... 9709") would be returned. We must always pull
    // the actual syllabus code regardless of token order.
    expect(extractSyllabusCode("Cambridge (2019) 9709")).toBe("9709");
    expect(extractSyllabusCode("Cambridge 2027 syllabus 0460")).toBe("0460");
    expect(
      extractSyllabusCode("Cambridge · geography-0460-2027-2029"),
    ).toBe("0460");
  });

  it("falls back to any 4-digit token when no Cambridge-shape code is present", () => {
    // Best-effort for non-Cambridge boards whose codes don't follow the 0xxx /
    // 9xxx convention; better than failing outright.
    expect(extractSyllabusCode("Edexcel 1MA1")).toBeNull();
    expect(extractSyllabusCode("OCR 8500")).toBe("8500");
  });

  it("returns null when no 4-digit code is present", () => {
    expect(extractSyllabusCode("Cambridge")).toBeNull();
    expect(extractSyllabusCode("Cambridge ")).toBeNull();
    expect(extractSyllabusCode("cambridge")).toBeNull();
    expect(extractSyllabusCode("Cambridgee")).toBeNull();
    expect(extractSyllabusCode("")).toBeNull();
  });

  it("ignores 3- and 5-digit numbers that aren't standalone codes", () => {
    expect(extractSyllabusCode("Cambridge 970")).toBeNull();
    expect(extractSyllabusCode("Cambridge 97091")).toBeNull();
  });

  it("handles null and undefined input", () => {
    expect(extractSyllabusCode(null)).toBeNull();
    expect(extractSyllabusCode(undefined)).toBeNull();
  });
});

describe("normalizeQuizSyllabusForWrite", () => {
  it("trims leading and trailing whitespace", () => {
    expect(normalizeQuizSyllabusForWrite("Cambridge ")).toBe("Cambridge");
    expect(normalizeQuizSyllabusForWrite("  Cambridge Syllabus · 9709  ")).toBe(
      "Cambridge Syllabus · 9709",
    );
  });

  it("collapses runs of whitespace inside the string", () => {
    expect(normalizeQuizSyllabusForWrite("Cambridge   Syllabus  ·   9709")).toBe(
      "Cambridge Syllabus · 9709",
    );
  });

  it("returns null for empty / whitespace-only / null / undefined input", () => {
    expect(normalizeQuizSyllabusForWrite("")).toBeNull();
    expect(normalizeQuizSyllabusForWrite("   ")).toBeNull();
    expect(normalizeQuizSyllabusForWrite(null)).toBeNull();
    expect(normalizeQuizSyllabusForWrite(undefined)).toBeNull();
  });

  it("preserves the original descriptive label (does not strip down to the code)", () => {
    // Display strings in the UI should survive intact — only extractSyllabusCode
    // is allowed to pull the bare code.
    expect(normalizeQuizSyllabusForWrite("Cambridge (CAIE) 9709")).toBe(
      "Cambridge (CAIE) 9709",
    );
  });
});
