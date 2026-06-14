import { Link } from "wouter";
import { BookOpen, Clock, Hash, Award, ArrowLeft, Play, Save, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { SomaQuiz } from "@shared/schema";
import StudentAssessmentPdfSection from "@/components/student/StudentAssessmentPdfSection";

// Pre-quiz "ready to begin?" screen. Shown once on a fresh attempt so the
// student can see what they're walking into before the timer starts.
// Skipped entirely when a resume is detected (answers already present).
export function AssessmentStartScreen({
  quiz,
  questionCount,
  totalMarks,
  onStart,
  quizId,
  isStudent = false,
}: {
  quiz: Pick<SomaQuiz, "title" | "subject" | "level" | "syllabus" | "timeLimitMinutes">;
  questionCount: number;
  totalMarks: number;
  onStart: () => void;
  // PDF worksheets/response section is shown to real students on the landing
  // screen. Omitted (e.g. tutor preview) when these aren't provided.
  quizId?: number;
  isStudent?: boolean;
}) {
  const rows: Array<{ label: string; value: string; icon: typeof BookOpen }> = [];
  if (quiz.subject) rows.push({ label: "Subject", value: quiz.subject, icon: BookOpen });
  if (quiz.level) rows.push({ label: "Level", value: quiz.level, icon: BookOpen });
  if (quiz.syllabus) rows.push({ label: "Syllabus", value: quiz.syllabus, icon: BookOpen });
  rows.push({ label: "Questions", value: String(questionCount), icon: Hash });
  rows.push({ label: "Total marks", value: String(totalMarks), icon: Award });
  rows.push({
    label: "Time limit",
    value: `${quiz.timeLimitMinutes} minute${quiz.timeLimitMinutes === 1 ? "" : "s"}`,
    icon: Clock,
  });

  return (
    <div className="min-h-screen bg-background px-4 py-8">
      <div className="max-w-2xl mx-auto">
        <div className="mb-4">
          <Link href="/dashboard">
            <Button
              variant="ghost"
              size="default"
              className="text-muted-foreground hover:text-foreground"
              data-testid="button-start-exit"
            >
              <ArrowLeft className="w-4 h-4 mr-1" />
              Back to dashboard
            </Button>
          </Link>
        </div>

        <div className="glass-card p-6 md:p-10 text-center">
          <div className="w-16 h-16 md:w-20 md:h-20 rounded-2xl bg-violet-500/10 border border-violet-500/30 flex items-center justify-center mx-auto mb-5">
            <BookOpen className="w-8 h-8 md:w-10 md:h-10 text-violet-300" aria-hidden="true" />
          </div>

          <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground mb-2">Ready to begin?</p>
          <h1
            className="text-2xl md:text-3xl font-bold gradient-text mb-6"
            data-testid="text-start-title"
          >
            {quiz.title}
          </h1>

          <div className="bg-foreground/5 border border-border/50 rounded-xl p-4 md:p-5 mb-6 divide-y divide-white/5">
            {rows.map((row) => {
              const Icon = row.icon;
              return (
                <div
                  key={row.label}
                  className="flex items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0"
                >
                  <span className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Icon className="w-4 h-4 text-muted-foreground" aria-hidden="true" />
                    {row.label}
                  </span>
                  <span className="text-sm font-medium text-foreground text-right">
                    {row.value}
                  </span>
                </div>
              );
            })}
          </div>

          <div className="text-left bg-foreground/[0.03] border border-border/30 rounded-xl p-4 md:p-5 mb-6 space-y-2.5">
            <p className="text-xs uppercase tracking-wider text-muted-foreground mb-1">What to expect</p>
            <Expect icon={Clock} text="The timer starts when you click Start — not before." />
            <Expect icon={Save} text="Your answers are auto-saved. You can close the tab and come back." />
            <Expect icon={CheckCircle2} text="You can review and change answers before submitting." />
          </div>

          {isStudent && quizId != null && quizId > 0 && (
            <StudentAssessmentPdfSection quizId={quizId} />
          )}

          <Button
            className="glow-button w-full min-h-[52px] text-base font-semibold"
            onClick={onStart}
            data-testid="button-start-assessment"
          >
            <Play className="w-5 h-5 mr-2" />
            Start assessment
          </Button>
          <p className="text-[11px] text-muted-foreground mt-3">
            Make sure you have a stable connection and enough time to finish.
          </p>
        </div>
      </div>
    </div>
  );
}

function Expect({ icon: Icon, text }: { icon: typeof Clock; text: string }) {
  return (
    <div className="flex items-start gap-2.5">
      <Icon className="w-4 h-4 text-violet-300 mt-0.5 shrink-0" aria-hidden="true" />
      <p className="text-sm text-foreground/80 leading-relaxed">{text}</p>
    </div>
  );
}

export default AssessmentStartScreen;
