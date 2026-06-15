/**
 * Per-subject syllabus radar + end-of-year paper readiness heatmap.
 *
 * Consumed by both the tutor's student-detail page and the student's own
 * dashboard, so it takes pre-fetched data as a prop rather than owning its
 * own query.
 */
import { Radar as RadarIcon, Layers } from "lucide-react";
import {
  ResponsiveContainer,
  RadarChart, Radar as RechartsRadar, PolarGrid, PolarAngleAxis, PolarRadiusAxis,
  Tooltip,
} from "recharts";
import { useChartPalette } from "@/lib/chartTheme";

export interface TopicInsight {
  topic: string;
  understandingPercent: number;
  masteryAchieved: boolean;
  attempted: boolean;
  totalQuestions: number;
}

export interface PaperInsight {
  paperNumber: number;
  code: string | null;
  title: string;
  readinessPercent: number;
  mappedTopics: number;
  attemptedTopics: number;
  weakTopics: Array<{ topic: string; understandingPercent: number }>;
}

export interface SubjectInsight {
  subject: string;
  examBody: string;
  syllabusCode: string;
  level: string;
  topics: TopicInsight[];
  papers: PaperInsight[];
}

interface Props {
  insights: { subjects: SubjectInsight[] } | undefined;
  isLoading?: boolean;
  studentFirstName?: string;
}

const GP = "glass-panel-elite";

function shortLabel(topic: string, max = 14): string {
  return topic.length > max ? topic.slice(0, max) + "…" : topic;
}

function readinessColor(pct: number): { bg: string; text: string; border: string } {
  if (pct >= 75) return { bg: "bg-emerald-500/20", text: "text-emerald-700 dark:text-emerald-300", border: "border-emerald-500/40" };
  if (pct >= 50) return { bg: "bg-amber-500/20", text: "text-amber-700 dark:text-amber-300", border: "border-amber-500/40" };
  if (pct > 0)   return { bg: "bg-red-500/20",   text: "text-red-700 dark:text-red-300",       border: "border-red-500/40" };
  return { bg: "bg-muted/50", text: "text-muted-foreground", border: "border-border/60" };
}

export function SyllabusInsightsSection({ insights, isLoading, studentFirstName }: Props) {
  if (isLoading) {
    return (
      <div className={GP}>
        <div className="px-6 py-12 text-center text-xs text-muted-foreground">Loading syllabus insights…</div>
      </div>
    );
  }

  const subjects = insights?.subjects ?? [];
  if (subjects.length === 0) {
    return (
      <div className={GP}>
        <div className="px-6 py-10 text-center">
          <RadarIcon className="w-8 h-8 mx-auto text-muted-foreground mb-2" />
          <p className="text-[13px] font-medium text-foreground/80">No syllabus data yet</p>
          <p className="text-[11px] text-muted-foreground mt-1">
            {studentFirstName ? `Enroll ${studentFirstName} in a subject` : "Add a subject to your profile"}
            {" "}to see the topic radar and paper readiness.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {subjects.map((subj) => (
        <SubjectInsightCard key={`${subj.examBody}-${subj.syllabusCode}-${subj.level}-${subj.subject}`} subj={subj} />
      ))}
    </div>
  );
}

function SubjectInsightCard({ subj }: { subj: SubjectInsight }) {
  const palette = useChartPalette();
  const topicsSorted = [...subj.topics].sort((a, b) => a.understandingPercent - b.understandingPercent);
  const avgUnderstanding = subj.topics.length > 0
    ? Math.round(subj.topics.reduce((s, t) => s + t.understandingPercent, 0) / subj.topics.length)
    : 0;
  const attemptedCount = subj.topics.filter((t) => t.attempted).length;
  const masteredCount = subj.topics.filter((t) => t.masteryAchieved).length;

  return (
    <div className={GP}>
      <div className="px-6 pt-5 pb-3 flex items-center justify-between border-b border-border/40">
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-lg flex items-center justify-center bg-primary/10 border border-primary/12">
            <RadarIcon className="w-3.5 h-3.5 text-primary" />
          </div>
          <div>
            <h3 className="text-[13px] font-semibold text-foreground">{subj.subject}</h3>
            <p className="text-[10px] text-muted-foreground font-medium">
              {subj.examBody} &middot; {subj.syllabusCode} &middot; {subj.level}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-4 text-[10px] text-muted-foreground">
          <span><span className="text-foreground font-semibold">{avgUnderstanding}%</span> avg mastery</span>
          <span>{attemptedCount}/{subj.topics.length} attempted</span>
          <span>{masteredCount} mastered</span>
        </div>
      </div>

      <div className="px-6 py-5 grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Topic radar */}
        <div>
          <div className="text-[11px] font-semibold text-foreground/80 mb-2 uppercase tracking-wide">
            Syllabus topic radar
          </div>
          {subj.topics.length >= 3 ? (
            <div style={{ height: 320 }}>
              <ResponsiveContainer width="100%" height="100%">
                <RadarChart
                  data={subj.topics.map((t) => ({
                    subject: shortLabel(t.topic),
                    fullSubject: t.topic,
                    mastery: t.understandingPercent,
                    attempted: t.attempted ? 100 : 0,
                  }))}
                  cx="50%" cy="50%" outerRadius="72%"
                >
                  <PolarGrid stroke={palette.gridStroke} />
                  <PolarAngleAxis dataKey="subject" tick={{ fill: palette.axisTick, fontSize: 9, fontWeight: 600 }} />
                  <PolarRadiusAxis domain={[0, 100]} tick={{ fill: palette.axisTickMuted, fontSize: 9 }} axisLine={false} />
                  <RechartsRadar
                    name="Mastery"
                    dataKey="mastery"
                    stroke={palette.radarStroke}
                    fill={palette.radarArea}
                    strokeWidth={2}
                    dot={{ r: 3, fill: palette.radarStroke }}
                  />
                  <Tooltip content={({ active, payload }: any) => {
                    if (!active || !payload?.length) return null;
                    const d = payload[0]?.payload;
                    return (
                      <div className="rounded-md border border-border/50 bg-card/95 px-3 py-2 text-[11px] shadow-xl">
                        <div className="font-semibold text-foreground">{d?.fullSubject}</div>
                        <div className="text-foreground/80">Mastery: <span className="tabular-nums font-semibold">{d?.mastery}%</span></div>
                        <div className="text-muted-foreground">{d?.attempted === 100 ? "Attempted" : "Not attempted yet"}</div>
                      </div>
                    );
                  }} />
                </RadarChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <div className="flex items-center justify-center h-[320px] text-muted-foreground text-[11px] font-medium rounded-lg border border-dashed border-border/50">
              {subj.topics.length === 0
                ? "No topics on this syllabus yet"
                : "Need 3+ topics for a radar chart"}
            </div>
          )}
        </div>

        {/* Weakest topics list */}
        <div>
          <div className="text-[11px] font-semibold text-foreground/80 mb-2 uppercase tracking-wide">
            Weakest topics
          </div>
          <div className="space-y-1.5 max-h-[320px] overflow-y-auto pr-1">
            {topicsSorted.slice(0, 8).map((t) => {
              const barColor = t.understandingPercent >= 75
                ? "from-emerald-500 to-emerald-400"
                : t.understandingPercent >= 50
                  ? "from-amber-500 to-amber-400"
                  : t.understandingPercent > 0
                    ? "from-red-500 to-red-400"
                    : "from-slate-600 to-slate-500";
              return (
                <div key={t.topic} className="px-3 py-2 rounded-md bg-foreground/[0.03] border border-border/40">
                  <div className="flex items-center justify-between gap-2 mb-1.5">
                    <span className="text-[11px] text-foreground font-medium truncate">{t.topic}</span>
                    <span className="text-[10px] tabular-nums font-semibold text-foreground/80">
                      {t.attempted ? `${t.understandingPercent}%` : "—"}
                    </span>
                  </div>
                  <div className="h-1 rounded-full bg-foreground/[0.05] overflow-hidden">
                    <div
                      className={`h-full rounded-full bg-gradient-to-r ${barColor}`}
                      style={{ width: `${t.attempted ? Math.max(3, t.understandingPercent) : 0}%` }}
                    />
                  </div>
                  <div className="mt-1 text-[9px] text-muted-foreground">
                    {t.attempted ? `${t.totalQuestions} question${t.totalQuestions === 1 ? "" : "s"}` : "Not attempted yet"}
                  </div>
                </div>
              );
            })}
            {topicsSorted.length === 0 && (
              <div className="text-[11px] text-muted-foreground text-center py-4">No topics to show.</div>
            )}
          </div>
        </div>
      </div>

      {/* Paper readiness heatmap */}
      {subj.papers.length > 0 && (
        <div className="px-6 pb-5 border-t border-border/40 pt-4">
          <div className="flex items-center gap-2 mb-3">
            <Layers className="w-3.5 h-3.5 text-info" />
            <div className="text-[11px] font-semibold text-foreground/80 uppercase tracking-wide">
              End-of-year paper readiness
            </div>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2.5">
            {subj.papers.map((p) => {
              const col = readinessColor(p.readinessPercent);
              return (
                <div
                  key={p.paperNumber}
                  className={`rounded-lg border px-3 py-3 ${col.bg} ${col.border} transition hover:translate-y-[-1px]`}
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[10px] font-semibold text-foreground/80 uppercase tracking-wide">
                      Paper {p.paperNumber}{p.code ? ` (${p.code})` : ""}
                    </span>
                    <span className={`text-[13px] font-bold tabular-nums ${col.text}`}>
                      {p.readinessPercent}%
                    </span>
                  </div>
                  <div className="text-[10px] text-muted-foreground line-clamp-2 mb-1.5">{p.title}</div>
                  <div className="text-[9px] text-muted-foreground">
                    {p.attemptedTopics}/{p.mappedTopics} topics attempted
                  </div>
                  {p.weakTopics.length > 0 && (
                    <div className="mt-1.5 pt-1.5 border-t border-border/40">
                      <div className="text-[8px] uppercase tracking-wide text-muted-foreground mb-0.5">Focus</div>
                      {p.weakTopics.map((w) => (
                        <div key={w.topic} className="text-[9px] text-muted-foreground truncate">
                          {w.topic} · {w.understandingPercent}%
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <div className="mt-3 flex items-center gap-3 text-[9px] text-muted-foreground">
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-emerald-500/60" /> 75%+</span>
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-amber-500/60" /> 50–74%</span>
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-red-500/60" /> &lt;50%</span>
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-slate-500/40" /> Not yet attempted</span>
          </div>
        </div>
      )}
    </div>
  );
}
