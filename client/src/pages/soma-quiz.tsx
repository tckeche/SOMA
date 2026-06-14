import { useState, useEffect, useMemo, useRef } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useParams, useLocation } from "wouter";
import { Link } from "wouter";
import { useSupabaseSession } from "@/hooks/use-supabase-session";
import { queryClient } from "@/lib/queryClient";
import type { GraphQuestionSpec, SomaQuiz } from "@shared/schema";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import {
  ChevronLeft, ChevronRight, SkipForward, Send, ArrowLeft, Home,
  AlertCircle, Loader2, CheckCircle2, Circle, BookOpen, X, Award, Clock
} from "lucide-react";
import 'katex/dist/katex.min.css';
import MarkdownRenderer from '@/components/MarkdownRenderer';
import GraphPlot from "@/components/GraphPlot";
import { authFetch } from "@/lib/supabase";
import { emitSomaMutation } from "@/lib/realtimeEvents";
import FlagQuestionButton from "@/components/student/FlagQuestionButton";
import AutosaveIndicator from "@/components/student/AutosaveIndicator";
import AssessmentStartScreen from "@/components/student/AssessmentStartScreen";
import {
  buildAutosaveKey,
  readAutosave,
  writeAutosave,
  clearAutosave,
  isResumableAutosave,
  type SaveStatus,
} from "@/lib/quizAutosave";
import { ThemeToggle } from "@/components/ThemeToggle";

export type StudentQuestion = {
  id: number;
  quizId: number;
  stem: string;
  options: string[];
  marks: number;
  questionType?: string;
  graphSpec?: GraphQuestionSpec | null;
};

function LoadingSkeleton() {
  return (
    <div className="min-h-screen bg-background flex items-center justify-center px-4">
      <div className="w-full max-w-3xl">
        <div className="glass-card p-8 mb-6">
          <div className="flex items-center gap-3 mb-8">
            <div className="w-10 h-10 rounded-xl bg-violet-500/20 animate-pulse" />
            <div className="flex-1">
              <Skeleton className="h-6 w-48 mb-2 bg-foreground/10" />
              <Skeleton className="h-4 w-32 bg-foreground/10" />
            </div>
          </div>
          <div className="space-y-4">
            <Skeleton className="h-8 w-full bg-foreground/10" />
            <Skeleton className="h-6 w-3/4 bg-foreground/10" />
          </div>
        </div>
        <div className="grid gap-3">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="glass-card p-5 animate-pulse" style={{ animationDelay: `${i * 100}ms` }}>
              <Skeleton className="h-5 w-full bg-foreground/10" />
            </div>
          ))}
        </div>
        <div className="mt-8 flex justify-center">
          <div className="flex items-center gap-2">
            <Loader2 className="w-5 h-5 text-violet-400 animate-spin" />
            <span className="text-sm text-muted-foreground">Loading assessment...</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function ErrorView({ message }: { message: string }) {
  return (
    <div className="min-h-screen bg-background flex items-center justify-center px-4">
      <div className="glass-card w-full max-w-md text-center p-10">
        <div className="w-16 h-16 rounded-full bg-red-500/10 flex items-center justify-center mx-auto mb-5 border border-red-500/30">
          <AlertCircle className="w-8 h-8 text-red-400" />
        </div>
        <h2 className="text-xl font-bold mb-2 text-foreground">Failed to Load</h2>
        <p className="text-sm text-muted-foreground mb-6">{message}</p>
        <Link href="/dashboard">
          <Button className="glow-button" data-testid="button-error-back">
            <Home className="w-4 h-4 mr-1.5" />
            Return to Dashboard
          </Button>
        </Link>
      </div>
    </div>
  );
}

function ResultsView({ quizTitle, totalScore, maxPossibleScore }: { quizTitle: string; totalScore: number; maxPossibleScore: number }) {
  const percentage = maxPossibleScore > 0 ? Math.round((totalScore / maxPossibleScore) * 100) : 0;

  const tier = percentage >= 80
    ? {
        label: "Excellent", color: "text-emerald-400", bg: "bg-emerald-500/10", border: "border-emerald-500/30", glow: "rgba(16,185,129,0.4)",
        messages: [
          "Outstanding work! You've demonstrated a strong grasp of the material.",
          "Brilliant! This is exactly the kind of mastery examiners love to see.",
          "Exceptional result — your hard work is clearly paying off.",
          "Top marks territory! Keep this momentum going.",
        ],
      }
    : percentage >= 65
      ? {
          label: "Good", color: "text-cyan-400", bg: "bg-cyan-500/10", border: "border-cyan-500/30", glow: "rgba(6,182,212,0.4)",
          messages: [
            "Well done! You're on the right track. Review any areas you found tricky.",
            "Nice work — a confident result with a little room to push higher.",
            "Good going! Tighten up the trickier topics and you'll be flying.",
            "Solid performance. A focused review will turn this into a top grade.",
          ],
        }
      : percentage >= 50
        ? {
            label: "Satisfactory", color: "text-amber-400", bg: "bg-amber-500/10", border: "border-amber-500/30", glow: "rgba(245,158,11,0.4)",
            messages: [
              "A solid effort! Focus on the areas you found challenging to keep improving.",
              "You're getting there — revisit the feedback and the gaps will close fast.",
              "Decent start. A bit more practice on the weak spots will lift this nicely.",
              "Halfway and climbing — target the tricky questions next time.",
            ],
          }
        : {
            label: "Needs Practice", color: "text-rose-400", bg: "bg-rose-500/10", border: "border-rose-500/30", glow: "rgba(244,63,94,0.4)",
            messages: [
              "Don't worry — every expert was once a beginner. Review the feedback and try again!",
              "This is a starting point, not the finish line. Work through the feedback and go again.",
              "Tough one, but it's all useful data. Focus on the basics and you'll improve.",
              "Keep going — the feedback below shows exactly what to work on next.",
            ],
          };

  // Deterministically vary the encouragement so it isn't identical every time,
  // using the score itself to pick from this tier's messages.
  const message = tier.messages[percentage % tier.messages.length];

  return (
    <div className="min-h-screen bg-background flex items-center justify-center px-4">
      <div className="glass-card w-full max-w-md text-center p-10">
        <div className={`w-20 h-20 rounded-full ${tier.bg} flex items-center justify-center mx-auto mb-5 border ${tier.border}`}>
          <Award className={`w-10 h-10 ${tier.color}`} />
        </div>
        <h2 className="text-2xl font-bold mb-1 gradient-text" data-testid="text-results-title">
          Assessment Complete
        </h2>
        <p className="text-sm text-muted-foreground mb-6">{quizTitle}</p>

        <div className="bg-foreground/5 rounded-2xl p-6 border border-border/50 mb-4">
          <p className={`text-5xl font-black ${tier.color}`} style={{ filter: `drop-shadow(0 0 15px ${tier.glow})` }} data-testid="text-grade-percentage">
            {percentage}%
          </p>
          <p className="text-sm text-muted-foreground mt-2" data-testid="text-grade-score">
            {totalScore} / {maxPossibleScore} marks
          </p>
          <span className={`inline-block mt-3 text-xs font-semibold px-3 py-1 rounded-full ${tier.bg} ${tier.color} ${tier.border} border`} data-testid="badge-performance-tier">
            {tier.label}
          </span>
        </div>

        <p className="text-sm text-foreground/80 mb-2" data-testid="text-encouragement">
          {message}
        </p>
        <p className="text-xs text-muted-foreground italic mb-8" data-testid="text-wait-message">
          Your detailed report is being generated. Check your dashboard shortly for feedback.
        </p>

        <div className="flex flex-col gap-3">
          <Link href="/dashboard?tab=completed">
            <Button className="glow-button w-full" data-testid="button-back-home">
              <Home className="w-4 h-4 mr-1.5" />
              View Completed Assessments
            </Button>
          </Link>
        </div>
      </div>
    </div>
  );
}

function SummaryView({
  quiz,
  questions,
  answers,
  onBack,
  onSubmit,
  isSubmitting,
}: {
  quiz: SomaQuiz;
  questions: StudentQuestion[];
  answers: Record<number, string>;
  onBack: () => void;
  onSubmit: () => void;
  isSubmitting: boolean;
}) {
  const answeredCount = Object.keys(answers).length;
  const unansweredCount = questions.length - answeredCount;
  const totalMarks = questions.reduce((s, q) => s + q.marks, 0);

  return (
    <div className="min-h-screen bg-background px-4 py-8">
      <div className="max-w-3xl mx-auto">
        <div className="glass-card p-8 mb-6">
          <div className="flex items-center gap-3 mb-6">
            <div className="w-10 h-10 rounded-xl bg-violet-500/20 flex items-center justify-center border border-violet-500/30">
              <BookOpen className="w-5 h-5 text-violet-400" />
            </div>
            <div>
              <h2 className="text-xl font-bold gradient-text" data-testid="text-summary-title">Assessment Summary</h2>
              <p className="text-xs text-muted-foreground">{quiz.title}</p>
            </div>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
            <div className="bg-foreground/5 rounded-xl p-4 border border-border/50 text-center">
              <p className="text-2xl font-bold text-violet-300" data-testid="text-summary-answered">{answeredCount}</p>
              <p className="text-xs text-muted-foreground">Answered</p>
            </div>
            <div
              className={`rounded-xl p-4 border text-center ${
                unansweredCount > 0
                  ? "bg-yellow-500/15 border-yellow-500/50 ring-1 ring-yellow-500/40"
                  : "bg-foreground/5 border-border/50"
              }`}
            >
              <p
                className={`text-2xl font-bold ${unansweredCount > 0 ? "text-yellow-300" : "text-foreground/80"}`}
                data-testid="text-summary-unanswered"
              >
                {unansweredCount}
              </p>
              <p className={`text-xs ${unansweredCount > 0 ? "text-yellow-200/80" : "text-muted-foreground"}`}>Unanswered</p>
            </div>
            <div className="bg-foreground/5 rounded-xl p-4 border border-border/50 text-center">
              <p className="text-2xl font-bold text-foreground/80" data-testid="text-summary-total">{questions.length}</p>
              <p className="text-xs text-muted-foreground">Total</p>
            </div>
            <div className="bg-foreground/5 rounded-xl p-4 border border-border/50 text-center">
              <p className="text-2xl font-bold text-cyan-300" data-testid="text-summary-marks">{totalMarks}</p>
              <p className="text-xs text-muted-foreground">Marks</p>
            </div>
          </div>

          <div className="space-y-2 mb-6">
            {questions.map((q, idx) => {
              const isAnswered = !!answers[q.id];
              return (
                <div
                  key={q.id}
                  className={`flex items-center gap-3 rounded-lg p-3 border transition-all ${
                    isAnswered
                      ? "bg-blue-500/10 border-blue-500/40 ring-2 ring-blue-500 shadow-[0_0_15px_rgba(59,130,246,0.5)]"
                      : "bg-yellow-500/15 border-yellow-500/50 ring-1 ring-yellow-500/40"
                  }`}
                >
                  <span className={`text-xs font-mono w-6 text-right ${isAnswered ? "text-cyan-400" : "text-yellow-300"}`}>{idx + 1}</span>
                  {isAnswered ? (
                    <CheckCircle2 className="w-4 h-4 text-cyan-400 shrink-0" />
                  ) : (
                    <Circle className="w-4 h-4 text-yellow-400 shrink-0" />
                  )}
                  <span className={`text-sm truncate flex-1 ${isAnswered ? "text-foreground" : "text-yellow-100"}`}>
                    {q.stem.slice(0, 60)}{q.stem.length > 60 ? "..." : ""}
                  </span>
                  <Badge className={`text-xs ${isAnswered ? "bg-cyan-500/10 text-cyan-400 border-cyan-400/30" : "bg-yellow-500/15 text-yellow-300 border-yellow-500/40"}`}>
                    [{q.marks}]
                  </Badge>
                </div>
              );
            })}
          </div>
        </div>

        <div className="flex gap-3">
          <Button
            variant="outline"
            className="flex-1 glow-button-outline min-h-[44px]"
            onClick={onBack}
            data-testid="button-summary-back"
          >
            <ArrowLeft className="w-4 h-4 mr-1.5" />
            Review Answers
          </Button>
          <Button
            className="flex-1 glow-button min-h-[44px]"
            onClick={onSubmit}
            disabled={isSubmitting}
            data-testid="button-summary-submit"
          >
            {isSubmitting ? (
              <>
                <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
                Submitting...
              </>
            ) : (
              <>
                <Send className="w-4 h-4 mr-1.5" />
                Submit Assessment
              </>
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}

export type PreviewProps = {
  previewMode: true;
  previewTitle: string;
  previewQuestions: StudentQuestion[];
  onExitPreview: () => void;
};

type NormalProps = {
  previewMode?: false;
};

export type SomaQuizEngineProps = PreviewProps | NormalProps;

export default function SomaQuizEngine(props: SomaQuizEngineProps = {}) {
  const isPreview = props.previewMode === true;
  const params = useParams<{ id: string }>();
  const quizId = isPreview ? 0 : parseInt(params.id || "0");
  const [, setLocation] = useLocation();
  const { toast } = useToast();

  const { session, isLoading: sessionHookLoading } = useSupabaseSession();
  const sessionLoading = !isPreview && sessionHookLoading;
  const [currentIndex, setCurrentIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [showSummary, setShowSummary] = useState(false);
  const [submissionResult, setSubmissionResult] = useState<{ score: number; maxScore: number } | null>(null);
  const [quizStartedAt, setQuizStartedAt] = useState<string>(() => new Date().toISOString());
  const [timeRemainingSeconds, setTimeRemainingSeconds] = useState<number | null>(null);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);
  const [autosaveRestored, setAutosaveRestored] = useState(false);
  // The student must click Start on the intro screen before the timer begins
  // and autosave writes fire. Previews skip the intro entirely.
  const [hasStarted, setHasStarted] = useState<boolean>(isPreview);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedToastShownRef = useRef(false);

  const userId = session?.user?.id;
  const quizRole = (session?.user?.app_metadata?.role ?? session?.user?.user_metadata?.role) as string | undefined;
  const displayName = session?.user?.user_metadata?.display_name || session?.user?.email?.split("@")[0] || "Student";
  const autosaveKey = !isPreview ? buildAutosaveKey(quizId, userId) : null;

  const { data: quiz, isLoading: quizLoading, error: quizError } = useQuery<SomaQuiz>({
    queryKey: ["/api/soma/quizzes", quizId],
    queryFn: async () => {
      const res = await authFetch(`/api/soma/quizzes/${quizId}`);
      if (!res.ok) throw new Error("Failed to load quiz");
      return res.json();
    },
    enabled: !isPreview && quizId > 0,
  });

  const { data: fetchedQuestions, isLoading: questionsLoading, error: questionsError } = useQuery<StudentQuestion[]>({
    queryKey: ["/api/soma/quizzes", quizId, "questions"],
    queryFn: async () => {
      const res = await authFetch(`/api/soma/quizzes/${quizId}/questions`);
      if (!res.ok) throw new Error("Failed to load questions");
      return res.json();
    },
    enabled: !isPreview && quizId > 0,
  });

  const { data: submissionCheck } = useQuery<{ submitted: boolean }>({
    queryKey: ["/api/soma/quizzes", quizId, "check-submission", userId],
    queryFn: async () => {
      const res = await authFetch(`/api/soma/quizzes/${quizId}/check-submission`);
      if (!res.ok) return { submitted: false };
      return res.json();
    },
    enabled: !isPreview && quizId > 0 && !!userId,
  });


  // Restore autosaved state (answers, current question, start time) on mount.
  // Any saved payload represents a real resume because the autosave write
  // effect is gated on hasStarted — so the mere presence of a payload means
  // the student already pressed Start. Honoring startedAt unconditionally
  // here closes the timer-bypass loophole where a student could Start, wait,
  // refresh, and pick up a fresh timer.
  useEffect(() => {
    if (!autosaveKey || autosaveRestored) return;
    const restored = readAutosave(autosaveKey);
    if (restored) {
      const answerCount = Object.keys(restored.answers || {}).length;
      if (answerCount > 0) {
        setAnswers(restored.answers);
      }
      if (Number.isFinite(restored.currentIndex) && restored.currentIndex >= 0) {
        setCurrentIndex(restored.currentIndex);
      }
      if (restored.startedAt) {
        setQuizStartedAt(restored.startedAt);
      }
      setLastSavedAt(restored.savedAt);
      setSaveStatus("saved");
      setHasStarted(true);
      // Only show the welcome-back toast when there's visible progress to talk
      // about. An empty post-Start shell shouldn't pop a banner.
      if (isResumableAutosave(restored) && !savedToastShownRef.current) {
        savedToastShownRef.current = true;
        toast({
          title: "Welcome back",
          description: "We restored your progress from where you left off.",
        });
      }
    }
    setAutosaveRestored(true);
  }, [autosaveKey, autosaveRestored, toast]);

  // Once questions load, clamp the restored currentIndex to the available
  // range and drop any saved answers that point to question IDs which no
  // longer exist (e.g. the tutor edited the quiz between sessions). Without
  // this, a stale autosave can land the student on a non-existent question
  // and trigger the "Question not found" error screen.
  useEffect(() => {
    if (!fetchedQuestions || fetchedQuestions.length === 0) return;
    const maxIndex = fetchedQuestions.length - 1;
    if (currentIndex > maxIndex) setCurrentIndex(maxIndex);
    const validIds = new Set(fetchedQuestions.map((q) => q.id));
    setAnswers((prev) => {
      let changed = false;
      const next: Record<number, string> = {};
      for (const [k, v] of Object.entries(prev)) {
        const id = Number(k);
        if (validIds.has(id)) next[id] = v;
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [fetchedQuestions, currentIndex]);

  const submitMutation = useMutation({
    mutationFn: async () => {
      const res = await authFetch(`/api/soma/quizzes/${quizId}/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          studentName: displayName,
          answers,
          startedAt: quizStartedAt,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => null);
        throw new Error(err?.message || "Submission failed");
      }
      return res.json();
    },
    onSuccess: (data: any) => {
      const totalMarks = questions ? questions.reduce((s, q) => s + q.marks, 0) : 0;
      setSubmissionResult({ score: data.score, maxScore: totalMarks });
      clearAutosave(autosaveKey);
      queryClient.invalidateQueries({ queryKey: ["/api/student/reports"] });
      queryClient.invalidateQueries({ queryKey: ["/api/soma/quizzes", quizId, "check-submission"] });
      queryClient.invalidateQueries({ queryKey: ["/api/student/dashboard"] });
      queryClient.invalidateQueries({ queryKey: ["/api/student/notifications"] });
      emitSomaMutation({ type: "assessment_submitted", quizId });
    },
    onError: (err: any) => {
      toast({ title: "Submission failed", description: err.message || "Please try again.", variant: "destructive" });
    },
  });

  // Initialize countdown timer from quiz's timeLimitMinutes, accounting for
  // any time already elapsed since the quiz was originally started — so a
  // refresh or resume doesn't silently hand the student extra time.
  useEffect(() => {
    if (isPreview || !quiz?.timeLimitMinutes || submissionResult) return;
    if (!autosaveRestored || !hasStarted) return; // wait for student to click Start
    const totalSeconds = quiz.timeLimitMinutes * 60;
    const elapsedSeconds = Math.max(
      0,
      Math.floor((Date.now() - new Date(quizStartedAt).getTime()) / 1000),
    );
    const remaining = Math.max(0, totalSeconds - elapsedSeconds);
    setTimeRemainingSeconds(remaining);
    if (remaining <= 0) return;
    const interval = setInterval(() => {
      setTimeRemainingSeconds((prev) => {
        if (prev === null || prev <= 1) {
          clearInterval(interval);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [isPreview, quiz?.timeLimitMinutes, submissionResult, autosaveRestored, quizStartedAt]);

  // Auto-submit when timer reaches 0
  useEffect(() => {
    if (timeRemainingSeconds === 0 && !isPreview && userId && !submissionResult && !submitMutation.isPending) {
      submitMutation.mutate();
    }
  }, [timeRemainingSeconds, isPreview, userId, submissionResult, submitMutation]);

  const questions = isPreview ? (props as PreviewProps).previewQuestions : fetchedQuestions;
  const effectiveQuiz: SomaQuiz | undefined = isPreview
    ? { id: 0, title: (props as PreviewProps).previewTitle, topic: "", curriculumContext: null, status: "published", createdAt: new Date() } as SomaQuiz
    : quiz;

  const isLoading = isPreview ? false : (quizLoading || questionsLoading || sessionLoading);
  const error = isPreview ? null : (quizError || questionsError);

  const currentQuestion = useMemo(() => {
    if (!questions || questions.length === 0) return null;
    return questions[currentIndex] || null;
  }, [questions, currentIndex]);

  const totalMarks = useMemo(() => {
    if (!questions) return 0;
    return questions.reduce((s, q) => s + q.marks, 0);
  }, [questions]);

  // Debounced autosave: whenever answers or the current question change we
  // schedule a write a moment later so rapid taps don't hit localStorage on
  // every keystroke. Gated on hasStarted so the intro screen doesn't spawn
  // an empty autosave record.
  useEffect(() => {
    if (!autosaveKey || !autosaveRestored || !hasStarted || submissionResult) return;
    setSaveStatus("saving");
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      const result = writeAutosave(autosaveKey, {
        answers,
        currentIndex,
        startedAt: quizStartedAt,
      });
      if (result.ok) {
        setSaveStatus("saved");
        setLastSavedAt(result.savedAt);
      } else {
        setSaveStatus("failed");
      }
    }, 400);
    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
    };
  }, [answers, currentIndex, quizStartedAt, autosaveKey, autosaveRestored, hasStarted, submissionResult]);

  const handleSelectAnswer = (questionId: number, option: string) => {
    setAnswers((prev) => ({ ...prev, [questionId]: option }));
  };

  const handleNext = () => {
    if (!questions) return;
    if (currentIndex < questions.length - 1) {
      setCurrentIndex((i) => i + 1);
    } else {
      setShowSummary(true);
    }
  };

  const handleSkip = () => {
    if (!questions) return;
    if (currentIndex < questions.length - 1) {
      setCurrentIndex((i) => i + 1);
    } else {
      setShowSummary(true);
    }
  };

  const handleDotClick = (idx: number) => {
    setCurrentIndex(idx);
    setShowSummary(false);
  };

  const handleSubmit = () => {
    if (!userId) {
      toast({ title: "Not logged in", description: "Please log in to submit.", variant: "destructive" });
      return;
    }
    submitMutation.mutate();
  };

  const previewBanner = isPreview ? (
    <div className="fixed top-0 left-0 right-0 z-50 bg-card/80 backdrop-blur-md border-b border-card-border shadow-lg" data-testid="banner-preview-mode">
      <div className="max-w-3xl mx-auto px-4 py-2.5 flex items-center justify-between">
        <Button
          size="default"
          className="hover:bg-muted bg-transparent text-foreground/80 transition-colors rounded-lg flex items-center gap-2"
          onClick={(props as PreviewProps).onExitPreview}
          data-testid="button-exit-preview"
        >
          <ArrowLeft className="w-4 h-4" />
          <span className="hidden sm:inline">Exit Preview</span>
        </Button>
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
          <span className="text-xs sm:text-sm font-semibold text-amber-300 tracking-wide">Admin Preview — Scores will not be saved</span>
        </div>
        <Button
          size="default"
          className="hover:bg-muted bg-transparent text-muted-foreground transition-colors rounded-lg flex items-center gap-2"
          onClick={() => { (props as PreviewProps).onExitPreview(); setLocation("/tutor/assessments"); }}
          data-testid="button-preview-to-dashboard"
        >
          <Home className="w-4 h-4" />
          <span className="hidden sm:inline">Dashboard</span>
        </Button>
      </div>
    </div>
  ) : null;

  if (isLoading) return <LoadingSkeleton />;
  if (error) {
    if (isPreview) {
      return <>{previewBanner}<div className="pt-12"><ErrorView message={(error as Error).message} /></div></>;
    }
    return <ErrorView message={(error as Error).message} />;
  }
  if (!effectiveQuiz || !questions || questions.length === 0) {
    if (isPreview) {
      return <>{previewBanner}<div className="pt-12"><ErrorView message="No questions found for this assessment." /></div></>;
    }
    return <ErrorView message="No questions found for this assessment." />;
  }

  if (!isPreview && submissionCheck?.submitted && !submissionResult) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center px-4">
        <div className="glass-card w-full max-w-md text-center p-10">
          <div className="w-16 h-16 rounded-full bg-amber-500/10 flex items-center justify-center mx-auto mb-5 border border-amber-500/30">
            <AlertCircle className="w-8 h-8 text-amber-400" />
          </div>
          <h2 className="text-xl font-bold mb-2 text-foreground">Already Submitted</h2>
          <p className="text-sm text-muted-foreground mb-6">You have already submitted this assessment. Check your dashboard for results.</p>
          <Link href="/dashboard">
            <Button className="glow-button" data-testid="button-already-submitted-back">
              <Home className="w-4 h-4 mr-1.5" />
              Return to Dashboard
            </Button>
          </Link>
        </div>
      </div>
    );
  }

  if (submissionResult) {
    return <ResultsView quizTitle={effectiveQuiz.title} totalScore={submissionResult.score} maxPossibleScore={submissionResult.maxScore} />;
  }

  // Pre-quiz start screen — only on a fresh attempt. Resumes set hasStarted
  // during the autosave-restore effect so they bypass this entirely.
  if (!isPreview && autosaveRestored && !hasStarted) {
    return (
      <AssessmentStartScreen
        quiz={effectiveQuiz}
        questionCount={questions.length}
        totalMarks={totalMarks}
        quizId={quizId}
        // This screen only renders when !isPreview, and tutors/admins reach the
        // quiz via preview. A logged-in viewer here taking the quiz is a student.
        isStudent={!isPreview && quizRole !== "tutor" && quizRole !== "super_admin"}
        onStart={() => {
          setQuizStartedAt(new Date().toISOString());
          setHasStarted(true);
        }}
      />
    );
  }

  if (showSummary) {
    return (
      <>
        {previewBanner}
        <div className={isPreview ? "pt-10" : ""}>
          <SummaryView
            quiz={effectiveQuiz}
            questions={questions}
            answers={answers}
            onBack={() => setShowSummary(false)}
            onSubmit={isPreview ? () => {} : handleSubmit}
            isSubmitting={submitMutation.isPending}
          />
        </div>
      </>
    );
  }

  if (!currentQuestion) return <ErrorView message="Question not found." />;

  const selectedAnswer = answers[currentQuestion.id];
  const answeredCount = Object.keys(answers).length;

  return (
    <div className="min-h-screen bg-background px-3 sm:px-4 py-4 sm:py-8 pb-28 md:pb-8">
      {previewBanner}
      <div className={`max-w-3xl mx-auto ${isPreview ? "pt-8" : ""}`}>
        <div className="flex items-center justify-between gap-2 mb-4 sm:mb-6">
          {isPreview ? (
            <Button
              variant="ghost"
              size="default"
              className="text-muted-foreground hover:text-foreground px-2 sm:px-3"
              onClick={(props as PreviewProps).onExitPreview}
              aria-label="Exit preview"
              data-testid="button-preview-back"
            >
              <ArrowLeft className="w-4 h-4 sm:mr-1" />
              <span className="hidden sm:inline">Exit Preview</span>
            </Button>
          ) : (
            <Link href="/dashboard">
              <Button
                variant="ghost"
                size="default"
                className="text-muted-foreground hover:text-foreground px-2 sm:px-3"
                aria-label="Exit assessment"
                data-testid="button-soma-back"
              >
                <ArrowLeft className="w-4 h-4 sm:mr-1" />
                <span className="hidden sm:inline">Exit Assessment</span>
              </Button>
            </Link>
          )}
          <div className="flex items-center gap-1.5 sm:gap-3 flex-wrap justify-end">
            {!isPreview && (
              <AutosaveIndicator status={saveStatus} savedAt={lastSavedAt} />
            )}
            {!isPreview && timeRemainingSeconds !== null && (
              <Badge
                className={`flex items-center gap-1.5 ${
                  timeRemainingSeconds <= 300
                    ? "bg-red-500/15 text-red-400 border-red-500/30 animate-pulse"
                    : "bg-amber-500/10 text-amber-300 border-amber-500/30"
                }`}
                title="Time remaining"
                data-testid="badge-timer"
              >
                <Clock className="w-3.5 h-3.5" />
                <span className="uppercase text-[10px] tracking-wider font-bold mr-0.5 hidden sm:inline">Left</span>
                {Math.floor(timeRemainingSeconds / 60)}:{String(timeRemainingSeconds % 60).padStart(2, "0")}
              </Badge>
            )}
            <Badge className="bg-violet-500/10 text-violet-300 border-violet-500/30" data-testid="badge-progress">
              {currentIndex + 1} / {questions.length}
            </Badge>
            <Badge className="bg-foreground/5 text-muted-foreground border-border/50 hidden sm:inline-flex" data-testid="badge-marks">
              {totalMarks} marks
            </Badge>
            <ThemeToggle size="sm" />
          </div>
        </div>

        {!isPreview && (
          <div
            className="sticky top-2 z-20 mb-4 rounded-full bg-card/70 border border-card-border h-2.5 overflow-hidden backdrop-blur"
            role="progressbar"
            aria-label="Answered progress"
            aria-valuenow={answeredCount}
            aria-valuemin={0}
            aria-valuemax={questions.length}
            data-testid="progress-answered"
          >
            <div
              className="h-full bg-gradient-to-r from-violet-500 via-cyan-400 to-emerald-400 transition-all duration-300"
              style={{ width: `${questions.length > 0 ? (answeredCount / questions.length) * 100 : 0}%` }}
            />
          </div>
        )}

        <div className="glass-card p-4 sm:p-6 md:p-8 mb-4 sm:mb-6" style={{ background: "rgba(255,255,255,0.03)", backdropFilter: "blur(12px)" }}>
          <div className="flex items-center justify-between gap-2 mb-4 sm:mb-6">
            <div className="flex items-center gap-2.5 sm:gap-3 min-w-0">
              <div className="w-9 h-9 sm:w-10 sm:h-10 rounded-xl bg-gradient-to-br from-violet-500/30 to-cyan-500/20 flex items-center justify-center border border-violet-500/30 text-base sm:text-lg font-bold text-violet-300 shrink-0">
                {currentIndex + 1}
              </div>
              <div className="min-w-0">
                <p className="text-[11px] sm:text-xs text-muted-foreground uppercase tracking-wider truncate">Question {currentIndex + 1} of {questions.length}</p>
                <p className="text-[11px] sm:text-xs text-violet-400/70">{currentQuestion.marks} mark{currentQuestion.marks > 1 ? "s" : ""}</p>
              </div>
            </div>
            <FlagQuestionButton questionId={currentQuestion.id} quizId={currentQuestion.quizId} />
          </div>

          <div className="text-base sm:text-lg text-foreground leading-relaxed mb-2" data-testid="text-question-stem">
            <MarkdownRenderer content={currentQuestion.stem} />
          </div>
          {currentQuestion.questionType === "graph" ? (
            currentQuestion.graphSpec ? (
              <div className="mt-6" data-testid="graph-question-layout">
                <GraphPlot spec={currentQuestion.graphSpec} />
              </div>
            ) : (
              <div className="mt-6 rounded-2xl border border-border/50 bg-card/60 p-4 text-center text-muted-foreground text-sm" data-testid="graph-unavailable">
                Graph data unavailable for this question.
              </div>
            )
          ) : null}
        </div>

        <div className="grid gap-2.5 sm:gap-3 mb-6 sm:mb-8">
          {currentQuestion.options.map((option, idx) => {
            const letter = String.fromCharCode(65 + idx);
            const isSelected = selectedAnswer === option;
            return (
              <button
                key={idx}
                onClick={() => handleSelectAnswer(currentQuestion.id, option)}
                className={`w-full text-left p-4 sm:p-5 min-h-[60px] rounded-2xl border transition-all duration-200 active:scale-[0.99] ${
                  isSelected
                    ? "bg-violet-500/15 border-violet-500/40 shadow-[0_0_20px_rgba(139,92,246,0.15)]"
                    : "bg-foreground/[0.04] border-border/50 hover:bg-foreground/[0.06] hover:border-white/20"
                }`}
                data-testid={`button-option-${idx}`}
              >
                <div className="flex items-start gap-3 sm:gap-4">
                  <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 text-sm font-semibold ${
                    isSelected
                      ? "bg-violet-500/30 text-violet-200 border border-violet-500/50"
                      : "bg-foreground/5 text-muted-foreground border border-border/50"
                  }`}>
                    {letter}
                  </div>
                  <div className="text-[15px] sm:text-base text-foreground pt-0.5 sm:pt-1 flex-1 leading-relaxed">
                    <MarkdownRenderer content={option} />
                  </div>
                </div>
              </button>
            );
          })}
        </div>

        {/* Action bar — sticky to the viewport bottom on mobile so Next/Prev
            stay reachable after scrolling through a long question; inline on
            desktop where vertical space isn't as precious. */}
        <div
          className="fixed bottom-0 left-0 right-0 z-30 md:static md:z-auto bg-background/85 md:bg-transparent backdrop-blur-md md:backdrop-blur-0 border-t border-border/30 md:border-0 px-3 sm:px-4 md:px-0 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] md:py-0 md:mb-8"
          data-testid="quiz-action-bar"
        >
          <div className="max-w-3xl mx-auto flex items-center gap-2 sm:gap-3">
            {currentIndex > 0 && (
              <Button
                variant="outline"
                className="glow-button-outline min-h-[48px] px-3 sm:px-4"
                onClick={() => setCurrentIndex((i) => i - 1)}
                aria-label="Previous question"
                data-testid="button-previous"
              >
                <ChevronLeft className="w-4 h-4 sm:mr-1" />
                <span className="hidden sm:inline">Previous</span>
              </Button>
            )}
            <Button
              variant="outline"
              className="flex-1 glow-button-outline min-h-[48px]"
              onClick={handleSkip}
              data-testid="button-skip"
            >
              <SkipForward className="w-4 h-4 mr-1.5" />
              Skip
            </Button>
            {currentIndex === questions.length - 1 ? (
              <Button
                className="flex-1 glow-button min-h-[48px]"
                onClick={() => setShowSummary(true)}
                data-testid="button-submit-exam"
              >
                <Send className="w-4 h-4 mr-1.5" />
                <span className="sm:hidden">Review</span>
                <span className="hidden sm:inline">Review &amp; Submit</span>
              </Button>
            ) : (
              <Button
                className="flex-1 glow-button min-h-[48px]"
                onClick={handleNext}
                data-testid="button-next"
              >
                <span className="sm:hidden">Next</span>
                <span className="hidden sm:inline">Next Question</span>
                <ChevronRight className="w-4 h-4 ml-1.5" />
              </Button>
            )}
          </div>
        </div>

        {/* Nav dots are a nice-to-have on desktop and fight for space on mobile.
            The sticky action bar + progress counter already cover mobile nav. */}
        <div
          className="hidden md:flex items-center justify-center gap-2 flex-wrap px-2"
          data-testid="nav-dots"
        >
          {questions.map((q, idx) => (
            <button
              key={q.id}
              onClick={() => handleDotClick(idx)}
              className={`w-3 h-3 rounded-full transition-all duration-200 ${
                idx === currentIndex
                  ? "bg-violet-500 shadow-[0_0_8px_rgba(139,92,246,0.6)] scale-125"
                  : answers[q.id]
                    ? "bg-emerald-500/60"
                    : "bg-yellow-500/60 hover:bg-yellow-500/80 ring-1 ring-yellow-500/40"
              }`}
              aria-label={`Go to question ${idx + 1}`}
              data-testid={`dot-question-${idx}`}
            />
          ))}
        </div>

        <div className="hidden md:block text-center mt-4">
          <p className="text-xs text-muted-foreground">
            {answeredCount} of {questions.length} answered
          </p>
        </div>
      </div>
    </div>
  );
}
