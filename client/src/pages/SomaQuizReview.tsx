import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useParams, Link, useLocation } from "wouter";
import DOMPurify from "dompurify";
import { authFetch } from "@/lib/supabase";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ThemeToggle } from "@/components/ThemeToggle";
import {
  ArrowLeft, Home, AlertCircle, Loader2, CheckCircle2, XCircle, BookOpen, Award, Lightbulb, ClipboardCopy, Check, Quote, PenLine, Brain,
} from "lucide-react";
import MarkdownRenderer from "@/components/MarkdownRenderer";
import ReportPdfView, { type ReportPdfData } from "@/components/student/ReportPdfView";

interface StructuredMark {
  maxMarks: number;
  aiMarks: number;
  aiFeedback: string;
  aiUnderstanding: string;
  tutorMarks: number | null;
  confirmed: boolean;
}

const STANDARD_ACTION_BUTTON_CLASS = "inline-flex items-center justify-center gap-2 px-6 py-3 h-12 rounded-xl text-base font-semibold border border-primary/40 bg-primary/20 text-primary hover:bg-primary/30 transition-all cursor-pointer";

interface ReviewQuestion {
  id: number;
  stem: string;
  options: string[];
  correctAnswer: string;
  marks: number;
  explanation: string | null;
  questionType?: string;
  markScheme?: string | null;
}

interface ReviewReport {
  id: number;
  quizId: number;
  studentName: string;
  score: number;
  status: string;
  answersJson: Record<string, string> | null;
  structuredMarking: Record<string, StructuredMark> | null;
  reviewRequested?: boolean;
  reviewRequestNote?: string | null;
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
  /** True when the viewer (quiz-author tutor / super-admin) may confirm the
   *  AI-suggested marks on structured answers. */
  canConfirm?: boolean;
  /** True when the viewer is the student who owns this report. */
  isOwner?: boolean;
  /** Phase 2C — per-question diagnoses keyed by question id. Optional so
   *  reports created before Phase 2 still render. */
  diagnoses?: Record<string, QuestionDiagnosis>;
}

export default function SomaQuizReview() {
  const reportRef = useRef<HTMLDivElement>(null);
  const pdfRef = useRef<HTMLDivElement>(null);
  const params = useParams<{ reportId: string }>();
  const [, setLocation] = useLocation();
  const reportId = parseInt(params.reportId || "0");
  const [copied, setCopied] = useState(false);
  const [downloading, setDownloading] = useState(false);
  // Tutor mark overrides for structured answers, keyed by question id.
  const [markOverrides, setMarkOverrides] = useState<Record<string, number>>({});
  // Student's optional note when requesting a marking review.
  const [reviewNote, setReviewNote] = useState("");
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data, isLoading, error } = useQuery<ReviewData>({
    queryKey: ["/api/soma/reports", reportId, "review"],
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

  const structuredMarking = data?.report?.structuredMarking ?? null;

  const confirmMarksMutation = useMutation({
    mutationFn: async () => {
      const marks = Object.entries(markOverrides).map(([questionId, m]) => ({ questionId, marks: m }));
      const res = await authFetch(`/api/tutor/reports/${reportId}/structured-marking`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ marks }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.message || "Could not save marks");
      }
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Marks confirmed", description: "The score has been released to the student." });
      queryClient.invalidateQueries({ queryKey: ["/api/soma/reports", reportId, "review"] });
    },
    onError: (err: Error) => {
      toast({ title: "Could not confirm marks", description: err.message, variant: "destructive" });
    },
  });

  const requestReviewMutation = useMutation({
    mutationFn: async (note: string) => {
      const res = await authFetch(`/api/soma/reports/${reportId}/request-review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.message || "Could not send request");
      }
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Review requested", description: "Your teacher has been notified and will take another look." });
      queryClient.invalidateQueries({ queryKey: ["/api/soma/reports", reportId, "review"] });
    },
    onError: (err: Error) => {
      toast({ title: "Could not request review", description: err.message, variant: "destructive" });
    },
  });

  // Seed the tutor's editable marks from the AI suggestion (or prior override).
  useEffect(() => {
    if (!structuredMarking) return;
    setMarkOverrides((prev) => {
      if (Object.keys(prev).length > 0) return prev;
      const seed: Record<string, number> = {};
      for (const [qid, m] of Object.entries(structuredMarking)) {
        seed[qid] = m.tutorMarks ?? m.aiMarks;
      }
      return seed;
    });
  }, [structuredMarking]);

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
              <Loader2 className="w-5 h-5 text-primary animate-spin" />
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
          <div className="w-16 h-16 rounded-full bg-danger/10 flex items-center justify-center mx-auto mb-5 border border-danger/30">
            <AlertCircle className="w-8 h-8 text-danger" />
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
    questionType: q.questionType,
    markScheme: q.markScheme ?? null,
  }));
  const percentage = totalMarks > 0 ? Math.round((score / totalMarks) * 100) : 0;
  const canConfirm = data.canConfirm === true;
  const isOwner = data.isOwner === true;
  const hasStructured = questions.some((q) => q.questionType === "structured");
  const reviewRequested = report.reviewRequested === true;
  const stillMarking = report.status === "pending" && hasStructured;

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
            <div className="w-10 h-10 rounded-xl bg-primary/20 flex items-center justify-center border border-primary/30">
              <BookOpen className="w-5 h-5 text-primary" />
            </div>
            <div className="flex-1">
              <h2 className="text-xl font-bold gradient-text" data-testid="text-review-title">{report.quiz.title}</h2>
              <p className="text-xs text-muted-foreground">{report.quiz.topic}</p>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-4">
            <div className="bg-foreground/5 rounded-xl p-4 border border-border/50 text-center">
              <p className="text-2xl font-bold text-primary" data-testid="text-review-percentage">{percentage}%</p>
              <p className="text-xs text-muted-foreground">Score</p>
            </div>
            <div className="bg-foreground/5 rounded-xl p-4 border border-border/50 text-center">
              <p className="text-2xl font-bold text-foreground/80" data-testid="text-review-marks">{report.score}/{totalMarks}</p>
              <p className="text-xs text-muted-foreground">Marks</p>
            </div>
            <div className="bg-foreground/5 rounded-xl p-4 border border-border/50 text-center">
              <p className="text-2xl font-bold text-info" data-testid="text-review-total-q">{questions.length}</p>
              <p className="text-xs text-muted-foreground">Questions</p>
            </div>
          </div>
        </div>

        {stillMarking && (
          <div className="glass-card p-4 mb-6 border-l-4 border-l-warning bg-warning/[0.06]" data-testid="banner-still-marking">
            <div className="flex items-center gap-3">
              <Loader2 className="w-5 h-5 text-warning shrink-0 animate-spin" />
              <p className="text-sm text-foreground">Your written answers are still being marked. Refresh in a moment to see your score.</p>
            </div>
          </div>
        )}

        {/* Tutor view: adjust + confirm the AI marks (e.g. after a request). */}
        {canConfirm && hasStructured && !stillMarking && (
          <div className={`glass-card p-4 mb-6 border-l-4 ${reviewRequested ? "border-l-primary bg-primary/[0.08]" : "border-l-border bg-foreground/[0.03]"}`} data-testid="banner-tutor-marking">
            <div className="flex items-start gap-3">
              {reviewRequested ? <PenLine className="w-5 h-5 text-primary shrink-0 mt-0.5" /> : <Brain className="w-5 h-5 text-muted-foreground shrink-0 mt-0.5" />}
              <div className="flex-1">
                <p className="text-sm font-semibold text-foreground">
                  {reviewRequested ? `${studentName} requested a marking review` : "AI-marked written answers"}
                </p>
                {reviewRequested && report.reviewRequestNote && (
                  <p className="text-xs text-muted-foreground mt-1 italic">“{report.reviewRequestNote}”</p>
                )}
                <p className="text-xs text-muted-foreground mt-0.5">
                  Adjust any marks below, then save to update the student's score.
                </p>
                <Button
                  className="glow-button mt-3 min-h-[40px]"
                  onClick={() => confirmMarksMutation.mutate()}
                  disabled={confirmMarksMutation.isPending}
                  data-testid="button-confirm-structured-marks"
                >
                  {confirmMarksMutation.isPending
                    ? <><Loader2 className="w-4 h-4 mr-1.5 animate-spin" />Saving…</>
                    : <><Check className="w-4 h-4 mr-1.5" />Save marks &amp; update score</>}
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* Student view: request a tutor review of the AI marking. */}
        {isOwner && !canConfirm && hasStructured && !stillMarking && (
          <div className="glass-card p-4 mb-6 border-l-4 border-l-primary bg-primary/[0.06]" data-testid="banner-student-review">
            {reviewRequested ? (
              <div className="flex items-center gap-3">
                <CheckCircle2 className="w-5 h-5 text-primary shrink-0" />
                <p className="text-sm text-foreground">You've asked your teacher to review this marking. They'll take another look soon.</p>
              </div>
            ) : (
              <div className="flex items-start gap-3">
                <PenLine className="w-5 h-5 text-primary shrink-0 mt-0.5" />
                <div className="flex-1">
                  <p className="text-sm font-semibold text-foreground">Disagree with the marking?</p>
                  <p className="text-xs text-muted-foreground mt-0.5 mb-2">
                    Your written answers were marked by AI. You can ask your teacher to review the marks.
                  </p>
                  <textarea
                    value={reviewNote}
                    onChange={(e) => setReviewNote(e.target.value)}
                    placeholder="Optional: tell your teacher which answer and why (e.g. 'Q2 covers the point in different words')."
                    rows={2}
                    maxLength={1000}
                    className="w-full text-sm rounded-lg bg-background border border-border/60 px-3 py-2 text-foreground resize-y"
                    data-testid="input-review-note"
                  />
                  <Button
                    className="glow-button mt-2 min-h-[40px]"
                    onClick={() => requestReviewMutation.mutate(reviewNote.trim())}
                    disabled={requestReviewMutation.isPending}
                    data-testid="button-request-review"
                  >
                    {requestReviewMutation.isPending
                      ? <><Loader2 className="w-4 h-4 mr-1.5 animate-spin" />Sending…</>
                      : <><PenLine className="w-4 h-4 mr-1.5" />Request a teacher review</>}
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}

        <div className="space-y-6">
          {questions.map((q, idx) => {
            const studentAnswer = studentAnswers[String(q.id)] || null;
            const isStructured = q.questionType === "structured";
            const sm = isStructured && structuredMarking ? structuredMarking[String(q.id)] : null;
            const effectiveStructuredMark = sm ? (sm.tutorMarks ?? sm.aiMarks) : 0;
            const isCorrect = !isStructured && studentAnswer === q.correctAnswer;

            return (
              <div key={q.id} className="glass-card p-6" data-testid={`review-question-${idx + 1}`}>
                <div className="flex items-center gap-3 mb-4">
                  <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-primary/30 to-info/20 flex items-center justify-center border border-primary/30 text-sm font-bold text-primary">
                    {idx + 1}
                  </div>
                  <div className="flex-1 flex items-center gap-2">
                    <p className="text-xs text-muted-foreground uppercase tracking-wider">Q{idx + 1}</p>
                    {isStructured && (
                      <Badge className="text-[10px] bg-info/10 text-info border-info/30">
                        <PenLine className="w-3 h-3 mr-1" /> Written
                      </Badge>
                    )}
                  </div>
                  {isStructured ? (
                    <Badge className={`text-xs ${sm?.confirmed ? "bg-success/10 text-success border-success/30" : "bg-info/10 text-info border-info/30"}`}>
                      {sm ? `${effectiveStructuredMark}/${q.marks}` : "—"} · {sm?.confirmed ? "tutor" : "AI"}
                    </Badge>
                  ) : (
                    <Badge className={`text-xs ${isCorrect ? "bg-success/10 text-success border-success/30" : studentAnswer ? "bg-danger/10 text-danger border-danger/30" : "bg-muted text-muted-foreground border-border"}`}>
                      {isCorrect ? "Correct" : studentAnswer ? "Incorrect" : "Skipped"} [{q.marks}]
                    </Badge>
                  )}
                </div>

                <div className="text-base text-foreground leading-relaxed mb-4" data-testid={`text-review-stem-${idx + 1}`}>
                  <MarkdownRenderer content={q.stem} />
                </div>

                {isStructured ? (
                  <div className="space-y-4" data-testid={`review-structured-${idx + 1}`}>
                    {/* Student's written answer */}
                    <div className="rounded-xl border border-border/50 bg-foreground/[0.03] p-4">
                      <p className="text-xs font-semibold mb-2 uppercase tracking-wider text-muted-foreground">Your answer</p>
                      {studentAnswer ? (
                        <div
                          className="text-sm text-foreground/90 leading-relaxed prose-sm [&_ul]:list-disc [&_ul]:pl-5"
                          dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(studentAnswer) }}
                        />
                      ) : (
                        <p className="text-sm text-muted-foreground italic">No answer submitted.</p>
                      )}
                    </div>

                    {/* AI understanding analysis */}
                    {sm?.aiUnderstanding && (
                      <div className="p-4 rounded-xl border-l-4 bg-violet-500/10 border-l-violet-500">
                        <p className="text-xs font-semibold mb-2 uppercase tracking-wider flex items-center gap-2 text-violet-300">
                          <Brain className="w-4 h-4" /> Understanding
                        </p>
                        <p className="text-sm text-foreground leading-relaxed">{sm.aiUnderstanding}</p>
                      </div>
                    )}

                    {/* Feedback */}
                    {sm?.aiFeedback && (
                      <div className="p-4 rounded-xl border-l-4 bg-amber-500/10 border-l-amber-500">
                        <p className="text-xs font-semibold mb-2 uppercase tracking-wider flex items-center gap-2 text-amber-400">
                          <Lightbulb className="w-4 h-4" /> Feedback
                        </p>
                        <p className="text-sm text-foreground leading-relaxed">{sm.aiFeedback}</p>
                      </div>
                    )}

                    {/* Tutor confirmation controls */}
                    {canConfirm && sm && (
                      <div className="p-4 rounded-xl border border-violet-500/30 bg-violet-500/[0.06]">
                        <div className="flex items-center justify-between gap-3 flex-wrap">
                          <div className="flex items-center gap-2">
                            <label className="text-xs uppercase tracking-wider text-muted-foreground">Award marks</label>
                            <input
                              type="number"
                              min={0}
                              max={q.marks}
                              value={markOverrides[String(q.id)] ?? effectiveStructuredMark}
                              onChange={(e) => {
                                const v = Math.max(0, Math.min(q.marks, Number(e.target.value) || 0));
                                setMarkOverrides((prev) => ({ ...prev, [String(q.id)]: v }));
                              }}
                              className="w-20 px-2 py-1 rounded-md bg-background border border-border/60 text-sm text-foreground"
                              data-testid={`structured-mark-input-${idx + 1}`}
                            />
                            <span className="text-xs text-muted-foreground">/ {q.marks}</span>
                          </div>
                          <span className="text-[11px] text-muted-foreground">AI suggested {sm.aiMarks}/{q.marks}</span>
                        </div>
                      </div>
                    )}

                    {/* Mark scheme (shown post-submission) */}
                    {q.markScheme && (
                      <details className="rounded-xl border border-border/50 bg-foreground/[0.02] p-4">
                        <summary className="text-xs font-semibold uppercase tracking-wider text-muted-foreground cursor-pointer">Mark scheme</summary>
                        <div className="text-sm text-foreground/80 leading-relaxed mt-2 whitespace-pre-line">
                          <MarkdownRenderer content={q.markScheme} />
                        </div>
                      </details>
                    )}
                  </div>
                ) : (
                <>
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
                </>
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
