import { useQuery } from "@tanstack/react-query";
import { authFetch } from "@/lib/supabase";
import { useSupabaseSession } from "@/hooks/use-supabase-session";

type State = "ok" | "degraded" | "down" | "no_key" | "unknown";
interface ProviderStatus {
  provider: "openai" | "anthropic" | "google";
  state: State;
  lastCheckedAt: string | null;
  note: string | null;
}

const PROVIDER_LABELS: Record<ProviderStatus["provider"], string> = {
  openai: "GPT",
  anthropic: "Claude",
  google: "Gemini",
};

const STATE_META: Record<State, { color: string; ring: string; text: string; label: string }> = {
  ok: {
    color: "bg-emerald-400",
    ring: "shadow-[0_0_6px_rgba(52,211,153,0.6)]",
    text: "text-emerald-400",
    label: "Online",
  },
  degraded: {
    color: "bg-amber-400",
    ring: "shadow-[0_0_6px_rgba(251,191,36,0.6)]",
    text: "text-amber-400",
    label: "Degraded",
  },
  down: {
    color: "bg-rose-500",
    ring: "shadow-[0_0_6px_rgba(244,63,94,0.6)]",
    text: "text-rose-400",
    label: "Down",
  },
  no_key: {
    color: "bg-slate-500",
    ring: "",
    text: "text-muted-foreground",
    label: "Not configured",
  },
  unknown: {
    color: "bg-slate-400/70",
    ring: "",
    text: "text-muted-foreground",
    label: "Idle",
  },
};

/**
 * Bottom-of-page AI status lights. A tutor glances here to confirm all three
 * providers are reachable. Amber = recent rate-limit or network blip (self-
 * healing), red = auth/quota error (needs your attention), grey = no API key
 * set or the provider hasn't been called yet in this session.
 */
export function AIStatusLights() {
  const { userId } = useSupabaseSession();
  const { data } = useQuery<{ providers: ProviderStatus[] }>({
    queryKey: ["/api/ai/status", userId],
    queryFn: async () => {
      const res = await authFetch("/api/ai/status");
      if (!res.ok) return { providers: [] };
      return res.json();
    },
    enabled: !!userId,
    refetchInterval: 30_000,
    staleTime: 15_000,
    refetchOnWindowFocus: false,
  });

  if (!userId || !data?.providers?.length) return null;

  return (
    <div
      className="fixed bottom-3 right-3 z-40 flex items-center gap-2 px-3 py-1.5 rounded-full bg-background/85 backdrop-blur-md border border-border/60 shadow-sm"
      data-testid="ai-status-lights"
    >
      {data.providers.map((p) => {
        const meta = STATE_META[p.state] ?? STATE_META.unknown;
        const title = [
          `${PROVIDER_LABELS[p.provider]}: ${meta.label}`,
          p.note ? `· ${p.note}` : null,
          p.lastCheckedAt ? `· last call ${new Date(p.lastCheckedAt).toLocaleTimeString()}` : null,
        ].filter(Boolean).join(" ");
        return (
          <span
            key={p.provider}
            className="flex items-center gap-1.5"
            title={title}
            data-testid={`ai-status-${p.provider}`}
            data-state={p.state}
          >
            <span className={`inline-block w-2 h-2 rounded-full ${meta.color} ${meta.ring}`} />
            <span className={`text-[10px] font-semibold tracking-wide ${meta.text}`}>
              {PROVIDER_LABELS[p.provider]}
            </span>
          </span>
        );
      })}
    </div>
  );
}
