// Pre-publish assessment-draft recovery for tutors.
//
// Before the builder ever calls the server (ensureQuizExists), the tutor has
// already spent effort on title / subject / level / syllabus / time limit /
// initial Co-Pilot prompt. Those values live only in React state and are lost
// on refresh or tab close. This module persists them to localStorage until
// a real server-side quiz is created, at which point the server's draft API
// takes over.
//
// Drafts are scoped by tutorId. Payloads are versioned so a future schema
// change can migrate safely instead of surprising the tutor with garbled
// text in their form fields.

export const TUTOR_DRAFT_VERSION = 1;

export interface TutorAssessmentDraft {
  version: number;
  title: string;
  subject: string;
  level: string;
  syllabus: string;
  // Optional: topic lifted from an uploaded syllabus's topic inventory. Older
  // drafts predate this field and will deserialise with an empty string.
  topic: string;
  timeLimitMinutes: number;
  prompt: string;
  savedAt: string;
}

export function buildTutorDraftKey(tutorId: string | null | undefined): string | null {
  if (!tutorId) return null;
  return `soma_tutor_new_assessment_draft_${tutorId}`;
}

export function readTutorDraft(key: string | null): TutorAssessmentDraft | null {
  if (!key || typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.version !== TUTOR_DRAFT_VERSION) {
      return null;
    }
    return {
      version: TUTOR_DRAFT_VERSION,
      title: typeof parsed.title === "string" ? parsed.title : "",
      subject: typeof parsed.subject === "string" ? parsed.subject : "",
      level: typeof parsed.level === "string" ? parsed.level : "",
      syllabus: typeof parsed.syllabus === "string" ? parsed.syllabus : "",
      topic: typeof parsed.topic === "string" ? parsed.topic : "",
      timeLimitMinutes: Number.isFinite(parsed.timeLimitMinutes)
        ? Number(parsed.timeLimitMinutes)
        : 60,
      prompt: typeof parsed.prompt === "string" ? parsed.prompt : "",
      savedAt: typeof parsed.savedAt === "string" ? parsed.savedAt : new Date().toISOString(),
    };
  } catch {
    try { localStorage.removeItem(key); } catch { /* ignore */ }
    return null;
  }
}

export function writeTutorDraft(
  key: string | null,
  data: Omit<TutorAssessmentDraft, "version" | "savedAt">,
): { ok: true; savedAt: string } | { ok: false; error: string } {
  if (!key || typeof window === "undefined") {
    return { ok: false, error: "draft_unavailable" };
  }
  const payload: TutorAssessmentDraft = {
    version: TUTOR_DRAFT_VERSION,
    ...data,
    savedAt: new Date().toISOString(),
  };
  try {
    localStorage.setItem(key, JSON.stringify(payload));
    return { ok: true, savedAt: payload.savedAt };
  } catch (err: any) {
    return { ok: false, error: err?.name || "storage_error" };
  }
}

export function clearTutorDraft(key: string | null): void {
  if (!key || typeof window === "undefined") return;
  try { localStorage.removeItem(key); } catch { /* ignore */ }
}

// A draft is worth surfacing when the tutor has done enough work that losing
// it would be annoying. An empty shell (no title, no subject, no prompt, no
// level, no syllabus, default time limit) is not worth a banner.
export function isMeaningfulDraft(draft: TutorAssessmentDraft | null): boolean {
  if (!draft) return false;
  if (draft.title.trim()) return true;
  if (draft.subject.trim()) return true;
  if (draft.level.trim()) return true;
  if (draft.syllabus.trim()) return true;
  if (draft.topic.trim()) return true;
  if (draft.prompt.trim()) return true;
  return false;
}

export function describeDraft(draft: TutorAssessmentDraft): string {
  const title = draft.title.trim();
  if (title) return title;
  const bits = [draft.subject, draft.level].map((s) => s.trim()).filter(Boolean);
  if (bits.length > 0) return bits.join(" · ");
  if (draft.prompt.trim()) {
    const p = draft.prompt.trim();
    return p.length > 48 ? `${p.slice(0, 45)}…` : p;
  }
  return "Untitled draft";
}
