import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { authFetch } from "@/lib/supabase";
import { Activity, AlertTriangle, Loader2, Zap, RefreshCcw, TrendingUp, Users, History } from "lucide-react";

interface DimensionRow {
  key: string;
  calls: number;
  successes: number;
  failures: number;
  validationFailures: number;
  parseFailures: number;
  fallbacks: number;
  cachedHits: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  failureRate: number;
}

interface ProviderHealth {
  provider: string;
  model: string;
  successes: number;
  failures: number;
  timeouts: number;
  parseFailures: number;
  validationFailures: number;
  inCooldown: boolean;
  avgLatencyMs: number;
  p95LatencyMs: number;
  successRate: number;
  failureRate: number;
}

interface UsageByUserRow {
  userId: string;
  email: string | null;
  displayName: string | null;
  role: string | null;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

interface UsageDailyRow {
  day: string;
  calls: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

interface UsageRecentRow {
  id: number;
  createdAt: string;
  provider: string;
  model: string;
  route: string | null;
  taskType: string | null;
  userId: string | null;
  email: string | null;
  displayName: string | null;
  role: string | null;
  costUsd: number | null;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  success: boolean;
  cached: boolean;
}

interface UsageHistorical {
  rangeStart: string;
  totals: { calls: number; costUsd: number; inputTokens: number; outputTokens: number };
  byTutor: UsageByUserRow[];
  byStudent: UsageByUserRow[];
  byDay: UsageDailyRow[];
  recent: UsageRecentRow[];
}

interface AIUsageReport {
  usage: {
    generatedAt: string;
    overall: DimensionRow;
    byProvider: DimensionRow[];
    byModel: DimensionRow[];
    byTaskType: DimensionRow[];
    byPromptVersion: DimensionRow[];
    byRoute: DimensionRow[];
    byUser: DimensionRow[];
  };
  historical: UsageHistorical;
  rangeDays: number;
  health: {
    backend: string;
    providers: ProviderHealth[];
  };
  guardrails: {
    maxTokensByTask: Record<string, number>;
  };
}

const CARD = "bg-card/80 backdrop-blur-md border border-card-border rounded-2xl p-6 shadow-2xl";

function formatUsd(n: number) {
  if (n < 0.01 && n > 0) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

function formatNum(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function userLabel(r: { displayName: string | null; email: string | null; userId: string }): string {
  return r.displayName || r.email || r.userId.slice(0, 8);
}

const RANGE_OPTIONS = [
  { label: "7d", days: 7 },
  { label: "30d", days: 30 },
  { label: "90d", days: 90 },
  { label: "365d", days: 365 },
];

export function SuperAdminAIUsage() {
  const [days, setDays] = useState(30);
  const { data, isLoading, isError, refetch, isFetching } = useQuery<AIUsageReport>({
    queryKey: ["/api/super-admin/ai-usage", days],
    queryFn: async () => {
      const res = await authFetch(`/api/super-admin/ai-usage?days=${days}`);
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
    refetchInterval: 30_000,
  });

  if (isLoading) {
    return <div className="flex justify-center py-16"><Loader2 className="w-6 h-6 text-red-500 animate-spin" /></div>;
  }
  if (isError || !data) {
    return (
      <div className={`${CARD} text-center py-12`}>
        <AlertTriangle className="w-12 h-12 mx-auto text-amber-400 mb-4" />
        <p className="text-sm text-muted-foreground">Failed to load AI usage metrics.</p>
      </div>
    );
  }

  const { overall } = data.usage;
  const hist = data.historical;
  return (
    <section className="space-y-6" data-testid="ai-usage-section">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-lg font-semibold text-foreground flex items-center gap-2">
            <Activity className="w-4 h-4 text-red-400" /> AI Usage & Cost
          </h2>
          <p className="text-xs text-muted-foreground">
            Live counters (current process) plus historical spend from <code className="text-foreground/80">ai_usage_logs</code>. Health backend: <code className="text-foreground/80">{data.health.backend}</code>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center bg-muted/30 rounded-lg p-1 border border-border/50">
            {RANGE_OPTIONS.map((opt) => (
              <button
                key={opt.days}
                onClick={() => setDays(opt.days)}
                className={`text-xs px-2.5 py-1 rounded-md transition ${days === opt.days ? "bg-red-500/20 text-red-300 font-semibold" : "text-muted-foreground hover:text-foreground"}`}
                data-testid={`button-range-${opt.days}`}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <button
            onClick={() => refetch()}
            className="text-xs px-3 py-2 rounded-lg bg-muted/40 border border-border/50 hover:bg-muted/60 flex items-center gap-2"
            data-testid="button-refresh-ai-usage"
          >
            <RefreshCcw className={`w-3.5 h-3.5 ${isFetching ? "animate-spin" : ""}`} /> Refresh
          </button>
        </div>
      </div>

      {/* Historical totals — these reflect saved spend over the selected window. */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <SummaryCard label={`Spend (last ${days}d)`} value={formatUsd(hist.totals.costUsd)} accent="#F59E0B" />
        <SummaryCard label={`Calls (last ${days}d)`} value={formatNum(hist.totals.calls)} />
        <SummaryCard
          label="Tokens in / out"
          value={`${formatNum(hist.totals.inputTokens)} / ${formatNum(hist.totals.outputTokens)}`}
        />
        <SummaryCard label="Live process p95" value={`${overall.p95LatencyMs}ms`} />
      </div>

      {/* Daily spend */}
      <div className={CARD}>
        <h3 className="text-sm font-semibold text-foreground flex items-center gap-2 mb-3">
          <TrendingUp className="w-4 h-4 text-emerald-400" /> Daily spend
        </h3>
        {hist.byDay.length === 0 ? (
          <p className="text-xs text-muted-foreground">No spend recorded in this window.</p>
        ) : (
          <DailySpendChart rows={hist.byDay} />
        )}
      </div>

      {/* People who are spending */}
      <div className="grid md:grid-cols-2 gap-4">
        <PeopleCard
          title="Spend by tutor / super-admin"
          icon={<Users className="w-4 h-4 text-sky-400" />}
          rows={hist.byTutor}
          emptyHint="No tutor spend in this window."
        />
        <PeopleCard
          title="Spend by student"
          icon={<Users className="w-4 h-4 text-violet-400" />}
          rows={hist.byStudent}
          emptyHint="No student-attributed spend in this window."
        />
      </div>

      {/* Recent calls */}
      <div className={CARD}>
        <h3 className="text-sm font-semibold text-foreground flex items-center gap-2 mb-3">
          <History className="w-4 h-4 text-amber-400" /> Recent AI calls (latest 50)
        </h3>
        {hist.recent.length === 0 ? (
          <p className="text-xs text-muted-foreground">No persisted AI calls yet — once any AI call runs, rows will appear here.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-muted-foreground border-b border-card-border">
                <tr>
                  <th className="text-left px-2 py-1.5">When</th>
                  <th className="text-left px-2 py-1.5">User</th>
                  <th className="text-left px-2 py-1.5">Role</th>
                  <th className="text-left px-2 py-1.5">Route</th>
                  <th className="text-left px-2 py-1.5">Model</th>
                  <th className="text-right px-2 py-1.5">Tokens</th>
                  <th className="text-right px-2 py-1.5">Cost</th>
                  <th className="text-right px-2 py-1.5">Latency</th>
                  <th className="text-right px-2 py-1.5">Status</th>
                </tr>
              </thead>
              <tbody>
                {hist.recent.map((r) => (
                  <tr key={r.id} className="border-b border-card-border/60">
                    <td className="px-2 py-1.5 text-muted-foreground whitespace-nowrap">{new Date(r.createdAt).toLocaleString()}</td>
                    <td className="px-2 py-1.5 text-foreground">{r.displayName ?? r.email ?? (r.userId ? r.userId.slice(0, 8) : "—")}</td>
                    <td className="px-2 py-1.5 text-muted-foreground">{r.role ?? "—"}</td>
                    <td className="px-2 py-1.5 text-foreground"><code className="text-[11px]">{r.route ?? r.taskType ?? "—"}</code></td>
                    <td className="px-2 py-1.5 text-foreground"><code className="text-[11px]">{r.provider}/{r.model}</code></td>
                    <td className="px-2 py-1.5 text-right">{formatNum(r.inputTokens + r.outputTokens)}</td>
                    <td className="px-2 py-1.5 text-right">{r.costUsd === null ? "—" : formatUsd(r.costUsd)}</td>
                    <td className="px-2 py-1.5 text-right">{r.latencyMs}ms</td>
                    <td className="px-2 py-1.5 text-right">
                      {r.success ? <span className="text-emerald-400">ok</span> : <span className="text-red-300">fail</span>}
                      {r.cached && <span className="ml-1 text-amber-300">cached</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        <Breakdown title="Live: by provider" rows={data.usage.byProvider} />
        <Breakdown title="Live: by model" rows={data.usage.byModel} />
        <Breakdown title="Live: by route" rows={data.usage.byRoute} />
        <Breakdown title="Live: by task type" rows={data.usage.byTaskType} />
      </div>

      <div className={CARD}>
        <h3 className="text-sm font-semibold text-foreground flex items-center gap-2 mb-3">
          <Zap className="w-4 h-4 text-amber-400" /> Provider health (live)
        </h3>
        {data.health.providers.length === 0 ? (
          <p className="text-xs text-muted-foreground">No provider activity recorded yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-muted-foreground border-b border-card-border">
                <tr>
                  <th className="text-left px-3 py-2">Provider / model</th>
                  <th className="text-right px-3 py-2">Success</th>
                  <th className="text-right px-3 py-2">Fail</th>
                  <th className="text-right px-3 py-2">Timeouts</th>
                  <th className="text-right px-3 py-2">Avg latency</th>
                  <th className="text-right px-3 py-2">p95</th>
                  <th className="text-right px-3 py-2">State</th>
                </tr>
              </thead>
              <tbody>
                {data.health.providers.map((p) => (
                  <tr key={`${p.provider}/${p.model}`} className="border-b border-card-border/60">
                    <td className="px-3 py-2 text-foreground"><code>{p.provider}/{p.model}</code></td>
                    <td className="px-3 py-2 text-right">{p.successes}</td>
                    <td className="px-3 py-2 text-right text-red-300">{p.failures}</td>
                    <td className="px-3 py-2 text-right">{p.timeouts}</td>
                    <td className="px-3 py-2 text-right">{Math.round(p.avgLatencyMs)}ms</td>
                    <td className="px-3 py-2 text-right">{Math.round(p.p95LatencyMs)}ms</td>
                    <td className="px-3 py-2 text-right">
                      {p.inCooldown ? (
                        <span className="text-amber-300">cooldown</span>
                      ) : (
                        <span className="text-emerald-400">healthy</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}

function SummaryCard({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div className={CARD} style={{ borderColor: accent ? `${accent}30` : undefined }}>
      <p className="text-[10px] text-muted-foreground uppercase tracking-wider">{label}</p>
      <p className="text-xl font-bold text-foreground mt-1" style={{ color: accent }}>{value}</p>
    </div>
  );
}

function PeopleCard({
  title,
  icon,
  rows,
  emptyHint,
}: {
  title: string;
  icon: React.ReactNode;
  rows: UsageByUserRow[];
  emptyHint: string;
}) {
  return (
    <div className={CARD}>
      <h3 className="text-sm font-semibold text-foreground flex items-center gap-2 mb-3">
        {icon} {title}
      </h3>
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">{emptyHint}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-muted-foreground border-b border-card-border">
              <tr>
                <th className="text-left px-2 py-1.5">User</th>
                <th className="text-right px-2 py-1.5">Calls</th>
                <th className="text-right px-2 py-1.5">Tokens</th>
                <th className="text-right px-2 py-1.5">Spend</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 25).map((r) => (
                <tr key={r.userId} className="border-b border-card-border/60">
                  <td className="px-2 py-1.5 text-foreground">
                    <div className="font-medium">{userLabel(r)}</div>
                    {r.email && r.displayName && (
                      <div className="text-[10px] text-muted-foreground">{r.email}</div>
                    )}
                  </td>
                  <td className="px-2 py-1.5 text-right">{r.calls}</td>
                  <td className="px-2 py-1.5 text-right">{formatNum(r.inputTokens + r.outputTokens)}</td>
                  <td className="px-2 py-1.5 text-right text-amber-300">{formatUsd(r.costUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function DailySpendChart({ rows }: { rows: UsageDailyRow[] }) {
  const max = Math.max(...rows.map((r) => r.costUsd), 0.0001);
  return (
    <div className="space-y-2">
      <div className="flex items-end gap-1 h-32">
        {rows.map((r) => {
          const heightPct = Math.max(2, Math.round((r.costUsd / max) * 100));
          return (
            <div key={r.day} className="flex-1 flex flex-col items-center gap-1 group" title={`${r.day}: ${formatUsd(r.costUsd)} · ${r.calls} calls`}>
              <div
                className="w-full bg-gradient-to-t from-amber-500/60 to-amber-300/80 rounded-t-sm group-hover:from-amber-400 group-hover:to-amber-200 transition"
                style={{ height: `${heightPct}%` }}
              />
            </div>
          );
        })}
      </div>
      <div className="flex justify-between text-[10px] text-muted-foreground">
        <span>{rows[0]?.day}</span>
        <span>{rows[rows.length - 1]?.day}</span>
      </div>
    </div>
  );
}

function Breakdown({ title, rows }: { title: string; rows: DimensionRow[] }) {
  return (
    <div className={CARD}>
      <h3 className="text-sm font-semibold text-foreground mb-3">{title}</h3>
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">No data yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-muted-foreground border-b border-card-border">
              <tr>
                <th className="text-left px-2 py-1.5">Key</th>
                <th className="text-right px-2 py-1.5">Calls</th>
                <th className="text-right px-2 py-1.5">Cost</th>
                <th className="text-right px-2 py-1.5">Tokens</th>
                <th className="text-right px-2 py-1.5">Fail %</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 12).map((r) => (
                <tr key={r.key} className="border-b border-card-border/60">
                  <td className="px-2 py-1.5 text-foreground"><code className="text-[11px]">{r.key}</code></td>
                  <td className="px-2 py-1.5 text-right">{r.calls}</td>
                  <td className="px-2 py-1.5 text-right">{formatUsd(r.costUsd)}</td>
                  <td className="px-2 py-1.5 text-right">{formatNum(r.inputTokens + r.outputTokens)}</td>
                  <td className="px-2 py-1.5 text-right">{(r.failureRate * 100).toFixed(1)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
