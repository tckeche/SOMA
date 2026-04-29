import { useEffect, useMemo, useState } from "react";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import { supabase, authFetch } from "@/lib/supabase";
import { useSupabaseSession } from "@/hooks/use-supabase-session";
import { subscribeToSomaMutations } from "@/lib/realtimeEvents";
import {
  LogOut, Sparkles, ArrowRight, AlertCircle, RefreshCw, Loader2, LayoutDashboard, ListChecks,
} from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ThemeToggle } from "@/components/ThemeToggle";
import NotificationsPanel from "@/components/student/NotificationsPanel";
import SubjectCoverageCard from "@/components/student/SubjectCoverageCard";
import PerformanceCard from "@/components/student/PerformanceCard";
import RemindersCarousel from "@/components/student/RemindersCarousel";
import NextActionsList from "@/components/student/NextActionsList";
import RecentWinsList from "@/components/student/RecentWinsList";
import CompletedAssessmentsTab from "@/components/student/CompletedAssessmentsTab";
import AssignmentsList from "@/components/student/AssignmentsList";
import { SyllabusInsightsSection, type SubjectInsight } from "@/components/SyllabusInsightsSection";
import { SyllabusMasteryMap } from "@/components/SyllabusMasteryMap";
import { MarkLossPredictor } from "@/components/MarkLossPredictor";
import type { DashboardReminder, StudentDashboardPayload } from "@/types/studentDashboard";

interface StudyTipResponse {
  tips: Array<{
    id: string;
    topic: string;
    tip: string;
    whyItMatters: string;
    correctApproach: string;
    frequency: "very_common" | "common" | "occasional";
  }>;
  cacheHit: boolean;
  elapsedMs: number;
}

function DashboardSkeleton() {
  return (
    <div className="space-y-6 animate-pulse" data-testid="dashboard-skeleton">
      <div className="h-32 rounded-2xl bg-card/60 border border-card-border" />
      <div className="grid md:grid-cols-3 gap-4">
        <div className="h-48 rounded-2xl bg-card/60 border border-card-border md:col-span-2" />
        <div className="h-48 rounded-2xl bg-card/60 border border-card-border" />
      </div>
      <div className="grid md:grid-cols-2 gap-4">
        <div className="h-64 rounded-2xl bg-card/60 border border-card-border" />
        <div className="h-64 rounded-2xl bg-card/60 border border-card-border" />
      </div>
    </div>
  );
}

function ErrorState({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="rounded-2xl border border-rose-500/40 bg-rose-500/10 p-8 text-center" data-testid="dashboard-error">
      <AlertCircle className="w-10 h-10 text-rose-500 dark:text-rose-400 mx-auto mb-3" />
      <h2 className="text-lg font-semibold text-rose-800 dark:text-rose-200">We couldn't load your dashboard</h2>
      <p className="text-sm text-rose-700/90 dark:text-rose-300/80 mt-1">Check your connection and try again — your data is safe.</p>
      <button
        onClick={onRetry}
        className="mt-4 inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-rose-500/50 bg-rose-500/15 text-rose-800 dark:text-rose-200 hover:bg-rose-500/25 transition-colors"
        data-testid="button-retry-dashboard"
      >
        <RefreshCw className="w-4 h-4" /> Retry
      </button>
    </div>
  );
}

export default function StudentDashboard() {
  const queryClient = useQueryClient();
  const [, setLocation] = useLocation();
  const { session, userId } = useSupabaseSession();
  const initialTab = (() => {
    if (typeof window === "undefined") return "home" as const;
    const tab = new URLSearchParams(window.location.search).get("tab");
    return tab === "completed" ? ("completed" as const) : ("home" as const);
  })();
  const [activeTab, setActiveTab] = useState<"home" | "completed">(initialTab);

  useEffect(() => {
    return subscribeToSomaMutations(() => {
      queryClient.invalidateQueries({ queryKey: ["/api/student/dashboard", userId] });
    });
  }, [queryClient, userId]);

  const { data, isLoading, isError, refetch, isFetching, dataUpdatedAt } = useQuery<StudentDashboardPayload>({
    queryKey: ["/api/student/dashboard", userId],
    queryFn: async () => {
      const res = await authFetch("/api/student/dashboard");
      if (!res.ok) throw new Error(`Failed to load dashboard (${res.status})`);
      return res.json();
    },
    enabled: !!userId,
    refetchInterval: 10_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    refetchOnMount: "always",
  });

  const { data: syllabusInsights, isLoading: syllabusInsightsLoading } = useQuery<{ subjects: SubjectInsight[] }>({
    queryKey: ["/api/student/syllabus-insights", userId],
    queryFn: async () => {
      const res = await authFetch("/api/student/syllabus-insights");
      if (!res.ok) return { subjects: [] };
      return res.json();
    },
    enabled: !!userId,
  });

  // Examiner-driven study tips, fetched per subject. Each query is cached
  // server-side for 10 minutes and client-side for 5; we merge the results
  // into the reminders array so the carousel surfaces real, syllabus-grounded
  // mistakes alongside the generic composed reminders.
  const subjectsForTips = useMemo(
    () => (data?.subjects ?? []).slice(0, 4),
    [data?.subjects],
  );
  const tipQueries = useQueries({
    queries: subjectsForTips.map((s) => ({
      queryKey: ["/api/student/study-tips", s.subject],
      queryFn: async (): Promise<StudyTipResponse> => {
        const params = new URLSearchParams({ subject: s.subject, board: "Cambridge", top: "3" });
        const res = await authFetch(`/api/student/study-tips?${params.toString()}`);
        if (!res.ok) return { tips: [], cacheHit: false, elapsedMs: 0 };
        return res.json();
      },
      enabled: !!userId && !!s.subject,
      staleTime: 5 * 60 * 1000,
    })),
  });
  const studyTipReminders: DashboardReminder[] = useMemo(() => {
    const out: DashboardReminder[] = [];
    tipQueries.forEach((q, idx) => {
      const subject = subjectsForTips[idx]?.subject;
      if (!q.data || !subject) return;
      for (const tip of q.data.tips) {
        out.push({
          id: tip.id,
          topic: tip.topic,
          text: tip.tip,
          whyItMatters: tip.whyItMatters,
          correctApproach: tip.correctApproach,
          frequency: tip.frequency,
          subject,
        });
      }
    });
    return out;
  }, [tipQueries, subjectsForTips]);
  const mergedReminders: DashboardReminder[] = useMemo(() => {
    const composed = data?.reminders ?? [];
    // Surface the examiner tips first — they're more actionable than the
    // generic composed reminders.
    return [...studyTipReminders, ...composed];
  }, [studyTipReminders, data?.reminders]);

  const lastUpdated = dataUpdatedAt ? new Date(dataUpdatedAt) : null;
  const formatUpdated = (d: Date | null) => {
    if (!d) return "";
    const diffSec = Math.max(0, Math.round((Date.now() - d.getTime()) / 1000));
    if (diffSec < 5) return "just now";
    if (diffSec < 60) return `${diffSec}s ago`;
    const mins = Math.round(diffSec / 60);
    return `${mins}m ago`;
  };

  const handleLogout = async () => {
    await supabase.auth.signOut();
    setLocation("/login");
  };

  const displayName = data?.student.displayName ?? (session?.user?.user_metadata?.display_name || session?.user?.email?.split("@")[0] || "Student");
  const initials = displayName.split(" ").map((n: string) => n[0]).join("").toUpperCase().slice(0, 2);

  return (
    <div className="min-h-screen">
      <header className="border-b border-border/70 bg-background/95 backdrop-blur-xl sticky top-0 z-20">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <Link href="/">
            <div className="flex items-center gap-3 cursor-pointer" data-testid="link-dashboard-home">
              <img src="/MCEC - White Logo.png" alt="MCEC Logo" loading="lazy" className="h-10 w-auto object-contain brightness-0 dark:brightness-100" />
              <div>
                <h1 className="text-lg font-bold gradient-text" data-testid="text-dashboard-title">SOMA</h1>
                <p className="text-[10px] text-muted-foreground tracking-widest uppercase">Student Dashboard</p>
              </div>
            </div>
          </Link>

          <div className="flex items-center gap-4">
            <button
              onClick={() => refetch()}
              className="hidden sm:flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground transition-colors px-2 py-1.5 rounded-lg hover-elevate"
              aria-label="Refresh dashboard"
              title={lastUpdated ? `Last updated ${formatUpdated(lastUpdated)}` : "Refresh"}
              data-testid="button-refresh-dashboard"
            >
              {isFetching ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <RefreshCw className="w-3.5 h-3.5" />
              )}
              <span>{isFetching ? "Refreshing…" : `Updated ${formatUpdated(lastUpdated)}`}</span>
            </button>
            <div className="flex items-center gap-3">
              <div
                className="w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold text-white border-2 border-violet-500/60 bg-violet-600/80 shadow-[0_0_16px_rgba(139,92,246,0.35)]"
                data-testid="avatar-user"
              >
                {initials}
              </div>
              <div className="hidden sm:block">
                <p className="text-sm font-medium text-foreground" data-testid="text-user-name">{displayName}</p>
                <p className="text-[10px] text-muted-foreground">{session?.user?.email}</p>
              </div>
            </div>
            <ThemeToggle />
            <button
              onClick={handleLogout}
              className="text-muted-foreground hover:text-foreground transition-colors p-2 min-h-[44px] min-w-[44px]"
              aria-label="Log out"
              data-testid="button-logout"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-8 space-y-6">
        {isLoading ? (
          <DashboardSkeleton />
        ) : isError || !data ? (
          <ErrorState onRetry={() => refetch()} />
        ) : (
          <>
            {/* 1. Notifications panel — always shown first */}
            <NotificationsPanel
              items={data.notifications.items}
              unreadCount={data.notifications.unreadCount}
              studentKey={userId ?? ""}
            />

            {/* 2. Greeting + due summary */}
            <section className="rounded-2xl border border-card-border bg-gradient-to-br from-violet-500/15 via-card/80 to-card/70 p-6 shadow-xl" data-testid="section-greeting">
              <h2 className="text-2xl font-bold text-foreground" data-testid="text-greeting">{data.greeting}</h2>
              <p className="text-sm text-foreground/80 mt-2" data-testid="text-due-summary">{data.dueSummary}</p>
            </section>

            <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as "home" | "completed")}>
              <TabsList className="bg-card/60 border border-card-border">
                <TabsTrigger value="home" data-testid="tab-trigger-home">
                  <LayoutDashboard className="w-4 h-4 mr-2" /> Home
                </TabsTrigger>
                <TabsTrigger value="completed" data-testid="tab-trigger-completed">
                  <ListChecks className="w-4 h-4 mr-2" /> Completed ({data.completed.length})
                </TabsTrigger>
              </TabsList>

              <TabsContent value="home" className="space-y-6 mt-6">
                {/* 3. What to do now + Recent wins */}
                <div className="grid md:grid-cols-2 gap-5">
                  <NextActionsList actions={data.nextActions} />
                  <RecentWinsList wins={data.recentWins} />
                </div>

                {/* 4. Reminders carousel */}
                <RemindersCarousel reminders={mergedReminders} />

                {/* 5. Performance section */}
                <PerformanceCard performance={data.performance} subjects={data.subjects} />

                {/* 5a. Mark-loss predictor (Phase 3.2) */}
                <MarkLossPredictor />

                {/* 5b. Syllabus mastery map (Phase 3.1) */}
                <SyllabusMasteryMap />

                {/* 5c. Topic-coverage radar + paper readiness (legacy view, kept
                       alongside the mastery map for now). */}
                <section className="space-y-3" data-testid="section-syllabus-insights">
                  <header>
                    <h2 className="text-lg font-semibold text-foreground">Topic coverage radar</h2>
                    <p className="text-xs text-muted-foreground">Quick overview of which topics you've touched and where you stand.</p>
                  </header>
                  <SyllabusInsightsSection
                    insights={syllabusInsights}
                    isLoading={syllabusInsightsLoading}
                    studentFirstName={data.student.displayName}
                  />
                </section>

                {/* 6. Per-subject syllabus coverage */}
                <section className="space-y-3" data-testid="section-subjects">
                  <header className="flex items-center justify-between">
                    <div>
                      <h2 className="text-lg font-semibold text-foreground">Your subjects</h2>
                      <p className="text-xs text-muted-foreground">Each subject shows the syllabus topics for the level you're studying.</p>
                    </div>
                  </header>
                  {data.subjects.length === 0 ? (
                    <div className="rounded-2xl border border-card-border bg-card/70 p-8 text-center">
                      <p className="text-sm text-muted-foreground">Once you have an assigned assessment or your tutor sets your subjects, your syllabus coverage will appear here.</p>
                    </div>
                  ) : (
                    <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-4">
                      {data.subjects.map((s) => (
                        <SubjectCoverageCard key={s.subject} subject={s} />
                      ))}
                    </div>
                  )}
                </section>

                {/* 7. Open assignments */}
                <section className="space-y-3" data-testid="section-assignments">
                  <header>
                    <h2 className="text-lg font-semibold text-foreground">Pending assessments</h2>
                    <p className="text-xs text-muted-foreground">Sorted by what's most urgent.</p>
                  </header>
                  <AssignmentsList assignments={data.assignments} />
                </section>
              </TabsContent>

              <TabsContent value="completed" className="mt-6">
                <CompletedAssessmentsTab completed={data.completed} />
              </TabsContent>
            </Tabs>

            {/* SOMA Tutor CTA */}
            <section className="flex justify-center pt-2 pb-6">
              <button
                className="group relative inline-flex items-center gap-2.5 px-7 py-3.5 rounded-2xl font-semibold text-sm text-emerald-300 bg-emerald-500/5 border border-emerald-500/20 ring-2 ring-emerald-500/20 hover:bg-emerald-500/10 hover:ring-emerald-500/40 hover:border-emerald-500/40 transition-all duration-300 shadow-[0_0_30px_rgba(16,185,129,0.08)]"
                data-testid="button-consult-ai-tutor"
                onClick={() => setLocation("/soma/chat")}
              >
                <Sparkles className="w-4 h-4 text-emerald-400 group-hover:animate-pulse" />
                Consult SOMA Tutor
                <ArrowRight className="w-4 h-4 opacity-0 -translate-x-2 group-hover:opacity-100 group-hover:translate-x-0 transition-all duration-300" />
              </button>
            </section>
          </>
        )}
      </main>
    </div>
  );
}
