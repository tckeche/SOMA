import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { authFetch } from "@/lib/supabase";
import {
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  Circle,
  Loader2,
  AlertTriangle,
  BookOpen,
  Sparkles,
  Target,
  TrendingUp,
} from "lucide-react";

interface SubtopicLeaf {
  id: number | null;
  number: string | null;
  title: string;
  understandingPercent: number;
  attempts: number;
  totalQuestions: number;
  correctQuestions: number;
  covered: boolean;
  tested: boolean;
  masteryAchieved: boolean;
  lastTestedAt: string | null;
  examinerInsightCount: number;
  fkLinked: boolean;
}

interface TopicNode {
  id: number;
  title: string;
  topicNumber: string | null;
  subtopics: SubtopicLeaf[];
  understandingPercent: number;
  attempts: number;
  totalQuestions: number;
  attemptedSubtopics: number;
  totalSubtopics: number;
  examinerInsightCount: number;
}

interface SubjectNode {
  subject: string;
  examBody: string;
  syllabusCode: string;
  level: string;
  topics: TopicNode[];
  understandingPercent: number;
  totalSubtopics: number;
  attemptedSubtopics: number;
  masteredSubtopics: number;
  examinerInsightCount: number;
}

interface MasteryMapPayload {
  subjects: SubjectNode[];
}

export interface SyllabusMasteryMapProps {
  /** API endpoint to fetch from. Defaults to the student's own map. */
  endpoint?: string;
  title?: string;
  description?: string;
}

export function SyllabusMasteryMap({
  endpoint = "/api/student/mastery-map",
  title = "Your syllabus mastery map",
  description = "Every Cambridge bullet-point in your subjects, with how you're doing on each.",
}: SyllabusMasteryMapProps) {
  const { data, isLoading, isError } = useQuery<MasteryMapPayload>({
    queryKey: [endpoint],
    queryFn: async () => {
      const res = await authFetch(endpoint);
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
  });

  if (isLoading) {
    return (
      <section className="space-y-3" data-testid="section-mastery-map">
        <header>
          <h2 className="text-lg font-semibold text-foreground">{title}</h2>
          <p className="text-xs text-muted-foreground">{description}</p>
        </header>
        <div className="flex justify-center py-12">
          <Loader2 className="w-5 h-5 text-primary animate-spin" />
        </div>
      </section>
    );
  }

  if (isError || !data) {
    return (
      <section className="space-y-3" data-testid="section-mastery-map">
        <header>
          <h2 className="text-lg font-semibold text-foreground">{title}</h2>
          <p className="text-xs text-muted-foreground">{description}</p>
        </header>
        <div className="rounded-2xl border border-card-border bg-card/70 p-8 text-center">
          <AlertTriangle className="w-8 h-8 mx-auto text-warning mb-2" />
          <p className="text-sm text-muted-foreground">Couldn't load your mastery map.</p>
        </div>
      </section>
    );
  }

  if (data.subjects.length === 0) {
    return (
      <section className="space-y-3" data-testid="section-mastery-map">
        <header>
          <h2 className="text-lg font-semibold text-foreground">{title}</h2>
          <p className="text-xs text-muted-foreground">{description}</p>
        </header>
        <div className="rounded-2xl border border-card-border bg-card/70 p-8 text-center">
          <BookOpen className="w-8 h-8 mx-auto text-muted-foreground mb-2" />
          <p className="text-sm text-foreground font-medium">Your subjects haven't been set yet.</p>
          <p className="text-xs text-muted-foreground mt-1">
            Once your tutor assigns you to a subject, you'll see the full Cambridge syllabus here.
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className="space-y-4" data-testid="section-mastery-map">
      <header>
        <h2 className="text-lg font-semibold text-foreground">{title}</h2>
        <p className="text-xs text-muted-foreground">{description}</p>
      </header>
      <div className="space-y-4">
        {data.subjects.map((s) => (
          <SubjectCard key={`${s.examBody}|${s.syllabusCode}`} node={s} />
        ))}
      </div>
    </section>
  );
}

function SubjectCard({ node }: { node: SubjectNode }) {
  const [expanded, setExpanded] = useState(false);
  const coveragePct = node.totalSubtopics > 0
    ? Math.round((node.attemptedSubtopics / node.totalSubtopics) * 100)
    : 0;
  const masteryPct = node.totalSubtopics > 0
    ? Math.round((node.masteredSubtopics / node.totalSubtopics) * 100)
    : 0;

  return (
    <article
      className="rounded-2xl border border-card-border bg-card/70 overflow-hidden"
      data-testid={`mastery-subject-${node.syllabusCode}`}
    >
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full p-5 flex items-center gap-4 hover:bg-foreground/[0.02] text-left"
      >
        <div className="w-10 h-10 rounded-xl bg-primary/15 border border-primary/30 flex items-center justify-center shrink-0">
          <BookOpen className="w-5 h-5 text-primary" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-foreground truncate">
            {node.subject} <span className="text-muted-foreground font-normal">· {node.examBody} {node.syllabusCode} · {node.level}</span>
          </p>
          <div className="flex items-center gap-4 mt-1 text-[11px] text-muted-foreground">
            <span className="flex items-center gap-1">
              <Target className="w-3 h-3" /> {node.understandingPercent}% understanding
            </span>
            <span className="flex items-center gap-1">
              <CheckCircle2 className="w-3 h-3" /> {node.attemptedSubtopics}/{node.totalSubtopics} attempted
              {coveragePct > 0 && ` · ${coveragePct}%`}
            </span>
            <span className="flex items-center gap-1">
              <Sparkles className="w-3 h-3" /> {node.masteredSubtopics} mastered
              {masteryPct > 0 && ` · ${masteryPct}%`}
            </span>
            {node.examinerInsightCount > 0 && (
              <span className="text-danger">
                {node.examinerInsightCount} examiner insight{node.examinerInsightCount !== 1 ? "s" : ""}
              </span>
            )}
          </div>
        </div>
        {expanded ? <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" /> : <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />}
      </button>
      {expanded && (
        <div className="border-t border-card-border/60 divide-y divide-border/40">
          {node.topics.length === 0 ? (
            <div className="p-5 text-xs text-muted-foreground text-center">
              The Cambridge tree for this syllabus hasn't been ingested yet. Your mastery is being tracked by topic name in the meantime.
            </div>
          ) : (
            node.topics.map((t) => <TopicRow key={t.id} node={t} />)
          )}
        </div>
      )}
    </article>
  );
}

function TopicRow({ node }: { node: TopicNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div data-testid={`mastery-topic-${node.id}`}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full px-5 py-3 flex items-center gap-3 hover:bg-foreground/[0.02] text-left"
      >
        <div className="w-7 h-7 rounded-lg bg-foreground/[0.04] border border-border/50 flex items-center justify-center shrink-0 text-[10px] text-muted-foreground font-mono">
          {node.topicNumber ?? "·"}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm text-foreground font-medium truncate">{node.title}</p>
          <div className="flex items-center gap-3 text-[11px] text-muted-foreground mt-0.5">
            <span className="flex items-center gap-1"><TrendingUp className="w-3 h-3" /> {node.understandingPercent}%</span>
            <span>{node.attemptedSubtopics}/{node.totalSubtopics} subtopics tested</span>
            {node.examinerInsightCount > 0 && (
              <span className="text-danger">{node.examinerInsightCount} examiner insight{node.examinerInsightCount !== 1 ? "s" : ""}</span>
            )}
          </div>
        </div>
        <UnderstandingBar percent={node.understandingPercent} />
        {open ? <ChevronDown className="w-3.5 h-3.5 text-muted-foreground shrink-0" /> : <ChevronRight className="w-3.5 h-3.5 text-muted-foreground shrink-0" />}
      </button>
      {open && (
        <div className="px-5 pb-3 space-y-1.5">
          {node.subtopics.map((s) => (
            <SubtopicLeafRow key={s.id ?? `${node.id}-${s.title}`} leaf={s} />
          ))}
        </div>
      )}
    </div>
  );
}

function UnderstandingBar({ percent }: { percent: number }) {
  const colour = percent >= 80 ? "bg-success" : percent >= 50 ? "bg-warning" : percent > 0 ? "bg-danger" : "bg-muted";
  return (
    <div className="hidden sm:block w-20 h-1.5 bg-foreground/[0.06] rounded-full overflow-hidden shrink-0">
      <div className={`h-full ${colour}`} style={{ width: `${Math.max(0, Math.min(100, percent))}%` }} />
    </div>
  );
}

function SubtopicLeafRow({ leaf }: { leaf: SubtopicLeaf }) {
  const stateLabel = leaf.masteryAchieved
    ? "Mastered"
    : leaf.tested
      ? `${leaf.understandingPercent}% on ${leaf.totalQuestions} q${leaf.totalQuestions !== 1 ? "s" : ""}`
      : leaf.covered
        ? "Covered, not tested"
        : "Not yet tested";
  const stateColour = leaf.masteryAchieved
    ? "text-success"
    : leaf.tested && leaf.understandingPercent >= 50
      ? "text-warning"
      : leaf.tested
        ? "text-danger"
        : "text-muted-foreground";
  return (
    <div className="flex items-center gap-3 pl-10 py-1.5">
      <div className="shrink-0">
        {leaf.masteryAchieved ? (
          <CheckCircle2 className="w-3.5 h-3.5 text-success" />
        ) : (
          <Circle className={`w-3.5 h-3.5 ${leaf.tested ? "text-warning" : "text-muted-foreground/40"}`} />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-xs text-foreground/90 truncate">
          {leaf.number && <span className="text-muted-foreground font-mono mr-1.5">{leaf.number}</span>}
          {leaf.title}
        </p>
      </div>
      <p className={`text-[11px] ${stateColour} shrink-0`}>{stateLabel}</p>
      {leaf.examinerInsightCount > 0 && (
        <span className="text-[10px] text-danger shrink-0">{leaf.examinerInsightCount} examiner</span>
      )}
    </div>
  );
}
