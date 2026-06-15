import { CheckCircle2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import MarkdownRenderer from "@/components/MarkdownRenderer";

// Minimal shape shared by the builder's DraftQuestion and the published
// review-question DTO. Anything with a stem, options and a marked answer can
// be rendered read-only here with full LaTeX/Markdown.
export interface ReviewListQuestion {
  stem: string;
  options: string[];
  correctAnswer: string;
  explanation?: string | null;
  marks?: number;
  difficultyTag?: string | null;
  topicTag?: string | null;
  questionType?: string | null;
}

// A read-only, LaTeX-rendered audit list of questions. Used in the builder
// (Review tab next to Preview) and reusable anywhere a tutor needs to read the
// rendered questions rather than the raw $...$ source.
export function QuestionReviewList({
  questions,
  emptyMessage = "No questions to review yet.",
}: {
  questions: ReviewListQuestion[];
  emptyMessage?: string;
}) {
  if (!questions || questions.length === 0) {
    return (
      <p className="text-sm text-muted-foreground text-center py-10" data-testid="text-review-empty">
        {emptyMessage}
      </p>
    );
  }

  return (
    <div className="space-y-4" data-testid="list-question-review">
      {questions.map((q, idx) => (
        <div
          key={idx}
          className="bg-card/80 border border-card-border rounded-2xl p-5 shadow-lg"
          data-testid={`review-item-${idx}`}
        >
          <div className="flex items-center gap-2 flex-wrap mb-3">
            <Badge className="bg-primary/15 text-primary border border-primary/30 font-mono">
              Q{idx + 1}
            </Badge>
            {typeof q.marks === "number" && (
              <span className="text-xs text-muted-foreground">
                {q.marks} mark{q.marks === 1 ? "" : "s"}
              </span>
            )}
            {q.questionType === "graph" && (
              <Badge className="bg-primary/10 text-primary border border-primary/20">graph</Badge>
            )}
            {q.difficultyTag && <Badge variant="outline">{q.difficultyTag}</Badge>}
            {q.topicTag && <Badge variant="outline">{q.topicTag}</Badge>}
          </div>

          <div className="text-foreground font-medium mb-3" data-testid={`review-stem-${idx}`}>
            <MarkdownRenderer content={q.stem} />
          </div>

          <ul className="space-y-1.5 mb-3">
            {q.options.map((opt, i) => {
              const isCorrect = opt === q.correctAnswer;
              return (
                <li
                  key={i}
                  className={`text-sm flex items-start gap-2 rounded-lg px-2 py-1 ${
                    isCorrect
                      ? "bg-success/10 text-success font-medium"
                      : "text-muted-foreground"
                  }`}
                  data-testid={`review-option-${idx}-${i}`}
                >
                  <span className="shrink-0 mt-0.5">
                    {isCorrect ? <CheckCircle2 className="w-4 h-4" /> : <span className="inline-block w-4 text-center">•</span>}
                  </span>
                  <span className="min-w-0 flex-1">
                    <MarkdownRenderer content={opt} />
                  </span>
                </li>
              );
            })}
          </ul>

          {q.explanation && (
            <div className="text-sm text-muted-foreground border-t border-border/40 pt-3" data-testid={`review-explanation-${idx}`}>
              <span className="font-medium text-foreground block mb-1">Explanation</span>
              <MarkdownRenderer content={q.explanation} />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export default QuestionReviewList;
