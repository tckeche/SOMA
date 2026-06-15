import { useQuery } from "@tanstack/react-query";
import { authFetch } from "@/lib/supabase";
import { Loader2, AlertTriangle, TrendingDown, Award } from "lucide-react";

interface PaperPrediction {
  paperId: number;
  paperNumber: number;
  code: string | null;
  title: string;
  rawMarks: number;
  predictedScore: number;
  predictedLoss: number;
  confidenceBandMarks: number;
  confidenceLabel: "low" | "medium" | "high";
  attemptedQuestions: number;
  topicsCovered: number;
  topicsTotal: number;
  weakestTopics: Array<{ title: string; understandingPercent: number }>;
}

interface SubjectPrediction {
  subject: string;
  examBody: string;
  syllabusCode: string;
  level: string;
  papers: PaperPrediction[];
  totalRawMarks: number;
  totalPredictedScore: number;
  totalPredictedLoss: number;
}

interface Payload {
  subjects: SubjectPrediction[];
  generatedAt: string;
}

export interface MarkLossPredictorProps {
  endpoint?: string;
}

const CONFIDENCE_COPY: Record<PaperPrediction["confidenceLabel"], { label: string; tone: string }> = {
  high: { label: "high confidence", tone: "text-success" },
  medium: { label: "medium confidence", tone: "text-warning" },
  low: { label: "low confidence — keep practising", tone: "text-danger" },
};

export function MarkLossPredictor({ endpoint = "/api/student/mark-loss-prediction" }: MarkLossPredictorProps) {
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
      <section className="space-y-3" data-testid="section-mark-loss">
        <Header />
        <div className="flex justify-center py-10">
          <Loader2 className="w-5 h-5 text-primary animate-spin" />
        </div>
      </section>
    );
  }

  if (isError || !data) {
    return (
      <section className="space-y-3" data-testid="section-mark-loss">
        <Header />
        <div className="rounded-2xl border border-card-border bg-card/70 p-6 text-center">
          <AlertTriangle className="w-7 h-7 mx-auto text-warning mb-2" />
          <p className="text-xs text-muted-foreground">Couldn't compute a prediction right now.</p>
        </div>
      </section>
    );
  }

  if (data.subjects.length === 0) {
    return (
      <section className="space-y-3" data-testid="section-mark-loss">
        <Header />
        <div className="rounded-2xl border border-card-border bg-card/70 p-6 text-center">
          <p className="text-xs text-muted-foreground">
            Once you've taken a few quizzes on a syllabus with mapped papers, you'll see a mark-loss prediction here.
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className="space-y-3" data-testid="section-mark-loss">
      <Header />
      <div className="space-y-4">
        {data.subjects.map((s) => (
          <SubjectBlock key={`${s.examBody}|${s.syllabusCode}`} subject={s} />
        ))}
      </div>
    </section>
  );
}

function Header() {
  return (
    <header>
      <h2 className="text-lg font-semibold text-foreground">If you sat the exam today</h2>
      <p className="text-xs text-muted-foreground">Predicted score per paper based on your mastery so far. Wider bands mean the prediction has less data behind it.</p>
    </header>
  );
}

function SubjectBlock({ subject }: { subject: SubjectPrediction }) {
  const overallPct = subject.totalRawMarks > 0
    ? Math.round((subject.totalPredictedScore / subject.totalRawMarks) * 100)
    : 0;
  return (
    <article className="rounded-2xl border border-card-border bg-card/70 p-5" data-testid={`mark-loss-subject-${subject.syllabusCode}`}>
      <div className="flex items-center justify-between gap-4 mb-4">
        <div>
          <p className="text-sm font-semibold text-foreground">
            {subject.subject} <span className="text-muted-foreground font-normal">· {subject.examBody} {subject.syllabusCode} · {subject.level}</span>
          </p>
          <p className="text-[11px] text-muted-foreground">Across all papers you would sit.</p>
        </div>
        <div className="text-right shrink-0">
          <p className="text-2xl font-bold text-foreground tabular-nums">
            {subject.totalPredictedScore}<span className="text-sm text-muted-foreground">/{subject.totalRawMarks}</span>
          </p>
          <p className="text-[11px] text-muted-foreground">{overallPct}% predicted</p>
        </div>
      </div>

      <div className="space-y-2">
        {subject.papers.map((p) => (
          <PaperRow key={p.paperId} paper={p} />
        ))}
      </div>
    </article>
  );
}

function PaperRow({ paper }: { paper: PaperPrediction }) {
  const conf = CONFIDENCE_COPY[paper.confidenceLabel];
  const lo = Math.max(0, paper.predictedScore - paper.confidenceBandMarks);
  const hi = Math.min(paper.rawMarks, paper.predictedScore + paper.confidenceBandMarks);
  const pct = paper.rawMarks > 0 ? Math.round((paper.predictedScore / paper.rawMarks) * 100) : 0;
  return (
    <div className="rounded-xl bg-foreground/[0.02] border border-border/50 p-3" data-testid={`mark-loss-paper-${paper.paperId}`}>
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-foreground truncate">
            <span className="text-muted-foreground font-mono mr-2">P{paper.paperNumber}</span>
            {paper.title}
          </p>
          <p className={`text-[11px] mt-0.5 ${conf.tone}`}>
            {conf.label} · range {lo}–{hi} marks · {paper.attemptedQuestions} questions answered so far
          </p>
        </div>
        <div className="text-right shrink-0">
          <p className="text-lg font-bold tabular-nums">
            {paper.predictedScore}<span className="text-xs text-muted-foreground">/{paper.rawMarks}</span>
          </p>
          <p className="text-[11px] text-danger flex items-center gap-1 justify-end">
            <TrendingDown className="w-3 h-3" /> losing ~{paper.predictedLoss}
          </p>
        </div>
      </div>
      {/* Score bar with confidence band */}
      <div className="mt-3 h-2 bg-foreground/[0.04] rounded-full relative overflow-visible">
        {/* confidence band */}
        <div
          className="absolute top-0 h-full rounded-full bg-primary/15"
          style={{
            left: `${(lo / paper.rawMarks) * 100}%`,
            width: `${((hi - lo) / paper.rawMarks) * 100}%`,
          }}
        />
        {/* point estimate */}
        <div
          className="absolute top-0 h-full bg-primary rounded-full"
          style={{ left: `${(paper.predictedScore / paper.rawMarks) * 100 - 0.5}%`, width: "1.5%" }}
        />
      </div>
      {paper.weakestTopics.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <Award className="w-3 h-3 text-muted-foreground shrink-0" />
          <span className="text-[10px] text-muted-foreground uppercase tracking-wider">Where you'd lose most:</span>
          {paper.weakestTopics.map((w) => (
            <span key={w.title} className="text-[11px] text-foreground/80 bg-foreground/[0.04] border border-border/50 rounded px-1.5 py-0.5">
              {w.title} · {w.understandingPercent}%
            </span>
          ))}
        </div>
      )}
      <p className="text-[10px] text-muted-foreground mt-2">{pct}% predicted</p>
    </div>
  );
}
