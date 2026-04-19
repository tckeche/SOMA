import { describe, it, expect, beforeEach } from "vitest";
import {
  buildTutorDraftKey,
  readTutorDraft,
  writeTutorDraft,
  clearTutorDraft,
  isMeaningfulDraft,
  describeDraft,
  TUTOR_DRAFT_VERSION,
  type TutorAssessmentDraft,
} from "../client/src/lib/tutorAssessmentDraft";

function makeLocalStorageShim() {
  const store = new Map<string, string>();
  const shim: Storage = {
    get length() { return store.size; },
    clear: () => store.clear(),
    getItem: (k) => (store.has(k) ? store.get(k)! : null),
    key: (i) => Array.from(store.keys())[i] ?? null,
    removeItem: (k) => { store.delete(k); },
    setItem: (k, v) => { store.set(k, v); },
  };
  return shim;
}

beforeEach(() => {
  (globalThis as any).window = { localStorage: makeLocalStorageShim() };
  (globalThis as any).localStorage = (globalThis as any).window.localStorage;
});

describe("buildTutorDraftKey", () => {
  it("returns null for empty tutorId", () => {
    expect(buildTutorDraftKey(null)).toBeNull();
    expect(buildTutorDraftKey(undefined)).toBeNull();
    expect(buildTutorDraftKey("")).toBeNull();
  });

  it("scopes key by tutorId", () => {
    expect(buildTutorDraftKey("tutor-42"))
      .toBe("soma_tutor_new_assessment_draft_tutor-42");
  });
});

describe("writeTutorDraft / readTutorDraft", () => {
  const key = "soma_tutor_new_assessment_draft_t1";

  it("round-trips a payload", () => {
    const result = writeTutorDraft(key, {
      title: "Algebra mock",
      subject: "Mathematics",
      level: "IGCSE",
      syllabus: "Cambridge",
      timeLimitMinutes: 45,
      prompt: "10 quadratic MCQs",
    });
    expect(result.ok).toBe(true);

    const loaded = readTutorDraft(key);
    expect(loaded).not.toBeNull();
    expect(loaded!.version).toBe(TUTOR_DRAFT_VERSION);
    expect(loaded!.title).toBe("Algebra mock");
    expect(loaded!.subject).toBe("Mathematics");
    expect(loaded!.level).toBe("IGCSE");
    expect(loaded!.syllabus).toBe("Cambridge");
    expect(loaded!.timeLimitMinutes).toBe(45);
    expect(loaded!.prompt).toBe("10 quadratic MCQs");
    expect(typeof loaded!.savedAt).toBe("string");
  });

  it("returns null when nothing is stored", () => {
    expect(readTutorDraft(key)).toBeNull();
  });

  it("returns null and wipes corrupt entries", () => {
    localStorage.setItem(key, "{not valid json");
    expect(readTutorDraft(key)).toBeNull();
    expect(localStorage.getItem(key)).toBeNull();
  });

  it("returns null for a payload from a different version", () => {
    localStorage.setItem(
      key,
      JSON.stringify({ version: 999, title: "old" }),
    );
    expect(readTutorDraft(key)).toBeNull();
  });

  it("coerces missing fields to safe defaults", () => {
    localStorage.setItem(
      key,
      JSON.stringify({
        version: TUTOR_DRAFT_VERSION,
        title: "only title",
      }),
    );
    const loaded = readTutorDraft(key);
    expect(loaded).not.toBeNull();
    expect(loaded!.title).toBe("only title");
    expect(loaded!.subject).toBe("");
    expect(loaded!.level).toBe("");
    expect(loaded!.syllabus).toBe("");
    expect(loaded!.timeLimitMinutes).toBe(60);
    expect(loaded!.prompt).toBe("");
  });

  it("reports failure when localStorage throws", () => {
    (globalThis as any).localStorage = {
      ...(globalThis as any).localStorage,
      setItem: () => { const e: any = new Error("quota"); e.name = "QuotaExceededError"; throw e; },
    };
    const result = writeTutorDraft(key, {
      title: "t", subject: "", level: "", syllabus: "", timeLimitMinutes: 60, prompt: "",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("QuotaExceededError");
  });

  it("returns failure for a null key", () => {
    const result = writeTutorDraft(null, {
      title: "t", subject: "", level: "", syllabus: "", timeLimitMinutes: 60, prompt: "",
    });
    expect(result.ok).toBe(false);
  });

  it("clearTutorDraft removes the entry", () => {
    writeTutorDraft(key, {
      title: "t", subject: "", level: "", syllabus: "", timeLimitMinutes: 60, prompt: "",
    });
    expect(readTutorDraft(key)).not.toBeNull();
    clearTutorDraft(key);
    expect(readTutorDraft(key)).toBeNull();
  });

  it("ignores clearTutorDraft for null key without throwing", () => {
    expect(() => clearTutorDraft(null)).not.toThrow();
  });
});

describe("isMeaningfulDraft", () => {
  const base: TutorAssessmentDraft = {
    version: TUTOR_DRAFT_VERSION,
    title: "", subject: "", level: "", syllabus: "",
    timeLimitMinutes: 60, prompt: "", savedAt: "2026-04-19T00:00:00Z",
  };

  it("returns false for null", () => {
    expect(isMeaningfulDraft(null)).toBe(false);
  });

  it("returns false for an empty shell", () => {
    expect(isMeaningfulDraft(base)).toBe(false);
  });

  it("ignores whitespace-only fields", () => {
    expect(isMeaningfulDraft({ ...base, title: "   ", prompt: "\n" })).toBe(false);
  });

  it.each<[keyof TutorAssessmentDraft, string]>([
    ["title", "Mock"],
    ["subject", "Math"],
    ["level", "IGCSE"],
    ["syllabus", "Cambridge"],
    ["prompt", "Generate 5"],
  ])("returns true when %s has content", (field, val) => {
    expect(isMeaningfulDraft({ ...base, [field]: val })).toBe(true);
  });
});

describe("describeDraft", () => {
  const base: TutorAssessmentDraft = {
    version: TUTOR_DRAFT_VERSION,
    title: "", subject: "", level: "", syllabus: "",
    timeLimitMinutes: 60, prompt: "", savedAt: "2026-04-19T00:00:00Z",
  };

  it("prefers the title when set", () => {
    expect(describeDraft({ ...base, title: "Algebra mock", subject: "Math" }))
      .toBe("Algebra mock");
  });

  it("falls back to subject · level", () => {
    expect(describeDraft({ ...base, subject: "Mathematics", level: "IGCSE" }))
      .toBe("Mathematics · IGCSE");
  });

  it("falls back to just subject if level missing", () => {
    expect(describeDraft({ ...base, subject: "Mathematics" }))
      .toBe("Mathematics");
  });

  it("falls back to a truncated prompt", () => {
    const long = "a".repeat(100);
    const out = describeDraft({ ...base, prompt: long });
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(46);
  });

  it("returns 'Untitled draft' for an empty shell", () => {
    expect(describeDraft(base)).toBe("Untitled draft");
  });
});
