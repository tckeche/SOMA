import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { authFetch } from "@/lib/supabase";
import {
  ClipboardCheck,
  CheckCircle2,
  XCircle,
  Loader2,
  AlertTriangle,
  RefreshCcw,
  Pencil,
  Save,
  X,
  BookOpen,
  Lightbulb,
  Gauge,
} from "lucide-react";

type ReviewStatus = "pending" | "approved" | "rejected";

interface QueueRow {
  id: number;
  status: ReviewStatus;
  board: string;
  syllabusCode: string;
  subject: string | null;
  topic: string;
  subtopic: string | null;
  subtopicTitle: string | null;
  misconception: string;
  studentError: string;
  correctApproach: string;
  frequency: string;
  sourceQuote: string | null;
  sourcePage: number | null;
  confidencePct: number | null;
  reviewedAt: string | null;
  reviewedByDisplayName: string | null;
  reviewNotes: string | null;
  documentFilename: string | null;
  extractedAt: string;
}

interface QueueListResult {
  rows: QueueRow[];
  total: number;
}

interface Counts {
  pending: number;
  approved: number;
  rejected: number;
}

const TABS: Array<{ key: ReviewStatus; label: string }> = [
  { key: "pending", label: "To check" },
  { key: "approved", label: "Approved" },
  { key: "rejected", label: "Rejected" },
];

const FREQUENCY_LABEL: Record<string, string> = {
  very_common: "very common",
  common: "common",
  occasional: "occasional",
};

const FREQUENCY_BADGE: Record<string, string> = {
  very_common: "bg-rose-500/15 text-rose-300 border-rose-500/30",
  common: "bg-amber-500/15 text-amber-200 border-amber-500/30",
  occasional: "bg-sky-500/15 text-sky-200 border-sky-500/30",
};

type ConfidenceBucket = "high" | "medium" | "low" | "unknown";
type ConfidenceFilter = "all" | ConfidenceBucket;
type SortMode = "newest" | "confidence_desc" | "confidence_asc";

function bucketForConfidence(pct: number | null): ConfidenceBucket {
  if (pct === null || pct === undefined) return "unknown";
  if (pct >= 80) return "high";
  if (pct >= 50) return "medium";
  return "low";
}

const CONFIDENCE_BADGE: Record<ConfidenceBucket, { className: string; label: string; help: string }> = {
  high: {
    className: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
    label: "Pretty sure",
    help: "SOMA is pretty sure about this one — quick to approve if it looks right.",
  },
  medium: {
    className: "bg-amber-500/15 text-amber-200 border-amber-500/30",
    label: "Worth a look",
    help: "Worth a closer read before approving.",
  },
  low: {
    className: "bg-rose-500/15 text-rose-300 border-rose-500/30",
    label: "Not sure",
    help: "SOMA isn't very sure — please scrutinise before approving.",
  },
  unknown: {
    className: "bg-foreground/[0.04] text-muted-foreground border-border/50",
    label: "Unknown",
    help: "No confidence reported by the extractor.",
  },
};

const CONFIDENCE_FILTERS: Array<{ key: ConfidenceFilter; label: string }> = [
  { key: "all", label: "All confidence" },
  { key: "high", label: "Pretty sure (≥ 80%)" },
  { key: "medium", label: "Worth a look (50–79%)" },
  { key: "low", label: "Not sure (< 50%)" },
  { key: "unknown", label: "Unknown" },
];

const SORT_OPTIONS: Array<{ key: SortMode; label: string }> = [
  { key: "newest", label: "Newest first" },
  { key: "confidence_desc", label: "Most sure first" },
  { key: "confidence_asc", label: "Least sure first" },
];

function ConfidenceBadge({ pct }: { pct: number | null }) {
  const bucket = bucketForConfidence(pct);
  const meta = CONFIDENCE_BADGE[bucket];
  return (
    <span
      className={`px-2 py-0.5 rounded-full border text-[11px] inline-flex items-center gap-1 ${meta.className}`}
      title={pct === null ? meta.help : `${pct}% — ${meta.help}`}
      data-testid={`tutor-confidence-badge-${bucket}`}
    >
      <Gauge className="w-3 h-3" />
      {meta.label}
      {pct !== null && <span className="opacity-70">· {pct}%</span>}
    </span>
  );
}

export function TutorExaminerInsightsReview() {
  const [status, setStatus] = useState<ReviewStatus>("pending");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [confidenceFilter, setConfidenceFilter] = useState<ConfidenceFilter>("all");
  const [sortMode, setSortMode] = useState<SortMode>("newest");
  const queryClient = useQueryClient();

  const counts = useQuery<Counts>({
    queryKey: ["/api/tutor/examiner-insights/counts"],
    queryFn: async () => {
      const res = await authFetch("/api/tutor/examiner-insights/counts");
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
    refetchInterval: 60_000,
  });

  const queue = useQuery<QueueListResult>({
    queryKey: ["/api/tutor/examiner-insights/queue", status],
    queryFn: async () => {
      const res = await authFetch(`/api/tutor/examiner-insights/queue?status=${status}&limit=100`);
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
  });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/tutor/examiner-insights/queue"] });
    queryClient.invalidateQueries({ queryKey: ["/api/tutor/examiner-insights/counts"] });
  };

  const visibleRows = useMemo(() => {
    const rows = queue.data?.rows ?? [];
    const filtered =
      confidenceFilter === "all"
        ? rows
        : rows.filter((r) => bucketForConfidence(r.confidencePct) === confidenceFilter);
    const sorted = [...filtered];
    if (sortMode === "newest") {
      sorted.sort((a, b) => (a.extractedAt < b.extractedAt ? 1 : -1));
    } else {
      const dir = sortMode === "confidence_desc" ? -1 : 1;
      sorted.sort((a, b) => {
        const aHas = a.confidencePct !== null;
        const bHas = b.confidencePct !== null;
        if (!aHas && !bHas) return 0;
        if (!aHas) return 1;
        if (!bHas) return -1;
        return ((a.confidencePct ?? 0) - (b.confidencePct ?? 0)) * dir;
      });
    }
    return sorted;
  }, [queue.data?.rows, confidenceFilter, sortMode]);

  const confidenceCounts = useMemo(() => {
    const rows = queue.data?.rows ?? [];
    const counts: Record<ConfidenceBucket, number> = { high: 0, medium: 0, low: 0, unknown: 0 };
    for (const r of rows) counts[bucketForConfidence(r.confidencePct)]++;
    return counts;
  }, [queue.data?.rows]);

  const approve = useMutation({
    mutationFn: async ({ id }: { id: number }) => {
      const res = await authFetch(`/api/tutor/examiner-insights/${id}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) throw new Error("Approve failed");
      return res.json();
    },
    onSuccess: refresh,
  });

  const reject = useMutation({
    mutationFn: async ({ id }: { id: number }) => {
      const res = await authFetch(`/api/tutor/examiner-insights/${id}/reject`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) throw new Error("Reject failed");
      return res.json();
    },
    onSuccess: refresh,
  });

  const update = useMutation({
    mutationFn: async ({ id, patch }: { id: number; patch: Record<string, unknown> }) => {
      const res = await authFetch(`/api/tutor/examiner-insights/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error("Update failed");
      return res.json();
    },
    onSuccess: () => {
      setEditingId(null);
      refresh();
    },
  });

  const busy = approve.isPending || reject.isPending || update.isPending;

  return (
    <section className="space-y-5" data-testid="tutor-insights-review">
      {/* Hero — friendly framing so tutors aren't intimidated */}
      <div className="bg-gradient-to-br from-violet-500/10 to-amber-500/5 border border-violet-500/20 rounded-2xl p-5">
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded-xl bg-violet-500/20 border border-violet-500/30 flex items-center justify-center shrink-0">
            <Lightbulb className="w-5 h-5 text-violet-300" />
          </div>
          <div className="flex-1">
            <h2 className="text-base font-semibold text-foreground">Examiner mistakes — yours to check</h2>
            <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
              When SOMA reads a Cambridge examiner report, it pulls out common student mistakes for you. Approve the ones that look right and they'll be used to write better quiz distractors and feedback for your students. Skip or reject anything that doesn't ring true.
            </p>
          </div>
          <button
            onClick={refresh}
            className="text-xs px-3 py-1.5 rounded-lg bg-foreground/[0.04] border border-border/60 hover:bg-foreground/[0.08] text-muted-foreground hover:text-foreground flex items-center gap-1.5 shrink-0"
            data-testid="button-refresh-tutor-insights"
          >
            <RefreshCcw className="w-3 h-3" /> Refresh
          </button>
        </div>
      </div>

      {/* Status pills */}
      <div className="grid grid-cols-3 gap-2">
        {TABS.map((t) => {
          const n = counts.data ? counts.data[t.key] : 0;
          const active = status === t.key;
          return (
            <button
              key={t.key}
              onClick={() => setStatus(t.key)}
              className={`rounded-xl px-4 py-3 border text-left transition ${
                active
                  ? "bg-violet-500/15 border-violet-500/30 shadow-sm"
                  : "bg-foreground/[0.02] border-border/50 hover:bg-foreground/[0.04]"
              }`}
              data-testid={`tutor-status-pill-${t.key}`}
            >
              <p className={`text-[10px] uppercase tracking-wider ${active ? "text-violet-300" : "text-muted-foreground"}`}>{t.label}</p>
              <p className="text-2xl font-bold mt-0.5">{counts.data ? n : "—"}</p>
            </button>
          );
        })}
      </div>

      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div className="flex items-end gap-3 flex-wrap">
          <label className="block">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">How sure is SOMA?</span>
            <select
              value={confidenceFilter}
              onChange={(e) => setConfidenceFilter(e.target.value as ConfidenceFilter)}
              className="mt-1 block bg-foreground/[0.04] border border-border/60 rounded-lg text-xs px-2.5 py-1.5 text-foreground"
              data-testid="tutor-select-confidence-filter"
            >
              {CONFIDENCE_FILTERS.map((opt) => {
                const n = opt.key === "all" ? null : confidenceCounts[opt.key];
                return (
                  <option key={opt.key} value={opt.key}>
                    {opt.label}
                    {n !== null ? ` (${n})` : ""}
                  </option>
                );
              })}
            </select>
          </label>
          <label className="block">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Sort</span>
            <select
              value={sortMode}
              onChange={(e) => setSortMode(e.target.value as SortMode)}
              className="mt-1 block bg-foreground/[0.04] border border-border/60 rounded-lg text-xs px-2.5 py-1.5 text-foreground"
              data-testid="tutor-select-sort-mode"
            >
              {SORT_OPTIONS.map((opt) => (
                <option key={opt.key} value={opt.key}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="text-[11px] text-muted-foreground" data-testid="tutor-text-confidence-summary">
          Pretty sure {confidenceCounts.high} · Worth a look {confidenceCounts.medium} · Not sure {confidenceCounts.low}
          {confidenceCounts.unknown > 0 ? ` · Unknown ${confidenceCounts.unknown}` : ""}
        </div>
      </div>

      {queue.isLoading ? (
        <div className="flex justify-center py-16"><Loader2 className="w-6 h-6 text-violet-400 animate-spin" /></div>
      ) : queue.isError || !queue.data ? (
        <div className="bg-foreground/[0.02] border border-border/60 rounded-2xl text-center py-12 px-4">
          <AlertTriangle className="w-10 h-10 mx-auto text-amber-400 mb-3" />
          <p className="text-sm text-muted-foreground">Couldn't load the review queue. Try again.</p>
        </div>
      ) : queue.data.rows.length === 0 ? (
        <div className="bg-foreground/[0.02] border border-border/60 rounded-2xl text-center py-12 px-4">
          <ClipboardCheck className="w-10 h-10 mx-auto text-muted-foreground mb-3" />
          <p className="text-sm text-foreground font-medium">
            {status === "pending"
              ? "Nothing waiting on you right now."
              : status === "approved"
                ? "No approved insights yet for your syllabi."
                : "No rejected insights for your syllabi."}
          </p>
          {status === "pending" && (
            <p className="text-xs text-muted-foreground mt-1.5">
              You'll see items here once SOMA processes a new examiner report on a syllabus you've assigned.
            </p>
          )}
        </div>
      ) : visibleRows.length === 0 ? (
        <div className="bg-foreground/[0.02] border border-border/60 rounded-2xl text-center py-12 px-4">
          <ClipboardCheck className="w-10 h-10 mx-auto text-muted-foreground mb-3" />
          <p className="text-sm text-foreground font-medium">No insights match this confidence filter.</p>
          <button
            onClick={() => setConfidenceFilter("all")}
            className="mt-3 text-xs px-3 py-1.5 rounded-lg bg-foreground/[0.04] border border-border/60 hover:bg-foreground/[0.08]"
            data-testid="tutor-button-clear-confidence-filter"
          >
            Show all
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {visibleRows.map((row) => (
            <ReviewCard
              key={row.id}
              row={row}
              isEditing={editingId === row.id}
              onEdit={() => setEditingId(row.id)}
              onCancelEdit={() => setEditingId(null)}
              onSave={(patch) => update.mutate({ id: row.id, patch })}
              onApprove={() => approve.mutate({ id: row.id })}
              onReject={() => reject.mutate({ id: row.id })}
              busy={busy}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function ReviewCard({
  row,
  isEditing,
  onEdit,
  onCancelEdit,
  onSave,
  onApprove,
  onReject,
  busy,
}: {
  row: QueueRow;
  isEditing: boolean;
  onEdit: () => void;
  onCancelEdit: () => void;
  onSave: (patch: Record<string, unknown>) => void;
  onApprove: () => void;
  onReject: () => void;
  busy: boolean;
}) {
  const [misconception, setMisconception] = useState(row.misconception);
  const [studentError, setStudentError] = useState(row.studentError);
  const [correctApproach, setCorrectApproach] = useState(row.correctApproach);

  return (
    <article
      className="bg-foreground/[0.02] border border-border/60 rounded-2xl p-5"
      data-testid={`tutor-review-card-${row.id}`}
    >
      <div className="flex items-start justify-between gap-4 flex-wrap mb-3">
        <div className="flex items-center gap-2 flex-wrap text-xs">
          <span className={`px-2 py-0.5 rounded-full border text-[11px] ${FREQUENCY_BADGE[row.frequency] ?? FREQUENCY_BADGE.common}`}>
            {FREQUENCY_LABEL[row.frequency] ?? row.frequency}
          </span>
          <ConfidenceBadge pct={row.confidencePct} />
          <span className="flex items-center gap-1 text-muted-foreground">
            <BookOpen className="w-3 h-3" />
            {row.board} <code className="text-foreground/80">{row.syllabusCode}</code>
            {row.subject && <span>· {row.subject}</span>}
            {row.topic && <span>· {row.topic}</span>}
          </span>
        </div>
        {row.status === "pending" && !isEditing && (
          <div className="flex gap-2 flex-wrap">
            <button
              onClick={onEdit}
              disabled={busy}
              className="text-xs px-3 py-1.5 rounded-lg bg-foreground/[0.04] border border-border/60 hover:bg-foreground/[0.08] flex items-center gap-1 disabled:opacity-40"
              data-testid="tutor-button-edit"
            >
              <Pencil className="w-3 h-3" /> Edit
            </button>
            <button
              onClick={onApprove}
              disabled={busy}
              className="text-xs px-3 py-1.5 rounded-lg bg-emerald-500/15 border border-emerald-500/30 hover:bg-emerald-500/25 text-emerald-200 flex items-center gap-1 disabled:opacity-40"
              data-testid="tutor-button-approve"
            >
              <CheckCircle2 className="w-3 h-3" /> Approve
            </button>
            <button
              onClick={onReject}
              disabled={busy}
              className="text-xs px-3 py-1.5 rounded-lg bg-foreground/[0.04] border border-border/60 hover:bg-rose-500/15 hover:border-rose-500/30 hover:text-rose-200 flex items-center gap-1 disabled:opacity-40"
              data-testid="tutor-button-reject"
            >
              <XCircle className="w-3 h-3" /> Reject
            </button>
          </div>
        )}
      </div>

      {isEditing ? (
        <div className="space-y-3">
          <Field label="What's the misconception?">
            <textarea
              value={misconception}
              onChange={(e) => setMisconception(e.target.value)}
              rows={2}
              className="tutor-input"
            />
          </Field>
          <Field label="Typical wrong working">
            <textarea
              value={studentError}
              onChange={(e) => setStudentError(e.target.value)}
              rows={2}
              className="tutor-input"
            />
          </Field>
          <Field label="What students should do instead">
            <textarea
              value={correctApproach}
              onChange={(e) => setCorrectApproach(e.target.value)}
              rows={2}
              className="tutor-input"
            />
          </Field>
          <div className="flex gap-2">
            <button
              onClick={() => onSave({ misconception, studentError, correctApproach })}
              disabled={busy}
              className="text-xs px-3 py-1.5 rounded-lg bg-emerald-500/15 border border-emerald-500/30 hover:bg-emerald-500/25 text-emerald-200 flex items-center gap-1 disabled:opacity-40"
              data-testid="tutor-button-save-edit"
            >
              <Save className="w-3 h-3" /> Save changes
            </button>
            <button
              onClick={onCancelEdit}
              className="text-xs px-3 py-1.5 rounded-lg bg-foreground/[0.04] border border-border/60 hover:bg-foreground/[0.08] flex items-center gap-1"
              data-testid="tutor-button-cancel-edit"
            >
              <X className="w-3 h-3" /> Cancel
            </button>
          </div>
          <style>{`
            .tutor-input {
              width: 100%;
              background: rgba(0,0,0,0.15);
              border: 1px solid rgba(255,255,255,0.08);
              border-radius: 0.5rem;
              padding: 0.5rem 0.75rem;
              font-size: 0.85rem;
              color: inherit;
            }
            .tutor-input:focus { outline: none; border-color: rgba(139, 92, 246, 0.4); }
          `}</style>
        </div>
      ) : (
        <div className="space-y-3 text-sm">
          <p className="text-foreground font-medium leading-relaxed">{row.misconception}</p>
          <div className="grid md:grid-cols-2 gap-3">
            <CardField label="Typical wrong working">{row.studentError || "—"}</CardField>
            <CardField label="What students should do">{row.correctApproach || "—"}</CardField>
          </div>
          {row.sourceQuote && (
            <details className="group">
              <summary className="text-[11px] text-muted-foreground cursor-pointer hover:text-foreground/80 flex items-center gap-1">
                <span className="select-none">▸</span> See the examiner's exact words{row.sourcePage ? ` (≈ p.${row.sourcePage})` : ""}
              </summary>
              <div className="mt-2 bg-foreground/[0.03] border border-border/40 rounded-lg px-3 py-2">
                <p className="text-xs italic text-muted-foreground leading-relaxed">"{row.sourceQuote}"</p>
              </div>
            </details>
          )}
          {row.status !== "pending" && (
            <div className="text-[11px] text-muted-foreground pt-1 border-t border-border/40">
              {row.status === "approved" ? "Approved" : "Rejected"}
              {row.reviewedByDisplayName ? ` by ${row.reviewedByDisplayName}` : ""}
              {row.reviewedAt ? ` · ${new Date(row.reviewedAt).toLocaleDateString()}` : ""}
            </div>
          )}
        </div>
      )}
    </article>
  );
}

function CardField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">{label}</p>
      <p className="text-xs text-foreground/90 leading-relaxed">{children}</p>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</span>
      <div className="mt-1">{children}</div>
    </label>
  );
}
