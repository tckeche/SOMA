import { useState, useEffect, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import { supabase, authFetch } from "@/lib/supabase";
import { useSupabaseSession } from "@/hooks/use-supabase-session";
import { getLevelColor, getSubjectIcon } from "@/lib/subjectColors";
import { format, formatDistanceToNow } from "date-fns";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import type { SomaQuiz } from "@shared/schema";
import {
  Shield, Users, BookOpen, Trash2, LogOut,
  Loader2, AlertTriangle, Search, UserX, X,
  ShieldCheck, GraduationCap, UserCog, ChevronRight, Activity, ClipboardCheck, Bug,
} from "lucide-react";
import { ThemeToggle } from "@/components/ThemeToggle";
import { SuperAdminAIUsage } from "@/components/SuperAdminAIUsage";
import { SuperAdminExaminerInsightsReview } from "@/components/SuperAdminExaminerInsightsReview";

const CARD_CLASS = "glass-card backdrop-blur-md p-6";

interface SomaUser {
  id: string;
  email: string;
  displayName: string | null;
  role: string;
  createdAt: string;
}

interface AdminStats {
  totalUsers: number;
  totalStudents: number;
  totalTutors: number;
  totalQuizzes: number;
  publishedQuizzes: number;
}

interface TutorSummary {
  tutorId: string;
  tutorEmail: string;
  tutorName: string | null;
  adoptedStudentsCount: number;
  assessmentsCompletedCount: number;
  averageStudentGrade: number | null;
  subjects: string[];
  lastLoginAt: string | null;
}

export default function SuperAdminDashboard() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const [activeTab, setActiveTab] = useState<"users" | "quizzes" | "tutors" | "ai" | "insights">("tutors");
  const [searchQuery, setSearchQuery] = useState("");
  const [deleteConfirm, setDeleteConfirm] = useState<{ type: "user" | "quiz"; id: string | number; name: string } | null>(null);
  const [roleVerified, setRoleVerified] = useState(false);

  const { session, userId } = useSupabaseSession();

  useEffect(() => {
    if (!userId) return;
    authFetch("/api/auth/me")
      .then((r) => r.json())
      .then((data) => {
        if (data.role !== "super_admin") {
          setLocation("/dashboard");
        } else {
          setRoleVerified(true);
        }
      })
      .catch(() => setLocation("/login"));
  }, [userId, setLocation]);

  const { data: stats } = useQuery<AdminStats>({
    queryKey: ["/api/super-admin/stats", userId],
    queryFn: async () => {
      const res = await authFetch("/api/super-admin/stats");
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
    enabled: !!userId && roleVerified,
    refetchInterval: 60000,
    refetchOnWindowFocus: true,
  });

  const { data: users = [], isLoading: usersLoading } = useQuery<SomaUser[]>({
    queryKey: ["/api/super-admin/users", userId],
    queryFn: async () => {
      const res = await authFetch("/api/super-admin/users");
      if (!res.ok) return [];
      return res.json();
    },
    enabled: !!userId && roleVerified,
    refetchInterval: 60000,
    refetchOnWindowFocus: true,
  });

  const { data: quizzes = [], isLoading: quizzesLoading } = useQuery<SomaQuiz[]>({
    queryKey: ["/api/super-admin/quizzes", userId],
    queryFn: async () => {
      const res = await authFetch("/api/super-admin/quizzes");
      if (!res.ok) return [];
      return res.json();
    },
    enabled: !!userId && roleVerified,
    refetchInterval: 60000,
    refetchOnWindowFocus: true,
  });

  const { data: tutors = [], isLoading: tutorsLoading } = useQuery<TutorSummary[]>({
    queryKey: ["/api/super-admin/tutors", userId],
    queryFn: async () => {
      const res = await authFetch("/api/super-admin/tutors");
      if (!res.ok) return [];
      return res.json();
    },
    enabled: !!userId && roleVerified,
    refetchInterval: 60000,
    refetchOnWindowFocus: true,
  });

  const deleteUserMutation = useMutation({
    mutationFn: async (targetId: string) => {
      const res = await authFetch(`/api/super-admin/users/${targetId}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.message || "Failed to delete");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/super-admin/users"] });
      queryClient.invalidateQueries({ queryKey: ["/api/super-admin/stats"] });
      setDeleteConfirm(null);
      toast({ title: "User deleted" });
    },
    onError: (err: any) => {
      toast({ title: "Delete failed", description: err.message, variant: "destructive" });
    },
  });

  const deleteQuizMutation = useMutation({
    mutationFn: async (quizId: number) => {
      const res = await authFetch(`/api/super-admin/quizzes/${quizId}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to delete");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/super-admin/quizzes"] });
      queryClient.invalidateQueries({ queryKey: ["/api/super-admin/stats"] });
      setDeleteConfirm(null);
      toast({ title: "Assessment deleted" });
    },
    onError: (err: any) => {
      toast({ title: "Delete failed", description: err.message, variant: "destructive" });
    },
  });

  const handleLogout = async () => {
    await supabase.auth.signOut();
    setLocation("/login");
  };

  const filteredUsers = useMemo(() => {
    if (!searchQuery.trim()) return users;
    const q = searchQuery.toLowerCase();
    return users.filter((u) =>
      u.email.toLowerCase().includes(q) ||
      (u.displayName || "").toLowerCase().includes(q) ||
      u.role.toLowerCase().includes(q)
    );
  }, [users, searchQuery]);

  const filteredQuizzes = useMemo(() => {
    if (!searchQuery.trim()) return quizzes;
    const q = searchQuery.toLowerCase();
    return quizzes.filter((qz) =>
      qz.title.toLowerCase().includes(q) ||
      (qz.subject || "").toLowerCase().includes(q) ||
      (qz.topic || "").toLowerCase().includes(q)
    );
  }, [quizzes, searchQuery]);

  const filteredTutors = useMemo(() => {
    if (!searchQuery.trim()) return tutors;
    const q = searchQuery.toLowerCase();
    return tutors.filter((t) =>
      t.tutorEmail.toLowerCase().includes(q)
      || (t.tutorName || "").toLowerCase().includes(q)
      || t.subjects.some((s) => s.toLowerCase().includes(q))
    );
  }, [tutors, searchQuery]);

  const roleIcon = (role: string) => {
    if (role === "super_admin") return <ShieldCheck className="w-3.5 h-3.5" />;
    if (role === "tutor") return <UserCog className="w-3.5 h-3.5" />;
    return <GraduationCap className="w-3.5 h-3.5" />;
  };

  const roleBadgeClass = (role: string) => {
    if (role === "super_admin") return "chip chip-danger";
    if (role === "tutor") return "chip chip-brand";
    return "chip chip-success";
  };

  if (!roleVerified) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="w-8 h-8 text-danger animate-spin" />
      </div>
    );
  }

  return (
    <div className="min-h-screen">
      <header className="border-b border-danger/30 bg-background/95 backdrop-blur-xl sticky top-0 z-20">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <Link href="/">
            <div className="flex items-center gap-3 cursor-pointer">
              <img src="/MCEC - White Logo.png" alt="MCEC Logo" loading="lazy" className="h-10 w-auto object-contain brightness-0 dark:brightness-100" />
              <div>
                <h1 className="text-lg soma-display gradient-text">SOMA</h1>
                <p className="eyebrow text-danger">Super Admin</p>
              </div>
            </div>
          </Link>
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <div
                className="w-10 h-10 rounded-full flex items-center justify-center bg-danger/20 border-2 border-danger"
                style={{ boxShadow: "0 0 20px hsl(var(--destructive) / 0.3)" }}
              >
                <Shield className="w-5 h-5 text-danger" />
              </div>
              <div className="hidden sm:block">
                <p className="text-sm font-medium text-foreground">{session?.user?.email?.split("@")[0]}</p>
                <p className="eyebrow text-danger">Super Admin</p>
              </div>
            </div>
            <Link href="/super-admin/diagnostics">
              <button className="hidden sm:inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-danger/30 bg-danger/10 text-xs text-danger hover:bg-danger/20" data-testid="link-diagnostics">
                <Bug className="w-4 h-4" /> Diagnostics
              </button>
            </Link>
            <ThemeToggle />
            <button onClick={handleLogout} className="text-muted-foreground hover:text-foreground transition-colors p-2 min-h-[44px] min-w-[44px]" aria-label="Log out" data-testid="button-logout">
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-8 space-y-6">
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
          <StatCard label="Total Users" value={stats?.totalUsers ?? 0} tone="primary" icon={Users} />
          <StatCard label="Students" value={stats?.totalStudents ?? 0} tone="success" icon={GraduationCap} />
          <StatCard label="Tutors" value={stats?.totalTutors ?? 0} tone="info" icon={UserCog} />
          <StatCard label="Assessments" value={stats?.totalQuizzes ?? 0} tone="primary" icon={BookOpen} />
          <StatCard label="Published" value={stats?.publishedQuizzes ?? 0} tone="warning" icon={ShieldCheck} />
        </div>

        <div className="flex flex-col sm:flex-row gap-3">
          <div className="flex gap-2">
            <button
              onClick={() => { setActiveTab("tutors"); setSearchQuery(""); }}
              className={`flex items-center gap-2 px-5 py-2.5 min-h-[44px] rounded-xl text-sm font-medium transition-all ${
                activeTab === "tutors"
                  ? "bg-danger/20 text-danger border border-danger/40"
                  : "bg-muted/40 text-muted-foreground border border-border/50 hover:bg-muted/60"
              }`}
              data-testid="tab-tutors"
            >
              <UserCog className="w-4 h-4" />
              Tutor Dashboard ({tutors.length})
            </button>
            <button
              onClick={() => { setActiveTab("users"); setSearchQuery(""); }}
              className={`flex items-center gap-2 px-5 py-2.5 min-h-[44px] rounded-xl text-sm font-medium transition-all ${
                activeTab === "users"
                  ? "bg-danger/20 text-danger border border-danger/40"
                  : "bg-muted/40 text-muted-foreground border border-border/50 hover:bg-muted/60"
              }`}
              data-testid="tab-users"
            >
              <Users className="w-4 h-4" />
              Users ({users.length})
            </button>
            <button
              onClick={() => { setActiveTab("quizzes"); setSearchQuery(""); }}
              className={`flex items-center gap-2 px-5 py-2.5 min-h-[44px] rounded-xl text-sm font-medium transition-all ${
                activeTab === "quizzes"
                  ? "bg-danger/20 text-danger border border-danger/40"
                  : "bg-muted/40 text-muted-foreground border border-border/50 hover:bg-muted/60"
              }`}
              data-testid="tab-quizzes"
            >
              <BookOpen className="w-4 h-4" />
              Assessments ({quizzes.length})
            </button>
            <button
              onClick={() => { setActiveTab("ai"); setSearchQuery(""); }}
              className={`flex items-center gap-2 px-5 py-2.5 min-h-[44px] rounded-xl text-sm font-medium transition-all ${
                activeTab === "ai"
                  ? "bg-danger/20 text-danger border border-danger/40"
                  : "bg-muted/40 text-muted-foreground border border-border/50 hover:bg-muted/60"
              }`}
              data-testid="tab-ai-usage"
            >
              <Activity className="w-4 h-4" />
              AI Usage
            </button>
            <button
              onClick={() => { setActiveTab("insights"); setSearchQuery(""); }}
              className={`flex items-center gap-2 px-5 py-2.5 min-h-[44px] rounded-xl text-sm font-medium transition-all ${
                activeTab === "insights"
                  ? "bg-danger/20 text-danger border border-danger/40"
                  : "bg-muted/40 text-muted-foreground border border-border/50 hover:bg-muted/60"
              }`}
              data-testid="tab-insights"
            >
              <ClipboardCheck className="w-4 h-4" />
              Insights
            </button>
          </div>
          <div className="relative flex-1">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={`Search ${activeTab}...`}
              className="w-full h-12 pl-11 pr-4 rounded-xl bg-card/60 border border-card-border text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-danger/40"
              data-testid="input-search"
            />
          </div>
        </div>

        {activeTab === "tutors" && (
          <section>
            {tutorsLoading ? (
              <div className="flex justify-center py-16"><Loader2 className="w-6 h-6 text-danger animate-spin" /></div>
            ) : filteredTutors.length === 0 ? (
              <div className={`${CARD_CLASS} text-center py-12`}>
                <UserCog className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
                <p className="text-sm text-muted-foreground">{searchQuery ? "No matching tutors" : "No tutors found yet"}</p>
              </div>
            ) : (
              <div className="overflow-x-auto bg-card/50 border border-card-border rounded-xl">
                <table className="w-full text-sm">
                  <thead className="text-muted-foreground border-b border-card-border">
                    <tr>
                      <th className="text-left px-4 py-3">Tutor</th>
                      <th className="text-left px-4 py-3">Students</th>
                      <th className="text-left px-4 py-3">Completed</th>
                      <th className="text-left px-4 py-3">Avg Grade</th>
                      <th className="text-left px-4 py-3">Last Login</th>
                      <th className="text-left px-4 py-3">Subjects</th>
                      <th className="text-right px-4 py-3">Details</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredTutors.map((tutor) => (
                      <tr key={tutor.tutorId} className="border-b border-card-border/60 hover:bg-muted/40">
                        <td className="px-4 py-3">
                          <p className="text-foreground font-medium">{tutor.tutorName || tutor.tutorEmail.split("@")[0]}</p>
                          <p className="text-xs text-muted-foreground">{tutor.tutorEmail}</p>
                        </td>
                        <td className="px-4 py-3 text-foreground">{tutor.adoptedStudentsCount}</td>
                        <td className="px-4 py-3 text-foreground">{tutor.assessmentsCompletedCount}</td>
                        <td className="px-4 py-3 text-foreground">{tutor.averageStudentGrade !== null ? `${tutor.averageStudentGrade}%` : "—"}</td>
                        <td className="px-4 py-3 text-muted-foreground text-xs">
                          {tutor.lastLoginAt ? formatDistanceToNow(new Date(tutor.lastLoginAt), { addSuffix: true }) : "Not tracked yet"}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex flex-wrap gap-1">
                            {tutor.subjects.length ? tutor.subjects.map((subj) => (
                              <Badge key={subj} className="text-[10px] bg-muted border-border text-foreground/80">{subj}</Badge>
                            )) : <span className="text-xs text-muted-foreground">No subjects</span>}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-right">
                          <Link href={`/super-admin/tutors/${tutor.tutorId}`}>
                            <button className="inline-flex items-center gap-1 text-danger hover:text-danger/80">
                              View <ChevronRight className="w-4 h-4" />
                            </button>
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )}

        {activeTab === "users" && (
          <section>
            {usersLoading ? (
              <div className="flex justify-center py-16"><Loader2 className="w-6 h-6 text-danger animate-spin" /></div>
            ) : filteredUsers.length === 0 ? (
              <div className={`${CARD_CLASS} text-center py-12`}>
                <Users className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
                <p className="text-sm text-muted-foreground">{searchQuery ? "No matching users" : "No users found"}</p>
              </div>
            ) : (
              <div className="space-y-2">
                {filteredUsers.map((user) => (
                  <div
                    key={user.id}
                    className="flex items-center gap-4 glass-card px-5 py-3.5"
                    data-testid={`user-row-${user.id}`}
                  >
                    <div className="w-9 h-9 rounded-full flex items-center justify-center text-xs font-bold shrink-0"
                      style={{
                        backgroundColor: user.role === "super_admin" ? "hsl(var(--destructive) / 0.2)" : user.role === "tutor" ? "hsl(var(--primary) / 0.2)" : "hsl(var(--success) / 0.2)",
                        border: `1.5px solid ${user.role === "super_admin" ? "hsl(var(--destructive))" : user.role === "tutor" ? "hsl(var(--primary))" : "hsl(var(--success))"}`,
                        color: user.role === "super_admin" ? "hsl(var(--destructive))" : user.role === "tutor" ? "hsl(var(--primary))" : "hsl(var(--success))",
                      }}
                    >
                      {(user.displayName || user.email)[0]?.toUpperCase()}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-foreground truncate">{user.displayName || user.email.split("@")[0]}</p>
                      <p className="text-xs text-muted-foreground">{user.email}</p>
                    </div>
                    <Badge className={`${roleBadgeClass(user.role)}`} data-testid={`badge-role-${user.id}`}>
                      {roleIcon(user.role)}
                      {user.role}
                    </Badge>
                    <p className="text-[10px] text-muted-foreground hidden md:block shrink-0">
                      {user.createdAt ? format(new Date(user.createdAt), "PP") : ""}
                    </p>
                    {user.role !== "super_admin" && (
                      <button
                        onClick={() => setDeleteConfirm({ type: "user", id: user.id, name: user.displayName || user.email })}
                        className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center text-danger/40 hover:text-danger hover:bg-danger/10 rounded-lg transition-all shrink-0"
                        data-testid={`button-delete-user-${user.id}`}
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>
        )}

        {activeTab === "quizzes" && (
          <section>
            {quizzesLoading ? (
              <div className="flex justify-center py-16"><Loader2 className="w-6 h-6 text-danger animate-spin" /></div>
            ) : filteredQuizzes.length === 0 ? (
              <div className={`${CARD_CLASS} text-center py-12`}>
                <BookOpen className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
                <p className="text-sm text-muted-foreground">{searchQuery ? "No matching assessments" : "No assessments found"}</p>
              </div>
            ) : (
              <div className="space-y-2">
                {filteredQuizzes.map((quiz) => {
                  const sc = getLevelColor(quiz.level);
                  const SubIcon = getSubjectIcon(quiz.subject);
                  return (
                    <div
                      key={quiz.id}
                      className="flex items-center gap-4 glass-card px-5 py-3.5"
                      data-testid={`quiz-row-${quiz.id}`}
                    >
                      <div className={`w-9 h-9 rounded-lg flex items-center justify-center border ${sc.border} ${sc.bg} shrink-0`}>
                        <SubIcon className={`w-4 h-4 ${sc.label}`} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-foreground truncate">{quiz.title}</p>
                        <p className="text-xs text-muted-foreground">{quiz.topic} | {quiz.level}</p>
                      </div>
                      <Badge className={`chip ${
                        quiz.status === "published" ? "chip-success" : "chip-warning"
                      }`}>
                        {quiz.status}
                      </Badge>
                      <p className="text-[10px] text-muted-foreground hidden md:block shrink-0">
                        {quiz.createdAt ? format(new Date(quiz.createdAt), "PP") : ""}
                      </p>
                      <button
                        onClick={() => setDeleteConfirm({ type: "quiz", id: quiz.id, name: quiz.title })}
                        className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center text-danger/40 hover:text-danger hover:bg-danger/10 rounded-lg transition-all shrink-0"
                        data-testid={`button-delete-quiz-${quiz.id}`}
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        )}

        {activeTab === "ai" && <SuperAdminAIUsage />}
        {activeTab === "insights" && <SuperAdminExaminerInsightsReview />}
      </main>

      {deleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4" onClick={() => setDeleteConfirm(null)}>
          <div className="glass-panel-elite border-danger/40 max-w-md w-full p-6" onClick={(e) => e.stopPropagation()} data-testid="modal-delete-confirm">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-full bg-danger/20 border border-danger/40 flex items-center justify-center">
                <AlertTriangle className="w-5 h-5 text-danger" />
              </div>
              <div>
                <h3 className="text-lg font-bold text-foreground">Confirm Deletion</h3>
                <p className="text-xs text-muted-foreground">This action cannot be undone</p>
              </div>
            </div>
            <p className="text-sm text-foreground/80 mb-6">
              Are you sure you want to permanently delete{" "}
              <span className="font-semibold text-danger">{deleteConfirm.name}</span>?
              {deleteConfirm.type === "user" && " All their data, reports, and comments will also be removed."}
              {deleteConfirm.type === "quiz" && " All questions, reports, and assignments for this assessment will also be removed."}
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setDeleteConfirm(null)}
                className="flex-1 py-3 min-h-[44px] rounded-xl text-sm font-medium bg-muted text-foreground/80 border border-border hover:bg-muted/70 transition-all"
                data-testid="button-cancel-delete"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  if (deleteConfirm.type === "user") deleteUserMutation.mutate(deleteConfirm.id as string);
                  else deleteQuizMutation.mutate(deleteConfirm.id as number);
                }}
                disabled={deleteUserMutation.isPending || deleteQuizMutation.isPending}
                className="flex-1 py-3 min-h-[44px] rounded-xl text-sm font-medium bg-danger text-white hover:bg-danger/90 disabled:opacity-50 transition-all flex items-center justify-center gap-2"
                data-testid="button-confirm-delete"
              >
                {(deleteUserMutation.isPending || deleteQuizMutation.isPending) ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <>
                    <Trash2 className="w-4 h-4" />
                    Hard Delete
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const STAT_TONES: Record<string, string> = {
  primary: "var(--primary)",
  success: "var(--success)",
  info: "var(--info)",
  warning: "var(--warning)",
  danger: "var(--destructive)",
};

function StatCard({ label, value, tone, icon: Icon }: { label: string; value: number; tone: keyof typeof STAT_TONES; icon: any }) {
  const v = STAT_TONES[tone] ?? STAT_TONES.primary;
  return (
    <div
      className={CARD_CLASS}
      style={{ borderColor: `hsl(${v} / 0.2)` }}
      data-testid={`stat-${label.toLowerCase().replace(/\s+/g, "-")}`}
    >
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ backgroundColor: `hsl(${v} / 0.12)`, border: `1px solid hsl(${v} / 0.3)` }}>
          <Icon className="w-5 h-5" style={{ color: `hsl(${v})` }} />
        </div>
        <div>
          <p className="text-xl font-bold text-foreground">{value}</p>
          <p className="text-[10px] text-muted-foreground uppercase tracking-wider">{label}</p>
        </div>
      </div>
    </div>
  );
}
