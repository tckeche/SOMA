import { useState, useMemo, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import { supabase, authFetch } from "@/lib/supabase";
import { useSupabaseSession } from "@/hooks/use-supabase-session";
import {
  Users, UserPlus, X, Loader2, Check, ChevronRight,
  BookOpen, LogOut, LayoutDashboard, Search, RotateCcw, Mail, AlertTriangle,
  Send, Clock,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { useToast } from "@/hooks/use-toast";
import { ThemeToggle } from "@/components/ThemeToggle";

interface SomaUser {
  id: string;
  email: string;
  displayName: string | null;
  role: string;
}

function formatStudentName(student: SomaUser): string {
  const fromDisplay = (student.displayName || "").trim();
  if (fromDisplay) return fromDisplay;
  return "Student";
}

const GP = "glass-panel-elite";

export default function TutorStudents() {
  const queryClient = useQueryClient();
  const [, setLocation] = useLocation();
  const [showAdoptModal, setShowAdoptModal] = useState(false);
  const [selectedStudentIds, setSelectedStudentIds] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState("");
  const [adoptSearchQuery, setAdoptSearchQuery] = useState("");
  const [pendingRemoveId, setPendingRemoveId] = useState<string | null>(null);
  const [adoptFeedback, setAdoptFeedback] = useState<string | null>(null);
  const [inviteEmail, setInviteEmail] = useState("");
  const { toast } = useToast();

  const { session, userId, isLoading: authLoading } = useSupabaseSession();
  const displayName = session?.user?.user_metadata?.display_name || session?.user?.email?.split("@")[0] || "Tutor";
  const initials = displayName.split(" ").map((n: string) => n[0]).join("").toUpperCase().slice(0, 2);

  const { data: adoptedStudents = [], isLoading: studentsLoading } = useQuery<SomaUser[]>({
    queryKey: ["/api/tutor/students", userId],
    queryFn: async () => {
      if (!userId) return [];
      const res = await authFetch("/api/tutor/students");
      if (!res.ok) return [];
      return res.json();
    },
    enabled: !!userId,
  });

  const { data: availableStudents = [] } = useQuery<SomaUser[]>({
    queryKey: ["/api/tutor/students/available", userId],
    queryFn: async () => {
      if (!userId) return [];
      const res = await authFetch("/api/tutor/students/available");
      if (!res.ok) return [];
      return res.json();
    },
    enabled: !!userId && showAdoptModal,
  });

  const adoptMutation = useMutation({
    mutationFn: async (studentIds: string[]) => {
      const res = await authFetch("/api/tutor/students/adopt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ studentIds }),
      });
      if (!res.ok) throw new Error("Failed to adopt");
      return res.json();
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["/api/tutor/students"] });
      queryClient.invalidateQueries({ queryKey: ["/api/tutor/students/available"] });
      const count = variables.length;
      setAdoptFeedback(`Added ${count} student${count !== 1 ? "s" : ""} to your cohort.`);
      setShowAdoptModal(false);
      setSelectedStudentIds(new Set());
      setAdoptSearchQuery("");
      setTimeout(() => setAdoptFeedback(null), 4000);
    },
    onError: () => {
      setAdoptFeedback("Could not add students. Please try again.");
      setTimeout(() => setAdoptFeedback(null), 5000);
    },
  });

  const removeMutation = useMutation({
    mutationFn: async (studentId: string) => {
      const res = await authFetch(`/api/tutor/students/${studentId}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("Failed to remove");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/tutor/students"] });
      queryClient.invalidateQueries({ queryKey: ["/api/tutor/students/available"] });
      setPendingRemoveId(null);
    },
  });

  // Pending email invitations — students who've been invited but haven't signed up yet.
  interface PendingInvite {
    id: number;
    email: string;
    status: "pending" | "accepted" | "cancelled";
    createdAt: string;
    lastSentAt: string;
  }
  const { data: invitesData } = useQuery<{ invites: PendingInvite[] }>({
    queryKey: ["/api/tutor/invites", userId],
    queryFn: async () => {
      const res = await authFetch("/api/tutor/invites");
      if (!res.ok) return { invites: [] };
      return res.json();
    },
    enabled: !!userId,
    refetchInterval: 30_000,
  });
  const pendingInvites = (invitesData?.invites ?? []).filter((i) => i.status === "pending");

  const inviteMutation = useMutation({
    mutationFn: async (email: string) => {
      const res = await authFetch("/api/tutor/invites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.message || "Failed to send invite");
      return body as { kind: "invited" | "adopted"; invite?: PendingInvite; studentId?: string };
    },
    onSuccess: (data) => {
      setInviteEmail("");
      queryClient.invalidateQueries({ queryKey: ["/api/tutor/invites"] });
      if (data.kind === "adopted") {
        queryClient.invalidateQueries({ queryKey: ["/api/tutor/students"] });
        toast({ title: "Student added", description: "They were already registered — added to your cohort." });
      } else {
        toast({ title: "Invite sent", description: "They'll be auto-adopted when they sign up." });
      }
    },
    onError: (err: Error) => {
      toast({ title: "Couldn't send invite", description: err.message, variant: "destructive" });
    },
  });

  const resendInviteMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await authFetch(`/api/tutor/invites/${id}/resend`, { method: "POST" });
      if (!res.ok) throw new Error("Failed to resend");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/tutor/invites"] });
      toast({ title: "Invite resent" });
    },
  });

  const cancelInviteMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await authFetch(`/api/tutor/invites/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to cancel");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/tutor/invites"] });
      toast({ title: "Invite cancelled" });
    },
  });

  const toggleStudentSelection = useCallback((id: string) => {
    setSelectedStudentIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const filteredStudents = useMemo(() => {
    const sorted = [...adoptedStudents].sort((a, b) => formatStudentName(a).localeCompare(formatStudentName(b)));
    if (!searchQuery.trim()) return sorted;
    const q = searchQuery.toLowerCase();
    return sorted.filter((s) =>
      formatStudentName(s).toLowerCase().includes(q) ||
      (s.email || "").toLowerCase().includes(q)
    );
  }, [adoptedStudents, searchQuery]);

  const filteredAvailable = useMemo(() => {
    const sorted = [...availableStudents].sort((a, b) => formatStudentName(a).localeCompare(formatStudentName(b)));
    if (!adoptSearchQuery.trim()) return sorted;
    const q = adoptSearchQuery.toLowerCase();
    return sorted.filter((s) =>
      formatStudentName(s).toLowerCase().includes(q) ||
      (s.email || "").toLowerCase().includes(q)
    );
  }, [availableStudents, adoptSearchQuery]);

  const allVisibleSelected =
    filteredAvailable.length > 0 &&
    filteredAvailable.every((s) => selectedStudentIds.has(s.id));

  const toggleSelectAllVisible = useCallback(() => {
    setSelectedStudentIds((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) {
        filteredAvailable.forEach((s) => next.delete(s.id));
      } else {
        filteredAvailable.forEach((s) => next.add(s.id));
      }
      return next;
    });
  }, [filteredAvailable, allVisibleSelected]);

  const handleLogout = async () => {
    await supabase.auth.signOut();
    setLocation("/login");
  };

  const pendingRemoveStudent = pendingRemoveId
    ? adoptedStudents.find((s) => s.id === pendingRemoveId) || null
    : null;

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-30 border-b border-border/60 backdrop-blur-2xl bg-background/95">
        <div className="max-w-[1440px] mx-auto px-6 lg:px-10 py-3.5 flex items-center justify-between">
          <Link href="/">
            <div className="flex items-center gap-3.5 cursor-pointer group">
              <img src="/MCEC - White Logo.png" alt="MCEC Logo" loading="lazy" className="h-9 w-auto object-contain opacity-90 group-hover:opacity-100 transition-opacity brightness-0 dark:brightness-100" />
              <div>
                <h1 className="text-lg font-extrabold tracking-tight gradient-text leading-none">SOMA</h1>
                <p className="text-[9px] text-muted-foreground tracking-[0.25em] uppercase font-semibold mt-0.5">Assessment Platform</p>
              </div>
            </div>
          </Link>
          <div className="flex items-center gap-5">
            <nav className="hidden md:flex items-center gap-0.5 mr-2">
              <Link href="/tutor">
                <span className="flex items-center gap-2 px-4 py-2 text-[13px] font-medium text-muted-foreground hover:text-foreground/80 border-b-2 border-transparent transition-all cursor-pointer" data-testid="nav-dashboard">
                  <LayoutDashboard className="w-3.5 h-3.5" /> Dashboard
                </span>
              </Link>
              <span className="flex items-center gap-2 px-4 py-2 text-[13px] font-semibold text-violet-300 border-b-2 border-violet-500 cursor-default" data-testid="nav-students">
                <Users className="w-3.5 h-3.5" /> Students
              </span>
              <Link href="/tutor/assessments">
                <span className="flex items-center gap-2 px-4 py-2 text-[13px] font-medium text-muted-foreground hover:text-foreground/80 border-b-2 border-transparent transition-all cursor-pointer" data-testid="nav-assessments">
                  <BookOpen className="w-3.5 h-3.5" /> Assessments
                </span>
              </Link>
            </nav>
            <div className="flex items-center gap-3">
              <div
                className="w-9 h-9 rounded-xl flex items-center justify-center text-xs font-bold text-white shrink-0"
                style={{ background: "linear-gradient(135deg, rgba(139,92,246,0.3), rgba(99,102,241,0.2))", boxShadow: "0 0 24px rgba(139,92,246,0.2), inset 0 1px 0 rgba(255,255,255,0.08)", border: "1.5px solid rgba(139,92,246,0.4)" }}
              >
                {initials}
              </div>
              <div className="hidden sm:block">
                <p className="text-[13px] font-medium text-foreground leading-none">{displayName}</p>
                <p className="text-[9px] text-violet-400/70 font-bold uppercase tracking-[0.2em] mt-0.5">Tutor</p>
              </div>
            </div>
            <ThemeToggle />
            <button onClick={handleLogout} className="text-muted-foreground hover:text-foreground transition-colors p-2 min-h-[44px] min-w-[44px] rounded-lg hover:bg-foreground/[0.04]" aria-label="Log out">
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
      </header>

      {adoptFeedback && (
        <div className="fixed top-20 right-6 z-40 max-w-sm">
          <div className="glass-panel-elite px-4 py-3 border border-emerald-500/40 bg-emerald-500/10 text-sm text-emerald-200" role="status">
            {adoptFeedback}
          </div>
        </div>
      )}

      <main className="max-w-[1440px] mx-auto px-6 lg:px-10 py-7 space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h2 className="text-2xl font-bold text-foreground">My Students</h2>
            <p className="text-sm text-muted-foreground mt-1">{adoptedStudents.length} student{adoptedStudents.length !== 1 ? "s" : ""} in your cohort</p>
          </div>
          <button
            onClick={() => { setShowAdoptModal(true); setSelectedStudentIds(new Set()); setAdoptSearchQuery(""); }}
            className="flex items-center gap-2 px-5 py-2.5 min-h-[44px] rounded-xl text-sm font-medium bg-violet-500/20 text-violet-300 border border-violet-500/40 hover:bg-violet-500/30 transition-all"
            data-testid="button-adopt-students"
          >
            <UserPlus className="w-4 h-4" />
            Add Students
          </button>
        </div>

        {(adoptedStudents.length > 3 || searchQuery) && (
          <div className="relative">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search by name or email..."
              className="w-full h-12 pl-11 pr-4 rounded-xl bg-card/60 border border-card-border text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-violet-500/40"
              data-testid="input-search-students"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery("")}
                className="absolute right-3 top-1/2 -translate-y-1/2 p-2 text-muted-foreground hover:text-foreground/80"
                aria-label="Clear search"
                data-testid="button-clear-search-students"
              >
                <RotateCcw className="w-4 h-4" />
              </button>
            )}
          </div>
        )}

        {/* ── INVITE BY EMAIL ───────────────────────────────────────
            A tutor enters a student's email. If the email is already a
            registered student they're adopted immediately; otherwise an
            invitation row is created and auto-accepted on signup. */}
        <div className={`${GP} p-5`}>
          <div className="flex items-center gap-2.5 mb-3">
            <div className="w-7 h-7 rounded-lg flex items-center justify-center bg-violet-500/15 border border-violet-500/20">
              <Mail className="w-3.5 h-3.5 text-violet-400" />
            </div>
            <div>
              <h3 className="text-[13px] font-bold text-foreground tracking-wide">Invite a student</h3>
              <p className="text-[11px] text-muted-foreground">Already registered? They're added instantly. Otherwise we'll auto-adopt them on signup.</p>
            </div>
          </div>
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const email = inviteEmail.trim();
              if (!email) return;
              inviteMutation.mutate(email);
            }}
          >
            <input
              type="email"
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              placeholder="student@example.com"
              className="flex-1 h-11 px-4 rounded-xl bg-card/60 border border-card-border text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-violet-500/40"
              data-testid="input-invite-email"
              required
            />
            <button
              type="submit"
              disabled={inviteMutation.isPending || !inviteEmail.trim()}
              className="flex items-center gap-2 px-4 h-11 rounded-xl text-sm font-semibold bg-violet-500/20 text-violet-300 border border-violet-500/40 hover:bg-violet-500/30 disabled:opacity-50 transition-all"
              data-testid="button-send-invite"
            >
              {inviteMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <><Send className="w-3.5 h-3.5" /> Invite</>}
            </button>
          </form>

          {pendingInvites.length > 0 && (
            <div className="mt-5 pt-4 border-t border-border/60">
              <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-2">
                Pending invites ({pendingInvites.length})
              </p>
              <div className="space-y-1.5">
                {pendingInvites.map((inv) => (
                  <div
                    key={inv.id}
                    className="flex items-center gap-3 rounded-lg border border-border/60 bg-foreground/[0.03] px-3 py-2"
                    data-testid={`invite-${inv.id}`}
                  >
                    <div className="w-7 h-7 rounded-lg bg-amber-500/15 border border-amber-500/25 flex items-center justify-center shrink-0">
                      <Clock className="w-3.5 h-3.5 text-amber-400" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-[12px] font-medium text-foreground truncate">{inv.email}</p>
                      <p className="text-[10px] text-muted-foreground">
                        Invited {formatDistanceToNow(new Date(inv.createdAt), { addSuffix: true })}
                        {inv.lastSentAt !== inv.createdAt && <> · resent {formatDistanceToNow(new Date(inv.lastSentAt), { addSuffix: true })}</>}
                      </p>
                    </div>
                    <button
                      onClick={() => resendInviteMutation.mutate(inv.id)}
                      disabled={resendInviteMutation.isPending}
                      className="text-[11px] font-semibold text-violet-300 hover:text-violet-200 px-2 py-1 rounded hover:bg-violet-500/10 transition-all disabled:opacity-50"
                      data-testid={`button-resend-${inv.id}`}
                    >
                      Resend
                    </button>
                    <button
                      onClick={() => cancelInviteMutation.mutate(inv.id)}
                      disabled={cancelInviteMutation.isPending}
                      className="text-muted-foreground hover:text-red-400 p-1.5 rounded hover:bg-red-500/10 transition-all disabled:opacity-50"
                      aria-label="Cancel invite"
                      data-testid={`button-cancel-invite-${inv.id}`}
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {authLoading || studentsLoading ? (
          <div className="flex justify-center py-16">
            <Loader2 className="w-6 h-6 text-violet-500 animate-spin" />
          </div>
        ) : filteredStudents.length === 0 ? (
          <div className={`${GP} text-center py-14 px-6`}>
            <Users className="w-10 h-10 mx-auto text-muted-foreground mb-3" />
            <p className="text-[13px] text-muted-foreground font-medium">{searchQuery ? "No matching students found" : "No students yet"}</p>
            {!searchQuery && <p className="text-[11px] text-muted-foreground mt-1">Click "Add Students" to add students to your cohort</p>}
          </div>
        ) : (
          <div className="grid gap-3">
            {filteredStudents.map((student) => {
              const name = formatStudentName(student);
              const si = name.split(" ").map((n: string) => n[0]).join("").toUpperCase().slice(0, 2);
              return (
                <div
                  key={student.id}
                  className="group flex items-center gap-4 bg-card/60 backdrop-blur-md border border-card-border rounded-xl px-5 py-4 hover:border-border transition-all"
                  data-testid={`student-card-${student.id}`}
                >
                  <div className="w-10 h-10 rounded-full bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center text-xs font-bold text-emerald-300 shrink-0">
                    {si}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-foreground truncate">{name}</p>
                    {student.email && (
                      <p className="text-xs text-muted-foreground truncate">{student.email}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-4 shrink-0">
                    <Link href={`/tutor/students/${student.id}`}>
                      <span className="flex items-center gap-1 px-4 py-2 min-h-[44px] rounded-lg text-xs font-medium text-violet-300 bg-violet-500/10 border border-violet-500/20 hover:bg-violet-500/20 transition-all cursor-pointer" data-testid={`link-view-${student.id}`}>
                        View
                        <ChevronRight className="w-3 h-3" />
                      </span>
                    </Link>
                    <button
                      onClick={(e) => { e.stopPropagation(); setPendingRemoveId(student.id); }}
                      className="text-red-400/60 hover:text-red-400 transition-colors p-2 min-h-[44px] min-w-[44px] flex items-center justify-center rounded-lg hover:bg-red-500/10 border border-transparent hover:border-red-500/20"
                      title="Remove student"
                      aria-label={`Remove ${name}`}
                      data-testid={`button-remove-${student.id}`}
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </main>

      {pendingRemoveStudent && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-lg p-4"
          onClick={() => setPendingRemoveId(null)}
          role="dialog"
          aria-modal="true"
        >
          <div className="glass-panel-elite max-w-md w-full p-6" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start gap-3 mb-4">
              <div className="w-10 h-10 rounded-xl bg-red-500/15 border border-red-500/30 flex items-center justify-center shrink-0">
                <AlertTriangle className="w-5 h-5 text-red-400" />
              </div>
              <div>
                <h3 className="text-base font-bold text-foreground">Remove student?</h3>
                <p className="text-xs text-muted-foreground mt-1">
                  {formatStudentName(pendingRemoveStudent)}
                  {pendingRemoveStudent.email ? ` · ${pendingRemoveStudent.email}` : ""}
                </p>
              </div>
            </div>
            <p className="text-sm text-foreground/80 mb-5">
              They will be removed from your cohort. You can re-add them at any time from "Add Students".
            </p>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setPendingRemoveId(null)}
                className="px-4 py-2 min-h-[44px] rounded-lg text-sm font-medium text-foreground/80 bg-muted/60 border border-border hover:bg-muted transition-all"
                data-testid="button-cancel-remove"
              >
                Cancel
              </button>
              <button
                onClick={() => removeMutation.mutate(pendingRemoveStudent.id)}
                disabled={removeMutation.isPending}
                className="px-4 py-2 min-h-[44px] rounded-lg text-sm font-medium text-white bg-red-600 hover:bg-red-500 disabled:opacity-50 transition-all"
                data-testid="button-confirm-remove"
              >
                {removeMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : "Remove"}
              </button>
            </div>
          </div>
        </div>
      )}

      {showAdoptModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 backdrop-blur-lg p-4" onClick={() => setShowAdoptModal(false)}>
          <div className="glass-panel-elite max-w-lg w-full max-h-[85vh] overflow-hidden flex flex-col p-6" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between gap-3 mb-4">
              <div>
                <h3 className="text-base font-bold text-foreground">Add Students</h3>
                <p className="text-[11px] text-muted-foreground mt-0.5">Search by name or email, then select the accounts to add to your cohort.</p>
              </div>
              <button
                onClick={() => setShowAdoptModal(false)}
                className="text-muted-foreground hover:text-foreground/80 p-2 min-h-[40px] min-w-[40px] rounded-lg hover:bg-foreground/[0.05] transition-colors"
                aria-label="Close dialog"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {availableStudents.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">No students available to add</p>
            ) : (
              <>
                <div className="relative mb-3">
                  <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                  <input
                    type="text"
                    value={adoptSearchQuery}
                    onChange={(e) => setAdoptSearchQuery(e.target.value)}
                    placeholder="Search by name or email..."
                    className="w-full h-11 pl-11 pr-10 rounded-xl bg-card/60 border border-card-border text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-violet-500/40"
                    data-testid="input-search-adopt"
                    autoFocus
                  />
                  {adoptSearchQuery && (
                    <button
                      onClick={() => setAdoptSearchQuery("")}
                      className="absolute right-2 top-1/2 -translate-y-1/2 p-2 text-muted-foreground hover:text-foreground/80"
                      aria-label="Clear search"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>

                <div className="flex items-center justify-between text-[11px] text-muted-foreground mb-2 px-1">
                  <span>
                    {filteredAvailable.length} result{filteredAvailable.length !== 1 ? "s" : ""}
                    {selectedStudentIds.size > 0 ? ` · ${selectedStudentIds.size} selected` : ""}
                  </span>
                  {filteredAvailable.length > 0 && (
                    <button
                      onClick={toggleSelectAllVisible}
                      className="text-violet-300 hover:text-violet-200 font-medium"
                      data-testid="button-select-all-adopt"
                    >
                      {allVisibleSelected ? "Clear selection" : "Select all visible"}
                    </button>
                  )}
                </div>

                <div className="space-y-2 flex-1 overflow-y-auto pr-1">
                  {filteredAvailable.length === 0 ? (
                    <p className="text-xs text-muted-foreground text-center py-6">No matches for "{adoptSearchQuery}"</p>
                  ) : (
                    filteredAvailable.map((student) => {
                      const name = formatStudentName(student);
                      const si = name.split(" ").map((n: string) => n[0]).join("").toUpperCase().slice(0, 2);
                      const isSelected = selectedStudentIds.has(student.id);
                      return (
                        <button
                          key={student.id}
                          onClick={() => toggleStudentSelection(student.id)}
                          className={`w-full min-h-[56px] flex items-center gap-3 px-4 py-3 rounded-xl transition-all text-left ${
                            isSelected
                              ? "bg-violet-500/20 border-2 border-violet-500/60 ring-1 ring-violet-500/30"
                              : "bg-muted/40 border-2 border-border/50 hover:bg-muted/60 hover:border-border"
                          }`}
                          data-testid={`adopt-student-${student.id}`}
                          aria-pressed={isSelected}
                        >
                          <div className={`w-6 h-6 rounded-md border-2 flex items-center justify-center shrink-0 ${
                            isSelected ? "bg-violet-500 border-violet-500" : "border-slate-500"
                          }`}>
                            {isSelected && <Check className="w-4 h-4 text-white" strokeWidth={3} />}
                          </div>
                          <div className="w-9 h-9 rounded-full bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center text-[11px] font-bold text-emerald-300 shrink-0">
                            {si}
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-foreground truncate">{name}</p>
                            {student.email && (
                              <p className="flex items-center gap-1 text-[11px] text-muted-foreground truncate">
                                <Mail className="w-3 h-3 shrink-0" />
                                <span className="truncate">{student.email}</span>
                              </p>
                            )}
                          </div>
                        </button>
                      );
                    })
                  )}
                </div>

                <button
                  onClick={() => adoptMutation.mutate(Array.from(selectedStudentIds))}
                  disabled={selectedStudentIds.size === 0 || adoptMutation.isPending}
                  className="w-full mt-4 py-3 min-h-[48px] rounded-xl text-sm font-semibold bg-violet-600 text-white hover:bg-violet-500 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
                  data-testid="button-confirm-adopt"
                >
                  {adoptMutation.isPending ? (
                    <Loader2 className="w-4 h-4 animate-spin mx-auto" />
                  ) : (
                    `Add ${selectedStudentIds.size} Student${selectedStudentIds.size !== 1 ? "s" : ""}`
                  )}
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
