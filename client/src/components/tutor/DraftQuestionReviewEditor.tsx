import { useState } from "react";
import { CheckCircle2, Pencil, Check, X, Plus, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import MarkdownRenderer from "@/components/MarkdownRenderer";
import type { DraftQuestion } from "@shared/schema";

// Editable, LaTeX-aware review of the builder's DRAFT questions (pre-publish).
// Each card renders read-only with full Markdown until the tutor clicks Edit;
// edits are buffered locally and committed once on Save (so the draft autosave
// fires once per save, not per keystroke). Used in the builder Review modal.
interface EditBuffer {
  questionType: DraftQuestion["questionType"];
  stem: string;
  options: string[];
  correctIndex: number;
  marks: number;
  explanation: string;
  markScheme: string;
}

const FIELD_CLASS =
  "w-full px-3 py-2 rounded-lg bg-muted/80 border border-border/50 text-sm text-foreground focus:outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/30";

export function DraftQuestionReviewEditor({
  questions,
  onSave,
  onDelete,
  emptyMessage = "No questions to review yet.",
}: {
  questions: DraftQuestion[];
  onSave: (index: number, patch: Partial<DraftQuestion>) => void;
  onDelete?: (index: number) => void;
  emptyMessage?: string;
}) {
  const [editing, setEditing] = useState<Record<number, EditBuffer>>({});

  function startEdit(idx: number) {
    const q = questions[idx];
    const correctIndex = Math.max(0, q.options.findIndex((o) => o === q.correctAnswer));
    setEditing((prev) => ({
      ...prev,
      [idx]: {
        questionType: q.questionType,
        stem: q.stem,
        options: [...q.options],
        correctIndex,
        marks: q.marks,
        explanation: q.explanation ?? "",
        markScheme: q.markScheme ?? "",
      },
    }));
  }

  function cancelEdit(idx: number) {
    setEditing((prev) => {
      const next = { ...prev };
      delete next[idx];
      return next;
    });
  }

  function patchBuffer(idx: number, patch: Partial<EditBuffer>) {
    setEditing((prev) => ({ ...prev, [idx]: { ...prev[idx], ...patch } }));
  }

  function isValid(buf: EditBuffer): boolean {
    if (buf.stem.trim().length === 0 || !Number.isFinite(buf.marks) || buf.marks <= 0) return false;
    if (buf.questionType === "structured") {
      // Structured answers have no options; they need a mark scheme instead.
      return buf.markScheme.trim().length > 0;
    }
    return (
      buf.options.length >= 2 &&
      buf.options.every((o) => o.trim().length > 0) &&
      buf.correctIndex >= 0 &&
      buf.correctIndex < buf.options.length
    );
  }

  function saveEdit(idx: number) {
    const buf = editing[idx];
    if (!buf || !isValid(buf)) return;
    if (buf.questionType === "structured") {
      onSave(idx, {
        stem: buf.stem,
        marks: buf.marks,
        markScheme: buf.markScheme,
        explanation: buf.explanation,
      });
    } else {
      onSave(idx, {
        stem: buf.stem,
        options: buf.options,
        correctAnswer: buf.options[buf.correctIndex] ?? buf.options[0] ?? "",
        marks: buf.marks,
        explanation: buf.explanation,
      });
    }
    cancelEdit(idx);
  }

  if (!questions || questions.length === 0) {
    return (
      <p className="text-sm text-muted-foreground text-center py-10" data-testid="text-review-empty">
        {emptyMessage}
      </p>
    );
  }

  return (
    <div className="space-y-4" data-testid="list-question-review">
      {questions.map((q, idx) => {
        const buf = editing[idx];
        const isEditing = Boolean(buf);

        return (
          <div
            key={q.draftId ?? idx}
            className="bg-card/80 border border-card-border rounded-2xl p-5 shadow-lg"
            data-testid={`review-item-${idx}`}
          >
            <div className="flex items-center gap-2 flex-wrap mb-3">
              <Badge className="bg-primary/15 text-primary border border-primary/30 font-mono">
                Q{idx + 1}
              </Badge>
              {!isEditing && typeof q.marks === "number" && (
                <span className="text-xs text-muted-foreground">
                  {q.marks} mark{q.marks === 1 ? "" : "s"}
                </span>
              )}
              {q.questionType === "graph" && (
                <Badge className="bg-primary/10 text-primary border border-primary/20">graph</Badge>
              )}
              {q.questionType === "structured" && (
                <Badge className="bg-info/10 text-info border border-info/20">structured</Badge>
              )}
              {!isEditing && q.difficultyTag && <Badge variant="outline">{q.difficultyTag}</Badge>}

              <div className="ml-auto flex items-center gap-2">
                {isEditing ? (
                  <>
                    <button
                      type="button"
                      onClick={() => saveEdit(idx)}
                      disabled={!isValid(buf!)}
                      data-testid={`button-review-save-${idx}`}
                      className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium border border-success/40 bg-success/10 text-success hover:bg-success/20 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
                    >
                      <Check className="w-3.5 h-3.5" /> Save
                    </button>
                    <button
                      type="button"
                      onClick={() => cancelEdit(idx)}
                      data-testid={`button-review-cancel-${idx}`}
                      className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium border border-border/50 text-muted-foreground hover:text-foreground transition-all"
                    >
                      <X className="w-3.5 h-3.5" /> Cancel
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={() => startEdit(idx)}
                      data-testid={`button-review-edit-${idx}`}
                      className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium border border-primary/40 bg-primary/10 text-primary hover:bg-primary/20 transition-all"
                    >
                      <Pencil className="w-3.5 h-3.5" /> Edit
                    </button>
                    {onDelete && (
                      <button
                        type="button"
                        onClick={() => onDelete(idx)}
                        title="Remove question"
                        data-testid={`button-review-delete-${idx}`}
                        className="inline-flex items-center justify-center w-8 h-8 rounded-lg text-muted-foreground hover:text-danger transition-colors"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </>
                )}
              </div>
            </div>

            {isEditing ? (
              <div className="space-y-4">
                <div>
                  <label className="text-xs uppercase tracking-wider text-muted-foreground block mb-1">Question</label>
                  <textarea
                    value={buf!.stem}
                    onChange={(e) => patchBuffer(idx, { stem: e.target.value })}
                    rows={3}
                    data-testid={`input-review-stem-${idx}`}
                    className={`${FIELD_CLASS} resize-y`}
                  />
                </div>

                {buf!.questionType === "structured" ? (
                <div>
                  <label className="text-xs uppercase tracking-wider text-muted-foreground block mb-1">
                    Mark scheme · what a good answer covers
                  </label>
                  <textarea
                    value={buf!.markScheme}
                    onChange={(e) => patchBuffer(idx, { markScheme: e.target.value })}
                    rows={4}
                    data-testid={`input-review-markscheme-${idx}`}
                    className={`${FIELD_CLASS} resize-y`}
                    placeholder="List the key points / understanding the AI should look for."
                  />
                </div>
                ) : (
                <div>
                  <label className="text-xs uppercase tracking-wider text-muted-foreground block mb-1">
                    Options · select the correct answer
                  </label>
                  <div className="space-y-2">
                    {buf!.options.map((opt, i) => (
                      <div key={i} className="flex items-center gap-2">
                        <input
                          type="radio"
                          name={`review-correct-${idx}`}
                          checked={i === buf!.correctIndex}
                          onChange={() => patchBuffer(idx, { correctIndex: i })}
                          data-testid={`radio-review-correct-${idx}-${i}`}
                          className="h-4 w-4 accent-success shrink-0"
                        />
                        <input
                          value={opt}
                          onChange={(e) =>
                            patchBuffer(idx, {
                              options: buf!.options.map((o, j) => (j === i ? e.target.value : o)),
                            })
                          }
                          data-testid={`input-review-option-${idx}-${i}`}
                          className={FIELD_CLASS}
                        />
                        {buf!.options.length > 2 && (
                          <button
                            type="button"
                            onClick={() =>
                              patchBuffer(idx, {
                                options: buf!.options.filter((_, j) => j !== i),
                                correctIndex:
                                  buf!.correctIndex === i
                                    ? 0
                                    : buf!.correctIndex > i
                                      ? buf!.correctIndex - 1
                                      : buf!.correctIndex,
                              })
                            }
                            title="Remove option"
                            data-testid={`button-review-remove-option-${idx}-${i}`}
                            className="inline-flex items-center justify-center w-8 h-8 rounded-lg text-muted-foreground hover:text-danger transition-colors shrink-0"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                  <button
                    type="button"
                    onClick={() => patchBuffer(idx, { options: [...buf!.options, ""] })}
                    data-testid={`button-review-add-option-${idx}`}
                    className="inline-flex items-center gap-1 mt-2 px-2.5 py-1.5 rounded-lg text-xs font-medium border border-border/50 text-muted-foreground hover:text-foreground transition-all"
                  >
                    <Plus className="w-3.5 h-3.5" /> Add option
                  </button>
                </div>
                )}

                <div className="flex items-center gap-3">
                  <label className="text-xs uppercase tracking-wider text-muted-foreground">Marks</label>
                  <input
                    type="number"
                    min={1}
                    value={buf!.marks}
                    onChange={(e) => patchBuffer(idx, { marks: Math.max(1, parseInt(e.target.value || "1", 10) || 1) })}
                    data-testid={`input-review-marks-${idx}`}
                    className={`${FIELD_CLASS} w-24`}
                  />
                </div>

                <div>
                  <label className="text-xs uppercase tracking-wider text-muted-foreground block mb-1">Explanation</label>
                  <textarea
                    value={buf!.explanation}
                    onChange={(e) => patchBuffer(idx, { explanation: e.target.value })}
                    rows={2}
                    data-testid={`input-review-explanation-${idx}`}
                    className={`${FIELD_CLASS} resize-y`}
                  />
                </div>

                {!isValid(buf!) && (
                  <p className="text-xs text-warning">
                    {buf!.questionType === "structured"
                      ? "A structured question needs a prompt, a mark scheme, and at least 1 mark."
                      : "Every option needs text, a correct answer must be selected, and marks must be at least 1."}
                  </p>
                )}
              </div>
            ) : (
              <>
                <div className="text-foreground font-medium mb-3" data-testid={`review-stem-${idx}`}>
                  <MarkdownRenderer content={q.stem} />
                </div>
                {q.questionType === "structured" ? (
                  <div className="text-sm rounded-lg bg-info/[0.06] border border-info/20 px-3 py-2 mb-3" data-testid={`review-markscheme-${idx}`}>
                    <span className="text-xs font-medium text-info block mb-1">Mark scheme</span>
                    {q.markScheme
                      ? <MarkdownRenderer content={q.markScheme} />
                      : <span className="text-muted-foreground">No mark scheme yet.</span>}
                  </div>
                ) : (
                <ul className="space-y-1.5 mb-3">
                  {q.options.map((opt, i) => {
                    const isCorrect = opt === q.correctAnswer;
                    return (
                      <li
                        key={i}
                        className={`text-sm flex items-start gap-2 rounded-lg px-2 py-1 ${
                          isCorrect ? "bg-success/10 text-success font-medium" : "text-muted-foreground"
                        }`}
                        data-testid={`review-option-${idx}-${i}`}
                      >
                        <span className="shrink-0 mt-0.5">
                          {isCorrect ? (
                            <CheckCircle2 className="w-4 h-4" />
                          ) : (
                            <span className="inline-block w-4 text-center">•</span>
                          )}
                        </span>
                        <span className="min-w-0 flex-1">
                          <MarkdownRenderer content={opt} />
                        </span>
                      </li>
                    );
                  })}
                </ul>
                )}
                {q.explanation && (
                  <div className="text-sm text-muted-foreground border-t border-border/40 pt-3" data-testid={`review-explanation-${idx}`}>
                    <span className="font-medium text-foreground block mb-1">Explanation</span>
                    <MarkdownRenderer content={q.explanation} />
                  </div>
                )}
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

export default DraftQuestionReviewEditor;
