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
  Timer,
  ChevronLeft,
  ChevronRight,
  Check,
  Loader2,
  AlertCircle,
  ChevronDown,
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
    title, onTitleChange,
    examiningBodySlug, onExaminingBodyChange, bodies, bodiesLoading,
    levelCode, onLevelChange, levels, levelsLoading,
    subjectSlug, onSubjectChange, subjects, subjectsLoading,
    resolvedSyllabus, topics, topicsLoading,
    selectedTopicIds, onToggleTopic, onClearTopics,
    selectedSubtopicIds, onToggleSubtopic, onToggleAllSubtopicsForTopic,
    timeLimitMinutes, onTimeLimitChange,
    activeQuizId, metaDirty, onSaveMeta, saveMetaPending,
    quickStart, onQuickStartChange,
  } = props;

  // In quick-start mode the tutor only sees Level / Subject / Time. Examining
  // body and Topics are intentionally hidden so the Co-Pilot can drive scope.
  const visibleStepKeys = useMemo<Array<0 | 1 | 2 | 3 | 4>>(
    () => quickStart ? [1, 2, 4] : [0, 1, 2, 3, 4],
    [quickStart],
  );
  const visibleSteps = useMemo(
    () => STEPS.filter((s) => visibleStepKeys.includes(s.key)),
    [visibleStepKeys],
  );

  // A step counts as "complete" once its required value is filled. Topics is
  // optional (empty selection = whole subject) and ticks complete as soon as
  // the tutor lands on the step.
  const stepDone = useMemo<Record<0 | 1 | 2 | 3 | 4, boolean>>(() => ({
    0: !!examiningBodySlug,
    1: !!levelCode,
    2: !!subjectSlug,
    3: !!subjectSlug, // topics step is optional — done once reachable
    4: Number.isFinite(timeLimitMinutes) && timeLimitMinutes >= 1 && timeLimitMinutes <= 300,
  }), [examiningBodySlug, levelCode, subjectSlug, timeLimitMinutes]);

  const canAdvance = (from: 0 | 1 | 2 | 3 | 4): boolean => {
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
        <BookOpen className="w-4 h-4 text-violet-400" />
        <h2 className="font-semibold text-slate-100 text-sm">Cambridge Syllabus</h2>
        {activeQuizId && (
          <Badge className="bg-emerald-500/10 text-emerald-400 border-emerald-500/30 text-[10px]">
            Live · ID {activeQuizId}
          </Badge>
        )}
        <button
          type="button"
          onClick={() => onQuickStartChange(!quickStart)}
          className={`ml-auto text-[11px] rounded-md px-2 py-1 border transition-colors ${
            quickStart
              ? "border-violet-500/50 bg-violet-500/15 text-violet-200"
              : "border-white/10 bg-white/[0.02] text-slate-400 hover:text-slate-200 hover:bg-white/5"
          }`}
          title="Hide examining body and topics — let the Co-Pilot infer scope from your prompt"
          data-testid="button-toggle-quick-start"
        >
          {quickStart ? "✓ Quick start" : "Quick start"}
        </button>
      </div>
      {quickStart && (
        <p className="text-[11px] text-violet-300/80 -mt-2">
          Quick start on — examining body fixed to Cambridge, topics skipped. The Co-Pilot will infer scope from your prompt.
        </p>
      )}

      {/* Title lives above the stepper — tutor can edit it at any step. */}
      <div className="space-y-1.5">
        <Label className="text-slate-400 text-xs uppercase">Title</Label>
        <Input
          value={title}
          onChange={(e) => onTitleChange(e.target.value)}
          placeholder="e.g. Pure Mathematics Paper 1"
          className="glass-input text-sm h-12"
          data-testid="input-quiz-title"
        />
      </div>

      <StepBar steps={visibleSteps} current={step} onStep={onStep} stepDone={stepDone} />

      <div className="rounded-lg border border-white/5 bg-black/20 p-4 min-h-[160px]">
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
        <p className="text-[11px] text-slate-500 flex-1 text-center">
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

      <div className="text-xs text-slate-500 flex items-start gap-2">
        <AlertCircle className="w-3.5 h-3.5 mt-0.5 text-violet-400 shrink-0" />
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
                  ? "border-violet-500/50 bg-violet-500/10 text-violet-200"
                  : isDone
                    ? "border-emerald-500/30 bg-emerald-500/[0.06] text-emerald-300 hover:bg-emerald-500/10"
                    : "border-white/5 bg-white/[0.02] text-slate-500 hover:border-white/10"
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
      <p className="text-xs text-slate-400">
        Pick the examining body that sets the syllabus. Cambridge International is the only option currently supported.
      </p>
      {loading ? (
        <p className="text-xs text-slate-500">Loading examining bodies…</p>
      ) : bodies.length === 0 ? (
        <p className="text-xs text-slate-500">No examining bodies available.</p>
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
                    ? "border-violet-500/50 bg-violet-500/10 text-violet-100"
                    : "border-white/10 bg-white/[0.02] text-slate-300 hover:bg-white/5"
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
    return <p className="text-xs text-slate-500">Pick an examining body first.</p>;
  }
  return (
    <div className="space-y-2">
      <p className="text-xs text-slate-400">
        Choose the Cambridge level. Each level has its own syllabus paper map — AS and A2 share subject codes but assess different tiers.
      </p>
      {loading ? (
        <p className="text-xs text-slate-500">Loading levels…</p>
      ) : levels.length === 0 ? (
        <p className="text-xs text-slate-500">No levels available for this body.</p>
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
                    ? "border-violet-500/50 bg-violet-500/10 text-violet-100"
                    : "border-white/10 bg-white/[0.02] text-slate-300 hover:bg-white/5"
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
    return <p className="text-xs text-slate-500">Pick a level first.</p>;
  }
  return (
    <div className="space-y-3">
      <p className="text-xs text-slate-400">
        Subjects available for the chosen body and level. Picking a subject auto-resolves a syllabus code.
      </p>
      {loading ? (
        <p className="text-xs text-slate-500">Loading subjects…</p>
      ) : subjects.length === 0 ? (
        <p className="text-xs text-slate-500">
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
                    ? "border-violet-500/50 bg-violet-500/10 text-violet-100"
                    : "border-white/10 bg-white/[0.02] text-slate-300 hover:bg-white/5"
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
          <Badge className="bg-violet-500/10 text-violet-200 border-violet-500/30 text-[10px]">
            Syllabus {resolvedSyllabus.syllabusCode}
          </Badge>
          <span className="text-[11px] text-slate-500 truncate">{resolvedSyllabus.title}</span>
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
  if (!subjectPicked) {
    return <p className="text-xs text-slate-500">Pick a subject first.</p>;
  }
  const selectedTopicSet = new Set(selectedTopicIds);
  const selectedSubtopicSet = new Set(selectedSubtopicIds);
  // Group by strand so the checklist mirrors the syllabus outline. Topics
  // with no strand fall under an "Uncategorised" heading.
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

  const totalSelected = selectedTopicIds.length + selectedSubtopicIds.length;

  return (
    <div className="space-y-2">
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs text-slate-400">
          Optional. Expand a topic to drill into its subtopics, or tick the topic header to ground the AI in the whole topic.
          Leave empty to target the full {resolvedSyllabus ? `syllabus ${resolvedSyllabus.syllabusCode}` : "subject"}.
        </p>
        {totalSelected > 0 && (
          <button
            type="button"
            onClick={onClearTopics}
            className="text-[11px] text-violet-400 hover:text-violet-300 shrink-0"
            data-testid="wizard-clear-topics"
          >
            Clear ({totalSelected})
          </button>
        )}
      </div>
      {loading ? (
        <p className="text-xs text-slate-500">Loading topics…</p>
      ) : topics.length === 0 ? (
        <p className="text-xs text-slate-500">
          No topics have been parsed for this syllabus yet. Leave blank to target the whole subject.
        </p>
      ) : (
        <div className="max-h-96 overflow-y-auto pr-1 space-y-3" data-testid="wizard-topic-list">
          {groups.map((g) => (
            <div key={g.strand || "__none__"}>
              {g.strand && (
                <p className="text-[10px] uppercase tracking-wider text-slate-500 mb-1.5">{g.strand}</p>
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
                          ? "border-violet-500/40 bg-violet-500/10"
                          : "border-white/5 bg-white/[0.02]"
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
                          className="accent-violet-500"
                          data-testid={`wizard-topic-checkbox-${t.id}`}
                        />
                        <button
                          type="button"
                          onClick={() => hasSubs && setExpanded((prev) => ({ ...prev, [t.id]: !prev[t.id] }))}
                          className="flex-1 flex items-center gap-2 text-left text-xs"
                          disabled={!hasSubs}
                          data-testid={`wizard-topic-toggle-${t.id}`}
                        >
                          <span className="flex-1 text-slate-200">
                            {t.topicNumber ? `${t.topicNumber} ` : ""}{t.title}
                            {t.levelTiers.length > 0 && (
                              <span className="ml-1 text-[10px] text-slate-500">
                                [{t.levelTiers.join("/")}]
                              </span>
                            )}
                          </span>
                          {hasSubs && (
                            <>
                              <span className="text-[10px] text-slate-500">
                                {selectedSubsForTopic.length > 0
                                  ? `${selectedSubsForTopic.length}/${subIds.length}`
                                  : `${subIds.length} subtopics`}
                              </span>
                              <ChevronDown
                                className={`w-3.5 h-3.5 text-slate-400 transition-transform ${isOpen ? "rotate-180" : ""}`}
                              />
                            </>
                          )}
                        </button>
                      </div>
                      {hasSubs && isOpen && (
                        <div
                          className="border-t border-white/5 px-2 py-1.5 grid grid-cols-1 md:grid-cols-2 gap-1"
                          data-testid={`wizard-subtopic-list-${t.id}`}
                        >
                          {t.subtopics.map((s) => {
                            const checked = selectedSubtopicSet.has(s.id);
                            return (
                              <label
                                key={s.id}
                                className={`flex items-start gap-2 text-[11px] rounded px-2 py-1 cursor-pointer ${
                                  checked ? "bg-violet-500/15" : "hover:bg-white/5"
                                }`}
                              >
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  onChange={() => onToggleSubtopic(t.id, s.id)}
                                  className="mt-0.5 accent-violet-500"
                                  data-testid={`wizard-subtopic-checkbox-${s.id}`}
                                />
                                <span className="flex-1 text-slate-300">
                                  <span className="text-slate-500">{s.subtopicNumber}</span>{" "}
                                  {s.title}
                                  {s.coreOrExtended && (
                                    <span className="ml-1 text-[10px] text-slate-500">
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
      <Label className="text-slate-400 text-xs uppercase">Time Limit (minutes)</Label>
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
      <p className="text-[11px] text-slate-500">Allowed range: 1 to 300 minutes.</p>
    </div>
  );
}

export default AssessmentWizard;
