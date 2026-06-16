import { useEffect } from "react";
import { Link, useLocation } from "wouter";
import { useSupabaseSession } from "@/hooks/use-supabase-session";
import {
  Loader2,
  ArrowRight,
  ClipboardList,
  PencilLine,
  TrendingUp,
  Flame,
} from "lucide-react";
import { ThemeToggle } from "@/components/ThemeToggle";

/* How-it-works steps — mirrors the mockup's HIW array */
const HIW: Array<{
  title: string;
  body: string;
  Icon: typeof ClipboardList;
}> = [
  {
    title: "Assign",
    body: "Tutors build or pick an assessment and assign it in seconds.",
    Icon: ClipboardList,
  },
  {
    title: "Practise",
    body: "Students sit timed papers with autosave and instant context.",
    Icon: PencilLine,
  },
  {
    title: "Improve",
    body: "Dashboards surface weak topics and what to do next.",
    Icon: TrendingUp,
  },
];

/* A SOMA dashboard "peek" — translated from the mockup's <UIPeek/>, themed via tokens */
function UIPeek() {
  const topics: Array<{ label: string; pct: number; tone: string }> = [
    { label: "Mole calculations", pct: 41, tone: "text-danger" },
    { label: "Simultaneous eqns", pct: 58, tone: "text-warning" },
    { label: "Differentiation", pct: 88, tone: "text-success" },
  ];
  const meterTone: Record<string, string> = {
    "text-danger": "bg-danger",
    "text-warning": "bg-warning",
    "text-success": "bg-success",
  };
  return (
    <div className="soma-card w-full max-w-[520px] overflow-hidden shadow-[var(--shadow-lg,0_30px_64px_-22px_rgba(0,0,0,0.45))]">
      {/* window chrome */}
      <div className="flex items-center gap-2 border-b border-card-border px-4 py-3">
        <span className="h-2.5 w-2.5 rounded-full bg-danger" />
        <span className="h-2.5 w-2.5 rounded-full bg-warning" />
        <span className="h-2.5 w-2.5 rounded-full bg-success" />
        <span className="ml-2 font-mono text-[11px] text-muted-foreground">
          soma.melaniacalvin.com/dashboard
        </span>
      </div>
      <div className="p-5 text-left">
        {/* greeting row */}
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <div className="text-base font-bold tracking-tight text-card-foreground">
              Good afternoon, Tafadzwa
            </div>
            <div className="text-xs text-muted-foreground">
              2 assessments due · 1 overdue
            </div>
          </div>
          <span className="chip chip-brand whitespace-nowrap">
            <Flame className="h-3.5 w-3.5" />
            3-day streak
          </span>
        </div>

        {/* overdue card */}
        <div className="relative mb-3 rounded-xl border border-card-border bg-secondary p-3.5">
          <span className="absolute bottom-3 left-0 top-3 w-[3px] rounded bg-danger" />
          <div className="mb-1.5 pl-2 text-[10.5px] font-semibold uppercase tracking-wide text-danger">
            Overdue · was Tue
          </div>
          <div className="pl-2 text-sm font-bold tracking-tight text-card-foreground">
            Quadratic Equations: Mixed MCQ
          </div>
          <div className="mt-0.5 pl-2 text-xs text-muted-foreground">
            15 questions · 25 marks · ~30 min
          </div>
        </div>

        {/* stat tiles */}
        <div className="grid grid-cols-3 gap-2.5">
          {[
            { k: "Average", v: "74%" },
            { k: "Accuracy", v: "81%" },
            { k: "Done", v: "18/21" },
          ].map((s) => (
            <div
              key={s.k}
              className="rounded-[10px] border border-card-border bg-secondary px-3 py-2.5"
            >
              <div className="eyebrow">{s.k}</div>
              <div className="num mt-0.5 text-xl text-card-foreground">
                {s.v}
              </div>
            </div>
          ))}
        </div>

        {/* topic meters */}
        <div className="mt-3 grid gap-2">
          {topics.map((t) => (
            <div key={t.label} className="flex items-center gap-2.5">
              <span className="w-32 text-xs font-medium text-card-foreground">
                {t.label}
              </span>
              <span className="meter flex-1">
                <span
                  className={meterTone[t.tone]}
                  style={{ width: `${t.pct}%` }}
                />
              </span>
              <span
                className={`w-8 text-right text-xs font-bold ${t.tone}`}
              >
                {t.pct}%
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function Landing() {
  const { session, isLoading: loading } = useSupabaseSession();
  const [, setLocation] = useLocation();

  useEffect(() => {
    if (!loading && session) {
      setLocation("/dashboard");
    }
  }, [loading, session, setLocation]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="w-8 h-8 text-primary animate-spin" />
      </div>
    );
  }

  return (
    <div className="min-h-screen w-full relative overflow-hidden bg-[radial-gradient(ellipse_80%_80%_at_50%_-20%,hsl(var(--primary)/0.16),transparent)]">
      {/* theme toggle in the corner */}
      <div className="fixed top-4 right-4 z-30">
        <ThemeToggle size="sm" />
      </div>

      <div className="mx-auto flex min-h-screen w-full max-w-6xl flex-col px-5 py-7 sm:px-8">
        {/* ── Nav ─────────────────────────────────────────── */}
        <nav className="flex items-center justify-between">
          <Link href="/login">
            <span
              className="flex cursor-pointer items-center gap-2.5"
              data-testid="link-dashboard-home"
            >
              <img
                src="/MCEC - White Logo.png"
                alt="MCEC Logo"
                loading="lazy"
                className="h-12 w-auto object-contain brightness-0 dark:brightness-100"
              />
              <span className="soma-display text-xl text-foreground">SOMA</span>
            </span>
          </Link>
          <div className="hidden items-center gap-7 md:flex">
            <span className="text-sm font-medium text-muted-foreground">
              Product
            </span>
            <span className="text-sm font-medium text-muted-foreground">
              For tutors
            </span>
            <span className="text-sm font-medium text-muted-foreground">
              For students
            </span>
            <span className="text-sm font-medium text-muted-foreground">
              by MCEC
            </span>
          </div>
          <Link href="/login">
            <span className="btn btn-primary cursor-pointer">
              Sign in
            </span>
          </Link>
        </nav>

        {/* ── Hero ────────────────────────────────────────── */}
        <div className="grid flex-1 items-center gap-10 py-10 lg:grid-cols-[1.05fr_0.95fr]">
          <div className="text-center lg:text-left">
            <span className="chip chip-brand">
              <span className="rounded-full bg-primary px-2 py-0.5 text-[10.5px] font-bold text-primary-foreground">
                NEW
              </span>
              Mastery maps for every paper
            </span>

            <h1
              className="soma-display mt-5 text-4xl tracking-tight text-foreground sm:text-5xl md:text-6xl"
              data-testid="text-main-title"
            >
              Assessments that{" "}
              <span className="gradient-text">actually move</span> students
              forward.
            </h1>

            <p
              className="mx-auto mt-5 max-w-[46ch] text-base leading-relaxed text-muted-foreground sm:text-lg lg:mx-0"
              data-testid="text-subtitle"
            >
              SOMA runs timed papers, marks them, and turns the results into
              clear next steps for students and the tutors guiding them.
            </p>

            <p
              className="mt-3 text-xs font-light uppercase tracking-[0.2em] text-muted-foreground"
              data-testid="text-byline"
            >
              by MCEC
            </p>

            <div className="mt-7 flex flex-wrap items-center justify-center gap-3 lg:justify-start">
              <Link href="/login?portal=student">
                <button
                  className="btn btn-primary min-h-[44px] cursor-pointer px-6"
                  data-testid="button-enter-portal"
                >
                  Enter Student Portal
                  <ArrowRight className="h-4 w-4" />
                </button>
              </Link>
              <Link href="/login?portal=tutor">
                <span
                  className="btn btn-ghost min-h-[44px] cursor-pointer px-6"
                  data-testid="link-admin-access"
                >
                  Tutor Access
                </span>
              </Link>
            </div>

            {/* tagline */}
            <div className="mt-9 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 lg:justify-start">
              <span className="text-sm font-bold tracking-tight text-foreground">
                Pioneering the Evolution of Education!
              </span>
            </div>
          </div>

          {/* product peek */}
          <div className="flex justify-center lg:justify-end">
            <UIPeek />
          </div>
        </div>

        {/* ── How it works ────────────────────────────────── */}
        <div className="grid gap-6 border-t border-border pt-8 sm:grid-cols-3">
          {HIW.map((s, i) => (
            <div key={s.title} className="flex gap-3">
              <span className="flex h-9 w-9 flex-none items-center justify-center rounded-[9px] bg-accent text-accent-foreground">
                <s.Icon className="h-[18px] w-[18px]" />
              </span>
              <span>
                <b className="text-sm font-bold tracking-tight text-foreground">
                  {i + 1}. {s.title}
                </b>
                <span className="mt-0.5 block max-w-[28ch] text-xs text-muted-foreground">
                  {s.body}
                </span>
              </span>
            </div>
          ))}
        </div>

        {/* ── Footer ──────────────────────────────────────── */}
        <footer className="mt-12 flex flex-col items-center justify-between gap-6 border-t border-border pt-8 sm:flex-row">
          <Link href="/login">
            <span
              className="flex cursor-pointer items-center gap-2.5"
              data-testid="link-footer-home"
            >
              <img
                src="/MCEC - White Logo.png"
                alt="MCEC Logo"
                loading="lazy"
                className="h-12 w-auto object-contain brightness-0 dark:brightness-100"
              />
              <span className="soma-display text-xl text-foreground">SOMA</span>
            </span>
          </Link>
          <nav className="flex flex-wrap items-center justify-center gap-x-7 gap-y-2">
            <span className="text-sm font-medium text-muted-foreground transition-colors hover:text-foreground">
              Product
            </span>
            <span className="text-sm font-medium text-muted-foreground transition-colors hover:text-foreground">
              For tutors
            </span>
            <span className="text-sm font-medium text-muted-foreground transition-colors hover:text-foreground">
              For students
            </span>
            <span className="text-sm font-medium text-muted-foreground transition-colors hover:text-foreground">
              by MCEC
            </span>
          </nav>
        </footer>
      </div>
    </div>
  );
}
