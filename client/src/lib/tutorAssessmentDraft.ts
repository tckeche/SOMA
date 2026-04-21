// Pre-publish assessment-draft recovery for tutors.
//
// Before the builder ever calls the server (ensureQuizExists), the tutor has
// already spent effort on title / level / subject / topic selection / time
// limit / initial Co-Pilot prompt. Those values live only in React state and
// are lost on refresh or tab close. This module persists them to localStorage
// until a real server-side quiz is created, at which point the server's draft
// API takes over.
//
// Phase 5 replaces the old free-text subject/level/syllabus fields with
// catalogue-driven identifiers (body slug + level code + subject slug) plus a
// resolved syllabus code and a list of topic IDs. Drafts are versioned so we
// can migrate older payloads instead of surprising the tutor with garbled
// values.

export const TUTOR_DRAFT_VERSION = 3;

export interface TutorAssessmentDraft {
  version: number;
  title: string;
  examiningBodySlug: string;
  levelCode: string;
  subjectSlug: string;
  /**
   * Resolved Cambridge syllabus code (e.g. "9709") for the chosen
   * body/level/subject. The server re-resolves this on save, but we cache it
   * so the read-only chip in the UI still has something to show while the
   * /api/catalogue/topics query is in flight after a reload.
   */
  syllabusCode: string;
  /**
   * Zero-or-more topic ids chosen from the canonical syllabus's topic list.
   * Ids are stable per syllabus row — storing ids (not titles) means a topic
   * rename upstream doesn't silently detach the draft from its topic.
   */
  selectedTopicIds: number[];
  /**
   * Zero-or-more subtopic ids chosen from a topic's subtopic list. Persisting
   * these alongside selectedTopicIds means a draft round-trip preserves the
   * tutor's exact granular scope rather than collapsing back to whole topics.
   */
  selectedSubtopicIds: number[];
  timeLimitMinutes: number;
  prompt: string;
  savedAt: string;
}

export function buildTutorDraftKey(tutorId: string | null | undefined): string | null {
  if (!tutorId) return null;
  return `soma_tutor_new_assessment_draft_${tutorId}`;
}

function coerceNumberArray(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  const out: number[] = [];
  for (const item of raw) {
    const n = Number(item);
    if (Number.isInteger(n) && n > 0) out.push(n);
  }
  return out;
}

export function readTutorDraft(key: string | null): TutorAssessmentDraft | null {
  if (!key || typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;

    const version = Number(parsed.version);
    // v1 drafts stored free-text subject/level/syllabus strings that can't be
    // mapped to catalogue slugs without a server call. Preserve the bits that
    // still make sense (title, prompt, time limit) and let the tutor re-pick
    // the curriculum fields.
    if (version === 1) {
      return {
        version: TUTOR_DRAFT_VERSION,
        title: typeof parsed.title === "string" ? parsed.title : "",
        examiningBodySlug: "cambridge",
        levelCode: "",
        subjectSlug: "",
        syllabusCode: "",
        selectedTopicIds: [],
        selectedSubtopicIds: [],
        timeLimitMinutes: Number.isFinite(parsed.timeLimitMinutes)
          ? Number(parsed.timeLimitMinutes)
          : 60,
        prompt: typeof parsed.prompt === "string" ? parsed.prompt : "",
        savedAt: typeof parsed.savedAt === "string" ? parsed.savedAt : new Date().toISOString(),
      };
    }

    // v2 drafts had everything except subtopic ids; carry their fields forward
    // and start subtopic selection empty (the tutor can re-expand the topic).
    if (version !== TUTOR_DRAFT_VERSION && version !== 2) return null;

    return {
      version: TUTOR_DRAFT_VERSION,
      title: typeof parsed.title === "string" ? parsed.title : "",
      examiningBodySlug: typeof parsed.examiningBodySlug === "string" && parsed.examiningBodySlug
        ? parsed.examiningBodySlug
        : "cambridge",
      levelCode: typeof parsed.levelCode === "string" ? parsed.levelCode : "",
      subjectSlug: typeof parsed.subjectSlug === "string" ? parsed.subjectSlug : "",
      syllabusCode: typeof parsed.syllabusCode === "string" ? parsed.syllabusCode : "",
      selectedTopicIds: coerceNumberArray(parsed.selectedTopicIds),
      selectedSubtopicIds: coerceNumberArray(parsed.selectedSubtopicIds),
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
// it would be annoying. An empty shell (nothing picked, default time limit)
// is not worth a banner.
export function isMeaningfulDraft(draft: TutorAssessmentDraft | null): boolean {
  if (!draft) return false;
  if (draft.title.trim()) return true;
  if (draft.levelCode.trim()) return true;
  if (draft.subjectSlug.trim()) return true;
  if (draft.syllabusCode.trim()) return true;
  if (draft.selectedTopicIds.length > 0) return true;
  if (draft.selectedSubtopicIds.length > 0) return true;
  if (draft.prompt.trim()) return true;
  return false;
}

export function describeDraft(draft: TutorAssessmentDraft): string {
  const title = draft.title.trim();
  if (title) return title;
  const bits = [draft.subjectSlug, draft.levelCode, draft.syllabusCode]
    .map((s) => s.trim())
    .filter(Boolean);
  if (bits.length > 0) return bits.join(" · ");
  if (draft.prompt.trim()) {
    const p = draft.prompt.trim();
    return p.length > 48 ? `${p.slice(0, 45)}…` : p;
  }
  return "Untitled draft";
}
