import { useQuery } from "@tanstack/react-query";
import { authFetch } from "@/lib/supabase";
import { Activity, AlertTriangle, Loader2, Zap, RefreshCcw } from "lucide-react";

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
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

function formatNum(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function SuperAdminAIUsage() {
  const { data, isLoading, isError, refetch, isFetching } = useQuery<AIUsageReport>({
    queryKey: ["/api/super-admin/ai-usage"],
    queryFn: async () => {
      const res = await authFetch("/api/super-admin/ai-usage");
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
  return (
    <section className="space-y-6" data-testid="ai-usage-section">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-foreground flex items-center gap-2">
            <Activity className="w-4 h-4 text-red-400" /> AI Usage & Cost
          </h2>
          <p className="text-xs text-muted-foreground">
            Aggregated counters only — no raw prompts or model output stored. Health backend: <code className="text-foreground/80">{data.health.backend}</code>
          </p>
        </div>
        <button
          onClick={() => refetch()}
          className="text-xs px-3 py-2 rounded-lg bg-muted/40 border border-border/50 hover:bg-muted/60 flex items-center gap-2"
          data-testid="button-refresh-ai-usage"
        >
          <RefreshCcw className={`w-3.5 h-3.5 ${isFetching ? "animate-spin" : ""}`} /> Refresh
        </button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <SummaryCard label="Total calls" value={formatNum(overall.calls)} />
        <SummaryCard label="Total cost" value={formatUsd(overall.costUsd)} accent="#F59E0B" />
        <SummaryCard label="Tokens (in/out)" value={`${formatNum(overall.inputTokens)} / ${formatNum(overall.outputTokens)}`} />
        <SummaryCard label="Failures" value={`${overall.failures} (${(overall.failureRate * 100).toFixed(1)}%)`} accent="#EF4444" />
        <SummaryCard label="p95 latency" value={`${overall.p95LatencyMs}ms`} />
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        <Breakdown title="By provider" rows={data.usage.byProvider} />
        <Breakdown title="By model" rows={data.usage.byModel} />
        <Breakdown title="By route / operation" rows={data.usage.byRoute} />
        <Breakdown title="By task type" rows={data.usage.byTaskType} />
        <Breakdown title="By prompt version" rows={data.usage.byPromptVersion} />
        <Breakdown title="Top users (by cost)" rows={data.usage.byUser.slice(0, 20)} keyHeader="User" />
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
                  <th className="text-right px-3 py-2">Parse fail</th>
                  <th className="text-right px-3 py-2">Validation fail</th>
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
                    <td className="px-3 py-2 text-right">{p.parseFailures}</td>
                    <td className="px-3 py-2 text-right">{p.validationFailures}</td>
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

      <div className={CARD}>
        <h3 className="text-sm font-semibold text-foreground mb-3">Cost guardrails (max_tokens by task)</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
          {Object.entries(data.guardrails.maxTokensByTask).map(([task, cap]) => (
            <div key={task} className="bg-muted/30 rounded-lg px-3 py-2 flex items-center justify-between">
              <span className="text-muted-foreground">{task}</span>
              <span className="text-foreground font-medium">{cap.toLocaleString()}</span>
            </div>
          ))}
        </div>
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

function Breakdown({ title, rows, keyHeader = "Key" }: { title: string; rows: DimensionRow[]; keyHeader?: string }) {
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
                <th className="text-left px-2 py-1.5">{keyHeader}</th>
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
