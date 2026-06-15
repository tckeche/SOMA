import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { authFetch } from "@/lib/supabase";
import { formatDistanceToNow } from "date-fns";
import { Flag, CheckCircle2, Loader2, ChevronDown, ChevronUp, MessageSquare } from "lucide-react";
import MarkdownRenderer from "@/components/MarkdownRenderer";
import { formatPersonName } from "@/lib/personName";

interface TutorFlag {
  id: number;
  studentId: string;
  questionId: number;
  quizId: number;
  reason: string | null;
  resolvedAt: string | null;
  createdAt: string;
  question: { id: number; stem: string; correctAnswer: string; options: string[]; topicTag: string | null };
  quiz: { id: number; title: string; subject: string | null };
  student: { id: string; displayName: string | null; email: string };
}

interface Props {
  quizId?: number;
}

export default function TutorFlagsPanel({ quizId }: Props) {
  const qc = useQueryClient();
  const [showResolved, setShowResolved] = useState(false);

  const queryKey = quizId ? ["/api/tutor/flagged-questions", quizId, showResolved] : ["/api/tutor/flagged-questions", "all", showResolved];

  const { data, isLoading } = useQuery<{ flags: TutorFlag[] }>({
    queryKey,
    queryFn: async () => {
      const params = new URLSearchParams();
      if (quizId) params.set("quizId", String(quizId));
      if (!showResolved) params.set("unresolvedOnly", "true");
      const res = await authFetch(`/api/tutor/flagged-questions?${params.toString()}`);
      if (!res.ok) return { flags: [] };
      return res.json();
    },
    refetchInterval: 30_000,
  });

  const resolveMutation = useMutation({
    mutationFn: async (flagId: number) => {
      const res = await authFetch(`/api/tutor/flagged-questions/${flagId}/resolve`, { method: "POST" });
      if (!res.ok) throw new Error("Failed to resolve flag");
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/tutor/flagged-questions"] });
    },
  });

  const flags = data?.flags ?? [];
  const unresolved = useMemo(() => flags.filter((f) => !f.resolvedAt), [flags]);

  return (
    <section
      className="rounded-2xl border border-warning/20 bg-gradient-to-br from-warning/5 to-warning/5 p-5 shadow-lg"
      data-testid="panel-tutor-flags"
    >
      <header className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Flag className="w-5 h-5 text-warning" />
          <div>
            <h2 className="text-sm font-semibold text-warning">Student-flagged questions</h2>
            <p className="text-[11px] text-warning/70">
              {unresolved.length > 0
                ? `${unresolved.length} unresolved ${unresolved.length === 1 ? "flag" : "flags"} for your attention`
                : "Nothing flagged right now"}
            </p>
          </div>
        </div>
        <button
          onClick={() => setShowResolved((v) => !v)}
          className="text-[11px] text-warning hover:text-warning px-2 py-1 rounded border border-warning/30"
          data-testid="button-toggle-resolved"
        >
          {showResolved ? <><ChevronUp className="w-3 h-3 inline mr-1" />Hide resolved</> : <><ChevronDown className="w-3 h-3 inline mr-1" />Show resolved</>}
        </button>
      </header>

      {isLoading ? (
        <div className="text-center py-6 text-warning/60">
          <Loader2 className="w-5 h-5 animate-spin mx-auto" />
        </div>
      ) : flags.length === 0 ? (
        <p className="text-sm text-warning/70 py-4 text-center">No flagged questions yet.</p>
      ) : (
        <ul className="space-y-2.5" data-testid="list-tutor-flags">
          {flags.map((f) => (
            <li
              key={f.id}
              className={`rounded-xl border p-3 ${f.resolvedAt ? "border-border bg-card/50 opacity-70" : "border-warning/30 bg-card/60"}`}
              data-testid={`flag-${f.id}`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[10px] font-medium text-warning px-2 py-0.5 rounded-full bg-warning/15 border border-warning/30">
                      Q{f.question.id}
                    </span>
                    {f.question.topicTag && (
                      <span className="text-[10px] text-foreground/80 px-2 py-0.5 rounded-full bg-muted/60">{f.question.topicTag}</span>
                    )}
                    {!quizId && (
                      <span className="text-[10px] text-muted-foreground">{f.quiz.title}</span>
                    )}
                    <span className="text-[10px] text-muted-foreground">
                      by {formatPersonName(f.student)} · {formatDistanceToNow(new Date(f.createdAt), { addSuffix: true })}
                    </span>
                  </div>
                  <div className="text-xs text-foreground mt-1.5 line-clamp-3">
                    <MarkdownRenderer content={f.question.stem} />
                  </div>
                  {f.reason && (
                    <div className="flex items-start gap-1.5 mt-2 text-[11px] text-warning/90 bg-warning/5 border border-warning/20 rounded-lg p-2">
                      <MessageSquare className="w-3 h-3 mt-0.5 shrink-0" />
                      <span className="italic">"{f.reason}"</span>
                    </div>
                  )}
                </div>
                {!f.resolvedAt && (
                  <button
                    onClick={() => resolveMutation.mutate(f.id)}
                    disabled={resolveMutation.isPending}
                    className="inline-flex items-center gap-1 text-[11px] font-medium text-success bg-success/10 border border-success/30 px-2.5 py-1 rounded hover:bg-success/20 disabled:opacity-60"
                    data-testid={`button-resolve-${f.id}`}
                  >
                    <CheckCircle2 className="w-3 h-3" /> Resolve
                  </button>
                )}
                {f.resolvedAt && (
                  <span className="inline-flex items-center gap-1 text-[10px] text-success">
                    <CheckCircle2 className="w-3 h-3" /> Resolved
                  </span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
