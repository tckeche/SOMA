import { useEffect, useMemo, useState } from "react";
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
  Quote,
  Zap,
  FileText,
  Gauge,
  CheckSquare,
  Link2,
  HelpCircle,
} from "lucide-react";

interface SubtopicOption {
  id: number;
  subtopicNumber: string;
  title: string;
  topicId: number;
  topicNumber: string;
  topicTitle: string;
}

interface SubtopicOptionsResult {
  insight: {
    id: number;
    board: string;
    syllabusCode: string;
    subject: string | null;
    topic: string;
    subtopic: string | null;
    subtopicId: number | null;
  };
  options: SubtopicOption[];
  suggestion: { id: number; title: string } | null;
}

type ReviewStatus = "pending" | "approved" | "rejected";

interface QueueRow {
  id: number;
  status: ReviewStatus;
  board: string;
  syllabusCode: string;
  subject: string | null;
  topic: string;
  subtopic: string | null;
  subtopicId: number | null;
  subtopicTitle: string | null;
  misconception: string;
  studentError: string;
  correctApproach: string;
  frequency: string;
  sourceQuote: string | null;
  sourcePage: number | null;
  confidencePct: number | null;
  reviewedAt: string | null;
  reviewedById: string | null;
  reviewedByDisplayName: string | null;
  reviewNotes: string | null;
  documentId: number;
  documentFilename: string | null;
  documentType: string | null;
  extractedAt: string;
}

interface QueueListResult {
  rows: QueueRow[];
  total: number;
}

interface ConfidenceBreakdown {
  high: number;
  medium: number;
  low: number;
  unknown: number;
}

interface Counts {
  pending: number;
  approved: number;
  rejected: number;
  byConfidence?: Record<ReviewStatus, ConfidenceBreakdown>;
  unmatched?: Record<ReviewStatus, number>;
}

const PILL_BUCKET_META: Array<{ key: keyof ConfidenceBreakdown; label: string; dot: string }> = [
  { key: "high", label: "High", dot: "bg-emerald-400" },
  { key: "medium", label: "Medium", dot: "bg-amber-400" },
  { key: "low", label: "Low", dot: "bg-rose-400" },
];

function PillConfidenceBreakdown({
  breakdown,
  statusKey,
}: {
  breakdown: ConfidenceBreakdown | undefined;
  statusKey: ReviewStatus;
}) {
  if (!breakdown) return null;
  const total = breakdown.high + breakdown.medium + breakdown.low + breakdown.unknown;
  if (total === 0) return null;
  const segments = [
    { key: "high" as const, value: breakdown.high, color: "bg-emerald-500/70" },
    { key: "medium" as const, value: breakdown.medium, color: "bg-amber-500/70" },
    { key: "low" as const, value: breakdown.low, color: "bg-rose-500/70" },
    { key: "unknown" as const, value: breakdown.unknown, color: "bg-muted-foreground/40" },
  ];
  const tooltip =
    `High ${breakdown.high} · Medium ${breakdown.medium} · Low ${breakdown.low}` +
    (breakdown.unknown > 0 ? ` · Unknown ${breakdown.unknown}` : "");
  return (
    <div className="mt-2 space-y-1.5" data-testid={`pill-confidence-breakdown-${statusKey}`}>
      <div className="flex h-1 rounded-full overflow-hidden bg-muted/30" title={tooltip}>
        {segments
          .filter((s) => s.value > 0)
          .map((s) => (
            <div
              key={s.key}
              className={s.color}
              style={{ flexGrow: s.value, flexBasis: 0 }}
              data-testid={`pill-confidence-segment-${statusKey}-${s.key}`}
            />
          ))}
      </div>
      <div className="flex items-center gap-2 text-[10px] text-muted-foreground flex-wrap">
        {PILL_BUCKET_META.map((b) => (
          <span
            key={b.key}
            className="inline-flex items-center gap-1"
            data-testid={`pill-confidence-count-${statusKey}-${b.key}`}
          >
            <span className={`inline-block w-1.5 h-1.5 rounded-full ${b.dot}`} />
            {b.label} {breakdown[b.key]}
          </span>
        ))}
        {breakdown.unknown > 0 && (
          <span
            className="inline-flex items-center gap-1"
            data-testid={`pill-confidence-count-${statusKey}-unknown`}
          >
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-muted-foreground/60" />
            ? {breakdown.unknown}
          </span>
        )}
      </div>
    </div>
  );
}

const CARD = "bg-card/80 backdrop-blur-md border border-card-border rounded-2xl p-6 shadow-2xl";

const FREQUENCY_BADGE: Record<string, string> = {
  very_common: "bg-red-500/20 text-red-300 border-red-500/40",
  common: "bg-amber-500/20 text-amber-300 border-amber-500/40",
  occasional: "bg-sky-500/20 text-sky-300 border-sky-500/40",
};

const STATUS_TABS: Array<{ key: ReviewStatus; label: string }> = [
  { key: "pending", label: "Pending" },
  { key: "approved", label: "Approved" },
  { key: "rejected", label: "Rejected" },
];

type ConfidenceBucket = "high" | "medium" | "low" | "unknown";
type ConfidenceFilter = "all" | ConfidenceBucket;
type SortMode = "newest" | "confidence_desc" | "confidence_asc";

function bucketForConfidence(pct: number | null): ConfidenceBucket {
  if (pct === null || pct === undefined) return "unknown";
  if (pct >= 80) return "high";
  if (pct >= 50) return "medium";
  return "low";
}

const CONFIDENCE_BADGE: Record<ConfidenceBucket, { className: string; label: string }> = {
  high: {
    className: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40",
    label: "High",
  },
  medium: {
    className: "bg-amber-500/15 text-amber-300 border-amber-500/40",
    label: "Medium",
  },
  low: {
    className: "bg-rose-500/15 text-rose-300 border-rose-500/40",
    label: "Low",
  },
  unknown: {
    className: "bg-muted/30 text-muted-foreground border-border/50",
    label: "—",
  },
};

const CONFIDENCE_FILTERS: Array<{ key: ConfidenceFilter; label: string }> = [
  { key: "all", label: "All confidence" },
  { key: "high", label: "High (≥ 80%)" },
  { key: "medium", label: "Medium (50–79%)" },
  { key: "low", label: "Low (< 50%)" },
  { key: "unknown", label: "Unknown" },
];

const SORT_OPTIONS: Array<{ key: SortMode; label: string }> = [
  { key: "newest", label: "Newest first" },
  { key: "confidence_desc", label: "Confidence: high → low" },
  { key: "confidence_asc", label: "Confidence: low → high" },
];

function ConfidenceBadge({ pct }: { pct: number | null }) {
  const bucket = bucketForConfidence(pct);
  const meta = CONFIDENCE_BADGE[bucket];
  return (
    <span
      className={`px-2 py-0.5 rounded-full border text-[11px] inline-flex items-center gap-1 ${meta.className}`}
      title={pct === null ? "Confidence not reported" : `${pct}% confidence (${meta.label})`}
      data-testid={`confidence-badge-${bucket}`}
    >
      <Gauge className="w-3 h-3" />
      {pct === null ? "?" : `${pct}%`}
      <span className="opacity-70">· {meta.label}</span>
    </span>
  );
}

export function SuperAdminExaminerInsightsReview() {
  const [status, setStatus] = useState<ReviewStatus>("pending");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [confidenceFilter, setConfidenceFilter] = useState<ConfidenceFilter>("all");
  const [unmatchedOnly, setUnmatchedOnly] = useState(false);
  const [sortMode, setSortMode] = useState<SortMode>("newest");
  const [selectedIds, setSelectedIds] = useState<Set<number>>(() => new Set());
  const queryClient = useQueryClient();

  // Selection only makes sense on the pending tab; any other tab clears it.
  useEffect(() => {
    if (status !== "pending") setSelectedIds(new Set());
  }, [status]);

  const counts = useQuery<Counts>({
    queryKey: ["/api/super-admin/examiner-insights/counts"],
    queryFn: async () => {
      const res = await authFetch("/api/super-admin/examiner-insights/counts");
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
    refetchInterval: 30_000,
  });

  const queue = useQuery<QueueListResult>({
    queryKey: ["/api/super-admin/examiner-insights/queue", status, unmatchedOnly],
    queryFn: async () => {
      const url = `/api/super-admin/examiner-insights/queue?status=${status}&limit=100${unmatchedOnly ? "&unmatchedOnly=1" : ""}`;
      const res = await authFetch(url);
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
  });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/super-admin/examiner-insights/queue"] });
    queryClient.invalidateQueries({ queryKey: ["/api/super-admin/examiner-insights/counts"] });
  };

  const toggleSelected = (id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const clearSelection = () => setSelectedIds(new Set());

  // Note: `unmatchedOnly` is applied server-side (it's part of the queue
  // query key and request URL), so the rows already arrive pre-filtered.
  // We only layer the client-side confidence filter and sort on top.
  const visibleRows = useMemo(() => {
    const rows = queue.data?.rows ?? [];
    let filtered = rows;
    if (confidenceFilter !== "all") {
      filtered = filtered.filter((r) => bucketForConfidence(r.confidencePct) === confidenceFilter);
    }
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

  // Server count is canonical (whole status). When the older counts
  // payload is cached without `unmatched`, fall back to the loaded
  // row count when the toggle is on (every row is unmatched in that
  // case because the server pre-filters), else 0.
  const unmatchedCount =
    counts.data?.unmatched?.[status]
    ?? (unmatchedOnly ? queue.data?.rows.length ?? 0 : 0);

  const approve = useMutation({
    mutationFn: async ({ id, notes }: { id: number; notes?: string }) => {
      const res = await authFetch(`/api/super-admin/examiner-insights/${id}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notes: notes ?? null }),
      });
      if (!res.ok) throw new Error("Approve failed");
      return res.json();
    },
    onSuccess: refresh,
  });

  const reject = useMutation({
    mutationFn: async ({ id, notes }: { id: number; notes?: string }) => {
      const res = await authFetch(`/api/super-admin/examiner-insights/${id}/reject`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notes: notes ?? null }),
      });
      if (!res.ok) throw new Error("Reject failed");
      return res.json();
    },
    onSuccess: refresh,
  });

  const update = useMutation({
    mutationFn: async ({ id, patch }: { id: number; patch: Record<string, unknown> }) => {
      const res = await authFetch(`/api/super-admin/examiner-insights/${id}`, {
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

  const bulkApprove = useMutation({
    mutationFn: async () => {
      const res = await authFetch(`/api/super-admin/examiner-insights/bulk-approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ minConfidence: 90 }),
      });
      if (!res.ok) throw new Error("Bulk approve failed");
      return res.json() as Promise<{ approved: number }>;
    },
    onSuccess: refresh,
  });

  const bulkAction = useMutation({
    mutationFn: async ({ action, ids }: { action: "approve" | "reject"; ids: number[] }) => {
      const res = await authFetch(`/api/super-admin/examiner-insights/bulk-action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ids }),
      });
      if (!res.ok) throw new Error("Bulk action failed");
      return res.json() as Promise<{ updated: number }>;
    },
    onSuccess: () => {
      clearSelection();
      refresh();
    },
  });

  return (
    <section className="space-y-6" data-testid="examiner-insights-review">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-lg font-semibold text-foreground flex items-center gap-2">
            <ClipboardCheck className="w-4 h-4 text-amber-400" /> Examiner Insight Review Queue
          </h2>
          <p className="text-xs text-muted-foreground">
            AI-extracted misconceptions land here as <code className="text-foreground/80">pending</code>. Approve to make
            them visible to tutors and students; reject to hide. Source quote + page show the evidence behind every item.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => bulkApprove.mutate()}
            disabled={bulkApprove.isPending || (counts.data?.pending ?? 0) === 0}
            className="text-xs px-3 py-2 rounded-lg bg-emerald-500/15 border border-emerald-500/30 hover:bg-emerald-500/25 text-emerald-200 flex items-center gap-2 disabled:opacity-40"
            data-testid="button-bulk-approve"
          >
            <Zap className="w-3.5 h-3.5" /> Bulk approve ≥ 90% confidence
            {bulkApprove.isPending && <Loader2 className="w-3 h-3 animate-spin" />}
          </button>
          <button
            onClick={refresh}
            className="text-xs px-3 py-2 rounded-lg bg-muted/40 border border-border/50 hover:bg-muted/60 flex items-center gap-2"
            data-testid="button-refresh-insights"
          >
            <RefreshCcw className="w-3.5 h-3.5" /> Refresh
          </button>
        </div>
      </div>

      {bulkApprove.data && (
        <div className="text-xs text-emerald-300 bg-emerald-500/10 border border-emerald-500/30 rounded-lg px-3 py-2">
          Approved {bulkApprove.data.approved} insight(s).
        </div>
      )}

      <div className="grid grid-cols-3 gap-3">
        {STATUS_TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setStatus(t.key)}
            className={`${CARD} text-left transition ${status === t.key ? "border-red-500/40 bg-red-500/10" : "hover:border-border/80"}`}
            data-testid={`status-pill-${t.key}`}
          >
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{t.label}</p>
            <p className="text-2xl font-bold mt-1">{counts.data ? counts.data[t.key] : "—"}</p>
            {t.key === "pending" && (
              <PillConfidenceBreakdown breakdown={counts.data?.byConfidence?.[t.key]} statusKey={t.key} />
            )}
          </button>
        ))}
      </div>

      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div className="flex items-end gap-3 flex-wrap">
          <label className="block">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Filter by confidence</span>
            <select
              value={confidenceFilter}
              onChange={(e) => setConfidenceFilter(e.target.value as ConfidenceFilter)}
              className="mt-1 block bg-card/60 border border-border/60 rounded-lg text-xs px-2.5 py-1.5 text-foreground"
              data-testid="select-confidence-filter"
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
              className="mt-1 block bg-card/60 border border-border/60 rounded-lg text-xs px-2.5 py-1.5 text-foreground"
              data-testid="select-sort-mode"
            >
              {SORT_OPTIONS.map((opt) => (
                <option key={opt.key} value={opt.key}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={() => setUnmatchedOnly((v) => !v)}
            aria-pressed={unmatchedOnly}
            className={`mt-[18px] inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg border transition ${
              unmatchedOnly
                ? "bg-amber-500/20 border-amber-500/40 text-amber-200"
                : "bg-card/60 border-border/60 text-muted-foreground hover:bg-muted/40 hover:text-foreground"
            }`}
            title="Only show rows whose subtopic text couldn't be auto-mapped to a canonical subtopic."
            data-testid="button-toggle-unmatched-only"
          >
            <Link2 className="w-3.5 h-3.5" />
            Show only unmatched
            <span className="opacity-70">({unmatchedCount})</span>
          </button>
        </div>
        <div className="text-[11px] text-muted-foreground" data-testid="text-confidence-summary">
          High {confidenceCounts.high} · Medium {confidenceCounts.medium} · Low {confidenceCounts.low}
          {confidenceCounts.unknown > 0 ? ` · Unknown ${confidenceCounts.unknown}` : ""}
        </div>
      </div>

      {queue.isLoading ? (
        <div className="flex justify-center py-16"><Loader2 className="w-6 h-6 text-amber-400 animate-spin" /></div>
      ) : queue.isError || !queue.data ? (
        <div className={`${CARD} text-center py-12`}>
          <AlertTriangle className="w-12 h-12 mx-auto text-amber-400 mb-4" />
          <p className="text-sm text-muted-foreground">Failed to load review queue.</p>
        </div>
      ) : queue.data.rows.length === 0 ? (
        <div className={`${CARD} text-center py-12`}>
          <ClipboardCheck className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
          <p className="text-sm text-muted-foreground">No {status} insights right now.</p>
        </div>
      ) : visibleRows.length === 0 ? (
        <div className={`${CARD} text-center py-12`}>
          <ClipboardCheck className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
          <p className="text-sm text-muted-foreground" data-testid="text-empty-filtered">
            {unmatchedOnly && confidenceFilter !== "all"
              ? `No unmatched insights match the current confidence filter (${unmatchedCount} unmatched in ${status}).`
              : unmatchedOnly
                ? `No unmatched insights in ${status}.`
                : "No insights match the current confidence filter."}
          </p>
          <div className="mt-3 flex items-center justify-center gap-2">
            {confidenceFilter !== "all" && (
              <button
                onClick={() => setConfidenceFilter("all")}
                className="text-xs px-3 py-1.5 rounded-lg bg-muted/40 border border-border/50 hover:bg-muted/60"
                data-testid="button-clear-confidence-filter"
              >
                Clear confidence filter
              </button>
            )}
            {unmatchedOnly && (
              <button
                onClick={() => setUnmatchedOnly(false)}
                className="text-xs px-3 py-1.5 rounded-lg bg-muted/40 border border-border/50 hover:bg-muted/60"
                data-testid="button-clear-unmatched-filter"
              >
                Show all subtopic states
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="space-y-3 pb-24">
          {visibleRows.map((row) => (
            <ReviewRow
              key={row.id}
              row={row}
              isEditing={editingId === row.id}
              onEdit={() => setEditingId(row.id)}
              onCancelEdit={() => setEditingId(null)}
              onSave={(patch) => update.mutate({ id: row.id, patch })}
              onApprove={() => approve.mutate({ id: row.id })}
              onReject={() => reject.mutate({ id: row.id })}
              busy={approve.isPending || reject.isPending || update.isPending || bulkAction.isPending}
              selectable={status === "pending"}
              isSelected={selectedIds.has(row.id)}
              onToggleSelect={() => toggleSelected(row.id)}
            />
          ))}
        </div>
      )}

      {selectedIds.size > 0 && (
        <div
          className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 bg-card/95 backdrop-blur-md border border-card-border rounded-2xl shadow-2xl px-4 py-3 flex items-center gap-3 flex-wrap"
          data-testid="bulk-action-bar"
        >
          <span className="text-xs text-muted-foreground inline-flex items-center gap-1.5">
            <CheckSquare className="w-3.5 h-3.5 text-emerald-300" />
            <span data-testid="text-bulk-selection-count">
              {selectedIds.size} selected
            </span>
          </span>
          <button
            onClick={() => bulkAction.mutate({ action: "approve", ids: Array.from(selectedIds) })}
            disabled={bulkAction.isPending}
            className="text-xs px-3 py-1.5 rounded-lg bg-emerald-500/15 border border-emerald-500/30 hover:bg-emerald-500/25 text-emerald-200 flex items-center gap-1 disabled:opacity-40"
            data-testid="button-bulk-action-approve"
          >
            <CheckCircle2 className="w-3 h-3" /> Approve {selectedIds.size}
            {bulkAction.isPending && bulkAction.variables?.action === "approve" && (
              <Loader2 className="w-3 h-3 animate-spin" />
            )}
          </button>
          <button
            onClick={() => bulkAction.mutate({ action: "reject", ids: Array.from(selectedIds) })}
            disabled={bulkAction.isPending}
            className="text-xs px-3 py-1.5 rounded-lg bg-red-500/15 border border-red-500/30 hover:bg-red-500/25 text-red-200 flex items-center gap-1 disabled:opacity-40"
            data-testid="button-bulk-action-reject"
          >
            <XCircle className="w-3 h-3" /> Reject {selectedIds.size}
            {bulkAction.isPending && bulkAction.variables?.action === "reject" && (
              <Loader2 className="w-3 h-3 animate-spin" />
            )}
          </button>
          <button
            onClick={clearSelection}
            disabled={bulkAction.isPending}
            className="text-xs px-2 py-1.5 rounded-lg bg-muted/40 border border-border/50 hover:bg-muted/60 text-muted-foreground flex items-center gap-1 disabled:opacity-40"
            data-testid="button-bulk-clear-selection"
          >
            <X className="w-3 h-3" /> Clear
          </button>
        </div>
      )}
    </section>
  );
}

function ReviewRow({
  row,
  isEditing,
  onEdit,
  onCancelEdit,
  onSave,
  onApprove,
  onReject,
  busy,
  selectable,
  isSelected,
  onToggleSelect,
}: {
  row: QueueRow;
  isEditing: boolean;
  onEdit: () => void;
  onCancelEdit: () => void;
  onSave: (patch: Record<string, unknown>) => void;
  onApprove: () => void;
  onReject: () => void;
  busy: boolean;
  selectable: boolean;
  isSelected: boolean;
  onToggleSelect: () => void;
}) {
  const [misconception, setMisconception] = useState(row.misconception);
  const [studentError, setStudentError] = useState(row.studentError);
  const [correctApproach, setCorrectApproach] = useState(row.correctApproach);
  const [topic, setTopic] = useState(row.topic);
  const [subtopic, setSubtopic] = useState(row.subtopic ?? "");

  return (
    <article
      className={`${CARD} ${isSelected ? "ring-2 ring-emerald-500/40 border-emerald-500/40" : ""}`}
      data-testid={`review-row-${row.id}`}
    >
      <div className="flex items-start justify-between gap-4 flex-wrap">
        {selectable && !isEditing && (
          <label className="flex items-center pt-1 cursor-pointer select-none shrink-0">
            <input
              type="checkbox"
              checked={isSelected}
              onChange={onToggleSelect}
              disabled={busy}
              className="w-4 h-4 rounded accent-emerald-500 cursor-pointer disabled:cursor-not-allowed disabled:opacity-40"
              data-testid={`checkbox-select-${row.id}`}
              aria-label={`Select insight ${row.id}`}
            />
          </label>
        )}
        <div className="flex-1 min-w-[250px]">
          <div className="flex items-center gap-2 flex-wrap text-xs">
            <span className={`px-2 py-0.5 rounded-full border ${FREQUENCY_BADGE[row.frequency] ?? FREQUENCY_BADGE.common}`}>
              {row.frequency.replace("_", " ")}
            </span>
            <ConfidenceBadge pct={row.confidencePct} />
            <span className="text-muted-foreground">{row.board}</span>
            <span className="text-muted-foreground">·</span>
            <span className="text-foreground"><code>{row.syllabusCode}</code></span>
            {row.subject && <><span className="text-muted-foreground">·</span><span>{row.subject}</span></>}
            {row.sourcePage !== null && (
              <>
                <span className="text-muted-foreground">·</span>
                <span className="text-muted-foreground">≈ p.{row.sourcePage}</span>
              </>
            )}
          </div>
          <div className="mt-2 text-xs text-muted-foreground flex items-center gap-2 flex-wrap">
            <FileText className="w-3 h-3" />
            <span>{row.documentFilename ?? `Document ${row.documentId}`}</span>
            <span>·</span>
            <SubtopicLinkBadge row={row} />
          </div>
        </div>

        {!isEditing && row.status === "pending" && (
          <div className="flex gap-2 flex-wrap">
            <button
              onClick={onEdit}
              disabled={busy}
              className="text-xs px-3 py-1.5 rounded-lg bg-muted/40 border border-border/50 hover:bg-muted/60 flex items-center gap-1 disabled:opacity-40"
              data-testid="button-edit"
            >
              <Pencil className="w-3 h-3" /> Edit
            </button>
            <button
              onClick={onApprove}
              disabled={busy}
              className="text-xs px-3 py-1.5 rounded-lg bg-emerald-500/15 border border-emerald-500/30 hover:bg-emerald-500/25 text-emerald-200 flex items-center gap-1 disabled:opacity-40"
              data-testid="button-approve"
            >
              <CheckCircle2 className="w-3 h-3" /> Approve
            </button>
            <button
              onClick={onReject}
              disabled={busy}
              className="text-xs px-3 py-1.5 rounded-lg bg-red-500/15 border border-red-500/30 hover:bg-red-500/25 text-red-200 flex items-center gap-1 disabled:opacity-40"
              data-testid="button-reject"
            >
              <XCircle className="w-3 h-3" /> Reject
            </button>
          </div>
        )}
      </div>

      {isEditing ? (
        <div className="mt-4 space-y-3">
          <Field label="Topic">
            <input value={topic} onChange={(e) => setTopic(e.target.value)} className="input-field" />
          </Field>
          <Field label="Subtopic (free-text)">
            <input value={subtopic} onChange={(e) => setSubtopic(e.target.value)} className="input-field" />
          </Field>
          {((row.subtopic ?? "").trim() || row.subtopicId) ? (
            <SubtopicPickerInline
              row={row}
              onPick={(subtopicId) => onSave({ subtopicId })}
              busy={busy}
              testIdPrefix=""
            />
          ) : null}
          <Field label="Misconception">
            <textarea value={misconception} onChange={(e) => setMisconception(e.target.value)} rows={2} className="input-field font-medium" />
          </Field>
          <Field label="Student error">
            <textarea value={studentError} onChange={(e) => setStudentError(e.target.value)} rows={2} className="input-field" />
          </Field>
          <Field label="Correct approach">
            <textarea value={correctApproach} onChange={(e) => setCorrectApproach(e.target.value)} rows={2} className="input-field" />
          </Field>
          <div className="flex gap-2">
            <button
              onClick={() =>
                onSave({
                  topic,
                  subtopic: subtopic.trim() ? subtopic : null,
                  misconception,
                  studentError,
                  correctApproach,
                })
              }
              disabled={busy}
              className="text-xs px-3 py-1.5 rounded-lg bg-emerald-500/15 border border-emerald-500/30 hover:bg-emerald-500/25 text-emerald-200 flex items-center gap-1 disabled:opacity-40"
              data-testid="button-save-edit"
            >
              <Save className="w-3 h-3" /> Save edits
            </button>
            <button
              onClick={onCancelEdit}
              className="text-xs px-3 py-1.5 rounded-lg bg-muted/40 border border-border/50 hover:bg-muted/60 flex items-center gap-1"
              data-testid="button-cancel-edit"
            >
              <X className="w-3 h-3" /> Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-4 space-y-3 text-sm">
          <div>
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Misconception</p>
            <p className="text-foreground font-medium">{row.misconception}</p>
          </div>
          <div className="grid md:grid-cols-2 gap-3">
            <div>
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Student error</p>
              <p className="text-foreground/90 text-xs">{row.studentError || "—"}</p>
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Correct approach</p>
              <p className="text-foreground/90 text-xs">{row.correctApproach || "—"}</p>
            </div>
          </div>
          {row.sourceQuote && (
            <div className="bg-muted/30 border border-border/50 rounded-lg px-3 py-2 flex gap-2">
              <Quote className="w-3.5 h-3.5 text-muted-foreground shrink-0 mt-0.5" />
              <p className="text-xs text-muted-foreground italic">{row.sourceQuote}</p>
            </div>
          )}
          {row.status !== "pending" && (
            <div className="text-[11px] text-muted-foreground">
              {row.status === "approved" ? "Approved" : "Rejected"}
              {row.reviewedByDisplayName ? ` by ${row.reviewedByDisplayName}` : ""}
              {row.reviewedAt ? ` on ${new Date(row.reviewedAt).toLocaleString()}` : ""}
              {row.reviewNotes && <> — <span className="italic">{row.reviewNotes}</span></>}
            </div>
          )}
        </div>
      )}
    </article>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</span>
      <div className="mt-1">{children}</div>
      <style>{`
        .input-field {
          width: 100%;
          background: rgba(0,0,0,0.2);
          border: 1px solid rgba(255,255,255,0.1);
          border-radius: 0.5rem;
          padding: 0.5rem 0.75rem;
          font-size: 0.8rem;
          color: inherit;
        }
        .input-field:focus { outline: none; border-color: rgba(239, 68, 68, 0.4); }
      `}</style>
    </label>
  );
}

/**
 * Three-state subtopic-link badge:
 *  - Linked to a canonical subtopic (green-ish "Linked to: …")
 *  - Free-text subtopic exists but couldn't be auto-mapped (amber
 *    "Unmatched" badge so reviewers can fix orphans during their pass)
 *  - No free-text subtopic at all (existing muted "Not linked" state)
 */
function SubtopicLinkBadge({ row }: { row: QueueRow }) {
  if (row.subtopicId && row.subtopicTitle) {
    return (
      <span className="inline-flex items-center gap-1" data-testid={`subtopic-link-badge-linked-${row.id}`}>
        <Link2 className="w-3 h-3 text-emerald-400" />
        Linked to: <span className="text-foreground/80">{row.subtopicTitle}</span>
      </span>
    );
  }
  if ((row.subtopic ?? "").trim()) {
    return (
      <span
        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full border border-amber-500/40 bg-amber-500/15 text-amber-200"
        title={`Free-text subtopic "${row.subtopic}" couldn't be auto-mapped to the catalogue. Edit this row to pick the right one.`}
        data-testid={`subtopic-link-badge-unmatched-${row.id}`}
      >
        <AlertTriangle className="w-3 h-3" />
        Unmatched: <span className="font-medium">{row.subtopic}</span> — pick a subtopic
      </span>
    );
  }
  return (
    <span data-testid={`subtopic-link-badge-empty-${row.id}`}>Not linked to a catalogue subtopic</span>
  );
}

/**
 * Inline picker rendered inside the edit form. Lazy-loads the subtopic
 * catalogue for the row's syllabus on mount, surfaces the resolver's
 * best guess, and saves via the existing PATCH endpoint with
 * `subtopicId`.
 */
function SubtopicPickerInline({
  row,
  onPick,
  busy,
  testIdPrefix,
}: {
  row: QueueRow;
  onPick: (subtopicId: number | null) => void;
  busy: boolean;
  testIdPrefix: string;
}) {
  const [selectedId, setSelectedId] = useState<number | "">(row.subtopicId ?? "");
  const options = useQuery<SubtopicOptionsResult>({
    queryKey: ["/api/super-admin/examiner-insights", row.id, "subtopic-options"],
    queryFn: async () => {
      const res = await authFetch(`/api/super-admin/examiner-insights/${row.id}/subtopic-options`);
      if (!res.ok) throw new Error("Failed to load subtopic options");
      return res.json();
    },
  });

  const grouped = useMemo(() => {
    const opts = options.data?.options ?? [];
    const map = new Map<number, { topicTitle: string; topicNumber: string; items: SubtopicOption[] }>();
    for (const o of opts) {
      const g = map.get(o.topicId) ?? { topicTitle: o.topicTitle, topicNumber: o.topicNumber, items: [] };
      g.items.push(o);
      map.set(o.topicId, g);
    }
    return Array.from(map.values());
  }, [options.data]);

  const tid = (suffix: string) => `${testIdPrefix}${suffix}`;

  return (
    <div
      className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 space-y-2"
      data-testid={tid(`subtopic-picker-${row.id}`)}
    >
      <div className="flex items-start gap-2">
        <HelpCircle className="w-4 h-4 text-amber-300 shrink-0 mt-0.5" />
        <div className="flex-1 text-xs">
          <p className="text-amber-100 font-medium">Catalogue subtopic</p>
          <p className="text-muted-foreground mt-0.5">
            {row.subtopicId
              ? "This row is currently linked to a catalogue subtopic. Pick a different one to re-link."
              : (row.subtopic ?? "").trim()
                ? `Free-text "${row.subtopic}" couldn't be auto-mapped. Pick the right canonical subtopic so it shows up in tutor / student views.`
                : "Optional: link this row to a canonical subtopic from the syllabus catalogue."}
          </p>
        </div>
      </div>

      {options.isLoading ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="w-3 h-3 animate-spin" /> Loading catalogue…
        </div>
      ) : options.isError ? (
        <p className="text-xs text-rose-300">Couldn't load subtopic options.</p>
      ) : (options.data?.options.length ?? 0) === 0 ? (
        <p className="text-xs text-muted-foreground">
          No catalogue subtopics found for syllabus <code>{row.syllabusCode}</code>.
        </p>
      ) : (
        <>
          {options.data?.suggestion && (
            <div className="text-[11px] text-emerald-300 flex items-center gap-2 flex-wrap">
              Best guess: <span className="text-foreground/90 font-medium">{options.data.suggestion.title}</span>
              {options.data.suggestion.id !== selectedId && (
                <button
                  type="button"
                  onClick={() => setSelectedId(options.data!.suggestion!.id)}
                  className="px-2 py-0.5 rounded bg-emerald-500/15 border border-emerald-500/30 hover:bg-emerald-500/25 text-emerald-200"
                  data-testid={tid(`button-accept-suggestion-${row.id}`)}
                >
                  Use suggestion
                </button>
              )}
            </div>
          )}
          <div className="flex items-center gap-2 flex-wrap">
            <select
              value={selectedId === "" ? "" : String(selectedId)}
              onChange={(e) => setSelectedId(e.target.value === "" ? "" : Number(e.target.value))}
              className="flex-1 min-w-[200px] bg-black/20 border border-white/10 rounded-lg text-xs px-2.5 py-1.5 text-foreground"
              data-testid={tid(`select-subtopic-${row.id}`)}
            >
              <option value="">— Choose a subtopic —</option>
              {grouped.map((g) => (
                <optgroup key={g.topicNumber} label={`${g.topicNumber} ${g.topicTitle}`}>
                  {g.items.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.subtopicNumber} {o.title}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            <button
              type="button"
              onClick={() => onPick(selectedId === "" ? null : Number(selectedId))}
              disabled={busy || selectedId === "" || selectedId === row.subtopicId}
              className="text-xs px-3 py-1.5 rounded-lg bg-emerald-500/15 border border-emerald-500/30 hover:bg-emerald-500/25 text-emerald-200 flex items-center gap-1 disabled:opacity-40"
              data-testid={tid(`button-save-subtopic-${row.id}`)}
            >
              <Link2 className="w-3 h-3" /> Link subtopic
            </button>
            {row.subtopicId && (
              <button
                type="button"
                onClick={() => onPick(null)}
                disabled={busy}
                className="text-xs px-2 py-1.5 rounded-lg bg-muted/40 border border-border/50 hover:bg-muted/60 text-muted-foreground flex items-center gap-1 disabled:opacity-40"
                data-testid={tid(`button-unlink-subtopic-${row.id}`)}
              >
                <X className="w-3 h-3" /> Unlink
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
