import { useMemo, useState } from "react";
import { Layers, ChevronDown, ChevronUp, Target, CheckCircle2, CircleDashed } from "lucide-react";
import { Ring } from "@/components/soma/Charts";
import { getSubjectIcon, getLevelColor } from "@/lib/subjectColors";
import type { StudentDashboardSubject } from "@/types/studentDashboard";

function scoreColor(pct: number): string {
  if (pct >= 75) return "hsl(var(--success))";
  if (pct >= 55) return "hsl(var(--warning))";
  return "hsl(var(--danger))";
}

const STATUS_META: Record<string, { label: string; cls: string }> = {
  needs_work: { label: "Weak", cls: "chip-danger" },
  in_progress: { label: "Developing", cls: "chip-warning" },
  mastered: { label: "Secure", cls: "chip-success" },
  untested: { label: "Untested", cls: "chip" },
};

// Orders topics so the ones that should be studied next float to the top:
// weak first, then untested, then developing, then secure; ties broken by the
// lower understanding score.
const STATUS_PRIORITY: Record<string, number> = {
  needs_work: 0,
  untested: 1,
  in_progress: 2,
  mastered: 3,
};

interface Props {
  subjects: StudentDashboardSubject[];
}

// Study tools centrepiece: a per-subject map of the student's syllabus topic
// coverage. It answers, at a glance, "how much of each subject have I covered,
// how much have I actually mastered, and what should I study next?".
export default function TopicCoverageExplorer({ subjects }: Props) {
  const withTopics = useMemo(
    () => (subjects ?? []).filter((s) => s.topics && s.topics.length > 0),
    [subjects],
  );
  const [openSubject, setOpenSubject] = useState<string | null>(
    () => withTopics[0]?.subject ?? null,
  );

  if (withTopics.length === 0) {
    return (
      <section className="soma-card" style={{ padding: 22 }} data-testid="panel-topic-coverage-empty">
        <div className="row" style={{ gap: 10, marginBottom: 6 }}>
          <Layers className="w-5 h-5" style={{ color: "hsl(var(--primary))" }} />
          <h3 className="soma-display" style={{ fontSize: 18 }}>Topic coverage</h3>
        </div>
        <p className="text-sm text-muted-foreground">
          Your topic coverage builds up as you complete assessments. Once you've taken a quiz,
          you'll see exactly which syllabus topics you've covered and mastered here.
        </p>
      </section>
    );
  }

  return (
    <section className="soma-card" style={{ padding: 22 }} data-testid="panel-topic-coverage">
      <header className="row between wrap" style={{ marginBottom: 16, gap: 10 }}>
        <div className="row" style={{ gap: 10 }}>
          <span
            className="grid place-items-center"
            style={{ width: 32, height: 32, borderRadius: 9, background: "hsl(var(--primary) / 0.12)", color: "hsl(var(--primary))", border: "1px solid hsl(var(--primary) / 0.25)" }}
          >
            <Layers className="w-4 h-4" />
          </span>
          <div>
            <div className="eyebrow">Study tools</div>
            <h3 className="soma-display" style={{ fontSize: 18, marginTop: 2 }}>Topic coverage</h3>
          </div>
        </div>
        <span className="text-muted-foreground" style={{ fontSize: 12, maxWidth: 260, textAlign: "right" }}>
          How much of each subject you've covered, how much you've mastered, and what to study next.
        </span>
      </header>

      <div style={{ display: "grid", gap: 12 }}>
        {withTopics.map((s) => {
          const Icon = getSubjectIcon(s.subject);
          const lc = getLevelColor(s.level);
          const isOpen = openSubject === s.subject;
          const coveragePct = Math.round(s.coverage.coveragePercent);
          const masteryPct = Math.round(s.coverage.masteryPercent);

          // Topics to study next: weak + untested, ordered by priority/score.
          const ordered = [...s.topics].sort((a, b) => {
            const pa = STATUS_PRIORITY[a.status] ?? 9;
            const pb = STATUS_PRIORITY[b.status] ?? 9;
            if (pa !== pb) return pa - pb;
            return a.understandingPercent - b.understandingPercent;
          });

          return (
            <div
              key={s.subject}
              className="rounded-2xl border border-border bg-card/40 overflow-hidden"
              data-testid={`coverage-subject-${s.subject}`}
            >
              <button
                onClick={() => setOpenSubject(isOpen ? null : s.subject)}
                className="w-full flex items-center gap-3 text-left hover:bg-foreground/[0.02] transition-colors"
                style={{ padding: "14px 16px" }}
                aria-expanded={isOpen}
              >
                <div className={`w-10 h-10 rounded-xl ${lc.bg} border ${lc.border} flex items-center justify-center shrink-0`}>
                  <Icon className={`w-5 h-5 ${lc.label}`} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="row" style={{ gap: 8 }}>
                    <span style={{ fontWeight: 700, fontSize: 15 }}>{s.subject}</span>
                    {s.level && <span className="chip" style={{ fontSize: 10 }}>{s.level}</span>}
                  </div>
                  <span className="text-muted-foreground" style={{ fontSize: 12 }}>
                    {s.coverage.coveredTopics}/{s.coverage.totalTopics} topics covered · {s.coverage.masteredTopics} mastered
                  </span>
                </div>
                <div className="flex items-center gap-4 shrink-0">
                  <div className="grid place-items-center" style={{ gap: 3 }}>
                    <Ring pct={coveragePct} size={44} stroke={5} color="hsl(var(--info))">
                      <span className="num" style={{ fontSize: 11 }}>{coveragePct}%</span>
                    </Ring>
                    <span className="eyebrow" style={{ fontSize: 8.5 }}>Covered</span>
                  </div>
                  <div className="grid place-items-center" style={{ gap: 3 }}>
                    <Ring pct={masteryPct} size={44} stroke={5} color={scoreColor(masteryPct)}>
                      <span className="num" style={{ fontSize: 11 }}>{masteryPct}%</span>
                    </Ring>
                    <span className="eyebrow" style={{ fontSize: 8.5 }}>Mastered</span>
                  </div>
                  {isOpen ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
                </div>
              </button>

              {isOpen && (
                <div style={{ padding: "4px 16px 16px" }}>
                  <div className="row" style={{ gap: 6, margin: "4px 0 10px", color: "hsl(var(--muted-foreground))", fontSize: 11 }}>
                    <Target className="w-3.5 h-3.5" style={{ color: "hsl(var(--danger))" }} />
                    Study next is listed first
                  </div>
                  <div style={{ display: "grid", gap: 7 }}>
                    {ordered.map((t) => {
                      const m = STATUS_META[t.status] ?? STATUS_META.untested;
                      const pct = Math.round(t.understandingPercent);
                      const tested = t.status !== "untested";
                      return (
                        <div
                          key={t.topic}
                          className="row between"
                          style={{ gap: 12, padding: "10px 12px", background: "hsl(var(--secondary))", border: "1px solid hsl(var(--border))", borderRadius: 10 }}
                          data-testid={`coverage-topic-${s.subject}-${t.topic}`}
                        >
                          <span style={{ minWidth: 0, flex: 1 }}>
                            <span className="row" style={{ gap: 8, marginBottom: tested ? 6 : 0 }}>
                              {t.status === "mastered" ? (
                                <CheckCircle2 className="w-3.5 h-3.5 shrink-0" style={{ color: "hsl(var(--success))" }} />
                              ) : (
                                <CircleDashed className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
                              )}
                              <span style={{ fontWeight: 600, fontSize: 13.5 }} className="truncate">{t.topic}</span>
                            </span>
                            {tested && (
                              <span className="meter" style={{ maxWidth: 280 }}><span style={{ width: pct + "%", background: scoreColor(pct) }} /></span>
                            )}
                          </span>
                          <span className="row" style={{ gap: 8, flex: "none" }}>
                            {tested && <span className="num" style={{ fontSize: 13, width: 34, textAlign: "right", color: scoreColor(pct) }}>{pct}%</span>}
                            <span className={`chip ${m.cls}`} style={{ fontSize: 10.5 }}>{m.label}</span>
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
