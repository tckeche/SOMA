import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  BookOpen,
  Building2,
  GraduationCap,
  Library,
  ListChecks,
  FileText,
  Timer,
  ChevronLeft,
  ChevronRight,
  Check,
  Loader2,
  AlertCircle,
  ChevronDown,
  PenLine,
  Combine,
  Minus,
  Plus,
} from "lucide-react";

// ── Types shared with builder.tsx ──────────────────────────────────────────
// Kept in this file rather than re-imported from the server because the
// wizard has no need for the full catalogue DTOs — just their display
// fields. Any additions here must stay compatible with the backend shape.

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

export interface AssessmentWizardProps {
  step: 0 | 1 | 2 | 3 | 4;
  onStep: (s: 0 | 1 | 2 | 3 | 4) => void;

  title: string;
  onTitleChange: (v: string) => void;
  titleError?: boolean;

  examiningBodySlug: string;
  onExaminingBodyChange: (slug: string) => void;
  bodies: ExaminingBodyDto[];
  bodiesLoading: boolean;

  levelCode: string;
  onLevelChange: (code: string) => void;
  levels: LevelDto[];
  levelsLoading: boolean;

  subjectSlug: string;
  onSubjectChange: (slug: string) => void;
  subjects: SubjectDto[];
  subjectsLoading: boolean;

  resolvedSyllabus: SyllabusDto | null;
  topics: TopicListItemDto[];
  topicsLoading: boolean;
  selectedTopicIds: number[];
  onToggleTopic: (id: number) => void;
  onClearTopics: () => void;
  selectedSubtopicIds: number[];
  onToggleSubtopic: (topicId: number, subtopicId: number) => void;
  onToggleAllSubtopicsForTopic: (topicId: number, subtopicIds: number[], select: boolean) => void;

  timeLimitMinutes: number;
  onTimeLimitChange: (v: number) => void;

  activeQuizId: number | null;
  metaDirty: boolean;
  onSaveMeta: () => void;
  saveMetaPending: boolean;

  // Quick-start mode collapses the wizard to Level → Subject → Time only.
  // Examining body is auto-fixed to Cambridge and the Topics step is hidden,
  // so the Co-Pilot infers scope from the tutor's free-text prompt instead.
  // Useful for English Lit / English Lang / History where the catalogue does
  // not break the syllabus into machine-readable topics.
  quickStart: boolean;
  onQuickStartChange: (next: boolean) => void;

  // Delivery format, chosen up front. "mcq" drives the Co-Pilot/MCQ engine;
  // "pdf" switches the build to worksheet upload + student PDF submission.
  format: "mcq" | "pdf";
  onFormatChange: (next: "mcq" | "pdf") => void;
  pdfMarkingMode: "manual" | "dual_ai";
  onPdfMarkingModeChange: (next: "manual" | "dual_ai") => void;
  // Locked once the assessment exists so the format can't change after rows
  // (questions or worksheets) are tied to one delivery model.
  formatLocked?: boolean;

  // Quiz sub-type + parametric question counts (only shown for the quiz engine,
  // i.e. when format !== "pdf").
  quizMode: "mcq" | "structured" | "hybrid";
  onQuizModeChange: (next: "mcq" | "structured" | "hybrid") => void;
  questionCount: number;
  onQuestionCountChange: (next: number) => void;
  structuredRatio: number;
  onStructuredRatioChange: (next: number) => void;
  // Derived split, supplied by the parent for display.
  structuredCount: number;
  mcqCount: number;
  // Locked alongside the format once the assessment exists.
  modeLocked?: boolean;
}

const STEPS: Array<{
  key: 0 | 1 | 2 | 3 | 4;
  label: string;
  icon: typeof BookOpen;
}> = [
  { key: 0, label: "Examining body", icon: Building2 },
  { key: 1, label: "Level", icon: GraduationCap },
  { key: 2, label: "Subject", icon: Library },
  { key: 3, label: "Topics", icon: ListChecks },
  { key: 4, label: "Time limit", icon: Timer },
];

export function AssessmentWizard(props: AssessmentWizardProps) {
  const {
    step, onStep,
    title, onTitleChange, titleError = false,
    examiningBodySlug, onExaminingBodyChange, bodies, bodiesLoading,
    levelCode, onLevelChange, levels, levelsLoading,
    subjectSlug, onSubjectChange, subjects, subjectsLoading,
    resolvedSyllabus, topics, topicsLoading,
    selectedTopicIds, onToggleTopic, onClearTopics,
    selectedSubtopicIds, onToggleSubtopic, onToggleAllSubtopicsForTopic,
    timeLimitMinutes, onTimeLimitChange,
    activeQuizId, metaDirty, onSaveMeta, saveMetaPending,
    quickStart, onQuickStartChange,
    format, onFormatChange, pdfMarkingMode, onPdfMarkingModeChange, formatLocked = false,
    quizMode, onQuizModeChange,
    questionCount, onQuestionCountChange,
    structuredRatio, onStructuredRatioChange,
    structuredCount, mcqCount, modeLocked = false,
  } = props;

  // Hybrid quizzes need at least one of each type, so the floor is 2.
  const minQuestions = quizMode === "hybrid" ? 2 : 1;
  // 40 is the platform ceiling (see somaGenerateSchema). Quizzes over 15 are
  // generated in sequential, de-duplicated batches of 15 server-side.
  const MAX_QUESTIONS = 40;
  const clampCount = (n: number) =>
    Math.max(minQuestions, Math.min(MAX_QUESTIONS, Math.round(n)));

  // In quick-start mode the tutor sees Level / Subject / Topics / Time. Only the
  // Examining body step is hidden (locked to Cambridge); the Topics step stays
  // available so the tutor can manually scope the assessment if they want to.
  const visibleStepKeys = useMemo<Array<0 | 1 | 2 | 3 | 4>>(
    () => quickStart ? [1, 2, 3, 4] : [0, 1, 2, 3, 4],
    [quickStart],
  );
  const visibleSteps = useMemo(
    () => STEPS.filter((s) => visibleStepKeys.includes(s.key)),
    [visibleStepKeys],
  );

  // A step counts as "complete" once its required value is filled. Topics is
  // optional (empty selection = whole subject) and ticks complete as soon as
  // the tutor lands on the step.
  // A title is required before the tutor can leave the first visible step.
  // In quick-start mode the first visible step is Level (1); otherwise it is
  // Examining body (0). Gate that step on the title as well as its own value.
  const firstVisibleStep = visibleStepKeys[0];
  const titleProvided = !!title.trim();

  const stepDone = useMemo<Record<0 | 1 | 2 | 3 | 4, boolean>>(() => ({
    0: !!examiningBodySlug && (firstVisibleStep !== 0 || titleProvided),
    1: !!levelCode && (firstVisibleStep !== 1 || titleProvided),
    2: !!subjectSlug,
    3: !!subjectSlug, // topics step is optional — done once reachable
    4: Number.isFinite(timeLimitMinutes) && timeLimitMinutes >= 1 && timeLimitMinutes <= 300,
  }), [examiningBodySlug, levelCode, subjectSlug, timeLimitMinutes, firstVisibleStep, titleProvided]);

  const canAdvance = (from: 0 | 1 | 2 | 3 | 4): boolean => {
    // The title gate applies to whichever step is the first visible one.
    if (from === firstVisibleStep && !titleProvided) return false;
    // Mirror stepDone but treat step 3 (topics) as always advanceable.
    if (from === 3) return !!subjectSlug;
    return stepDone[from];
  };

  // Walk forward/back through only the visible steps. This keeps the ordering
  // stable (Level → Subject → Time in quick-start) without having to renumber
  // the underlying step keys, which the parent uses for persistence.
  const goNext = () => {
    const idx = visibleStepKeys.indexOf(step);
    if (idx < 0 || idx === visibleStepKeys.length - 1) return;
    if (!canAdvance(step)) return;
    onStep(visibleStepKeys[idx + 1]);
  };
  const goBack = () => {
    const idx = visibleStepKeys.indexOf(step);
    if (idx <= 0) return;
    onStep(visibleStepKeys[idx - 1]);
  };
  const isLastVisibleStep = visibleStepKeys.indexOf(step) === visibleStepKeys.length - 1;

  return (
    <div className="glass-card p-4 md:p-5 space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        <BookOpen className="w-4 h-4 text-primary" />
        <h2 className="font-semibold text-foreground text-sm">Assessment Parameters</h2>
        {activeQuizId && (
          <Badge className="bg-success/10 text-success border-success/30 text-[10px]">
            Live · ID {activeQuizId}
          </Badge>
        )}
        <button
          type="button"
          onClick={() => onQuickStartChange(!quickStart)}
          className={`ml-auto text-[11px] rounded-md px-2 py-1 border transition-colors ${
            quickStart
              ? "border-primary/50 bg-primary/15 text-primary"
              : "border-border/50 bg-foreground/[0.03] text-muted-foreground hover:text-foreground hover:bg-foreground/5"
          }`}
          title="Hide examining body and topics — let the Co-Pilot infer scope from your prompt"
          data-testid="button-toggle-quick-start"
        >
          {quickStart ? "✓ Quick start" : "Quick start"}
        </button>
      </div>
      {quickStart && (
        <p className="text-[11px] text-primary/80 -mt-2">
          Quick start on — examining body fixed to Cambridge, topics skipped. The Co-Pilot will infer scope from your prompt.
        </p>
      )}

      {/* Assessment type — chosen up front. Quiz drives the Co-Pilot engine;
          PDF switches to worksheet upload + student PDF submission. */}
      <div className="space-y-1.5">
        <Label className="text-xs uppercase text-muted-foreground">Assessment type</Label>
        <div className="grid grid-cols-2 gap-2">
          {([
            { value: "mcq" as const, title: "Quiz", desc: "AI-built questions, auto-marked", icon: ListChecks },
            { value: "pdf" as const, title: "PDF Submission", desc: "Upload an assessment and choose manual or AI-assisted marking.", icon: FileText },
          ]).map((opt) => {
            const Icon = opt.icon;
            const selected = format === opt.value;
            const disabled = formatLocked && !selected;
            return (
              <button
                type="button"
                key={opt.value}
                onClick={() => { if (!formatLocked) onFormatChange(opt.value); }}
                disabled={disabled}
                className={`text-left rounded-lg border px-3 py-2.5 transition-colors ${
                  selected
                    ? "border-primary/50 bg-primary/10 text-primary"
                    : "border-border/50 bg-foreground/[0.03] text-foreground/80 hover:bg-foreground/5"
                } ${disabled ? "opacity-50 cursor-not-allowed" : ""}`}
                data-testid={`wizard-format-${opt.value}`}
              >
                <span className="flex items-center gap-1.5 text-sm font-semibold">
                  <Icon className="w-3.5 h-3.5" />
                  {opt.title}
                </span>
                <span className="block text-[11px] text-muted-foreground mt-0.5">{opt.desc}</span>
              </button>
            );
          })}
        </div>
        {formatLocked && (
          <p className="text-[11px] text-muted-foreground">Type is locked once the assessment is created.</p>
        )}

        {format === "pdf" && (
          <div className="mt-3 rounded-lg border border-border/40 bg-background/30 p-3 space-y-2" data-testid="pdf-marking-method">
            <Label className="text-xs uppercase text-muted-foreground">PDF marking method</Label>
            <div className="grid gap-2 md:grid-cols-2">
              {[
                { value: "manual" as const, title: "Tutor marks manually", desc: "Use the current PDF workflow and enter marks yourself." },
                { value: "dual_ai" as const, title: "AI-assisted dual marking", desc: "Two independent AI markers assess the handwritten script, cross-check one another and prepare an annotated result for tutor approval." },
              ].map((opt) => (
                <button key={opt.value} type="button" disabled={formatLocked} onClick={() => onPdfMarkingModeChange(opt.value)} className={`text-left rounded-lg border px-3 py-2 ${pdfMarkingMode === opt.value ? "border-primary/50 bg-primary/10 text-primary" : "border-border/50 bg-foreground/[0.03]"} ${formatLocked ? "opacity-60 cursor-not-allowed" : "hover:bg-foreground/5"}`} data-testid={`pdf-marking-mode-${opt.value}`}>
                  <span className="block text-sm font-semibold">{opt.title}</span>
                  <span className="block text-[11px] text-muted-foreground mt-0.5">{opt.desc}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Quiz sub-type + parametric question count — quiz engine only. */}
      {format !== "pdf" && (
        <div className="space-y-3 rounded-lg border border-border/30 bg-background/30 p-3">
          <div className="space-y-1.5">
            <Label className="text-xs uppercase text-muted-foreground">Question style</Label>
            <div className="grid grid-cols-3 gap-2">
              {([
                { value: "mcq" as const, title: "Multiple choice", icon: ListChecks },
                { value: "structured" as const, title: "Structured", icon: PenLine },
                { value: "hybrid" as const, title: "Hybrid", icon: Combine },
              ]).map((opt) => {
                const Icon = opt.icon;
                const selected = quizMode === opt.value;
                const disabled = modeLocked && !selected;
                return (
                  <button
                    type="button"
                    key={opt.value}
                    onClick={() => { if (!modeLocked) onQuizModeChange(opt.value); }}
                    disabled={disabled}
                    className={`flex flex-col items-center gap-1 rounded-lg border px-2 py-2.5 text-center transition-colors ${
                      selected
                        ? "border-primary/50 bg-primary/10 text-primary"
                        : "border-border/50 bg-foreground/[0.03] text-foreground/80 hover:bg-foreground/5"
                    } ${disabled ? "opacity-50 cursor-not-allowed" : ""}`}
                    data-testid={`wizard-mode-${opt.value}`}
                  >
                    <Icon className="w-4 h-4" />
                    <span className="text-[11px] font-semibold leading-tight">{opt.title}</span>
                  </button>
                );
              })}
            </div>
            {modeLocked && (
              <p className="text-[11px] text-muted-foreground">Question style is locked once the assessment is created.</p>
            )}
          </div>

          {/* Number of questions dial. */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label className="text-xs uppercase text-muted-foreground">Number of questions</Label>
              <span className="text-[10px] text-muted-foreground">
                {minQuestions}–{MAX_QUESTIONS}{quizMode === "hybrid" ? " · min 2 for hybrid" : ""}
              </span>
            </div>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => onQuestionCountChange(clampCount(questionCount - 1))}
                disabled={questionCount <= minQuestions}
                className="h-9 w-9 shrink-0 rounded-md border border-border/50 bg-foreground/[0.03] flex items-center justify-center text-foreground hover:bg-foreground/5 disabled:opacity-40 disabled:cursor-not-allowed"
                aria-label="Decrease question count"
                data-testid="wizard-count-decrement"
              >
                <Minus className="w-4 h-4" />
              </button>
              <div
                className="min-w-[3rem] text-center text-2xl font-bold tabular-nums text-foreground"
                data-testid="wizard-question-count"
              >
                {questionCount}
              </div>
              <button
                type="button"
                onClick={() => onQuestionCountChange(clampCount(questionCount + 1))}
                disabled={questionCount >= MAX_QUESTIONS}
                className="h-9 w-9 shrink-0 rounded-md border border-border/50 bg-foreground/[0.03] flex items-center justify-center text-foreground hover:bg-foreground/5 disabled:opacity-40 disabled:cursor-not-allowed"
                aria-label="Increase question count"
                data-testid="wizard-count-increment"
              >
                <Plus className="w-4 h-4" />
              </button>
              <input
                type="range"
                min={minQuestions}
                max={MAX_QUESTIONS}
                value={Math.min(MAX_QUESTIONS, Math.max(minQuestions, questionCount))}
                onChange={(e) => onQuestionCountChange(clampCount(Number(e.target.value)))}
                className="flex-1 accent-primary"
                data-testid="wizard-count-slider"
              />
            </div>
          </div>

          {/* Hybrid split — structured vs multiple choice. */}
          {quizMode === "hybrid" && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label className="text-xs uppercase text-muted-foreground">Structured share</Label>
                <span className="text-[10px] text-primary">{structuredRatio}% structured</span>
              </div>
              <input
                type="range"
                min={0}
                max={100}
                step={5}
                value={structuredRatio}
                onChange={(e) => onStructuredRatioChange(Number(e.target.value))}
                className="w-full accent-primary"
                data-testid="wizard-ratio-slider"
              />
              {/* Two-colour ratio bar so the structured vs multiple-choice split
                  is distinguishable at a glance (info = structured, brand = MCQ). */}
              <div className="flex h-2 w-full overflow-hidden rounded-full bg-muted" data-testid="wizard-ratio-bar">
                <div className="bg-info transition-all" style={{ width: `${structuredRatio}%` }} />
                <div className="bg-primary transition-all" style={{ width: `${100 - structuredRatio}%` }} />
              </div>
              <p className="text-[11px] text-muted-foreground" data-testid="wizard-split-summary">
                <span className="inline-block w-2 h-2 rounded-full bg-info align-middle mr-1" />
                <span className="text-info font-medium">{structuredCount}</span> structured ·{" "}
                <span className="inline-block w-2 h-2 rounded-full bg-primary align-middle mr-1" />
                <span className="text-primary font-medium">{mcqCount}</span> multiple choice
              </p>
            </div>
          )}
        </div>
      )}

      {/* Title lives above the stepper — tutor can edit it at any step. */}
      <div className="space-y-1.5">
        <Label
          className={`text-xs uppercase transition-colors ${
            titleError ? "text-danger" : "text-muted-foreground"
          }`}
        >
          Title{titleError && <span className="ml-1 normal-case lowercase tracking-normal">— required</span>}
        </Label>
        <Input
          value={title}
          onChange={(e) => onTitleChange(e.target.value)}
          placeholder="e.g. Pure Mathematics Paper 1"
          className={`glass-input text-sm h-12 transition-all ${
            titleError
              ? "border-danger ring-2 ring-danger/50 shadow-[0_0_22px_rgba(239,68,68,0.65)] animate-pulse"
              : ""
          }`}
          data-testid="input-quiz-title"
        />
        {!titleProvided && (
          <p className="text-[11px] text-warning/90 flex items-center gap-1" data-testid="hint-title-required">
            <AlertCircle className="w-3 h-3 shrink-0" />
            Title is required before you can continue.
          </p>
        )}
      </div>

      <StepBar steps={visibleSteps} current={step} onStep={onStep} stepDone={stepDone} />

      <div className="rounded-lg border border-border/30 bg-background/30 p-4 min-h-[160px]">
        {step === 0 && (
          <StepExaminingBody
            value={examiningBodySlug}
            onChange={onExaminingBodyChange}
            bodies={bodies}
            loading={bodiesLoading}
          />
        )}
        {step === 1 && (
          <StepLevel
            value={levelCode}
            onChange={onLevelChange}
            levels={levels}
            loading={levelsLoading}
            examiningBodyPicked={!!examiningBodySlug}
          />
        )}
        {step === 2 && (
          <StepSubject
            value={subjectSlug}
            onChange={onSubjectChange}
            subjects={subjects}
            loading={subjectsLoading}
            levelPicked={!!levelCode}
            resolvedSyllabus={resolvedSyllabus}
          />
        )}
        {step === 3 && (
          <StepTopics
            topics={topics}
            loading={topicsLoading}
            selectedTopicIds={selectedTopicIds}
            onToggleTopic={onToggleTopic}
            onClearTopics={onClearTopics}
            selectedSubtopicIds={selectedSubtopicIds}
            onToggleSubtopic={onToggleSubtopic}
            onToggleAllSubtopicsForTopic={onToggleAllSubtopicsForTopic}
            subjectPicked={!!subjectSlug}
            resolvedSyllabus={resolvedSyllabus}
          />
        )}
        {step === 4 && (
          <StepTimeLimit
            value={timeLimitMinutes}
            onChange={onTimeLimitChange}
          />
        )}
      </div>

      <div className="flex items-center justify-between gap-3">
        <Button
          type="button"
          className="glass-input text-xs min-h-[40px]"
          size="sm"
          onClick={goBack}
          disabled={step === 0}
          data-testid="button-wizard-back"
        >
          <ChevronLeft className="w-3.5 h-3.5 mr-1" />
          Back
        </Button>
        <p className="text-[11px] text-muted-foreground flex-1 text-center">
          Step {step + 1} of {STEPS.length} · {STEPS[step].label}
        </p>
        {step < 4 ? (
          <Button
            type="button"
            className="glow-button text-xs min-h-[40px]"
            size="sm"
            onClick={goNext}
            disabled={!canAdvance(step)}
            data-testid="button-wizard-next"
          >
            Next
            <ChevronRight className="w-3.5 h-3.5 ml-1" />
          </Button>
        ) : (
          <div className="w-[72px]" />
        )}
      </div>

      <div className="text-xs text-muted-foreground flex items-start gap-2">
        <AlertCircle className="w-3.5 h-3.5 mt-0.5 text-primary shrink-0" />
        <span>To publish: complete every step, add at least one question, and stay within a 1–300 minute time limit.</span>
      </div>

      {metaDirty && activeQuizId && (
        <div className="flex justify-end">
          <Button
            className="glow-button text-xs min-h-[44px]"
            size="sm"
            onClick={onSaveMeta}
            disabled={saveMetaPending || !title.trim()}
            data-testid="button-save-metadata"
          >
            {saveMetaPending ? (
              <><Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />Saving…</>
            ) : (
              <>Save Changes</>
            )}
          </Button>
        </div>
      )}
    </div>
  );
}

function StepBar({
  steps,
  current,
  onStep,
  stepDone,
}: {
  steps: typeof STEPS;
  current: 0 | 1 | 2 | 3 | 4;
  onStep: (s: 0 | 1 | 2 | 3 | 4) => void;
  stepDone: Record<0 | 1 | 2 | 3 | 4, boolean>;
}) {
  return (
    <ol className="flex items-center gap-1 md:gap-2" data-testid="wizard-step-bar">
      {steps.map((s, idx) => {
        const isCurrent = s.key === current;
        const isDone = stepDone[s.key] && !isCurrent;
        // Only allow jumping backward, or to a step whose prerequisites are met.
        const prerequisitesMet = steps.slice(0, idx).every((p) => stepDone[p.key]);
        const clickable = s.key <= current || prerequisitesMet;
        const Icon = s.icon;
        return (
          <li key={s.key} className="flex-1 min-w-0">
            <button
              type="button"
              onClick={() => { if (clickable) onStep(s.key); }}
              className={`w-full flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[11px] border transition-colors ${
                isCurrent
                  ? "border-primary/50 bg-primary/10 text-primary"
                  : isDone
                    ? "border-success/30 bg-success/[0.06] text-success hover:bg-success/10"
                    : "border-border/30 bg-foreground/[0.03] text-muted-foreground hover:border-border/50"
              } ${clickable ? "cursor-pointer" : "cursor-not-allowed opacity-60"}`}
              disabled={!clickable}
              data-testid={`wizard-step-${s.key}`}
            >
              <span className="shrink-0">
                {isDone ? <Check className="w-3.5 h-3.5" /> : <Icon className="w-3.5 h-3.5" />}
              </span>
              <span className="truncate">{s.label}</span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

function StepExaminingBody({
  value,
  onChange,
  bodies,
  loading,
}: {
  value: string;
  onChange: (slug: string) => void;
  bodies: ExaminingBodyDto[];
  loading: boolean;
}) {
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        Pick the examining body that sets the syllabus. Cambridge Syllabus is the only option currently supported.
      </p>
      {loading ? (
        <p className="text-xs text-muted-foreground">Loading examining bodies…</p>
      ) : bodies.length === 0 ? (
        <p className="text-xs text-muted-foreground">No examining bodies available.</p>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          {bodies.map((b) => {
            const selected = value === b.slug;
            return (
              <button
                type="button"
                key={b.slug}
                onClick={() => onChange(b.slug)}
                className={`text-left rounded-lg border px-3 py-3 text-sm transition-colors ${
                  selected
                    ? "border-primary/50 bg-primary/10 text-primary"
                    : "border-border/50 bg-foreground/[0.03] text-foreground/80 hover:bg-foreground/5"
                }`}
                data-testid={`wizard-body-${b.slug}`}
              >
                <span className="font-semibold">{b.displayName}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function StepLevel({
  value,
  onChange,
  levels,
  loading,
  examiningBodyPicked,
}: {
  value: string;
  onChange: (code: string) => void;
  levels: LevelDto[];
  loading: boolean;
  examiningBodyPicked: boolean;
}) {
  if (!examiningBodyPicked) {
    return <p className="text-xs text-muted-foreground">Pick an examining body first.</p>;
  }
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        Choose the Cambridge level. Each level has its own syllabus paper map — AS and A2 share subject codes but assess different tiers.
      </p>
      {loading ? (
        <p className="text-xs text-muted-foreground">Loading levels…</p>
      ) : levels.length === 0 ? (
        <p className="text-xs text-muted-foreground">No levels available for this body.</p>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
          {levels.map((l) => {
            const selected = value === l.code;
            return (
              <button
                type="button"
                key={l.code}
                onClick={() => onChange(l.code)}
                className={`rounded-lg border px-3 py-3 text-sm transition-colors text-left ${
                  selected
                    ? "border-primary/50 bg-primary/10 text-primary"
                    : "border-border/50 bg-foreground/[0.03] text-foreground/80 hover:bg-foreground/5"
                }`}
                data-testid={`wizard-level-${l.code}`}
              >
                <span className="font-semibold">{l.displayName}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function StepSubject({
  value,
  onChange,
  subjects,
  loading,
  levelPicked,
  resolvedSyllabus,
}: {
  value: string;
  onChange: (slug: string) => void;
  subjects: SubjectDto[];
  loading: boolean;
  levelPicked: boolean;
  resolvedSyllabus: SyllabusDto | null;
}) {
  if (!levelPicked) {
    return <p className="text-xs text-muted-foreground">Pick a level first.</p>;
  }
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Subjects available for the chosen body and level. Picking a subject auto-resolves a syllabus code.
      </p>
      {loading ? (
        <p className="text-xs text-muted-foreground">Loading subjects…</p>
      ) : subjects.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No subjects have been ingested for this level yet.
        </p>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
          {subjects.map((s) => {
            const selected = value === s.slug;
            return (
              <button
                type="button"
                key={s.slug}
                onClick={() => onChange(s.slug)}
                className={`text-left rounded-lg border px-3 py-2.5 text-sm transition-colors ${
                  selected
                    ? "border-primary/50 bg-primary/10 text-primary"
                    : "border-border/50 bg-foreground/[0.03] text-foreground/80 hover:bg-foreground/5"
                }`}
                data-testid={`wizard-subject-${s.slug}`}
              >
                <span className="font-semibold">{s.name}</span>
              </button>
            );
          })}
        </div>
      )}
      {resolvedSyllabus && (
        <div className="flex items-center gap-2" data-testid="wizard-syllabus-chip">
          <Badge className="bg-primary/10 text-primary border-primary/30 text-[10px]">
            Syllabus {resolvedSyllabus.syllabusCode}
          </Badge>
          <span className="text-[11px] text-muted-foreground truncate">{resolvedSyllabus.title}</span>
        </div>
      )}
    </div>
  );
}

function StepTopics({
  topics,
  loading,
  selectedTopicIds,
  onToggleTopic,
  onClearTopics,
  selectedSubtopicIds,
  onToggleSubtopic,
  onToggleAllSubtopicsForTopic,
  subjectPicked,
  resolvedSyllabus,
}: {
  topics: TopicListItemDto[];
  loading: boolean;
  selectedTopicIds: number[];
  onToggleTopic: (id: number) => void;
  onClearTopics: () => void;
  selectedSubtopicIds: number[];
  onToggleSubtopic: (topicId: number, subtopicId: number) => void;
  onToggleAllSubtopicsForTopic: (topicId: number, subtopicIds: number[], select: boolean) => void;
  subjectPicked: boolean;
  resolvedSyllabus: SyllabusDto | null;
}) {
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});
  // Group by strand so the checklist mirrors the syllabus outline. Topics
  // with no strand fall under an "Uncategorised" heading.
  // NOTE: this `useMemo` MUST run on every render — the early return for
  // `!subjectPicked` lives below it. Hoisting the hook above the early
  // return keeps the hook count stable between renders (otherwise React
  // throws #310 the moment `subjectPicked` flips false → true).
  const groups = useMemo(() => {
    const map = new Map<string, TopicListItemDto[]>();
    for (const t of topics) {
      const key = t.strandName ?? "";
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(t);
    }
    return Array.from(map.entries()).map(([strand, list]) => ({
      strand,
      topics: [...list].sort((a, b) => a.sortOrder - b.sortOrder || a.topicNumber.localeCompare(b.topicNumber)),
    }));
  }, [topics]);
  if (!subjectPicked) {
    return <p className="text-xs text-muted-foreground">Pick a subject first.</p>;
  }
  const selectedTopicSet = new Set(selectedTopicIds);
  const selectedSubtopicSet = new Set(selectedSubtopicIds);

  const totalSelected = selectedTopicIds.length + selectedSubtopicIds.length;

  return (
    <div className="space-y-2">
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          Optional. Expand a topic to drill into its subtopics, or tick the topic header to ground the AI in the whole topic.
          Leave empty to target the full {resolvedSyllabus ? `syllabus ${resolvedSyllabus.syllabusCode}` : "subject"}.
        </p>
        {totalSelected > 0 && (
          <button
            type="button"
            onClick={onClearTopics}
            className="text-[11px] text-primary hover:text-primary shrink-0"
            data-testid="wizard-clear-topics"
          >
            Clear ({totalSelected})
          </button>
        )}
      </div>
      {loading ? (
        <p className="text-xs text-muted-foreground">Loading topics…</p>
      ) : topics.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No topics have been parsed for this syllabus yet. Leave blank to target the whole subject.
        </p>
      ) : (
        <div className="max-h-96 overflow-y-auto pr-1 space-y-3" data-testid="wizard-topic-list">
          {groups.map((g) => (
            <div key={g.strand || "__none__"}>
              {g.strand && (
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5">{g.strand}</p>
              )}
              <div className="space-y-1.5">
                {g.topics.map((t) => {
                  const subIds = t.subtopics.map((s) => s.id);
                  const selectedSubsForTopic = subIds.filter((id) => selectedSubtopicSet.has(id));
                  const topicSelected = selectedTopicSet.has(t.id);
                  const allSubsSelected = subIds.length > 0 && selectedSubsForTopic.length === subIds.length;
                  const someSubsSelected = selectedSubsForTopic.length > 0 && !allSubsSelected;
                  // A topic header is "checked" when either the topic itself is
                  // selected OR every subtopic underneath has been ticked.
                  const headerChecked = topicSelected || allSubsSelected;
                  const isOpen = !!expanded[t.id];
                  const hasSubs = t.subtopics.length > 0;
                  return (
                    <div
                      key={t.id}
                      className={`rounded-md border ${
                        headerChecked || someSubsSelected
                          ? "border-primary/40 bg-primary/10"
                          : "border-border/30 bg-foreground/[0.03]"
                      }`}
                    >
                      <div className="flex items-center gap-2 px-2 py-1.5">
                        <input
                          type="checkbox"
                          checked={headerChecked}
                          ref={(el) => { if (el) el.indeterminate = someSubsSelected; }}
                          onChange={() => {
                            if (hasSubs) {
                              // Selecting/unselecting at the topic level toggles every subtopic.
                              const select = !(headerChecked || someSubsSelected);
                              onToggleAllSubtopicsForTopic(t.id, subIds, select);
                            } else {
                              onToggleTopic(t.id);
                            }
                          }}
                          className="accent-primary"
                          data-testid={`wizard-topic-checkbox-${t.id}`}
                        />
                        <button
                          type="button"
                          onClick={() => hasSubs && setExpanded((prev) => ({ ...prev, [t.id]: !prev[t.id] }))}
                          className="flex-1 flex items-center gap-2 text-left text-xs"
                          disabled={!hasSubs}
                          data-testid={`wizard-topic-toggle-${t.id}`}
                        >
                          <span className="flex-1 text-foreground">
                            {t.topicNumber ? `${t.topicNumber} ` : ""}{t.title}
                            {t.levelTiers.length > 0 && (
                              <span className="ml-1 text-[10px] text-muted-foreground">
                                [{t.levelTiers.join("/")}]
                              </span>
                            )}
                          </span>
                          {hasSubs && (
                            <>
                              <span className="text-[10px] text-muted-foreground">
                                {selectedSubsForTopic.length > 0
                                  ? `${selectedSubsForTopic.length}/${subIds.length}`
                                  : `${subIds.length} subtopics`}
                              </span>
                              <ChevronDown
                                className={`w-3.5 h-3.5 text-muted-foreground transition-transform ${isOpen ? "rotate-180" : ""}`}
                              />
                            </>
                          )}
                        </button>
                      </div>
                      {hasSubs && isOpen && (
                        <div
                          className="border-t border-border/30 px-2 py-1.5 grid grid-cols-1 md:grid-cols-2 gap-1"
                          data-testid={`wizard-subtopic-list-${t.id}`}
                        >
                          {t.subtopics.map((s) => {
                            const checked = selectedSubtopicSet.has(s.id);
                            return (
                              <label
                                key={s.id}
                                className={`flex items-start gap-2 text-[11px] rounded px-2 py-1 cursor-pointer ${
                                  checked ? "bg-primary/15" : "hover:bg-foreground/5"
                                }`}
                              >
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  onChange={() => onToggleSubtopic(t.id, s.id)}
                                  className="mt-0.5 accent-primary"
                                  data-testid={`wizard-subtopic-checkbox-${s.id}`}
                                />
                                <span className="flex-1 text-foreground/80">
                                  <span className="text-muted-foreground">{s.subtopicNumber}</span>{" "}
                                  {s.title}
                                  {s.coreOrExtended && (
                                    <span className="ml-1 text-[10px] text-muted-foreground">
                                      [{s.coreOrExtended}]
                                    </span>
                                  )}
                                </span>
                              </label>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function StepTimeLimit({
  value,
  onChange,
}: {
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="space-y-2 max-w-xs">
      <Label className="text-muted-foreground text-xs uppercase">Time Limit (minutes)</Label>
      <Input
        type="number"
        min={1}
        max={300}
        value={value}
        onChange={(e) => {
          const raw = e.target.value.trim();
          const parsed = Number(raw);
          onChange(Number.isFinite(parsed) ? parsed : 0);
        }}
        className="glass-input text-sm h-12"
        data-testid="input-quiz-time-limit"
      />
      <p className="text-[11px] text-muted-foreground">Allowed range: 1 to 300 minutes.</p>
    </div>
  );
}

export default AssessmentWizard;
