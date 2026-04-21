import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import type { SomaQuiz, SomaQuestion } from "@shared/schema";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { Link, useLocation, useParams } from "wouter";
import {
  ArrowLeft, Send, Loader2, Sparkles, FileStack, Trash2,
  X, Pencil,
  Scan, Brain, Search, CheckCircle2, Eye, PartyPopper, LayoutDashboard,
  Save, AlertCircle, AlertTriangle, StopCircle, RefreshCw
} from "lucide-react";
import 'katex/dist/katex.min.css';
import { unescapeLatex } from '@/lib/render-latex';
import MarkdownRenderer from '@/components/MarkdownRenderer';
import SomaQuizEngine from "./soma-quiz";
import type { StudentQuestion } from "./soma-quiz";
import { createIdentityHeaders } from "@/lib/identityHeaders";
import { useSupabaseSession } from "@/hooks/use-supabase-session";
import {
  buildTutorDraftKey,
  readTutorDraft,
  writeTutorDraft,
  clearTutorDraft,
  isMeaningfulDraft,
  type TutorAssessmentDraft,
} from "@/lib/tutorAssessmentDraft";
import DraftRecoveryBanner from "@/components/tutor/DraftRecoveryBanner";
import AssessmentWizard from "@/components/tutor/AssessmentWizard";

// ── Draft question type (mirrors server DraftQuestion) ───────────────────────
export interface DraftQuestion {
  draftId: string;
  stem: string;
  options: string[];
  correctAnswer: string;
  explanation: string;
  marks: number;
  questionType: "multiple_choice" | "graph";
  graphSpec?: any | null;
  topicTag?: string | null;
  subtopicTag?: string | null;
  difficultyTag?: string | null;
}

type CopilotAction = "ADD" | "REPLACE_ALL" | "REPLACE_SELECTED" | "DELETE" | "REORDER" | "NONE";
type GenerationState = "generation_started" | "generation_in_progress" | "generation_failed" | "partial_success" | "validation_failed" | "persistence_failed" | "ready_for_review";

function makeDraftId(): string {
  return `draft-${Math.random().toString(36).slice(2)}-${Date.now()}`;
}

function somaQuestionToDraft(q: SomaQuestion): DraftQuestion {
  return {
    draftId: `q-${q.id}`,
    stem: q.stem,
    options: Array.isArray(q.options) ? (q.options as string[]) : [],
    correctAnswer: q.correctAnswer,
    explanation: q.explanation,
    marks: q.marks,
    questionType: (q as any).questionType || "multiple_choice",
    graphSpec: (q as any).graphSpec ?? null,
    topicTag: (q as any).topicTag ?? null,
    subtopicTag: (q as any).subtopicTag ?? null,
    difficultyTag: (q as any).difficultyTag ?? null,
  };
}

function rawToDraftQuestion(raw: any): DraftQuestion | null {
  let opts = raw.options;
  if (opts && !Array.isArray(opts) && typeof opts === "object") {
    const keys = Object.keys(opts);
    opts = keys.every((k) => /^[A-Z]$/i.test(k))
      ? keys.sort().map((k) => opts[k])
      : Object.values(opts);
  }
  if (!Array.isArray(opts) || opts.length < 4) return null;
  opts = (opts as any[]).map(String).slice(0, 4);
  const stem = String(raw.prompt_text || raw.promptText || raw.stem || raw.question || "");
  if (!stem) return null;
  return {
    draftId: raw.draftId || makeDraftId(),
    stem,
    options: opts,
    correctAnswer: String(raw.correct_answer || raw.correctAnswer || opts[0] || ""),
    explanation: String(raw.explanation || ""),
    marks: Number(raw.marks_worth || raw.marksWorth || raw.marks || 1) || 1,
    questionType: (raw.question_type === "graph" || raw.questionType === "graph") ? "graph" : "multiple_choice",
    graphSpec: raw.graphSpec ?? raw.graph_spec ?? null,
    topicTag: raw.topic_tag ? String(raw.topic_tag) : raw.topicTag ? String(raw.topicTag) : null,
    subtopicTag: raw.subtopic_tag ? String(raw.subtopic_tag) : raw.subtopicTag ? String(raw.subtopicTag) : null,
    difficultyTag: raw.difficulty_tag ? String(raw.difficulty_tag) : raw.difficultyTag ? String(raw.difficultyTag) : null,
  };
}

function applyDraftAction(
  current: DraftQuestion[],
  action: CopilotAction,
  questions: DraftQuestion[],
  positions: number[],
): DraftQuestion[] {
  switch (action) {
    case "ADD":
      return [...current, ...questions];

    case "REPLACE_ALL":
      return [...questions];

    case "REPLACE_SELECTED": {
      const next = [...current];
      positions.forEach((pos, i) => {
        const idx = pos - 1;
        if (idx >= 0 && idx < next.length && questions[i]) {
          next[idx] = questions[i];
        }
      });
      return next;
    }

    case "DELETE": {
      const toRemove = new Set(positions.map((p) => p - 1));
      return current.filter((_, i) => !toRemove.has(i));
    }

    case "REORDER": {
      if (positions.length !== current.length) return current;
      return positions.map((pos) => current[pos - 1]).filter(Boolean);
    }

    default:
      return current;
  }
}

function getDraftValidationError(questions: DraftQuestion[]): string | null {
  if (questions.length === 0) return "Draft is empty.";
  for (const q of questions) {
    if (!q.stem?.trim()) return "A draft question is missing a prompt.";
    if (!Array.isArray(q.options) || q.options.length !== 4) return "Each question must have exactly 4 options.";
    if (!q.correctAnswer || !q.options.includes(q.correctAnswer)) return "Each question must have a valid correct answer.";
  }
  return null;
}

const PIPELINE_STAGES = [
  { stage: 1, icon: "brain", label: "Drafting questions", aiName: "Drafting" },
  { stage: 2, icon: "scan", label: "Verifying answers & writing explanations", aiName: "Verifying" },
  { stage: 3, icon: "pencil", label: "Saving to draft", aiName: "Saving" },
];


export default function BuilderPage() {
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const params = useParams<{ id?: string }>();
  const editId = params.id ? parseInt(params.id) : null;
  const isEditMode = editId !== null;

  const [title, setTitle] = useState("");
  // Catalogue selections (Phase 5). The old free-text subject/level/syllabus
  // strings are derived from these on the fly when we POST to the quiz API.
  const [examiningBodySlug, setExaminingBodySlug] = useState<string>("cambridge");
  const [levelCode, setLevelCode] = useState<string>("");
  const [subjectSlug, setSubjectSlug] = useState<string>("");
  const [selectedTopicIds, setSelectedTopicIds] = useState<number[]>([]);
  const [selectedSubtopicIds, setSelectedSubtopicIds] = useState<number[]>([]);
  const [timeLimitMinutes, setTimeLimitMinutes] = useState(60);
  // Wizard step: 0=Body, 1=Level, 2=Subject, 3=Topics, 4=Time limit.
  // In edit mode we jump straight to the end (everything already filled).
  // Default to step 1 (Level) when quick-start is on at mount so we never
  // render a hidden step (0=body) on first paint.
  const [wizardStep, setWizardStep] = useState<0 | 1 | 2 | 3 | 4>(() => {
    if (typeof window === "undefined") return 0;
    try { return window.localStorage.getItem("soma:wizard-quickstart") === "1" ? 1 : 0; }
    catch { return 0; }
  });
  // Quick-start mode hides the Examining body and Topics steps so tutors of
  // humanities subjects (English Lit, English Lang, History) can jump straight
  // to Level → Subject → Time and let the Co-Pilot infer scope from the
  // prompt. Persisted in localStorage so it survives reloads, but kept out of
  // the draft schema (it's a UI preference, not part of the quiz).
  const [quickStart, setQuickStart] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    try { return window.localStorage.getItem("soma:wizard-quickstart") === "1"; }
    catch { return false; }
  });
  // Resolved Cambridge syllabus code, synced from the /api/catalogue/topics
  // response. Declared here (rather than inline with the query hook below) so
  // that the debounced-draft-write effect can reference it without a
  // temporal-dead-zone error.
  const [resolvedSyllabusCode, setResolvedSyllabusCode] = useState<string>("");

  const [msg, setMsg] = useState("");
  const [chat, setChat] = useState<{ role: "user" | "ai"; text: string; metadata?: { provider: string; model: string; durationMs: number }; warnings?: { questionIndex: number; field: string; issue: string; autoFixed: boolean }[] }[]>([]);
  const [draftQuestions, setDraftQuestions] = useState<DraftQuestion[]>([]);
  const [draftLoaded, setDraftLoaded] = useState(false);
  const [isDraftDirty, setIsDraftDirty] = useState(false);
  const [isPublishing, setIsPublishing] = useState(false);
  const [isSyncingDraft, setIsSyncingDraft] = useState(false);
  const [populated, setPopulated] = useState(false);
  const [activeQuizId, setActiveQuizId] = useState<number | null>(editId);

  const [pipelineActive, setPipelineActive] = useState(false);
  const [currentStage, setCurrentStage] = useState(0);
  const [completedStages, setCompletedStages] = useState<Set<number>>(new Set());
  const [generationStartedAt, setGenerationStartedAt] = useState<number | null>(null);
  const [elapsedSecs, setElapsedSecs] = useState(0);
  const [lastAttemptMessage, setLastAttemptMessage] = useState<string>("");
  const abortControllerRef = useRef<AbortController | null>(null);
  const GENERATION_TIMEOUT_MS = 90_000;

  const [includeGraphQuestions, setIncludeGraphQuestions] = useState(false);

  const [showPreview, setShowPreview] = useState(false);
  const [showSuccessModal, setShowSuccessModal] = useState(false);
  const [lastSavedCount, setLastSavedCount] = useState(0);
  const [metaDirty, setMetaDirty] = useState(false);
  const [generationState, setGenerationState] = useState<GenerationState>("generation_started");

  const chatEndRef = useRef<HTMLDivElement>(null);

  // Pre-publish draft recovery (only relevant while activeQuizId is null —
  // once the server has a quiz row, its own draft API takes over).
  const [recoveredDraft, setRecoveredDraft] = useState<TutorAssessmentDraft | null>(null);
  const [draftBannerDismissed, setDraftBannerDismissed] = useState(false);
  const draftSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftCheckedRef = useRef(false);

  const { session: supaSession, isLoading: supaLoading, userId: tutorUserId } = useSupabaseSession();
  const supaAccessToken = supaSession?.access_token;
  const isTutorAuth = !!tutorUserId;
  const backLink = "/tutor/assessments";
  const confirmDiscardIfDirty = useCallback(() => {
    const hasInFlight = abortControllerRef.current !== null;
    const hasUnsaved = isDraftDirty || metaDirty;
    if (hasInFlight) {
      return window.confirm(
        "Co-Pilot is still generating questions. Leave now and lose the in-progress results?"
      );
    }
    if (hasUnsaved) {
      return window.confirm(
        "You have unsaved changes. Leave without saving? Your draft is preserved, but unsaved metadata changes will be lost."
      );
    }
    return true;
  }, [isDraftDirty, metaDirty]);

  const handleBack = useCallback(() => {
    if (!confirmDiscardIfDirty()) return;
    if (window.history.length > 1) {
      window.history.back();
      return;
    }
    navigate(backLink);
  }, [navigate, backLink, confirmDiscardIfDirty]);

  const handleExit = useCallback(
    (e: React.MouseEvent) => {
      if (!confirmDiscardIfDirty()) {
        e.preventDefault();
      }
    },
    [confirmDiscardIfDirty],
  );

  // Quick-start invariant: whenever quickStart is true, the wizard must
  // (a) force examiningBodySlug='cambridge', (b) carry no topic/subtopic
  // selections (those steps are hidden, so any leftover IDs would silently
  // narrow the AI prompt), and (c) sit on a visible step (skip 0=body and
  // 3=topics). This effect runs reactively — not just on mount — so it also
  // corrects state after draft recovery or any other path that might reseed
  // hidden-step values while quickStart is on.
  useEffect(() => {
    if (!quickStart) return;
    if (examiningBodySlug !== "cambridge") setExaminingBodySlug("cambridge");
    if (selectedTopicIds.length > 0) setSelectedTopicIds([]);
    if (selectedSubtopicIds.length > 0) setSelectedSubtopicIds([]);
    if (wizardStep === 0 || wizardStep === 3) setWizardStep(1);
  }, [quickStart, examiningBodySlug, selectedTopicIds, selectedSubtopicIds, wizardStep]);

  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      const hasInFlight = abortControllerRef.current !== null;
      if (hasInFlight || isDraftDirty || metaDirty) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [isDraftDirty, metaDirty]);

  // ── Pre-publish draft recovery ─────────────────────────────────────────────
  // When a tutor opens the builder in new-assessment mode, look up any local
  // draft they left behind. Skip entirely in edit mode — the server is the
  // source of truth once a quiz row exists.
  useEffect(() => {
    if (isEditMode || draftCheckedRef.current || !tutorUserId) return;
    draftCheckedRef.current = true;
    const key = buildTutorDraftKey(tutorUserId);
    const existing = readTutorDraft(key);
    if (isMeaningfulDraft(existing)) {
      setRecoveredDraft(existing);
    }
  }, [isEditMode, tutorUserId]);

  // Debounced write: while the quiz has not yet been created server-side,
  // persist metadata + initial prompt to localStorage so a refresh doesn't
  // wipe the tutor's work.
  useEffect(() => {
    if (isEditMode || !tutorUserId || activeQuizId !== null) return;
    const key = buildTutorDraftKey(tutorUserId);
    if (!key) return;
    // Don't save an empty shell — just clutters storage.
    const hasContent =
      title.trim() || levelCode.trim() || subjectSlug.trim() ||
      selectedTopicIds.length > 0 || selectedSubtopicIds.length > 0 || msg.trim();
    if (!hasContent) return;
    if (draftSaveTimerRef.current) clearTimeout(draftSaveTimerRef.current);
    draftSaveTimerRef.current = setTimeout(() => {
      writeTutorDraft(key, {
        title,
        examiningBodySlug,
        levelCode,
        subjectSlug,
        syllabusCode: resolvedSyllabusCode,
        selectedTopicIds,
        selectedSubtopicIds,
        timeLimitMinutes,
        prompt: msg,
      });
    }, 400);
    return () => {
      if (draftSaveTimerRef.current) clearTimeout(draftSaveTimerRef.current);
    };
  }, [isEditMode, tutorUserId, activeQuizId, title, examiningBodySlug, levelCode, subjectSlug, resolvedSyllabusCode, selectedTopicIds, selectedSubtopicIds, timeLimitMinutes, msg]);

  // Clear the local draft as soon as the server-side quiz row exists — the
  // server's draft API owns post-creation state.
  useEffect(() => {
    if (!tutorUserId || activeQuizId === null) return;
    const key = buildTutorDraftKey(tutorUserId);
    clearTutorDraft(key);
    setRecoveredDraft(null);
  }, [activeQuizId, tutorUserId]);

  const applyRecoveredDraft = useCallback(() => {
    if (!recoveredDraft) return;
    setTitle(recoveredDraft.title);
    setExaminingBodySlug(recoveredDraft.examiningBodySlug || "cambridge");
    setLevelCode(recoveredDraft.levelCode);
    setSubjectSlug(recoveredDraft.subjectSlug);
    setResolvedSyllabusCode(recoveredDraft.syllabusCode);
    setSelectedTopicIds(Array.isArray(recoveredDraft.selectedTopicIds) ? recoveredDraft.selectedTopicIds : []);
    setSelectedSubtopicIds(Array.isArray((recoveredDraft as any).selectedSubtopicIds) ? (recoveredDraft as any).selectedSubtopicIds : []);
    setTimeLimitMinutes(
      Number.isFinite(recoveredDraft.timeLimitMinutes) && recoveredDraft.timeLimitMinutes > 0
        ? recoveredDraft.timeLimitMinutes
        : 60,
    );
    setMsg(recoveredDraft.prompt);
    // Jump to the furthest-filled step so the tutor isn't forced to re-click
    // through choices they've already made.
    if (recoveredDraft.subjectSlug) setWizardStep(3);
    else if (recoveredDraft.levelCode) setWizardStep(2);
    else if (recoveredDraft.examiningBodySlug) setWizardStep(1);
    else setWizardStep(0);
    setRecoveredDraft(null);
    setDraftBannerDismissed(true);
  }, [recoveredDraft]);

  const deleteRecoveredDraft = useCallback(() => {
    clearTutorDraft(buildTutorDraftKey(tutorUserId));
    setRecoveredDraft(null);
    setDraftBannerDismissed(true);
    toast({ title: "Draft deleted", description: "Your unfinished assessment draft was discarded." });
  }, [tutorUserId, toast]);

  const validateMeta = useCallback(() => {
    if (!title.trim()) return "Assessment title is required.";
    if (!examiningBodySlug.trim()) return "Please select an examining body.";
    if (!levelCode.trim()) return "Please select a level.";
    if (!subjectSlug.trim()) return "Please select a subject.";
    if (!Number.isFinite(timeLimitMinutes) || timeLimitMinutes < 1 || timeLimitMinutes > 300) {
      return "Time limit must be between 1 and 300 minutes.";
    }
    return null;
  }, [title, examiningBodySlug, levelCode, subjectSlug, timeLimitMinutes]);

  const authHeaders = useCallback((): Record<string, string> => {
    return createIdentityHeaders(
      "x-tutor-id",
      tutorUserId,
      supaAccessToken ? { Authorization: `Bearer ${supaAccessToken}` } : {},
    );
  }, [supaAccessToken, tutorUserId]);

  const authFetch = useCallback(async (url: string, opts: RequestInit = {}): Promise<Response> => {
    const headers = { ...authHeaders(), ...(opts.headers || {}) };
    return fetch(url, { ...opts, headers, credentials: "include" });
  }, [authHeaders]);

  const authApiRequest = useCallback(async (method: string, url: string, data?: unknown): Promise<Response> => {
    const headers: Record<string, string> = { ...authHeaders() };
    if (data) headers["Content-Type"] = "application/json";
    const res = await fetch(url, {
      method,
      headers,
      body: data ? JSON.stringify(data) : undefined,
      credentials: "include",
    });
    if (!res.ok) {
      const text = await res.text();
      try {
        const json = JSON.parse(text);
        throw new Error(json.message || text);
      } catch (e) {
        if (e instanceof Error && e.message) throw e;
        throw new Error(text || res.statusText);
      }
    }
    return res;
  }, [authHeaders]);

  const { data: tutorSession, isLoading: sessionLoading, error: sessionError } = useQuery<{ authenticated: boolean }>({
    queryKey: ["/api/tutor/session", tutorUserId],
    queryFn: async () => {
      const res = await authFetch("/api/tutor/session");
      return res.json();
    },
    enabled: !supaLoading && !!tutorUserId,
  });

  const authenticated = tutorSession?.authenticated === true;

  // ── Catalogue (Phase 5) ────────────────────────────────────────────────────
  // Step-by-step drill-down: examining bodies → levels → subjects → topics.
  // Each layer depends on the previous selections, so we gate each query on
  // its prerequisites being filled.
  interface ExaminingBodyDto { id: number; slug: string; displayName: string; }
  interface LevelDto { id: number; code: string; displayName: string; topBand: string; sortOrder: number; }
  interface SubjectDto { id: number; slug: string; name: string; }
  interface SyllabusDto {
    id: number; examiningBodyId: number; subjectId: number;
    topBand: string; syllabusCode: string; title: string;
    yearsValidFrom: number | null; yearsValidTo: number | null;
  }
  interface PaperSummaryDto {
    id: number; paperNumber: number; code: string | null; title: string;
    levelTier: string | null; marks: number | null; durationMinutes: number | null;
  }
  interface SubtopicListItemDto {
    id: number; subtopicNumber: string; title: string;
    levelTier: string; coreOrExtended: string | null; sortOrder: number;
  }
  interface TopicListItemDto {
    id: number; topicNumber: string; title: string; description: string | null;
    levelTiers: string[]; sortOrder: number;
    strandName: string | null; papers: PaperSummaryDto[];
    subtopics: SubtopicListItemDto[];
  }

  const { data: examiningBodies = [], isLoading: bodiesLoading } = useQuery<ExaminingBodyDto[]>({
    queryKey: ["/api/catalogue/examining-bodies"],
    queryFn: async () => {
      const res = await authFetch("/api/catalogue/examining-bodies");
      if (!res.ok) return [];
      return res.json();
    },
    enabled: authenticated,
  });

  const { data: catalogueLevels = [], isLoading: levelsLoading } = useQuery<LevelDto[]>({
    queryKey: ["/api/catalogue/levels", examiningBodySlug],
    queryFn: async () => {
      const res = await authFetch(`/api/catalogue/levels?body=${encodeURIComponent(examiningBodySlug)}`);
      if (!res.ok) return [];
      return res.json();
    },
    enabled: authenticated && !!examiningBodySlug,
  });

  const { data: catalogueSubjects = [], isLoading: subjectsLoading } = useQuery<SubjectDto[]>({
    queryKey: ["/api/catalogue/subjects", examiningBodySlug, levelCode],
    queryFn: async () => {
      const res = await authFetch(
        `/api/catalogue/subjects?body=${encodeURIComponent(examiningBodySlug)}&level=${encodeURIComponent(levelCode)}`,
      );
      if (!res.ok) return [];
      return res.json();
    },
    enabled: authenticated && !!examiningBodySlug && !!levelCode,
  });

  const { data: topicsPayload, isLoading: topicsLoading } = useQuery<{ syllabus: SyllabusDto; topics: TopicListItemDto[] }>({
    queryKey: ["/api/catalogue/topics", examiningBodySlug, levelCode, subjectSlug],
    queryFn: async () => {
      const res = await authFetch(
        `/api/catalogue/topics?body=${encodeURIComponent(examiningBodySlug)}&level=${encodeURIComponent(levelCode)}&subject=${encodeURIComponent(subjectSlug)}`,
      );
      if (!res.ok) throw new Error("Failed to load topics");
      return res.json();
    },
    enabled: authenticated && !!examiningBodySlug && !!levelCode && !!subjectSlug,
  });
  const syllabusFromCatalogue = topicsPayload?.syllabus ?? null;
  const catalogueTopics = useMemo(() => topicsPayload?.topics ?? [], [topicsPayload]);

  // Sync the resolved syllabus code (declared earlier) whenever the topics
  // query returns a new syllabus for the current body/level/subject.
  useEffect(() => {
    setResolvedSyllabusCode(syllabusFromCatalogue?.syllabusCode ?? "");
  }, [syllabusFromCatalogue]);

  // Display names for the currently-selected catalogue entries. Used when we
  // send the legacy string fields (subject/level/syllabus) to the quiz API.
  const selectedBody = useMemo(
    () => examiningBodies.find((b) => b.slug === examiningBodySlug) ?? null,
    [examiningBodies, examiningBodySlug],
  );
  const selectedLevel = useMemo(
    () => catalogueLevels.find((l) => l.code === levelCode) ?? null,
    [catalogueLevels, levelCode],
  );
  const selectedSubject = useMemo(
    () => catalogueSubjects.find((s) => s.slug === subjectSlug) ?? null,
    [catalogueSubjects, subjectSlug],
  );

  // Legacy-compatible strings we still write onto the quiz row. Reconstructed
  // from the catalogue on every render so they stay in sync with the wizard.
  const legacySubjectName = selectedSubject?.name ?? "";
  const legacyLevelLabel = selectedLevel?.code ?? levelCode;
  const legacySyllabusLabel = useMemo(() => {
    if (!selectedBody || !syllabusFromCatalogue) return "";
    return `${selectedBody.displayName} · ${syllabusFromCatalogue.syllabusCode}`;
  }, [selectedBody, syllabusFromCatalogue]);
  const selectedTopicTitles = useMemo(() => {
    if (catalogueTopics.length === 0) return [] as string[];
    const byId = new Map(catalogueTopics.map((t) => [t.id, t.title]));
    return selectedTopicIds.map((id) => byId.get(id)).filter((t): t is string => !!t);
  }, [catalogueTopics, selectedTopicIds]);


  const { data: quizData, isLoading: quizLoading } = useQuery<SomaQuiz & { questions: SomaQuestion[] }>({
    queryKey: ["/api/tutor/quizzes", activeQuizId],
    queryFn: async () => {
      const res = await authFetch(`/api/tutor/quizzes/${activeQuizId}/detail`);
      if (!res.ok) throw new Error("Failed to load quiz");
      return res.json();
    },
    enabled: authenticated && activeQuizId !== null,
  });

  // Populate metadata from quizData on first load.
  // quizData still carries the pre-Phase-5 free-text fields (subject/level/
  // syllabus/topics as strings). We seed title + time limit directly and try
  // to map the catalogue fields by best-effort slug lookup in the effects
  // below. In edit mode we jump the wizard to the final step so the tutor
  // lands straight on the parameter summary.
  const [savedLegacyTopics, setSavedLegacyTopics] = useState<string[]>([]);
  useEffect(() => {
    if (quizData && !populated) {
      setTitle(quizData.title);
      const savedLevel = (quizData.level || "").trim();
      if (savedLevel === "IGCSE" || savedLevel === "AS" || savedLevel === "A2") {
        setLevelCode(savedLevel);
      }
      const savedTopics = Array.isArray((quizData as any).topics) ? (quizData as any).topics as string[] : [];
      if (savedTopics.length > 0) {
        setSavedLegacyTopics(savedTopics);
      } else {
        const singular = (quizData.topic || "").trim();
        if (singular && singular !== quizData.title) setSavedLegacyTopics([singular]);
      }
      setTimeLimitMinutes(quizData.timeLimitMinutes ?? 60);
      setPopulated(true);
      if (isEditMode) setWizardStep(4);
    }
  }, [quizData, populated, isEditMode]);

  // Best-effort map of the legacy subject name → catalogue subject slug.
  useEffect(() => {
    if (!populated || subjectSlug || !quizData?.subject) return;
    if (catalogueSubjects.length === 0) return;
    const needle = (quizData.subject || "").trim().toLowerCase();
    if (!needle) return;
    const hit = catalogueSubjects.find(
      (s) => s.name.toLowerCase() === needle || s.slug.toLowerCase() === needle,
    );
    if (hit) setSubjectSlug(hit.slug);
  }, [populated, subjectSlug, quizData, catalogueSubjects]);

  // Once the topics have loaded for the recovered subject, resolve legacy
  // topic titles → topic ids. Strings that no longer map are dropped
  // silently; the tutor can re-pick them from the refreshed list.
  useEffect(() => {
    if (!populated || selectedTopicIds.length > 0 || savedLegacyTopics.length === 0) return;
    if (catalogueTopics.length === 0) return;
    const normalize = (s: string) => s.trim().toLowerCase();
    const byTitle = new Map(catalogueTopics.map((t) => [normalize(t.title), t.id]));
    const mapped = savedLegacyTopics
      .map((t) => byTitle.get(normalize(t)))
      .filter((id): id is number => typeof id === "number");
    if (mapped.length > 0) setSelectedTopicIds(mapped);
    setSavedLegacyTopics([]);
  }, [populated, selectedTopicIds, savedLegacyTopics, catalogueTopics]);

  // Load draft from server when quiz is first opened (edit mode).
  // IMPORTANT: We only mark draftLoaded=true once we either:
  //   (a) have a non-empty server draft, or
  //   (b) quizData has finished loading (so we can seed from published questions or know it's empty)
  // If the draft API responds before quizData arrives, we hold off on marking draftLoaded
  // so that the effect re-runs once quizData is ready and can seed the draft correctly.
  useEffect(() => {
    if (!authenticated || !activeQuizId || draftLoaded) return;
    authFetch(`/api/tutor/quizzes/${activeQuizId}/draft`)
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        if (data && Array.isArray(data.questions) && data.questions.length > 0) {
          // Server has a saved draft — use it immediately
          setDraftQuestions(data.questions as DraftQuestion[]);
          setDraftLoaded(true);
        } else if (quizData !== undefined) {
          // Draft is empty AND quizData has arrived — seed from published questions if any
          if (quizData?.questions && quizData.questions.length > 0) {
            setDraftQuestions(quizData.questions.map(somaQuestionToDraft));
          }
          setDraftLoaded(true);
        }
        // If quizData is still loading (undefined), don't set draftLoaded yet —
        // the effect will re-run when quizData arrives (it's in the dependency array).
      })
      .catch(() => {
        // On fetch error, seed from quizData if available, otherwise wait
        if (quizData !== undefined) {
          if (quizData?.questions && quizData.questions.length > 0) {
            setDraftQuestions(quizData.questions.map(somaQuestionToDraft));
          }
          setDraftLoaded(true);
        }
      });
  }, [authenticated, activeQuizId, draftLoaded, authFetch, quizData]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chat]);

  // Helper: sync the current draft to the server (debounce-friendly, call after mutations)
  const syncDraft = useCallback(async (quizId: number, questions: DraftQuestion[]) => {
    setIsSyncingDraft(true);
    try {
      await authFetch(`/api/tutor/quizzes/${quizId}/draft`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ questions }),
      });
    } catch {
      // Non-fatal — draft is still in local state
    } finally {
      setIsSyncingDraft(false);
    }
  }, [authFetch]);

  // Update draft state + mark dirty + sync to server
  const updateDraft = useCallback(async (
    newQuestions: DraftQuestion[] | ((prev: DraftQuestion[]) => DraftQuestion[]),
    quizId?: number | null,
  ) => {
    setDraftQuestions((prev) => {
      const next = typeof newQuestions === "function" ? newQuestions(prev) : newQuestions;
      const id = quizId ?? activeQuizId;
      if (id) {
        syncDraft(id, next);
      }
      return next;
    });
    setIsDraftDirty(true);
  }, [activeQuizId, syncDraft]);

  const markMeta = () => { if (activeQuizId) setMetaDirty(true); };

  const ensureQuizExists = async (): Promise<{ quizId: number; isNew: boolean }> => {
    if (activeQuizId) return { quizId: activeQuizId, isNew: false };
    if (!title.trim()) throw new Error("Please fill in a quiz title before generating questions.");
    const quizRes = await authApiRequest("POST", "/api/tutor/quizzes", {
      title: title.trim(),
      topics: selectedTopicTitles,
      syllabus: legacySyllabusLabel || null,
      level: legacyLevelLabel || null,
      subject: legacySubjectName || null,
      timeLimitMinutes,
    });
    const quiz = await quizRes.json();
    setActiveQuizId(quiz.id);
    // NOTE: We do NOT navigate here — navigation happens AFTER the draft is persisted
    // to prevent a route remount that would wipe local state before the server has the draft.
    return { quizId: quiz.id, isNew: true };
  };

  const animatePipeline = (stage: number) => {
    setPipelineActive(true);
    setCurrentStage(stage);
    setCompletedStages((prev) => {
      const next = new Set(prev);
      for (let i = 1; i < stage; i++) next.add(i);
      return next;
    });
    if (stage === 1) {
      setGenerationStartedAt(Date.now());
      setElapsedSecs(0);
    }
  };

  const finishPipeline = () => {
    setCompletedStages(new Set([1, 2, 3, 4]));
    setCurrentStage(0);
    setGenerationStartedAt(null);
    setTimeout(() => setPipelineActive(false), 1500);
  };

  useEffect(() => {
    if (!generationStartedAt) return;
    const tick = () => setElapsedSecs(Math.floor((Date.now() - generationStartedAt) / 1000));
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [generationStartedAt]);

  const stopGeneration = useCallback(() => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    setPipelineActive(false);
    setGenerationStartedAt(null);
  }, []);

  const chatMutation = useMutation({
    mutationFn: async (message: string) => {
      setGenerationState("generation_started");
      animatePipeline(1);
      const context = [
        legacySubjectName && `Subject: ${legacySubjectName}`,
        legacyLevelLabel && `Level: ${legacyLevelLabel}`,
        legacySyllabusLabel && `Syllabus: ${legacySyllabusLabel}`,
        selectedTopicTitles.length > 0 && `Topics: ${selectedTopicTitles.join(" / ")}`,
      ].filter(Boolean).join(", ");
      const enrichedMessage = context ? `[${context}]\n\n${message}` : message;
      // Snapshot current draft for context
      const currentDraftSnap = draftQuestions;
      const difficultySpread = currentDraftSnap.reduce((acc, q) => {
        const d = String(q.difficultyTag || "").toLowerCase();
        if (d.includes("easy")) acc.easy++;
        else if (d.includes("hard")) acc.hard++;
        else acc.medium++;
        return acc;
      }, { easy: 0, medium: 0, hard: 0 });

      const assessmentContext = {
        assessmentMeta: {
          title,
          subject: legacySubjectName,
          level: legacyLevelLabel,
          syllabus: legacySyllabusLabel,
          topics: selectedTopicTitles,
          examiningBodySlug,
          levelCode,
          subjectSlug,
          syllabusCode: resolvedSyllabusCode,
          selectedTopicIds,
          selectedSubtopicIds,
        },
        difficultySpread,
      };

      animatePipeline(2);
      setGenerationState("generation_in_progress");
      const controller = new AbortController();
      abortControllerRef.current = controller;
      const timeoutId = setTimeout(() => controller.abort(), GENERATION_TIMEOUT_MS);
      let res: Response;
      try {
        res = await fetch("/api/tutor/copilot-chat", {
          method: "POST",
          headers: { ...authHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({
            message: enrichedMessage,
            chatHistory: chat,
            includeGraphQuestions,
            assessmentContext,
            draftQuestions: currentDraftSnap,
          }),
          credentials: "include",
          signal: controller.signal,
        });
      } catch (err: any) {
        if (controller.signal.aborted) {
          throw new Error("Generation was stopped. You can retry or refine your prompt.");
        }
        throw err;
      } finally {
        clearTimeout(timeoutId);
        abortControllerRef.current = null;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(text || `Co-Pilot request failed (${res.status})`);
      }
      const data = await res.json();

      if (data.needsClarification) {
        setPipelineActive(false);
        setGenerationState("generation_failed");
        return { action: "NONE" as CopilotAction, questions: [], positions: [], reply: data.reply, metadata: data.metadata };
      }

      // Parse action from response
      const action: CopilotAction = data.action || "ADD";
      const questions: DraftQuestion[] = (Array.isArray(data.questions) ? data.questions : [])
        .map((q: any) => rawToDraftQuestion(q))
        .filter((q: DraftQuestion | null): q is DraftQuestion => q !== null);
      const positions: number[] = Array.isArray(data.positions) ? data.positions : [];

      if (action !== "NONE" && (questions.length > 0 || positions.length > 0)) {
        animatePipeline(3);
        // Ensure quiz shell exists (creates quiz in DB for URL persistence).
        // NOTE: navigate() is NOT called inside ensureQuizExists — we do it below
        // AFTER the draft is persisted, to prevent a route remount wiping state.
        const { quizId, isNew } = await ensureQuizExists();
        animatePipeline(4);

        // Compute the new draft from the snapshot (captured before the AI call)
        const newDraft = applyDraftAction(currentDraftSnap, action, questions, positions);

        // ── CRITICAL: persist draft to server BEFORE navigating ──────────────
        // Directly awaiting syncDraft here ensures the server has the draft
        // before any route change that would remount this component.
        await syncDraft(quizId, newDraft);

        // Update local React state now that server is authoritative
        setDraftQuestions(newDraft);
        setIsDraftDirty(false); // draft is clean — just synced

        // Update the browser URL without triggering a route change or component remount.
        // Using history.replaceState instead of navigate() keeps React state intact
        // (draftQuestions, chat history, form fields) while letting the user bookmark
        // or refresh to the correct edit URL.
        if (isNew) {
          window.history.replaceState({}, "", `/tutor/assessments/edit/${quizId}`);
        }

        finishPipeline();
        return { action, questions, positions, reply: data.reply, metadata: data.metadata, draftCount: newDraft.length, verification: data.verification };
      }

      setPipelineActive(false);
      return { action, questions, positions, reply: data.reply, metadata: data.metadata, verification: data.verification };
    },
    onSuccess: (data, message) => {
      const verification = (data as any).verification;
      const afterCount = verification?.afterCount ?? draftQuestions.length;
      const appliedCount = verification?.appliedCount ?? 0;
      const reviewReady = verification?.reviewReady === true;
      const generatedSummary = verification
        ? `${appliedCount > 0 ? `Created/updated ${appliedCount} question${appliedCount !== 1 ? "s" : ""}.` : "No new draft questions were created."} Draft now has ${afterCount} question${afterCount !== 1 ? "s" : ""}.`
        : "";
      const skills = new Set(
        draftQuestions
          .map((q) => q.topicTag || q.subtopicTag || q.difficultyTag || "")
          .filter(Boolean),
      );
      const guidance = reviewReady
        ? `Review is ready. Open Review tab, inspect alignment, and publish when satisfied.`
        : `Review is not ready yet because there are no valid draft questions. Ask for regeneration with tighter constraints.`;
      const polishedFollowup = [generatedSummary, skills.size > 0 ? `Focus areas: ${Array.from(skills).slice(0, 4).join(", ")}.` : "", guidance]
        .filter(Boolean)
        .join("\n");
      if (verification?.state === "generation_failed") {
        setGenerationState("generation_failed");
      } else if (verification?.state === "validation_failed") {
        setGenerationState("validation_failed");
      } else if (verification?.state === "partial_success") {
        setGenerationState("partial_success");
      } else if (reviewReady) {
        setGenerationState("ready_for_review");
      }
      const respWarnings = (data as any).warnings;
      setChat((prev) => [...prev, { role: "user", text: message }, { role: "ai", text: `${data.reply}\n\n${polishedFollowup}`, metadata: data.metadata, warnings: Array.isArray(respWarnings) ? respWarnings : undefined }]);
      setMsg("");
    },
    onError: (err: Error) => {
      setPipelineActive(false);
      setGenerationStartedAt(null);
      setGenerationState(err.message.toLowerCase().includes("draft") ? "persistence_failed" : "generation_failed");
      const friendly = err.message.includes("stopped")
        ? err.message
        : err.message.includes("aborted") || err.message.toLowerCase().includes("timeout")
          ? "Generation timed out. Please retry, or try a shorter/simpler prompt."
          : err.message;
      toast({ title: "Co-Pilot failed", description: friendly, variant: "destructive" });
    },
  });

  const updateMetaMutation = useMutation({
    mutationFn: async () => {
      if (!activeQuizId) throw new Error("No quiz to update");
      const validationError = validateMeta();
      if (validationError) throw new Error(validationError);
      await authApiRequest("PUT", `/api/tutor/quizzes/${activeQuizId}`, {
        title: title.trim(),
        syllabus: legacySyllabusLabel || null,
        level: legacyLevelLabel || null,
        subject: legacySubjectName || null,
        topics: selectedTopicTitles,
        timeLimitMinutes,
      });
    },
    onSuccess: () => {
      setMetaDirty(false);
      queryClient.invalidateQueries({ queryKey: ["/api/tutor/quizzes", activeQuizId] });
      queryClient.invalidateQueries({ queryKey: ["/api/tutor/quizzes"] });
      toast({ title: "Assessment details updated" });
    },
    onError: (err: Error) => toast({ title: "Failed to update", description: err.message, variant: "destructive" }),
  });

  // Client-side draft delete (no DB write — draft only)
  const deleteDraftQuestion = useCallback(async (draftId: string) => {
    const newDraft = draftQuestions.filter((q) => q.draftId !== draftId);
    setDraftQuestions(newDraft);
    setIsDraftDirty(true);
    if (activeQuizId) await syncDraft(activeQuizId, newDraft);
  }, [draftQuestions, activeQuizId, syncDraft]);

  // Publish draft → commit to DB
  const handlePublish = useCallback(async () => {
    const validationError = validateMeta();
    if (validationError) {
      toast({ title: "Cannot publish yet", description: validationError, variant: "destructive" });
      return;
    }
    if (!activeQuizId) {
      toast({ title: "Create the quiz first", description: "Use the copilot to generate some questions before publishing.", variant: "destructive" });
      return;
    }
    if (draftQuestions.length === 0) {
      toast({ title: "Draft is empty", description: "Add at least one question before publishing.", variant: "destructive" });
      return;
    }
    const draftError = getDraftValidationError(draftQuestions);
    if (draftError) {
      toast({ title: "Draft not publishable", description: draftError, variant: "destructive" });
      return;
    }
    setIsPublishing(true);
    try {
      // Always sync the latest local draft to the server immediately before publishing.
      // This is the safety net: even if an earlier syncDraft failed silently,
      // the server will get the current draft from the client here.
      await syncDraft(activeQuizId, draftQuestions);

      const res = await authFetch(`/api/tutor/quizzes/${activeQuizId}/publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Also send local draft in body as a double fallback
        body: JSON.stringify({ questions: draftQuestions }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Publish failed");
      if (!Array.isArray(data.questions) || data.questions.length === 0) {
        throw new Error("Publish did not return reviewable questions. Draft remains unpublished.");
      }
      setIsDraftDirty(false);
      setLastSavedCount(data.publishedCount ?? draftQuestions.length);
      setGenerationState("ready_for_review");
      setShowSuccessModal(true);
      queryClient.invalidateQueries({ queryKey: ["/api/tutor/quizzes", activeQuizId] });
      queryClient.invalidateQueries({ queryKey: ["/api/tutor/quizzes"] });
    } catch (err: any) {
      toast({ title: "Publish failed", description: err.message, variant: "destructive" });
    } finally {
      setIsPublishing(false);
    }
  }, [activeQuizId, draftQuestions, authFetch, toast, validateMeta]);


  const handleSend = () => {
    if (!msg.trim() || chatMutation.isPending || !authenticated) return;
    setLastAttemptMessage(msg);
    chatMutation.mutate(msg);
  };

  const handleRetry = () => {
    if (!lastAttemptMessage.trim() || chatMutation.isPending) return;
    chatMutation.mutate(lastAttemptMessage);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const totalQuestions = draftQuestions.length;
  const draftValidationError = useMemo(() => getDraftValidationError(draftQuestions), [draftQuestions]);

  const previewQuestions = useMemo(() =>
    draftQuestions.map((q, idx) => ({
      id: idx,
      quizId: activeQuizId || 0,
      stem: unescapeLatex(q.stem),
      options: q.options,
      marks: q.marks,
      questionType: q.questionType,
      graphSpec: q.graphSpec,
    } as StudentQuestion)), [draftQuestions, activeQuizId]);


  if (supaLoading || sessionLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-violet-400" />
      </div>
    );
  }

  if (sessionError) {
    return <div className="min-h-screen bg-background p-4 md:p-6 text-red-400">Failed to verify session.</div>;
  }

  if (!authenticated) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <div className="glass-card p-8 text-center">
          <p className="text-slate-300">Please <Link href="/login" className="text-violet-400 underline">log in</Link> to access the builder.</p>
        </div>
      </div>
    );
  }

  if (isEditMode && quizLoading) {
    return (
      <div className="min-h-screen bg-background">
        <header className="border-b border-white/5 bg-white/[0.02] backdrop-blur-sm">
          <div className="max-w-[1400px] mx-auto px-4 md:px-6 py-4">
            <Skeleton className="h-8 w-48 bg-white/5" />
          </div>
        </header>
        <main className="max-w-[1400px] mx-auto p-4 md:p-6 space-y-4">
          <Skeleton className="h-64 w-full bg-white/5" />
          <Skeleton className="h-64 w-full bg-white/5" />
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-white/5 bg-white/[0.02] backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-[1400px] mx-auto px-4 md:px-6 py-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 md:gap-3 min-w-0">
            <Button className="glow-button-outline" size="default" data-testid="button-back-admin" onClick={handleBack}>
                <ArrowLeft className="w-4 h-4 md:mr-1" />
                <span>Back</span>
            </Button>
            <div className="flex items-center gap-2 md:gap-3 min-w-0">
              <img src="/MCEC - White Logo.png" alt="MCEC Logo" className="h-7 md:h-8 w-auto object-contain" />
              <div className="min-w-0">
                <h1 className="text-base md:text-lg font-bold gradient-text truncate" data-testid="text-builder-title">
                  {activeQuizId ? "Edit Assessment" : "New Assessment"}
                </h1>
                {activeQuizId && <p className="text-[10px] md:text-xs text-slate-500">ID: {activeQuizId}</p>}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Badge className={`text-[10px] md:text-xs border ${isDraftDirty ? "bg-amber-500/10 text-amber-400 border-amber-500/30" : "bg-white/5 text-slate-400 border-white/10"}`}>
              {totalQuestions} Q{totalQuestions !== 1 ? "s" : ""}
              {isDraftDirty && <span className="ml-1 hidden md:inline">· unsaved</span>}
            </Badge>
            <Button
              className="border border-violet-500/30 bg-violet-500/10 text-violet-300 hover:bg-violet-500/20 hover:border-violet-500/50 transition-all"
              size="default"
              onClick={() => setShowPreview(true)}
              disabled={totalQuestions === 0}
              data-testid="button-preview-quiz"
            >
              <Eye className="w-4 h-4 md:mr-1.5" />
              <span className="hidden md:inline">Preview</span>
            </Button>
            <Button
              className="border border-emerald-500/40 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 hover:border-emerald-500/60 transition-all font-semibold"
              size="default"
              onClick={handlePublish}
              disabled={isPublishing || !activeQuizId || !!draftValidationError}
              data-testid="button-save-publish"
            >
              {isPublishing ? (
                <Loader2 className="w-4 h-4 animate-spin md:mr-1.5" />
              ) : (
                <Save className="w-4 h-4 md:mr-1.5" />
              )}
              <span className="hidden md:inline">{isPublishing ? "Publishing…" : "Save & Publish"}</span>
            </Button>
            <Link href="/tutor/assessments" onClick={handleExit}>
              <Button className="border border-red-500/20 bg-red-500/10 text-red-400 hover:bg-red-500/20 hover:border-red-500/30 transition-all" size="default" data-testid="button-exit-builder">
                <X className="w-4 h-4 md:mr-1" />
                <span>Exit Assessment</span>
              </Button>
            </Link>
          </div>
        </div>
      </header>

      {/* Main content — single column on mobile, 2-col grid on desktop */}
      <main className="max-w-[1600px] mx-auto flex flex-col md:grid md:grid-cols-12 gap-4 p-4 md:p-6 lg:p-8">

        {/* Draft recovery banner — only before the first server-side save */}
        {recoveredDraft && !draftBannerDismissed && !activeQuizId && (
          <div className="md:col-span-12">
            <DraftRecoveryBanner
              draft={recoveredDraft}
              onContinue={applyRecoveredDraft}
              onDelete={deleteRecoveredDraft}
              onDismiss={() => setDraftBannerDismissed(true)}
            />
          </div>
        )}

        {/* LEFT COLUMN (parameters + copilot + pipeline + docs) */}
        <div className="md:col-span-8 flex flex-col gap-4">

          {/* 1. Assessment parameters — step-by-step wizard. */}
          <AssessmentWizard
            step={wizardStep}
            onStep={setWizardStep}
            title={title}
            onTitleChange={(v) => { setTitle(v); markMeta(); }}
            examiningBodySlug={examiningBodySlug}
            onExaminingBodyChange={(slug) => {
              setExaminingBodySlug(slug);
              setLevelCode("");
              setSubjectSlug("");
              setSelectedTopicIds([]);
              setSelectedSubtopicIds([]);
              setResolvedSyllabusCode("");
              markMeta();
            }}
            bodies={examiningBodies}
            bodiesLoading={bodiesLoading}
            levelCode={levelCode}
            onLevelChange={(code) => {
              setLevelCode(code);
              setSubjectSlug("");
              setSelectedTopicIds([]);
              setSelectedSubtopicIds([]);
              setResolvedSyllabusCode("");
              markMeta();
            }}
            levels={catalogueLevels}
            levelsLoading={levelsLoading}
            subjectSlug={subjectSlug}
            onSubjectChange={(slug) => {
              setSubjectSlug(slug);
              setSelectedTopicIds([]);
              setSelectedSubtopicIds([]);
              markMeta();
            }}
            subjects={catalogueSubjects}
            subjectsLoading={subjectsLoading}
            resolvedSyllabus={syllabusFromCatalogue}
            topics={catalogueTopics}
            topicsLoading={topicsLoading}
            selectedTopicIds={selectedTopicIds}
            onToggleTopic={(id) => {
              setSelectedTopicIds((prev) =>
                prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
              );
              markMeta();
            }}
            onClearTopics={() => {
              setSelectedTopicIds([]);
              setSelectedSubtopicIds([]);
              markMeta();
            }}
            selectedSubtopicIds={selectedSubtopicIds}
            onToggleSubtopic={(topicId, subtopicId) => {
              // Compute the next subtopic list synchronously so we can decide
              // whether the parent topic should still be in scope.
              const wasSelected = selectedSubtopicIds.includes(subtopicId);
              const nextSubs = wasSelected
                ? selectedSubtopicIds.filter((x) => x !== subtopicId)
                : [...selectedSubtopicIds, subtopicId];
              setSelectedSubtopicIds(nextSubs);

              // A topic is "in scope" when ≥1 of its subtopics is ticked. If
              // we just unchecked the last one, drop the parent topic so the
              // backend doesn't silently widen the prompt to the whole topic.
              const parentTopic = catalogueTopics.find((t) => t.id === topicId);
              const parentSubIds = parentTopic?.subtopics?.map((s) => s.id) ?? [];
              const anyParentSubSelected = nextSubs.some((id) => parentSubIds.includes(id));
              setSelectedTopicIds((prev) => {
                if (anyParentSubSelected) {
                  return prev.includes(topicId) ? prev : [...prev, topicId];
                }
                return prev.filter((id) => id !== topicId);
              });
              markMeta();
            }}
            onToggleAllSubtopicsForTopic={(topicId, subtopicIds, select) => {
              setSelectedSubtopicIds((prev) => {
                const without = prev.filter((id) => !subtopicIds.includes(id));
                return select ? [...without, ...subtopicIds] : without;
              });
              setSelectedTopicIds((prev) => {
                if (select) return prev.includes(topicId) ? prev : [...prev, topicId];
                return prev.filter((id) => id !== topicId);
              });
              markMeta();
            }}
            timeLimitMinutes={timeLimitMinutes}
            onTimeLimitChange={(v) => { setTimeLimitMinutes(v); markMeta(); }}
            activeQuizId={activeQuizId}
            metaDirty={metaDirty}
            onSaveMeta={() => updateMetaMutation.mutate()}
            saveMetaPending={updateMetaMutation.isPending}
            quickStart={quickStart}
            onQuickStartChange={(next) => {
              setQuickStart(next);
              try { window.localStorage.setItem("soma:wizard-quickstart", next ? "1" : "0"); } catch {}
              if (next) {
                // Lock examining body to Cambridge (the only one we currently
                // ingest) and clear any topic selections so the prompt isn't
                // silently narrowed by stale state.
                if (examiningBodySlug !== "cambridge") setExaminingBodySlug("cambridge");
                if (selectedTopicIds.length > 0) setSelectedTopicIds([]);
                if (selectedSubtopicIds.length > 0) setSelectedSubtopicIds([]);
                // If the tutor was sitting on a now-hidden step, jump to the
                // first visible one so the wizard renders sensibly.
                if (wizardStep === 0 || wizardStep === 3) setWizardStep(1);
                markMeta();
              }
            }}
          />


          {/* 2. Co-Pilot — Main Focus */}
          <div className="glass-card flex flex-col overflow-hidden" style={{ minHeight: "400px" }}>
            <div className="px-4 py-3 border-b border-white/5 flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-violet-400" />
              <span className="text-sm font-semibold text-slate-200" data-testid="tab-copilot">Co-Pilot</span>
              {pipelineActive && (
                <span className="ml-auto flex items-center gap-1.5 text-[11px] font-medium text-violet-300" data-testid="text-pipeline-current-stage">
                  <Loader2 className="w-3.5 h-3.5 animate-spin text-violet-400" />
                  <span className="hidden sm:inline">
                    {(PIPELINE_STAGES.find((s) => s.stage === currentStage)?.aiName) || "Working"}…
                  </span>
                </span>
              )}
              {totalQuestions > 0 && !pipelineActive && (
                <Badge className="bg-emerald-500/10 text-emerald-400 border-emerald-500/30 text-[10px] ml-auto">
                  {totalQuestions} saved
                </Badge>
              )}
            </div>
            <div className="px-4 py-2 border-b border-white/5 text-xs">
              {generationState === "generation_in_progress" && <span className="text-violet-300">Generation in progress…</span>}
              {generationState === "generation_failed" && <span className="text-red-400">Generation failed or produced no valid draft. Please refine your prompt.</span>}
              {generationState === "partial_success" && <span className="text-amber-300">Generation partially succeeded. Review the available questions before publishing.</span>}
              {generationState === "validation_failed" && <span className="text-amber-300">Generation output failed validation. No trusted draft changes were applied.</span>}
              {generationState === "persistence_failed" && <span className="text-red-400">Draft persistence failed. Please retry to sync questions.</span>}
              {generationState === "ready_for_review" && <span className="text-emerald-400">Draft is ready for review and publish.</span>}
              {generationState === "generation_started" && !pipelineActive && <span className="text-slate-500">Ready to generate when you send a prompt.</span>}
            </div>

            {/* Pipeline Progress */}
            {pipelineActive && (
              <div className="px-4 py-3 border-b border-white/5">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                  {PIPELINE_STAGES.map((s) => {
                    const isDone = completedStages.has(s.stage);
                    const isActive = currentStage === s.stage && !isDone;
                    return (
                      <div
                        key={s.stage}
                        className={`flex items-center gap-1.5 p-2 rounded-lg border text-xs transition-all ${
                          isDone ? "bg-emerald-500/10 border-emerald-500/30" :
                          isActive ? "bg-violet-500/10 border-violet-500/30 shadow-[0_0_15px_rgba(139,92,246,0.1)]" :
                          "bg-white/[0.02] border-white/5 opacity-40"
                        }`}
                        data-testid={`pipeline-stage-${s.stage}`}
                      >
                        <span className="shrink-0">
                          {s.icon === "scan" && <Scan className="w-3 h-3" />}
                          {s.icon === "brain" && <Brain className="w-3 h-3" />}
                          {s.icon === "pencil" && <Pencil className="w-3 h-3" />}
                          {s.icon === "search" && <Search className="w-3 h-3" />}
                        </span>
                        <span className={`flex-1 truncate ${isDone ? "text-emerald-400" : isActive ? "text-violet-300" : "text-slate-500"}`}>
                          {isActive ? s.label : s.aiName}
                        </span>
                        {isDone ? <CheckCircle2 className="w-3 h-3 text-emerald-400 shrink-0" /> :
                         isActive ? <Loader2 className="w-3 h-3 animate-spin text-violet-400 shrink-0" /> :
                         <div className="w-3 h-3 rounded-full border border-white/10 shrink-0" />}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Chat messages */}
            <div className="flex-1 p-4 overflow-auto space-y-3 h-[50vh] md:h-auto md:min-h-[300px] md:max-h-[500px]">
              {chat.length === 0 && (
                <div className="text-center pt-8 space-y-2">
                  <Sparkles className="w-8 h-8 mx-auto text-violet-400/40" />
                  <p className="text-sm text-slate-400">Generate assessment questions using the Co-Pilot.</p>
                  <p className="text-xs text-slate-500">Questions are auto-saved to the database.</p>
                  <p className="text-xs text-slate-600 italic">"Generate 5 IGCSE quadratics MCQs"</p>
                </div>
              )}
              {chat.map((m, i) => (
                <div key={i} className={m.role === "user" ? "text-right" : "text-left"}>
                  <div className={`inline-block max-w-[90%] rounded-xl px-3 py-2 text-sm whitespace-pre-wrap leading-relaxed ${
                    m.role === "user"
                      ? "bg-violet-600/20 text-violet-200 border border-violet-500/20"
                      : "bg-white/5 text-slate-300 border border-white/5"
                  }`}>
                    {m.text}
                    {m.metadata && (
                      <div className="mt-1.5 inline-flex items-center gap-1.5 px-1.5 py-0.5 rounded bg-slate-900/50 border border-white/5 text-[9px] text-slate-400 font-mono" data-testid={`badge-telemetry-${i}`}>
                        <span>{m.metadata.model}</span>
                        <span>{(m.metadata.durationMs / 1000).toFixed(2)}s</span>
                      </div>
                    )}
                    {m.warnings && m.warnings.length > 0 && (
                      <div className="mt-2 rounded-lg border border-amber-500/30 bg-amber-500/[0.06] p-2.5 text-left" data-testid={`block-warnings-${i}`}>
                        <div className="flex items-center gap-1.5 text-[11px] font-semibold text-amber-300 mb-1.5">
                          <AlertTriangle className="w-3.5 h-3.5" />
                          <span>Quality check flagged {m.warnings.length} issue{m.warnings.length === 1 ? "" : "s"}</span>
                        </div>
                        <ul className="space-y-1 text-[11px] text-amber-100/90 leading-relaxed">
                          {m.warnings.map((w, wi) => (
                            <li key={wi} className="flex items-start gap-1.5" data-testid={`text-warning-${i}-${wi}`}>
                              <span className="font-mono text-amber-400/80 shrink-0">{w.questionIndex > 0 ? `Q${w.questionIndex}` : "All"}</span>
                              <span className="text-amber-300/70 shrink-0">[{w.field}]</span>
                              <span className="flex-1">{w.issue}</span>
                              <span className={`shrink-0 px-1 rounded text-[9px] font-mono ${w.autoFixed ? "bg-emerald-500/20 text-emerald-300" : "bg-rose-500/20 text-rose-300"}`}>
                                {w.autoFixed ? "fixed" : "review"}
                              </span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                </div>
              ))}
              <div ref={chatEndRef} />
            </div>

            {/* Chat input */}
            <div className="p-3 md:p-4 border-t border-white/5 space-y-2">
              {chatMutation.isPending && (
                <div className="flex items-center justify-between gap-3 rounded-lg border border-violet-500/30 bg-violet-500/[0.06] px-3 py-2">
                  <div className="flex items-center gap-2 text-[11px] text-violet-200">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    <span>
                      Generating… {elapsedSecs}s elapsed
                      {elapsedSecs > 0 && elapsedSecs < 60 ? " · typical 15–45s" : ""}
                      {elapsedSecs >= 60 ? " · this is taking longer than usual" : ""}
                    </span>
                  </div>
                  <button
                    onClick={stopGeneration}
                    className="flex items-center gap-1 text-[11px] text-rose-300 hover:text-rose-200"
                    data-testid="button-copilot-stop"
                  >
                    <StopCircle className="w-3.5 h-3.5" />
                    Stop
                  </button>
                </div>
              )}
              {!chatMutation.isPending && generationState === "generation_failed" && lastAttemptMessage && (
                <div className="flex items-center justify-between gap-3 rounded-lg border border-rose-500/30 bg-rose-500/[0.06] px-3 py-2">
                  <span className="text-[11px] text-rose-200">Last generation failed. You can retry the same prompt.</span>
                  <button
                    onClick={handleRetry}
                    className="flex items-center gap-1 text-[11px] text-violet-200 hover:text-violet-100"
                    data-testid="button-copilot-retry"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    Retry
                  </button>
                </div>
              )}
              <div className="flex gap-2">
                <Textarea
                  value={msg}
                  onChange={(e) => setMsg(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder={activeQuizId ? "Ask to edit or add questions..." : "Ask for questions..."}
                  className="glass-input flex-1 min-h-[44px] max-h-[100px] resize-none text-sm"
                  data-testid="input-copilot-message"
                />
                <Button
                  className="glow-button shrink-0 self-end min-h-[44px] min-w-[44px]"
                  size="icon"
                  onClick={handleSend}
                  disabled={!msg.trim() || chatMutation.isPending || !authenticated}
                  data-testid="button-copilot-send"
                >
                  {chatMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                </Button>
              </div>
              <label className="flex items-center gap-2 cursor-pointer select-none w-fit" data-testid="label-include-graph-questions">
                <input
                  type="checkbox"
                  checked={includeGraphQuestions}
                  onChange={(e) => setIncludeGraphQuestions(e.target.checked)}
                  className="w-3.5 h-3.5 accent-violet-500"
                  data-testid="checkbox-include-graph-questions"
                />
                <span className="text-xs text-slate-400">Include some questions with graphs</span>
              </label>
            </div>
          </div>

        </div>

        {/* RIGHT COLUMN — Draft Questions (desktop sidebar) */}
        <div className="md:col-span-4">
          <div className="glass-card p-4 md:p-5 md:sticky md:top-20 flex flex-col gap-3">

            {/* Panel header */}
            <div className="flex items-center gap-2">
              <FileStack className="w-4 h-4 text-amber-400" />
              <h2 className="font-semibold text-slate-100 text-sm">Draft Questions</h2>
              {isDraftDirty && (
                <Badge className="bg-amber-500/10 text-amber-400 border-amber-500/20 text-[10px] flex items-center gap-1">
                  <AlertCircle className="w-3 h-3" />
                  Unsaved
                </Badge>
              )}
              <Badge className="bg-white/5 text-slate-400 border-white/10 text-[10px] ml-auto">{totalQuestions}</Badge>
            </div>

            {/* Draft syncing indicator */}
            {isSyncingDraft && (
              <div className="flex items-center gap-1.5 text-[10px] text-slate-500">
                <Loader2 className="w-3 h-3 animate-spin" />
                Auto-saving draft…
              </div>
            )}

            {/* Empty state */}
            {draftQuestions.length === 0 && !pipelineActive ? (
              <div className="py-8 text-center space-y-2">
                <FileStack className="w-8 h-8 mx-auto text-slate-700" />
                <p className="text-sm text-slate-500">No draft questions yet.</p>
                <p className="text-xs text-slate-600">Use the Co-Pilot to generate questions. They'll appear here before you publish.</p>
              </div>
            ) : (
              <div className="space-y-2 max-h-[50vh] md:max-h-[calc(100vh-280px)] overflow-auto pr-1">
                {draftQuestions.map((q, idx) => (
                  <div
                    key={q.draftId}
                    className="bg-white/[0.03] border border-white/5 rounded-lg p-3 flex items-start gap-2"
                    data-testid={`card-draft-q-${idx}`}
                  >
                    <span className="text-xs font-mono text-amber-400 font-medium mt-0.5 shrink-0 w-6">Q{idx + 1}</span>
                    <div className="flex-1 min-w-0">
                      <div className="text-xs text-slate-300 line-clamp-2"><MarkdownRenderer content={unescapeLatex(q.stem)} /></div>
                      <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                        <Badge className="bg-white/5 text-slate-500 border-white/10 text-[10px]">{q.options.length} opts</Badge>
                        <Badge className="bg-white/5 text-slate-500 border-white/10 text-[10px]">{q.marks}m</Badge>
                        {q.questionType === "graph" && (
                          <Badge className="bg-violet-500/10 text-violet-400 border-violet-500/20 text-[10px]">graph</Badge>
                        )}
                        {q.difficultyTag && (
                          <Badge className={`text-[10px] border ${
                            q.difficultyTag.toLowerCase().includes("hard")
                              ? "bg-red-500/10 text-red-400 border-red-500/20"
                              : q.difficultyTag.toLowerCase().includes("easy")
                                ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
                                : "bg-white/5 text-slate-500 border-white/10"
                          }`}>{q.difficultyTag}</Badge>
                        )}
                      </div>
                    </div>
                    <button
                      className="text-slate-600 hover:text-red-400 shrink-0 min-w-[32px] min-h-[32px] flex items-center justify-center rounded-lg transition-colors"
                      onClick={() => deleteDraftQuestion(q.draftId)}
                      title="Remove from draft"
                      data-testid={`button-delete-draft-${idx}`}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Publish CTA */}
            {draftQuestions.length > 0 && (
              <div className="border-t border-white/5 pt-3">
                <Button
                  className="w-full border border-emerald-500/40 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 hover:border-emerald-500/60 transition-all font-semibold min-h-[44px]"
                  onClick={handlePublish}
                  disabled={isPublishing || !activeQuizId}
                  data-testid="button-publish-draft"
                >
                  {isPublishing ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      Publishing…
                    </>
                  ) : (
                    <>
                      <Save className="w-4 h-4 mr-2" />
                      Save & Publish ({totalQuestions} Q{totalQuestions !== 1 ? "s" : ""})
                    </>
                  )}
                </Button>
                <p className="text-[10px] text-slate-600 text-center mt-2">
                  {draftValidationError ? `Cannot publish: ${draftValidationError}` : "Questions are in draft until you publish. Keep editing freely."}
                </p>
              </div>
            )}
          </div>
        </div>
      </main>

      {/* Success Modal */}
      {showSuccessModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" data-testid="modal-success">
          <div className="glass-card w-full max-w-md p-6 md:p-8 text-center space-y-5 border border-violet-500/20 shadow-[0_0_40px_rgba(139,92,246,0.15)]">
            <div className="w-16 h-16 rounded-full bg-gradient-to-br from-emerald-500/20 to-violet-500/20 flex items-center justify-center mx-auto border border-emerald-500/30">
              <PartyPopper className="w-8 h-8 text-emerald-400" />
            </div>
            <div>
              <h2 className="text-xl font-bold text-slate-100 mb-1" data-testid="text-success-title">Assessment Created Successfully!</h2>
              <p className="text-sm text-slate-400">
                {lastSavedCount} question{lastSavedCount !== 1 ? "s" : ""} generated, audited, and saved to the database.
              </p>
            </div>
            <div className="flex flex-col gap-2.5 pt-2">
              <Button
                className="w-full glow-button min-h-[48px]"
                onClick={() => { setShowSuccessModal(false); setShowPreview(true); }}
                data-testid="button-success-preview"
              >
                <Eye className="w-4 h-4 mr-2" />
                Preview Assessment
              </Button>
              <Link href="/tutor/assessments">
                <Button className="w-full glow-button-outline min-h-[48px]" data-testid="button-success-dashboard">
                  <LayoutDashboard className="w-4 h-4 mr-2" />
                  Back to Assessments
                </Button>
              </Link>
            </div>
          </div>
        </div>
      )}

      {/* Preview Modal */}
      {showPreview && (
        <div className="fixed inset-0 z-50 bg-background overflow-auto" data-testid="modal-preview">
          <SomaQuizEngine
            previewMode={true}
            previewTitle={title || "Untitled Assessment"}
            previewQuestions={previewQuestions}
            onExitPreview={() => setShowPreview(false)}
          />
        </div>
      )}
    </div>
  );
}
