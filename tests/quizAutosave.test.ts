import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  buildAutosaveKey,
  readAutosave,
  writeAutosave,
  clearAutosave,
  formatSavedLabel,
  QUIZ_AUTOSAVE_VERSION,
} from "../client/src/lib/quizAutosave";

// JSDOM / happy-dom is not the default env for these tests — provide a tiny
// in-memory shim that behaves like Storage for our needs.
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

describe("buildAutosaveKey", () => {
  it("returns null for invalid quizId", () => {
    expect(buildAutosaveKey(0, "user-1")).toBeNull();
    expect(buildAutosaveKey(-1, "user-1")).toBeNull();
  });

  it("scopes key by quizId and userId", () => {
    expect(buildAutosaveKey(42, "user-1")).toBe("soma_quiz_autosave_42_user-1");
    expect(buildAutosaveKey(42, null)).toBe("soma_quiz_autosave_42_guest");
  });
});

describe("writeAutosave / readAutosave", () => {
  const key = "soma_quiz_autosave_5_user-a";

  it("round-trips a payload", () => {
    const result = writeAutosave(key, {
      answers: { 1: "A", 2: "B" },
      currentIndex: 2,
      startedAt: "2026-04-19T09:00:00.000Z",
    });
    expect(result.ok).toBe(true);
    const loaded = readAutosave(key);
    expect(loaded).not.toBeNull();
    expect(loaded!.version).toBe(QUIZ_AUTOSAVE_VERSION);
    expect(loaded!.answers).toEqual({ 1: "A", 2: "B" });
    expect(loaded!.currentIndex).toBe(2);
    expect(loaded!.startedAt).toBe("2026-04-19T09:00:00.000Z");
    expect(typeof loaded!.savedAt).toBe("string");
  });

  it("returns null when nothing is stored", () => {
    expect(readAutosave(key)).toBeNull();
  });

  it("returns null and wipes corrupt entries", () => {
    localStorage.setItem(key, "{not valid json");
    expect(readAutosave(key)).toBeNull();
    expect(localStorage.getItem(key)).toBeNull();
  });

  it("migrates legacy (answers-only) payloads", () => {
    localStorage.setItem(key, JSON.stringify({ 1: "A", 2: "B" }));
    const loaded = readAutosave(key);
    expect(loaded).not.toBeNull();
    expect(loaded!.answers).toEqual({ 1: "A", 2: "B" });
    expect(loaded!.currentIndex).toBe(0);
  });

  it("reports failure when localStorage throws (quota exceeded)", () => {
    (globalThis as any).localStorage = {
      ...(globalThis as any).localStorage,
      setItem: () => { const e: any = new Error("quota"); e.name = "QuotaExceededError"; throw e; },
    };
    const result = writeAutosave(key, { answers: {}, currentIndex: 0, startedAt: "x" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("QuotaExceededError");
  });

  it("returns failure for a null key", () => {
    const result = writeAutosave(null, { answers: {}, currentIndex: 0, startedAt: "x" });
    expect(result.ok).toBe(false);
  });

  it("ignores clearAutosave for null key without throwing", () => {
    expect(() => clearAutosave(null)).not.toThrow();
  });

  it("clearAutosave removes the entry", () => {
    writeAutosave(key, { answers: { 1: "A" }, currentIndex: 0, startedAt: "x" });
    expect(readAutosave(key)).not.toBeNull();
    clearAutosave(key);
    expect(readAutosave(key)).toBeNull();
  });
});

describe("formatSavedLabel", () => {
  it("returns empty string for null input", () => {
    expect(formatSavedLabel(null, Date.now())).toBe("");
  });

  it("says 'Saved just now' for sub-3-second diffs", () => {
    const savedAt = new Date(1_000_000).toISOString();
    expect(formatSavedLabel(savedAt, 1_000_000 + 500)).toBe("Saved just now");
    expect(formatSavedLabel(savedAt, 1_000_000 + 2_999)).toBe("Saved just now");
  });

  it("formats seconds, minutes, hours", () => {
    const savedAt = new Date(1_000_000).toISOString();
    expect(formatSavedLabel(savedAt, 1_000_000 + 15_000)).toBe("Saved 15s ago");
    expect(formatSavedLabel(savedAt, 1_000_000 + 90_000)).toBe("Saved 1m ago");
    expect(formatSavedLabel(savedAt, 1_000_000 + 2 * 3_600_000)).toBe("Saved 2h ago");
  });

  it("handles clock-skew gracefully (now < savedAt)", () => {
    const savedAt = new Date(10_000_000).toISOString();
    expect(formatSavedLabel(savedAt, 9_000_000)).toBe("Saved just now");
  });
});
