import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useParams, Link, useLocation } from "wouter";
import { authFetch } from "@/lib/supabase";
import { useSupabaseSession } from "@/hooks/use-supabase-session";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ThemeToggle } from "@/components/ThemeToggle";
import {
  ArrowLeft, Home, AlertCircle, Loader2, CheckCircle2, XCircle, BookOpen, Award, Lightbulb, ClipboardCopy, Check, Quote, RotateCcw,
} from "lucide-react";
import MarkdownRenderer from "@/components/MarkdownRenderer";
import ReportPdfView, { type ReportPdfData } from "@/components/student/ReportPdfView";

const STANDARD_ACTION_BUTTON_CLASS = "inline-flex items-center justify-center gap-2 px-6 py-3 h-12 rounded-xl text-base font-semibold border border-violet-500/40 bg-violet-500/20 text-violet-300 hover:bg-violet-500/30 transition-all cursor-pointer";

interface ReviewQuestion {
  id: number;
  stem: string;
  options: string[];
  correctAnswer: string;
  marks: number;
  explanation: string | null;
}

interface ReviewReport {
  id: number;
  quizId: number;
  studentName: string;
  score: number;
  status: string;
  answersJson: Record<string, string> | null;
  /** Per-question awarded-marks overrides (questionId → marks). Null = none. */
  manualMarks: Record<string, number> | null;
  aiFeedbackHtml: string | null;
  completedAt: string | null;
  createdAt: string;
  quiz: {
    id: number;
    title: string;
    topic: string | null;
    subject?: string | null;
    level?: string | null;
    syllabus?: string | null;
  };
}

interface QuestionDiagnosis {
  category: string;
  correct: boolean;
  rationale: string | null;
  misconception: {
    id: number;
    misconception: string;
    studentError: string;
    correctApproach: string;
    frequency: string;
    sourceQuote: string | null;
    sourcePage: number | null;
    examYear: number | null;
  } | null;
}

interface ReviewData {
  report: ReviewReport;
  questions: ReviewQuestion[];
  /** Phase 2C — per-question diagnoses keyed by question id. Optional so
   *  reports created before Phase 2 still render. */
  diagnoses?: Record<string, QuestionDiagnosis>;
}

export default function SomaQuizReview() {
  const reportRef = useRef<HTMLDivElement>(null);
  const pdfRef = useRef<HTMLDivElement>(null);
  const params = useParams<{ reportId: string }>();
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const reportId = parseInt(params.reportId || "0");
  const [copied, setCopied] = useState(false);
  const [downloading, setDownloading] = useState(false);

  const { session } = useSupabaseSession();
  // Canonical role source mirrors RoleRouter — marks editing is tutor-only.
  const { data: viewer } = useQuery<{ role?: string }>({
    queryKey: ["/api/auth/me", session?.user?.id],
    queryFn: async () => {
      const res = await authFetch("/api/auth/me");
      if (!res.ok) return {};
      return res.json();
    },
    enabled: !!session?.user?.id,
    staleTime: 5 * 60 * 1000,
  });
  const isTutor = viewer?.role === "tutor" || viewer?.role === "super_admin";

  const reviewQueryKey = ["/api/soma/reports", reportId, "review"];

  const { data, isLoading, error } = useQuery<ReviewData>({
    queryKey: reviewQueryKey,
    queryFn: async () => {
      const res = await authFetch(`/api/soma/reports/${reportId}/review`);
      if (!res.ok) {
        if (res.status === 404) {
          throw new Error(
            "This assessment report is no longer available. It may have been removed when the quiz was deleted. Please go back and refresh the list.",
          );
        }
        if (res.status === 403) {
          throw new Error("You don't have permission to view this report.");
        }
        let msg = "Failed to load review data";
        try {
          const body = await res.json();
          if (body?.message) msg = body.message;
        } catch {
          /* ignore */
        }
        throw new Error(msg);
      }
      return res.json();
    },
    enabled: reportId > 0,
    retry: false,
  });

  const studentAnswers: Record<string, string> = useMemo(() => {
    if (!data?.report?.answersJson) return {};
    return data.report.answersJson;
  }, [data]);

  const totalMarks = useMemo(() => {
    if (!data?.questions) return 0;
    return data.questions.reduce((s, q) => s + q.marks, 0);
  }, [data]);

  const manualMarks = data?.report?.manualMarks ?? null;
  const reportCompleted = (data?.report?.status ?? "") === "completed";
  const canEditMarks = isTutor && reportCompleted;

  // Per-question draft values for the editable inputs (questionId → string).
  const [marksDraft, setMarksDraft] = useState<Record<string, string>>({});
  const [savingQid, setSavingQid] = useState<string | null>(null);

  const marksMutation = useMutation({
    mutationFn: async (overrides: Record<string, number | null>) => {
      const res = await authFetch(`/api/tutor/reports/${reportId}/marks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ overrides }),
      });
      if (!res.ok) {
        let msg = "Failed to update marks";
        try {
          const body = await res.json();
          if (body?.message) msg = body.message;
        } catch { /* ignore */ }
        throw new Error(msg);
      }
      return res.json() as Promise<{ score: number; maxPossibleScore: number; manualMarks: Record<string, number> | null }>;
    },
    onSettled: () => {
      setSavingQid(null);
      // Refresh the whole review so totals/badges reflect persisted score.
      queryClient.invalidateQueries({ queryKey: reviewQueryKey });
    },
  });

  const handleBack = () => {
    if (window.history.length > 1) {
      window.history.back();
      return;
    }
    setLocation("/tutor/assessments");
  };

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!data) return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("view") === "report" && reportRef.current) {
      const t = setTimeout(() => {
        try { window.print(); } catch { /* ignore */ }
      }, 500);
      return () => clearTimeout(t);
    }
  }, [data]);

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center px-4">
        <div className="w-full max-w-3xl space-y-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="glass-card p-6">
              <Skeleton className="h-6 w-3/4 mb-4 bg-foreground/10" />
              <div className="space-y-3">
                {[1, 2, 3, 4].map((j) => (
                  <Skeleton key={j} className="h-12 w-full bg-foreground/10" />
                ))}
              </div>
            </div>
          ))}
          <div className="flex justify-center">
            <div className="flex items-center gap-2">
              <Loader2 className="w-5 h-5 text-violet-400 animate-spin" />
              <span className="text-sm text-muted-foreground">Loading review...</span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center px-4">
        <div className="glass-card w-full max-w-md text-center p-10">
          <div className="w-16 h-16 rounded-full bg-red-500/10 flex items-center justify-center mx-auto mb-5 border border-red-500/30">
            <AlertCircle className="w-8 h-8 text-red-400" />
          </div>
          <h2 className="text-xl font-bold mb-2 text-foreground">Failed to Load Review</h2>
          <p className="text-sm text-muted-foreground mb-6">{(error as Error)?.message || "Review data not available"}</p>
          <Link href="/dashboard">
            <Button className="glow-button" data-testid="button-review-error-back">
              <Home className="w-4 h-4 mr-1.5" />
              Return to Dashboard
            </Button>
          </Link>
        </div>
      </div>
    );
  }

  const { report, questions: rawQuestions } = data;
  const quiz = report.quiz ?? ({} as ReviewReport["quiz"]);
  const quizTitle = quiz.title ?? "Assessment";
  const studentName = report.studentName ?? "Student";
  const score = typeof report.score === "number" ? report.score : 0;
  const questions: ReviewQuestion[] = (rawQuestions ?? []).map((q) => ({
    id: q.id,
    stem: q.stem ?? "",
    options: Array.isArray(q.options) ? q.options : [],
    correctAnswer: q.correctAnswer ?? "",
    marks: typeof q.marks === "number" ? q.marks : 0,
    explanation: q.explanation ?? null,
  }));
  const percentage = totalMarks > 0 ? Math.round((score / totalMarks) * 100) : 0;

  const pdfData: ReportPdfData = {
    title: quizTitle,
    subject: quiz.subject ?? null,
    level: quiz.level ?? null,
    syllabus: quiz.syllabus ?? null,
    studentName,
    score,
    totalMarks,
    completedAt: report.completedAt ?? report.createdAt,
    aiFeedbackHtml: report.aiFeedbackHtml ?? null,
    questions,
    answers: studentAnswers,
  };

  const slug = (s: string) => s.replace(/[^\w]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase() || "report";
  const dateStamp = new Date().toISOString().slice(0, 10);
  const filename = `${slug(quizTitle)}-${slug(studentName)}-${dateStamp}.pdf`;

  const downloadPdf = async () => {
    if (!pdfRef.current || downloading) return;
    setDownloading(true);
    try {
      const images = Array.from(pdfRef.current.querySelectorAll("img"));
      await Promise.all(
        images.map((img) =>
          img.complete && img.naturalWidth > 0
            ? Promise.resolve()
            : new Promise<void>((resolve) => {
                img.addEventListener("load", () => resolve(), { once: true });
                img.addEventListener("error", () => resolve(), { once: true });
              }),
        ),
      );
      const html2pdf = (await import("html2pdf.js")).default;
      await html2pdf().set({
        margin: [12, 12, 12, 12],
        filename,
        image: { type: "jpeg", quality: 0.98 },
        html2canvas: { scale: 2, useCORS: true, backgroundColor: "#ffffff" },
        jsPDF: { unit: "mm", format: "a4", orientation: "portrait" },
      }).from(pdfRef.current).save();
    } finally {
      setDownloading(false);
    }
  };

  const copySummary = async () => {
    const pct = totalMarks > 0 ? Math.round((report.score / totalMarks) * 100) : 0;
    const lines: string[] = [];
    lines.push(`soma assessment report`);
    lines.push(`${report.quiz.title}`);
    const metaBits = [report.quiz.subject, report.quiz.level, report.quiz.syllabus].filter(Boolean);
    if (metaBits.length) lines.push(metaBits.join(" | "));
    lines.push(`Student: ${report.studentName}`);
    lines.push(`Score: ${report.score}/${totalMarks} (${pct}%) across ${questions.length} questions`);
    const correctCount = questions.filter((q) => studentAnswers[String(q.id)] === q.correctAnswer).length;
    const skipped = questions.filter((q) => !studentAnswers[String(q.id)]).length;
    lines.push(`Correct: ${correctCount} | Skipped: ${skipped} | Incorrect: ${questions.length - correctCount - skipped}`);
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <div className="min-h-screen bg-background px-4 py-8">
      <div className="max-w-3xl mx-auto" ref={reportRef}>
        <div className="flex flex-wrap items-center justify-between gap-2 mb-6">
          <Button className={STANDARD_ACTION_BUTTON_CLASS} data-testid="button-review-back" onClick={handleBack}>
              <ArrowLeft className="w-5 h-5" />
              Back
          </Button>
          <span className={STANDARD_ACTION_BUTTON_CLASS} data-testid="badge-review-mode">
            <BookOpen className="w-5 h-5" />
            Review Mode
          </span>
          <div className="flex items-center gap-2">
            <Button
              className={STANDARD_ACTION_BUTTON_CLASS}
              onClick={copySummary}
              data-testid="button-copy-summary"
            >
              {copied ? <Check className="w-5 h-5" /> : <ClipboardCopy className="w-5 h-5" />}
              {copied ? "Copied" : "Copy Summary"}
            </Button>
            <Button
              className={STANDARD_ACTION_BUTTON_CLASS}
              onClick={downloadPdf}
              disabled={downloading}
              data-testid="button-download-report"
            >
              {downloading ? <Loader2 className="w-5 h-5 animate-spin" /> : <Award className="w-5 h-5" />}
              {downloading ? "Preparing…" : "Download PDF"}
            </Button>
            <ThemeToggle size="sm" />
          </div>
        </div>

        <div className="glass-card p-8 mb-6">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 rounded-xl bg-violet-500/20 flex items-center justify-center border border-violet-500/30">
              <BookOpen className="w-5 h-5 text-violet-400" />
            </div>
            <div className="flex-1">
              <h2 className="text-xl font-bold gradient-text" data-testid="text-review-title">{report.quiz.title}</h2>
              <p className="text-xs text-muted-foreground">{report.quiz.topic}</p>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-4">
            <div className="bg-foreground/5 rounded-xl p-4 border border-border/50 text-center">
              <p className="text-2xl font-bold text-violet-300" data-testid="text-review-percentage">{percentage}%</p>
              <p className="text-xs text-muted-foreground">Score</p>
            </div>
            <div className="bg-foreground/5 rounded-xl p-4 border border-border/50 text-center">
              <p className="text-2xl font-bold text-foreground/80" data-testid="text-review-marks">{report.score}/{totalMarks}</p>
              <p className="text-xs text-muted-foreground">Marks</p>
            </div>
            <div className="bg-foreground/5 rounded-xl p-4 border border-border/50 text-center">
              <p className="text-2xl font-bold text-cyan-300" data-testid="text-review-total-q">{questions.length}</p>
              <p className="text-xs text-muted-foreground">Questions</p>
            </div>
          </div>
        </div>

        <div className="space-y-6">
          {questions.map((q, idx) => {
            const studentAnswer = studentAnswers[String(q.id)] || null;
            const isCorrect = studentAnswer === q.correctAnswer;
            const qid = String(q.id);
            const hasOverride = !!manualMarks && Object.prototype.hasOwnProperty.call(manualMarks, qid);
            const autoMarks = isCorrect ? q.marks : 0;
            const awarded = hasOverride ? manualMarks![qid] : autoMarks;
            const draftValue = marksDraft[qid] ?? String(awarded);
            const isSavingThis = savingQid === qid && marksMutation.isPending;

            const commitMarks = () => {
              const raw = parseInt(draftValue, 10);
              const clamped = Number.isNaN(raw) ? awarded : Math.max(0, Math.min(q.marks, raw));
              setMarksDraft((d) => ({ ...d, [qid]: String(clamped) }));
              if (clamped === awarded) return; // no-op
              setSavingQid(qid);
              marksMutation.mutate({ [qid]: clamped });
            };

            const resetMarks = () => {
              setMarksDraft((d) => {
                const next = { ...d };
                delete next[qid];
                return next;
              });
              setSavingQid(qid);
              marksMutation.mutate({ [qid]: null });
            };

            return (
              <div key={q.id} className="glass-card p-6" data-testid={`review-question-${idx + 1}`}>
                <div className="flex items-center gap-3 mb-4">
                  <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-violet-500/30 to-cyan-500/20 flex items-center justify-center border border-violet-500/30 text-sm font-bold text-violet-300">
                    {idx + 1}
                  </div>
                  <div className="flex-1 flex items-center gap-2">
                    <p className="text-xs text-muted-foreground uppercase tracking-wider">Q{idx + 1}</p>
                    {hasOverride && (
                      <Badge
                        className="text-[10px] bg-amber-500/10 text-amber-400 border-amber-500/30"
                        data-testid={`marks-adjusted-${qid}`}
                      >
                        Adjusted
                      </Badge>
                    )}
                  </div>
                  {canEditMarks ? (
                    <div className="flex items-center gap-1.5">
                      <input
                        type="number"
                        min={0}
                        max={q.marks}
                        value={draftValue}
                        disabled={isSavingThis}
                        onChange={(e) => setMarksDraft((d) => ({ ...d, [qid]: e.target.value }))}
                        onBlur={commitMarks}
                        onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                        className="w-14 h-8 px-2 rounded-lg bg-foreground/5 border border-border/60 text-sm text-foreground text-center focus:outline-none focus:border-violet-500/60"
                        data-testid={`marks-input-${qid}`}
                        aria-label={`Awarded marks for question ${idx + 1}`}
                      />
                      <span className="text-xs text-muted-foreground">/ {q.marks}</span>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-8 w-8 p-0 text-emerald-400 hover:text-emerald-300 hover:bg-emerald-500/10"
                        onClick={commitMarks}
                        disabled={isSavingThis}
                        data-testid={`marks-save-${qid}`}
                        title="Save marks"
                      >
                        {isSavingThis ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                      </Button>
                      {hasOverride && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-8 w-8 p-0 text-muted-foreground hover:text-foreground hover:bg-foreground/10"
                          onClick={resetMarks}
                          disabled={isSavingThis}
                          data-testid={`marks-reset-${qid}`}
                          title="Reset to auto-computed"
                        >
                          <RotateCcw className="w-4 h-4" />
                        </Button>
                      )}
                    </div>
                  ) : (
                    <Badge className={`text-xs ${isCorrect ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/30" : studentAnswer ? "bg-red-500/10 text-red-400 border-red-500/30" : "bg-slate-500/10 text-muted-foreground border-slate-500/30"}`}>
                      {isCorrect ? "Correct" : studentAnswer ? "Incorrect" : "Skipped"} [{awarded}/{q.marks}]
                    </Badge>
                  )}
                </div>

                <div className="text-base text-foreground leading-relaxed mb-4" data-testid={`text-review-stem-${idx + 1}`}>
                  <MarkdownRenderer content={q.stem} />
                </div>

                <div className="grid gap-2.5">
                  {q.options.map((option, optIdx) => {
                    const letter = String.fromCharCode(65 + optIdx);
                    const isCorrectOption = option === q.correctAnswer;
                    const isStudentWrongPick = option === studentAnswer && !isCorrectOption;

                    let optionClasses = "bg-foreground/[0.04] border-border/50";
                    let ringClasses = "";
                    let iconEl = null;

                    if (isCorrectOption) {
                      optionClasses = "bg-green-500/20 border-green-500/40";
                      ringClasses = "ring-2 ring-green-500";
                      iconEl = <CheckCircle2 className="w-4 h-4 text-green-400 shrink-0" />;
                    } else if (isStudentWrongPick) {
                      optionClasses = "bg-red-500/20 border-red-500/40";
                      ringClasses = "ring-2 ring-red-500 shadow-[0_0_15px_rgba(239,68,68,0.5)]";
                      iconEl = <XCircle className="w-4 h-4 text-red-400 shrink-0" />;
                    }

                    return (
                      <div
                        key={optIdx}
                        className={`w-full text-left p-4 rounded-xl border transition-all duration-200 ${optionClasses} ${ringClasses}`}
                        data-testid={`review-option-${idx + 1}-${optIdx}`}
                      >
                        <div className="flex items-start gap-3">
                          <div className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 text-xs font-semibold ${
                            isCorrectOption
                              ? "bg-green-500/30 text-green-200 border border-green-500/50"
                              : isStudentWrongPick
                                ? "bg-red-500/30 text-red-200 border border-red-500/50"
                                : "bg-foreground/5 text-muted-foreground border border-border/50"
                          }`}>
                            {letter}
                          </div>
                          <div className={`text-sm pt-0.5 flex-1 ${
                            isCorrectOption ? "text-green-200" : isStudentWrongPick ? "text-red-200" : "text-foreground/80"
                          }`}>
                            <MarkdownRenderer content={option} />
                          </div>
                          {iconEl}
                        </div>
                      </div>
                    );
                  })}
                </div>

                {(() => {
                  const diag = data.diagnoses ? data.diagnoses[String(q.id)] : null;
                  if (!diag || !diag.misconception || diag.correct) return null;
                  const m = diag.misconception;
                  const yearLabel = m.examYear ? `in ${m.examYear}` : "before";
                  return (
                    <div
                      className="mt-5 p-4 rounded-xl border-l-4 bg-rose-500/10 border-l-rose-500"
                      data-testid={`review-examiner-citation-${idx + 1}`}
                    >
                      <p className="text-xs font-semibold mb-2 uppercase tracking-wider flex items-center gap-2 text-rose-400">
                        <Quote className="w-4 h-4" />
                        Cambridge examiners flagged this {yearLabel}
                      </p>
                      <p className="text-sm text-foreground">{m.misconception}</p>
                    </div>
                  );
                })()}

                {q.explanation && (
                  <div
                    className={`mt-5 p-4 rounded-xl border-l-4 ${
                      isCorrect
                        ? "bg-blue-500/10 border-l-blue-500"
                        : "bg-amber-500/10 border-l-amber-500"
                    }`}
                    data-testid={`review-explanation-${idx + 1}`}
                  >
                    <p className={`text-xs font-semibold mb-2 uppercase tracking-wider flex items-center gap-2 ${
                      isCorrect ? "text-blue-400" : "text-amber-400"
                    }`}>
                      <Lightbulb className="w-4 h-4" />
                      soma explanation
                    </p>
                    <div className="text-sm text-foreground leading-relaxed">
                      <MarkdownRenderer content={q.explanation} />
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="mt-8 flex justify-center">
          <Link href="/dashboard">
            <Button className="glow-button min-h-[44px]" data-testid="button-review-done">
              <Home className="w-4 h-4 mr-1.5" />
              Return to Dashboard
            </Button>
          </Link>
        </div>
      </div>

      <div
        aria-hidden="true"
        style={{
          position: "absolute",
          left: "-10000px",
          top: 0,
          width: "780px",
          pointerEvents: "none",
        }}
        data-testid="pdf-print-root"
      >
        <ReportPdfView ref={pdfRef} data={pdfData} />
      </div>
    </div>
  );
}
