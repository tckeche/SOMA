import { useState } from "react";
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

interface Counts {
  pending: number;
  approved: number;
  rejected: number;
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

export function SuperAdminExaminerInsightsReview() {
  const [status, setStatus] = useState<ReviewStatus>("pending");
  const [editingId, setEditingId] = useState<number | null>(null);
  const queryClient = useQueryClient();

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
    queryKey: ["/api/super-admin/examiner-insights/queue", status],
    queryFn: async () => {
      const res = await authFetch(`/api/super-admin/examiner-insights/queue?status=${status}&limit=100`);
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
  });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/super-admin/examiner-insights/queue"] });
    queryClient.invalidateQueries({ queryKey: ["/api/super-admin/examiner-insights/counts"] });
  };

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
          </button>
        ))}
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
      ) : (
        <div className="space-y-3">
          {queue.data.rows.map((row) => (
            <ReviewRow
              key={row.id}
              row={row}
              isEditing={editingId === row.id}
              onEdit={() => setEditingId(row.id)}
              onCancelEdit={() => setEditingId(null)}
              onSave={(patch) => update.mutate({ id: row.id, patch })}
              onApprove={() => approve.mutate({ id: row.id })}
              onReject={() => reject.mutate({ id: row.id })}
              busy={approve.isPending || reject.isPending || update.isPending}
            />
          ))}
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
  const [topic, setTopic] = useState(row.topic);
  const [subtopic, setSubtopic] = useState(row.subtopic ?? "");

  return (
    <article className={CARD} data-testid={`review-row-${row.id}`}>
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex-1 min-w-[250px]">
          <div className="flex items-center gap-2 flex-wrap text-xs">
            <span className={`px-2 py-0.5 rounded-full border ${FREQUENCY_BADGE[row.frequency] ?? FREQUENCY_BADGE.common}`}>
              {row.frequency.replace("_", " ")}
            </span>
            <span className="text-muted-foreground">{row.board}</span>
            <span className="text-muted-foreground">·</span>
            <span className="text-foreground"><code>{row.syllabusCode}</code></span>
            {row.subject && <><span className="text-muted-foreground">·</span><span>{row.subject}</span></>}
            {row.confidencePct !== null && (
              <>
                <span className="text-muted-foreground">·</span>
                <span className="text-amber-300">{row.confidencePct}% confidence</span>
              </>
            )}
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
            <span>{row.subtopicTitle ? `Linked to: ${row.subtopicTitle}` : "Not linked to a catalogue subtopic"}</span>
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
