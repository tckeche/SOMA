import { useQuery } from "@tanstack/react-query";
import { authFetch } from "@/lib/supabase";
import { Loader2, AlertTriangle, Users, BookOpen, Quote } from "lucide-react";

interface HeatmapStudent {
  id: string;
  displayName: string | null;
  evidenceCount: number;
  lastSeenAt: string;
}

interface HeatmapRow {
  misconceptionId: number;
  misconception: string;
  studentError: string;
  correctApproach: string;
  topic: string;
  subtopicTitle: string | null;
  examYear: number | null;
  frequency: string;
  syllabusCode: string;
  examBody: string;
  affectedStudents: HeatmapStudent[];
  totalEvidence: number;
}

interface Payload {
  rows: HeatmapRow[];
  cohortSize: number;
}

const FREQUENCY_BADGE: Record<string, string> = {
  very_common: "bg-danger/15 text-danger border-danger/30",
  common: "bg-warning/15 text-warning border-warning/30",
  occasional: "bg-sky-500/15 text-sky-200 border-sky-500/30",
};

export function CohortMisconceptionHeatmap() {
  const { data, isLoading, isError } = useQuery<Payload>({
    queryKey: ["/api/tutor/cohort-misconceptions"],
    queryFn: async () => {
      const res = await authFetch("/api/tutor/cohort-misconceptions");
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
  });

  if (isLoading) {
    return (
      <div className="flex justify-center py-16"><Loader2 className="w-6 h-6 text-primary animate-spin" /></div>
    );
  }
  if (isError || !data) {
    return (
      <div className="bg-foreground/[0.02] border border-border/60 rounded-2xl text-center py-12 px-4">
        <AlertTriangle className="w-10 h-10 mx-auto text-warning mb-3" />
        <p className="text-sm text-muted-foreground">Couldn't load the heatmap.</p>
      </div>
    );
  }

  return (
    <section className="space-y-5" data-testid="cohort-misconception-heatmap">
      <div className="bg-gradient-to-br from-primary/10 to-sky-500/5 border border-primary/20 rounded-2xl p-5">
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded-xl bg-primary/20 border border-primary/30 flex items-center justify-center shrink-0">
            <Users className="w-5 h-5 text-primary" />
          </div>
          <div className="flex-1">
            <h2 className="text-base font-semibold text-foreground">Where your class is getting stuck</h2>
            <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
              Active examiner-flagged misconceptions across your <span className="text-foreground font-medium">{data.cohortSize}</span> adopted student{data.cohortSize !== 1 ? "s" : ""}, ordered by how many students hold them. Resolved misconceptions are excluded.
            </p>
          </div>
        </div>
      </div>

      {data.rows.length === 0 ? (
        <div className="bg-foreground/[0.02] border border-border/60 rounded-2xl text-center py-12 px-4">
          <BookOpen className="w-10 h-10 mx-auto text-muted-foreground mb-3" />
          <p className="text-sm text-foreground font-medium">Nothing flagged yet across your cohort.</p>
          <p className="text-xs text-muted-foreground mt-1.5">
            Once your students take quizzes that target known examiner misconceptions, you'll see a heatmap of where they're getting stuck.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {data.rows.map((row) => (
            <CohortRow key={row.misconceptionId} row={row} cohortSize={data.cohortSize} />
          ))}
        </div>
      )}
    </section>
  );
}

function CohortRow({ row, cohortSize }: { row: HeatmapRow; cohortSize: number }) {
  const sharePct = cohortSize > 0 ? Math.round((row.affectedStudents.length / cohortSize) * 100) : 0;
  return (
    <article
      className="bg-foreground/[0.02] border border-border/60 rounded-2xl p-5"
      data-testid={`cohort-row-${row.misconceptionId}`}
    >
      <div className="flex items-start gap-4 mb-3">
        <div className="text-right shrink-0 min-w-[64px]">
          <p className="text-2xl font-bold text-foreground tabular-nums">
            {row.affectedStudents.length}<span className="text-sm text-muted-foreground">/{cohortSize}</span>
          </p>
          <p className="text-[10px] text-muted-foreground uppercase tracking-wider">{sharePct}% of cohort</p>
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-foreground leading-relaxed">{row.misconception}</p>
          <div className="flex items-center gap-2 flex-wrap mt-2 text-[11px]">
            <span className={`px-2 py-0.5 rounded-full border ${FREQUENCY_BADGE[row.frequency] ?? FREQUENCY_BADGE.common}`}>
              {row.frequency.replace("_", " ")}
            </span>
            <span className="text-muted-foreground flex items-center gap-1">
              <BookOpen className="w-3 h-3" />
              {row.examBody} <code className="text-foreground/80">{row.syllabusCode}</code>
              <span>· {row.topic}{row.subtopicTitle ? ` · ${row.subtopicTitle}` : ""}</span>
            </span>
            {row.examYear && (
              <span className="text-danger flex items-center gap-1">
                <Quote className="w-3 h-3" /> Examiners flagged this in {row.examYear}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Cohort bar — visual share */}
      <div className="h-2 bg-foreground/[0.04] rounded-full overflow-hidden mb-3">
        <div
          className="h-full bg-gradient-to-r from-primary to-danger"
          style={{ width: `${sharePct}%` }}
        />
      </div>

      <div className="grid md:grid-cols-2 gap-3 mb-3">
        <div>
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Typical wrong working</p>
          <p className="text-xs text-foreground/85 leading-relaxed">{row.studentError || "—"}</p>
        </div>
        <div>
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">What students should do</p>
          <p className="text-xs text-foreground/85 leading-relaxed">{row.correctApproach || "—"}</p>
        </div>
      </div>

      <div>
        <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5">Affected students</p>
        <div className="flex flex-wrap gap-1.5">
          {row.affectedStudents.map((s) => (
            <span
              key={s.id}
              className="text-[11px] bg-foreground/[0.04] border border-border/50 rounded-full px-2.5 py-0.5"
              title={`${s.evidenceCount} occurrence${s.evidenceCount !== 1 ? "s" : ""}, last seen ${new Date(s.lastSeenAt).toLocaleDateString()}`}
            >
              {s.displayName ?? s.id.slice(0, 8)}
              {s.evidenceCount > 1 && <span className="ml-1 text-muted-foreground">×{s.evidenceCount}</span>}
            </span>
          ))}
        </div>
      </div>
    </article>
  );
}
