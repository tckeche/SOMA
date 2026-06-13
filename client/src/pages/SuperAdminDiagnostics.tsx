import { useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { ArrowLeft, Activity, AlertTriangle, Database, Gauge, RefreshCw, Shield, Server } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { ThemeToggle } from "@/components/ThemeToggle";
import { authFetch, supabase } from "@/lib/supabase";
import { useSupabaseSession } from "@/hooks/use-supabase-session";

const categories = ["client", "server", "database", "auth", "permission", "rate_limit", "integration", "performance"] as const;
const severities = ["info", "warn", "error", "critical"] as const;

type DiagnosticsEvent = {
  id: string;
  timestamp: string;
  severity: "debug" | "info" | "warn" | "error" | "critical";
  category: typeof categories[number];
  route: string;
  method: string;
  statusCode?: number;
  durationMs?: number;
  requestId?: string;
  user?: { id?: string; role?: string };
  error?: { name?: string; message?: string };
  likelyRootCause?: string;
};

type DiagnosticsSummary = {
  bufferSize: number;
  capacity: number;
  lastHour: {
    total: number;
    bySeverity: Record<string, number>;
    byCategory: Record<string, number>;
    errorCount: number;
    warningCount: number;
    slowestRequest: DiagnosticsEvent | null;
  };
  generatedAt: string;
};

const severityClass: Record<string, string> = {
  debug: "bg-slate-500/10 text-slate-300 border-slate-500/30",
  info: "bg-blue-500/10 text-blue-300 border-blue-500/30",
  warn: "bg-amber-500/10 text-amber-300 border-amber-500/30",
  error: "bg-red-500/10 text-red-300 border-red-500/30",
  critical: "bg-fuchsia-500/10 text-fuchsia-300 border-fuchsia-500/30",
};

export default function SuperAdminDiagnostics() {
  const [, setLocation] = useLocation();
  const { userId, session } = useSupabaseSession();
  const [roleVerified, setRoleVerified] = useState(false);
  const [category, setCategory] = useState<string>("");
  const [severity, setSeverity] = useState<string>("");

  useEffect(() => {
    if (!userId) return;
    authFetch("/api/auth/me")
      .then((r) => r.json())
      .then((data) => {
        if (data.role !== "super_admin") setLocation("/dashboard");
        else setRoleVerified(true);
      })
      .catch(() => setLocation("/login"));
  }, [userId, setLocation]);

  const summaryQuery = useQuery<DiagnosticsSummary>({
    queryKey: ["/api/super-admin/diagnostics/summary", userId],
    queryFn: async () => {
      const res = await authFetch("/api/super-admin/diagnostics/summary");
      if (!res.ok) throw new Error("Failed to load diagnostics summary");
      return res.json();
    },
    enabled: !!userId && roleVerified,
    refetchInterval: 10000,
  });

  const recentQuery = useQuery<{ events: DiagnosticsEvent[] }>({
    queryKey: ["/api/super-admin/diagnostics/recent", userId, category, severity],
    queryFn: async () => {
      const params = new URLSearchParams({ limit: "100" });
      if (category) params.set("category", category);
      if (severity) params.set("severity", severity);
      const res = await authFetch(`/api/super-admin/diagnostics/recent?${params.toString()}`);
      if (!res.ok) throw new Error("Failed to load recent diagnostics");
      return res.json();
    },
    enabled: !!userId && roleVerified,
    refetchInterval: 10000,
  });

  const refresh = () => {
    summaryQuery.refetch();
    recentQuery.refetch();
  };

  const handleLogout = async () => {
    await supabase.auth.signOut();
    setLocation("/login");
  };

  if (!roleVerified) {
    return <div className="min-h-screen flex items-center justify-center"><RefreshCw className="w-8 h-8 text-red-500 animate-spin" /></div>;
  }

  const summary = summaryQuery.data;
  const events = recentQuery.data?.events ?? [];

  return (
    <div className="min-h-screen">
      <header className="border-b border-red-900/40 bg-background/95 backdrop-blur-xl sticky top-0 z-20">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <Link href="/super-admin">
            <div className="flex items-center gap-3 cursor-pointer text-muted-foreground hover:text-foreground">
              <ArrowLeft className="w-4 h-4" />
              <div>
                <h1 className="text-lg font-bold text-foreground">Internal Diagnostics</h1>
                <p className="text-[10px] text-red-400 tracking-widest uppercase font-semibold">Super Admin Only</p>
              </div>
            </div>
          </Link>
          <div className="flex items-center gap-3">
            <span className="hidden sm:inline text-xs text-muted-foreground">{session?.user?.email}</span>
            <ThemeToggle />
            <button onClick={handleLogout} className="px-3 py-2 rounded-lg border border-border text-xs text-muted-foreground hover:text-foreground">Log out</button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-8 space-y-6">
        <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-4">
          <div>
            <h2 className="text-2xl font-bold text-foreground flex items-center gap-2"><Shield className="w-6 h-6 text-red-400" /> Diagnostics Console</h2>
            <p className="text-sm text-muted-foreground mt-1">Recent structured server events from the in-memory ring buffer. User data is limited to safe id/role fields.</p>
          </div>
          <button onClick={refresh} className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-red-500/15 text-red-200 border border-red-500/30 hover:bg-red-500/25">
            <RefreshCw className="w-4 h-4" /> Refresh
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <MetricCard icon={Activity} label="Events in buffer" value={`${summary?.bufferSize ?? 0}/${summary?.capacity ?? 0}`} />
          <MetricCard icon={Server} label="Last hour" value={summary?.lastHour.total ?? 0} />
          <MetricCard icon={AlertTriangle} label="Warnings" value={summary?.lastHour.warningCount ?? 0} tone="amber" />
          <MetricCard icon={Database} label="Errors" value={summary?.lastHour.errorCount ?? 0} tone="red" />
        </div>

        <section className="bg-card/70 border border-card-border rounded-2xl p-5 shadow-xl">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div>
              <h3 className="font-semibold text-foreground mb-3">Categories in the last hour</h3>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {categories.map((cat) => <Badge key={cat} className="justify-between bg-muted/60 text-foreground border-border"><span>{cat}</span><span>{summary?.lastHour.byCategory?.[cat] ?? 0}</span></Badge>)}
              </div>
            </div>
            <div>
              <h3 className="font-semibold text-foreground mb-3">Severity in the last hour</h3>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {severities.map((sev) => <Badge key={sev} className={`justify-between border ${severityClass[sev]}`}><span>{sev}</span><span>{summary?.lastHour.bySeverity?.[sev] ?? 0}</span></Badge>)}
              </div>
            </div>
          </div>
          {summary?.lastHour.slowestRequest && (
            <div className="mt-5 rounded-xl bg-muted/40 border border-border p-4 text-sm text-muted-foreground">
              <Gauge className="inline w-4 h-4 mr-2 text-amber-300" />
              Slowest recent request: <span className="text-foreground">{summary.lastHour.slowestRequest.method} {summary.lastHour.slowestRequest.route}</span> in {summary.lastHour.slowestRequest.durationMs}ms
            </div>
          )}
        </section>

        <section className="bg-card/70 border border-card-border rounded-2xl shadow-xl overflow-hidden">
          <div className="p-5 border-b border-card-border flex flex-col md:flex-row gap-3 md:items-center md:justify-between">
            <h3 className="font-semibold text-foreground">Recent events</h3>
            <div className="flex gap-2">
              <select value={category} onChange={(e) => setCategory(e.target.value)} className="bg-background border border-border rounded-lg px-3 py-2 text-sm text-foreground">
                <option value="">All categories</option>
                {categories.map((cat) => <option key={cat} value={cat}>{cat}</option>)}
              </select>
              <select value={severity} onChange={(e) => setSeverity(e.target.value)} className="bg-background border border-border rounded-lg px-3 py-2 text-sm text-foreground">
                <option value="">All severities</option>
                {severities.map((sev) => <option key={sev} value={sev}>{sev}</option>)}
              </select>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-muted-foreground bg-muted/30">
                <tr>
                  <th className="text-left px-4 py-3">Time</th>
                  <th className="text-left px-4 py-3">Severity</th>
                  <th className="text-left px-4 py-3">Category</th>
                  <th className="text-left px-4 py-3">Request</th>
                  <th className="text-left px-4 py-3">User</th>
                  <th className="text-left px-4 py-3">Error / likely cause</th>
                </tr>
              </thead>
              <tbody>
                {events.length === 0 ? (
                  <tr><td colSpan={6} className="px-4 py-10 text-center text-muted-foreground">No diagnostics events match the current filters.</td></tr>
                ) : events.map((event) => (
                  <tr key={event.id} className="border-t border-card-border/70 hover:bg-muted/30 align-top">
                    <td className="px-4 py-3 whitespace-nowrap text-muted-foreground">{formatDistanceToNow(new Date(event.timestamp), { addSuffix: true })}</td>
                    <td className="px-4 py-3"><Badge className={`border ${severityClass[event.severity]}`}>{event.severity}</Badge></td>
                    <td className="px-4 py-3 text-foreground">{event.category}</td>
                    <td className="px-4 py-3 min-w-[260px]"><p className="text-foreground font-medium">{event.method} {event.route}</p><p className="text-xs text-muted-foreground">{event.statusCode ?? "—"} · {event.durationMs ?? 0}ms · {event.requestId || "no request id"}</p></td>
                    <td className="px-4 py-3 text-muted-foreground">{event.user?.role || "—"}{event.user?.id ? <span className="block text-xs font-mono">{event.user.id}</span> : null}</td>
                    <td className="px-4 py-3 max-w-[420px]"><p className="text-foreground">{event.error?.name ? `${event.error.name}: ` : ""}{event.error?.message || "—"}</p>{event.likelyRootCause && <p className="text-xs text-amber-200 mt-1">{event.likelyRootCause}</p>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </main>
    </div>
  );
}

function MetricCard({ icon: Icon, label, value, tone = "red" }: { icon: any; label: string; value: string | number; tone?: "red" | "amber" }) {
  const color = tone === "amber" ? "text-amber-300 bg-amber-500/10 border-amber-500/30" : "text-red-300 bg-red-500/10 border-red-500/30";
  return <div className="bg-card/70 border border-card-border rounded-2xl p-5 shadow-xl"><div className={`w-10 h-10 rounded-xl border flex items-center justify-center ${color}`}><Icon className="w-5 h-5" /></div><p className="mt-4 text-2xl font-bold text-foreground">{value}</p><p className="text-xs text-muted-foreground uppercase tracking-wide">{label}</p></div>;
}
