import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useParams, Link } from "wouter";
import { authFetch } from "@/lib/supabase";
import { useSupabaseSession } from "@/hooks/use-supabase-session";
import { useToast } from "@/hooks/use-toast";
import { ArrowLeft, Loader2, Check, X, Pencil, AlertTriangle, Archive, RotateCcw, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ThemeToggle } from "@/components/ThemeToggle";
import MarkdownRenderer from "@/components/MarkdownRenderer";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

interface GenerationWarning {
  issue?: string;
  [key: string]: unknown;
}

interface GenerationMeta {
  qualityWarnings?: string[];
  blockReason?: string;
  warnings?: GenerationWarning[];
  makerModel?: string;
  verifierModel?: string;
  [key: string]: unknown;
}

interface ReviewQuestion {
  id: number;
  stem: string;
  options: string[];
  correctAnswer: string;
  explanation: string | null;
  marks: number;
  reviewStatus: "approved" | "needs_review" | "auto_blocked" | "excluded";
  difficultyTag: string | null;
  topicTag: string | null;
  subtopicTag: string | null;
  generationMeta: GenerationMeta | null;
}

interface RegradeDetail {
  reportId: number;
  studentName: string;
  oldScore: number;
  newScore: number;
  maxPossibleScore: number;
}

interface RegradeResult {
  regraded: number;
  changed: number;
  details: RegradeDetail[];
}

const CARD_CLASS =
  "bg-card/80 backdrop-blur-md border border-card-border rounded-2xl p-6 shadow-2xl";

function statusBadge(status: ReviewQuestion["reviewStatus"]) {
  switch (status) {
    case "approved":
      return <Badge className="bg-success/20 text-success border border-success/40">approved</Badge>;
    case "needs_review":
      return <Badge className="bg-warning/20 text-warning border border-warning/40">needs review</Badge>;
    case "auto_blocked":
      return <Badge className="bg-danger/20 text-danger border border-danger/40">blocked</Badge>;
    case "excluded":
      return <Badge className="bg-muted text-muted-foreground border border-border">excluded</Badge>;
    default:
      return <Badge>{status}</Badge>;
  }
}

function rankFlagged(status: ReviewQuestion["reviewStatus"]) {
  // Flagged ones float to the top.
  if (status === "auto_blocked") return 0;
  if (status === "needs_review") return 1;
  return 2;
}

function QuestionCard({
  q,
  quizId,
  onMutate,
  pending,
}: {
  q: ReviewQuestion;
  quizId: string;
  onMutate: (questionId: number, body: Record<string, unknown>) => void;
  pending: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [stem, setStem] = useState(q.stem);
  const [explanation, setExplanation] = useState(q.explanation ?? "");
  const [options, setOptions] = useState<string[]>(() =>
    Array.from({ length: 4 }, (_, i) => q.options[i] ?? ""),
  );
  const [correct, setCorrect] = useState(q.correctAnswer);

  const meta = q.generationMeta;
  const flags: string[] = [];
  if (meta?.blockReason) flags.push(meta.blockReason);
  for (const w of meta?.qualityWarnings ?? []) flags.push(w);
  for (const w of meta?.warnings ?? []) if (w?.issue) flags.push(w.issue);

  function saveEdit() {
    const body: Record<string, unknown> = {};
    if (stem !== q.stem) body.stem = stem;
    if (explanation !== (q.explanation ?? "")) body.explanation = explanation;
    if (correct !== q.correctAnswer) body.correctAnswer = correct;
    const cleanedOptions = options.map((o) => o.trim());
    if (JSON.stringify(cleanedOptions) !== JSON.stringify(q.options)) body.options = cleanedOptions;
    if (Object.keys(body).length === 0) {
      setEditing(false);
      return;
    }
    onMutate(q.id, body);
    setEditing(false);
  }

  const isExcluded = q.reviewStatus === "excluded";

  return (
    <div
      className={`${CARD_CLASS}${isExcluded ? " opacity-60" : ""}`}
      data-testid={`review-question-${q.id}`}
    >
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="flex items-center gap-2 flex-wrap">
          {isExcluded ? (
            <Badge
              className="bg-muted text-muted-foreground border border-border"
              data-testid={`q-excluded-badge-${q.id}`}
            >
              Excluded
            </Badge>
          ) : (
            statusBadge(q.reviewStatus)
          )}
          {q.difficultyTag && <Badge variant="outline">{q.difficultyTag}</Badge>}
          {q.topicTag && <Badge variant="outline">{q.topicTag}</Badge>}
          <span className="text-xs text-muted-foreground">{q.marks} mark{q.marks === 1 ? "" : "s"}</span>
        </div>
        <div className="flex items-center gap-2">
          {isExcluded ? (
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              data-testid={`q-restore-${q.id}`}
              onClick={() => onMutate(q.id, { action: "restore" })}
            >
              <RotateCcw className="h-4 w-4 mr-1" /> Restore
            </Button>
          ) : (
            <>
              <Button
                size="sm"
                variant="outline"
                data-testid={`edit-question-${q.id}`}
                onClick={() => setEditing((e) => !e)}
              >
                <Pencil className="h-4 w-4 mr-1" /> {editing ? "Cancel" : "Edit"}
              </Button>
              <Button
                size="sm"
                className="bg-success hover:bg-success/90 text-white"
                disabled={pending}
                data-testid={`approve-question-${q.id}`}
                onClick={() => onMutate(q.id, { action: "approve" })}
              >
                <Check className="h-4 w-4 mr-1" /> Approve
              </Button>
              <Button
                size="sm"
                variant="destructive"
                disabled={pending}
                data-testid={`reject-question-${q.id}`}
                onClick={() => onMutate(q.id, { action: "reject" })}
              >
                <X className="h-4 w-4 mr-1" /> Reject
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={pending}
                data-testid={`q-exclude-${q.id}`}
                onClick={() => onMutate(q.id, { action: "exclude" })}
              >
                <Archive className="h-4 w-4 mr-1" /> Exclude
              </Button>
            </>
          )}
        </div>
      </div>

      {flags.length > 0 && (
        <div className="mb-4 rounded-lg border border-warning/40 bg-warning/10 p-3">
          <div className="flex items-center gap-2 text-warning text-sm font-medium mb-1">
            <AlertTriangle className="h-4 w-4" /> Flags
          </div>
          <ul className="list-disc list-inside text-sm text-warning/90 space-y-1">
            {flags.map((f, i) => (
              <li key={i}>{f}</li>
            ))}
          </ul>
        </div>
      )}

      {editing ? (
        <div className="space-y-3">
          <div>
            <Label className="text-xs">Stem</Label>
            <Textarea value={stem} onChange={(e) => setStem(e.target.value)} rows={3} />
          </div>
          <div className="space-y-2">
            <Label className="text-xs">Options (select the correct one)</Label>
            {options.map((opt, i) => (
              <div key={i} className="flex items-center gap-2">
                <input
                  type="radio"
                  name={`correct-${q.id}`}
                  checked={correct === opt}
                  onChange={() => setCorrect(opt)}
                  aria-label={`mark option ${i + 1} correct`}
                />
                <Input
                  value={opt}
                  onChange={(e) => {
                    const next = [...options];
                    const wasCorrect = correct === options[i];
                    next[i] = e.target.value;
                    setOptions(next);
                    if (wasCorrect) setCorrect(e.target.value);
                  }}
                />
              </div>
            ))}
          </div>
          <div>
            <Label className="text-xs">Explanation</Label>
            <Textarea value={explanation} onChange={(e) => setExplanation(e.target.value)} rows={3} />
          </div>
          <Button
            size="sm"
            disabled={pending}
            data-testid={`save-question-${q.id}`}
            onClick={saveEdit}
          >
            Save edits
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="text-foreground font-medium" data-testid={`q-stem-${q.id}`}>
            <MarkdownRenderer content={q.stem} />
          </div>
          <ul className="space-y-1">
            {q.options.map((opt, i) => {
              const isCorrect = opt === q.correctAnswer;
              return (
                <li
                  key={i}
                  className={`text-sm flex items-start gap-2 ${
                    isCorrect ? "text-success font-medium" : "text-muted-foreground"
                  }`}
                >
                  <span className="mt-0.5">{isCorrect ? "✓" : "•"}</span>
                  <span className="min-w-0 flex-1"><MarkdownRenderer content={opt} /></span>
                </li>
              );
            })}
          </ul>
          {q.explanation && (
            <div className="text-sm text-muted-foreground" data-testid={`q-explanation-${q.id}`}>
              <span className="font-medium text-foreground">Explanation: </span>
              <MarkdownRenderer content={q.explanation} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function TutorQuizReview() {
  const params = useParams();
  const quizId = params.quizId ?? "";
  const { userId } = useSupabaseSession();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const queryKey = [`/api/tutor/quizzes/${quizId}/review`, userId];

  const { data: questions = [], isLoading } = useQuery<ReviewQuestion[]>({
    queryKey,
    queryFn: async () => {
      if (!userId) throw new Error("Not authenticated");
      const res = await authFetch(`/api/tutor/quizzes/${quizId}/review`);
      if (!res.ok) throw new Error("Failed to load questions for review");
      return res.json();
    },
    enabled: !!userId && quizId.length > 0,
  });

  const [confirmRegrade, setConfirmRegrade] = useState(false);
  const [regradeResult, setRegradeResult] = useState<RegradeResult | null>(null);

  const mutation = useMutation({
    mutationFn: async ({ questionId, body }: { questionId: number; body: Record<string, unknown> }) => {
      const res = await authFetch(`/api/tutor/quizzes/${quizId}/questions/${questionId}/review`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error("Failed to update question");
      return res.json();
    },
    onSuccess: (data, variables) => {
      queryClient.invalidateQueries({ queryKey });
      const action = variables.body.action;
      if (action === "exclude") {
        const affected = Number(data?.affectedSubmissionCount ?? 0);
        if (affected > 0) {
          toast({
            title: "Question excluded",
            description: `${affected} submission${affected === 1 ? "" : "s"} affected — run 'Regrade submissions' to update scores.`,
          });
        } else {
          toast({ title: "Question excluded" });
        }
      } else if (action === "restore") {
        toast({ title: "Question restored" });
      } else {
        toast({ title: "Question updated" });
      }
    },
    onError: (err: any) => {
      toast({ title: "Update failed", description: err?.message, variant: "destructive" });
    },
  });

  const regradeMutation = useMutation({
    mutationFn: async () => {
      const res = await authFetch(`/api/tutor/quizzes/${quizId}/regrade`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      if (!res.ok) throw new Error("Failed to regrade submissions");
      return res.json() as Promise<RegradeResult>;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey });
      queryClient.invalidateQueries({ queryKey: [`/api/tutor/quizzes/${quizId}/details`] });
      setRegradeResult(data);
      toast({
        title: "Regrade complete",
        description: `Regraded ${data.regraded} submission${data.regraded === 1 ? "" : "s"}, ${data.changed} score${data.changed === 1 ? "" : "s"} changed.`,
      });
    },
    onError: (err: any) => {
      toast({ title: "Regrade failed", description: err?.message, variant: "destructive" });
    },
  });

  const sorted = [...questions].sort(
    (a, b) => rankFlagged(a.reviewStatus) - rankFlagged(b.reviewStatus) || a.id - b.id,
  );

  const flaggedCount = questions.filter(
    (q) => q.reviewStatus !== "approved" && q.reviewStatus !== "excluded",
  ).length;

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-card-border px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link href="/tutor/assessments" className="text-muted-foreground hover:text-foreground">
            <ArrowLeft className="h-5 w-5" />
          </Link>
          <h1 className="text-lg font-semibold">Review questions</h1>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={regradeMutation.isPending}
            data-testid="regrade-submissions"
            onClick={() => setConfirmRegrade(true)}
          >
            {regradeMutation.isPending ? (
              <Loader2 className="h-4 w-4 mr-1 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4 mr-1" />
            )}
            Regrade submissions
          </Button>
          <ThemeToggle />
        </div>
      </header>

      <AlertDialog open={confirmRegrade} onOpenChange={setConfirmRegrade}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Regrade submissions?</AlertDialogTitle>
            <AlertDialogDescription>
              This recomputes scores for all completed submissions using current
              (non-excluded) questions. Continue?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              data-testid="confirm-regrade"
              onClick={() => regradeMutation.mutate()}
            >
              Continue
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog
        open={regradeResult !== null}
        onOpenChange={(open) => !open && setRegradeResult(null)}
      >
        <DialogContent data-testid="regrade-results">
          <DialogHeader>
            <DialogTitle>Regrade complete</DialogTitle>
            <DialogDescription>
              Regraded {regradeResult?.regraded ?? 0} submission
              {regradeResult?.regraded === 1 ? "" : "s"}, {regradeResult?.changed ?? 0}{" "}
              score{regradeResult?.changed === 1 ? "" : "s"} changed.
            </DialogDescription>
          </DialogHeader>
          {regradeResult && regradeResult.changed > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Student</TableHead>
                  <TableHead className="text-right">Old</TableHead>
                  <TableHead className="text-right">New</TableHead>
                  <TableHead className="text-right">Max</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {regradeResult.details
                  .filter((d) => d.oldScore !== d.newScore)
                  .map((d) => (
                    <TableRow key={d.reportId}>
                      <TableCell>{d.studentName}</TableCell>
                      <TableCell className="text-right">{d.oldScore}</TableCell>
                      <TableCell className="text-right">{d.newScore}</TableCell>
                      <TableCell className="text-right">{d.maxPossibleScore}</TableCell>
                    </TableRow>
                  ))}
              </TableBody>
            </Table>
          )}
        </DialogContent>
      </Dialog>

      <main className="max-w-3xl mx-auto p-6 space-y-4">
        {isLoading ? (
          <div className="flex items-center justify-center py-20 text-muted-foreground">
            <Loader2 className="h-6 w-6 animate-spin" />
          </div>
        ) : questions.length === 0 ? (
          <p className="text-muted-foreground text-center py-20">No questions to review.</p>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              {flaggedCount > 0
                ? `${flaggedCount} question${flaggedCount === 1 ? "" : "s"} need attention. Only approved questions are shown to students.`
                : "All questions are approved."}
            </p>
            {sorted.map((q) => (
              <QuestionCard
                key={q.id}
                q={q}
                quizId={quizId}
                pending={mutation.isPending}
                onMutate={(questionId, body) => mutation.mutate({ questionId, body })}
              />
            ))}
          </>
        )}
      </main>
    </div>
  );
}
