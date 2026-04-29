import { useQuery } from "@tanstack/react-query";
import { authFetch } from "@/lib/supabase";
import { MessageCircle, Loader2, AlertTriangle, TrendingUp } from "lucide-react";

interface Row {
  commandWord: string;
  attempts: number;
  correct: number;
  accuracyPct: number;
  marksAttempted: number;
  marksAwarded: number;
  marksAccuracyPct: number;
  lastAttemptedAt: string | null;
}

interface SubjectGroup {
  subject: string;
  rows: Row[];
  totalAttempts: number;
  weakestCommandWord: string | null;
}

interface Payload {
  subjects: SubjectGroup[];
}

const COMMAND_WORD_HINT: Record<string, string> = {
  state: "Just give the answer — no explanation needed.",
  define: "Use the formal Cambridge definition.",
  describe: "Say what you observe; no reasoning required.",
  explain: "Give the cause or reason. Use 'because…' / 'this is due to…'.",
  evaluate: "Weigh up both sides, then conclude.",
  compare: "Identify similarities AND differences in parallel.",
  contrast: "Focus on differences only.",
  discuss: "Present arguments and counterarguments before judging.",
  calculate: "Show working and units; round at the end only.",
  determine: "Calculate or deduce — show working.",
  justify: "Give a reason, then explicitly link it to the conclusion.",
  suggest: "Propose a sensible answer; the marker accepts a range.",
  show: "Demonstrate that the result holds; full working required.",
  prove: "Rigorous step-by-step justification — no gaps.",
  identify: "Pick out the relevant feature, no explanation needed.",
};

export function CommandWordCoach({ endpoint = "/api/student/command-words" }: { endpoint?: string } = {}) {
  const { data, isLoading, isError } = useQuery<Payload>({
    queryKey: [endpoint],
    queryFn: async () => {
      const res = await authFetch(endpoint);
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
  });

  if (isLoading) {
    return (
      <section className="space-y-3" data-testid="section-command-word-coach">
        <Header />
        <div className="flex justify-center py-10"><Loader2 className="w-5 h-5 text-violet-400 animate-spin" /></div>
      </section>
    );
  }

  if (isError || !data) {
    return (
      <section className="space-y-3" data-testid="section-command-word-coach">
        <Header />
        <div className="rounded-2xl border border-card-border bg-card/70 p-6 text-center">
          <AlertTriangle className="w-7 h-7 mx-auto text-amber-400 mb-2" />
          <p className="text-xs text-muted-foreground">Couldn't load your command-word stats.</p>
        </div>
      </section>
    );
  }

  if (data.subjects.length === 0) {
    return (
      <section className="space-y-3" data-testid="section-command-word-coach">
        <Header />
        <div className="rounded-2xl border border-card-border bg-card/70 p-6 text-center">
          <MessageCircle className="w-7 h-7 mx-auto text-muted-foreground mb-2" />
          <p className="text-xs text-muted-foreground">
            Once you've answered a few questions tagged with command words ("explain", "calculate", "evaluate"...), you'll see how you're doing on each.
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className="space-y-3" data-testid="section-command-word-coach">
      <Header />
      <div className="space-y-4">
        {data.subjects.map((s) => (
          <SubjectBlock key={s.subject} group={s} />
        ))}
      </div>
    </section>
  );
}

function Header() {
  return (
    <header>
      <h2 className="text-lg font-semibold text-foreground">Command-word coach</h2>
      <p className="text-xs text-muted-foreground">
        Cambridge marks are won and lost on whether you answer the actual command word. Here's how you're doing on each.
      </p>
    </header>
  );
}

function SubjectBlock({ group }: { group: SubjectGroup }) {
  return (
    <article className="rounded-2xl border border-card-border bg-card/70 p-5 space-y-3" data-testid={`coach-subject-${group.subject}`}>
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-semibold text-foreground">{group.subject}</p>
        <p className="text-[11px] text-muted-foreground">{group.totalAttempts} answer{group.totalAttempts !== 1 ? "s" : ""} so far</p>
      </div>
      {group.weakestCommandWord && (
        <p className="text-xs text-rose-300 flex items-center gap-1">
          <TrendingUp className="w-3 h-3 rotate-180" /> Watch out for "{group.weakestCommandWord}" — that's where you're losing the most marks.
        </p>
      )}
      <div className="space-y-2">
        {group.rows.map((r) => (
          <RowItem key={r.commandWord} row={r} />
        ))}
      </div>
    </article>
  );
}

function RowItem({ row }: { row: Row }) {
  const colour = row.attempts < 3
    ? "bg-foreground/[0.06]"
    : row.accuracyPct >= 80
      ? "bg-emerald-400"
      : row.accuracyPct >= 50
        ? "bg-amber-400"
        : "bg-rose-400";
  const tone = row.attempts < 3
    ? "text-muted-foreground"
    : row.accuracyPct >= 80
      ? "text-emerald-300"
      : row.accuracyPct >= 50
        ? "text-amber-200"
        : "text-rose-300";
  const hint = COMMAND_WORD_HINT[row.commandWord];
  return (
    <div className="rounded-xl bg-foreground/[0.02] border border-border/50 p-3" data-testid={`coach-row-${row.commandWord}`}>
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-medium capitalize">{row.commandWord}</p>
        <p className={`text-sm tabular-nums ${tone}`}>
          {row.attempts < 3 ? `${row.attempts}/3 needed` : `${row.accuracyPct}%`}
          <span className="text-muted-foreground text-[11px] ml-1">· {row.correct}/{row.attempts}</span>
        </p>
      </div>
      <div className="h-1.5 bg-foreground/[0.04] rounded-full overflow-hidden mt-2">
        <div className={`h-full ${colour}`} style={{ width: `${Math.max(2, row.accuracyPct)}%` }} />
      </div>
      {hint && (
        <p className="text-[11px] text-muted-foreground mt-1.5">{hint}</p>
      )}
    </div>
  );
}
