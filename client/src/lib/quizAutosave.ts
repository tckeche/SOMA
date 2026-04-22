// Client-side autosave for the in-progress student quiz experience.
// Persists answers, the current question index, and the quiz start time to
// localStorage so a refresh, tab close, or dropped connection does not cost
// the student any progress. Values are scoped per (quizId, userId).

export const QUIZ_AUTOSAVE_VERSION = 1;

export interface QuizAutosavePayload {
  version: number;
  answers: Record<number, string>;
  currentIndex: number;
  startedAt: string;  // ISO timestamp
  savedAt: string;    // ISO timestamp of this save
}

export type SaveStatus = "idle" | "saving" | "saved" | "failed";

export function buildAutosaveKey(quizId: number, userId: string | null | undefined): string | null {
  if (!quizId || quizId <= 0) return null;
  return `soma_quiz_autosave_${quizId}_${userId || "guest"}`;
}

export function readAutosave(key: string | null): QuizAutosavePayload | null {
  if (!key || typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);

    // Backwards compat: a prior version stored just the answers map.
    if (parsed && typeof parsed === "object" && !("version" in parsed)) {
      const answers = Object.fromEntries(
        Object.entries(parsed as Record<string, unknown>)
          .filter(([, v]) => typeof v === "string")
          .map(([k, v]) => [Number(k), String(v)]),
      );
      return {
        version: QUIZ_AUTOSAVE_VERSION,
        answers,
        currentIndex: 0,
        startedAt: new Date().toISOString(),
        savedAt: new Date().toISOString(),
      };
    }

    if (parsed?.version === QUIZ_AUTOSAVE_VERSION && parsed.answers) {
      const answers = Object.fromEntries(
        Object.entries(parsed.answers as Record<string, unknown>)
          .filter(([, v]) => typeof v === "string")
          .map(([k, v]) => [Number(k), String(v)]),
      );
      return {
        version: QUIZ_AUTOSAVE_VERSION,
        answers,
        currentIndex: Number.isFinite(parsed.currentIndex) ? Number(parsed.currentIndex) : 0,
        startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : new Date().toISOString(),
        savedAt: typeof parsed.savedAt === "string" ? parsed.savedAt : new Date().toISOString(),
      };
    }
  } catch {
    // Corrupt or unreadable — wipe so we don't keep hitting the same error.
    try { localStorage.removeItem(key); } catch { /* ignore */ }
  }
  return null;
}

export function writeAutosave(
  key: string | null,
  data: Omit<QuizAutosavePayload, "version" | "savedAt">,
): { ok: true; savedAt: string } | { ok: false; error: string } {
  if (!key || typeof window === "undefined") {
    return { ok: false, error: "autosave_unavailable" };
  }
  const payload: QuizAutosavePayload = {
    version: QUIZ_AUTOSAVE_VERSION,
    ...data,
    savedAt: new Date().toISOString(),
  };
  try {
    localStorage.setItem(key, JSON.stringify(payload));
    return { ok: true, savedAt: payload.savedAt };
  } catch (err: unknown) {
    const name = err instanceof Error ? err.name : undefined;
    return { ok: false, error: name || "storage_error" };
  }
}

export function clearAutosave(key: string | null): void {
  if (!key || typeof window === "undefined") return;
  try { localStorage.removeItem(key); } catch { /* ignore */ }
}

// A restored autosave counts as an in-progress resume when the student has
// actually made progress — an answer picked or a later question viewed.
// An empty shell (no answers, still on question 1) is not a resume; the
// student should see the pre-quiz start screen instead so the timer only
// begins when they explicitly choose to start.
export function isResumableAutosave(payload: QuizAutosavePayload | null): boolean {
  if (!payload) return false;
  const answerCount = payload.answers ? Object.keys(payload.answers).length : 0;
  const currentIndex = Number.isFinite(payload.currentIndex) ? payload.currentIndex : 0;
  return answerCount > 0 || currentIndex > 0;
}

// Formats a "Saved 12s ago" / "Saved 3m ago" label given a savedAt ISO string
// and a reference "now" timestamp in ms.
export function formatSavedLabel(savedAt: string | null, now: number): string {
  if (!savedAt) return "";
  const diffMs = now - new Date(savedAt).getTime();
  if (!Number.isFinite(diffMs) || diffMs < 0) return "Saved just now";
  if (diffMs < 3_000) return "Saved just now";
  if (diffMs < 60_000) return `Saved ${Math.floor(diffMs / 1000)}s ago`;
  if (diffMs < 3_600_000) return `Saved ${Math.floor(diffMs / 60_000)}m ago`;
  return `Saved ${Math.floor(diffMs / 3_600_000)}h ago`;
}
