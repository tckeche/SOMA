import { useState, useEffect, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import { supabase } from "@/lib/supabase";
import { createIdentityHeaders } from "@/lib/identityHeaders";
import { useSupabaseSession } from "@/hooks/use-supabase-session";
import { getSubjectColor, getSubjectIcon } from "@/lib/subjectColors";
import { format } from "date-fns";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import type { SomaQuiz } from "@shared/schema";
import {
  Shield, Users, BookOpen, Trash2, LogOut,
  Loader2, AlertTriangle, Search, UserX, X,
  ShieldCheck, GraduationCap, UserCog,
} from "lucide-react";

const CARD_CLASS = "bg-slate-900/80 backdrop-blur-md border border-slate-800 rounded-2xl p-6 shadow-2xl";

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

export default function SuperAdminDashboard() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const [activeTab, setActiveTab] = useState<"users" | "quizzes">("users");
  const [searchQuery, setSearchQuery] = useState("");
  const [deleteConfirm, setDeleteConfirm] = useState<{ type: "user" | "quiz"; id: string | number; name: string } | null>(null);
  const [roleVerified, setRoleVerified] = useState(false);

  const { session, userId } = useSupabaseSession();
  const headers = useMemo(() => createIdentityHeaders("x-admin-id", userId), [userId]);

  useEffect(() => {
    if (!userId) return;
    const email = encodeURIComponent(session?.user?.email || "");
    fetch(`/api/auth/me?userId=${userId}&email=${email}`)
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
      const res = await fetch("/api/super-admin/stats", { headers });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
    enabled: !!userId && roleVerified,
    refetchInterval: 15000,
    refetchOnWindowFocus: true,
  });

  const { data: users = [], isLoading: usersLoading } = useQuery<SomaUser[]>({
    queryKey: ["/api/super-admin/users", userId],
    queryFn: async () => {
      const res = await fetch("/api/super-admin/users", { headers });
      if (!res.ok) return [];
      return res.json();
    },
    enabled: !!userId && roleVerified,
    refetchInterval: 15000,
    refetchOnWindowFocus: true,
  });

  const { data: quizzes = [], isLoading: quizzesLoading } = useQuery<SomaQuiz[]>({
    queryKey: ["/api/super-admin/quizzes", userId],
    queryFn: async () => {
      const res = await fetch("/api/super-admin/quizzes", { headers });
      if (!res.ok) return [];
      return res.json();
    },
    enabled: !!userId && roleVerified,
    refetchInterval: 15000,
    refetchOnWindowFocus: true,
  });

  const deleteUserMutation = useMutation({
    mutationFn: async (targetId: string) => {
      const res = await fetch(`/api/super-admin/users/${targetId}`, { method: "DELETE", headers });
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
      const res = await fetch(`/api/super-admin/quizzes/${quizId}`, { method: "DELETE", headers });
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

  const roleIcon = (role: string) => {
    if (role === "super_admin") return <ShieldCheck className="w-3.5 h-3.5" />;
    if (role === "tutor") return <UserCog className="w-3.5 h-3.5" />;
    return <GraduationCap className="w-3.5 h-3.5" />;
  };

  const roleBadgeClass = (role: string) => {
    if (role === "super_admin") return "bg-red-500/10 text-red-400 border-red-500/30";
    if (role === "tutor") return "bg-violet-500/10 text-violet-400 border-violet-500/30";
    return "bg-emerald-500/10 text-emerald-400 border-emerald-500/30";
  };

  if (!roleVerified) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="w-8 h-8 text-red-500 animate-spin" />
      </div>
    );
  }

  return (
    <div className="min-h-screen">
      <header className="border-b border-red-900/40 bg-slate-950/90 backdrop-blur-xl sticky top-0 z-20">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <Link href="/">
            <div className="flex items-center gap-3 cursor-pointer">
              <img src="/MCEC - White Logo.png" alt="MCEC Logo" loading="lazy" className="h-10 w-auto object-contain" />
              <div>
                <h1 className="text-lg font-bold gradient-text">SOMA</h1>
                <p className="text-[10px] text-red-400 tracking-widest uppercase font-semibold">Super Admin</p>
              </div>
            </div>
          </Link>
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <div
                className="w-10 h-10 rounded-full flex items-center justify-center"
                style={{ backgroundColor: "rgba(239,68,68,0.2)", boxShadow: "0 0 20px rgba(239,68,68,0.3)", border: "2px solid #EF4444" }}
              >
                <Shield className="w-5 h-5 text-red-400" />
              </div>
              <div className="hidden sm:block">
                <p className="text-sm font-medium text-slate-200">{session?.user?.email?.split("@")[0]}</p>
                <p className="text-[10px] text-red-400 font-semibold uppercase tracking-wider">Super Admin</p>
              </div>
            </div>
            <button onClick={handleLogout} className="text-slate-400 hover:text-slate-300 transition-colors p-2 min-h-[44px] min-w-[44px]" aria-label="Log out" data-testid="button-logout">
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-8 space-y-6">
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
          <StatCard label="Total Users" value={stats?.totalUsers ?? 0} color="#EF4444" icon={Users} />
          <StatCard label="Students" value={stats?.totalStudents ?? 0} color="#10B981" icon={GraduationCap} />
          <StatCard label="Tutors" value={stats?.totalTutors ?? 0} color="#8B5CF6" icon={UserCog} />
          <StatCard label="Assessments" value={stats?.totalQuizzes ?? 0} color="#3B82F6" icon={BookOpen} />
          <StatCard label="Published" value={stats?.publishedQuizzes ?? 0} color="#F59E0B" icon={ShieldCheck} />
        </div>

        <div className="flex flex-col sm:flex-row gap-3">
          <div className="flex gap-2">
            <button
              onClick={() => { setActiveTab("users"); setSearchQuery(""); }}
              className={`flex items-center gap-2 px-5 py-2.5 min-h-[44px] rounded-xl text-sm font-medium transition-all ${
                activeTab === "users"
                  ? "bg-red-500/20 text-red-300 border border-red-500/40"
                  : "bg-slate-800/40 text-slate-400 border border-slate-700/50 hover:bg-slate-800/60"
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
                  ? "bg-red-500/20 text-red-300 border border-red-500/40"
                  : "bg-slate-800/40 text-slate-400 border border-slate-700/50 hover:bg-slate-800/60"
              }`}
              data-testid="tab-quizzes"
            >
              <BookOpen className="w-4 h-4" />
              Assessments ({quizzes.length})
            </button>
          </div>
          <div className="relative flex-1">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={`Search ${activeTab}...`}
              className="w-full h-12 pl-11 pr-4 rounded-xl bg-slate-900/60 border border-slate-800 text-sm text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-red-500/40"
              data-testid="input-search"
            />
          </div>
        </div>

        {activeTab === "users" && (
          <section>
            {usersLoading ? (
              <div className="flex justify-center py-16"><Loader2 className="w-6 h-6 text-red-500 animate-spin" /></div>
            ) : filteredUsers.length === 0 ? (
              <div className={`${CARD_CLASS} text-center py-12`}>
                <Users className="w-12 h-12 mx-auto text-slate-600 mb-4" />
                <p className="text-sm text-slate-400">{searchQuery ? "No matching users" : "No users found"}</p>
              </div>
            ) : (
              <div className="space-y-2">
                {filteredUsers.map((user) => (
                  <div
                    key={user.id}
                    className="flex items-center gap-4 bg-slate-900/60 backdrop-blur-md border border-slate-800 rounded-xl px-5 py-3.5"
                    data-testid={`user-row-${user.id}`}
                  >
                    <div className="w-9 h-9 rounded-full flex items-center justify-center text-xs font-bold shrink-0"
                      style={{
                        backgroundColor: user.role === "super_admin" ? "rgba(239,68,68,0.2)" : user.role === "tutor" ? "rgba(139,92,246,0.2)" : "rgba(16,185,129,0.2)",
                        border: `1.5px solid ${user.role === "super_admin" ? "#EF4444" : user.role === "tutor" ? "#8B5CF6" : "#10B981"}`,
                        color: user.role === "super_admin" ? "#EF4444" : user.role === "tutor" ? "#8B5CF6" : "#10B981",
                      }}
                    >
                      {(user.displayName || user.email)[0]?.toUpperCase()}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-slate-200 truncate">{user.displayName || user.email.split("@")[0]}</p>
                      <p className="text-xs text-slate-400">{user.email}</p>
                    </div>
                    <Badge className={`text-[10px] font-semibold border ${roleBadgeClass(user.role)} flex items-center gap-1`} data-testid={`badge-role-${user.id}`}>
                      {roleIcon(user.role)}
                      {user.role}
                    </Badge>
                    <p className="text-[10px] text-slate-500 hidden md:block shrink-0">
                      {user.createdAt ? format(new Date(user.createdAt), "PP") : ""}
                    </p>
                    {user.role !== "super_admin" && (
                      <button
                        onClick={() => setDeleteConfirm({ type: "user", id: user.id, name: user.displayName || user.email })}
                        className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center text-red-400/40 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-all shrink-0"
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
              <div className="flex justify-center py-16"><Loader2 className="w-6 h-6 text-red-500 animate-spin" /></div>
            ) : filteredQuizzes.length === 0 ? (
              <div className={`${CARD_CLASS} text-center py-12`}>
                <BookOpen className="w-12 h-12 mx-auto text-slate-600 mb-4" />
                <p className="text-sm text-slate-400">{searchQuery ? "No matching assessments" : "No assessments found"}</p>
              </div>
            ) : (
              <div className="space-y-2">
                {filteredQuizzes.map((quiz) => {
                  const sc = getSubjectColor(quiz.subject);
                  const SubIcon = getSubjectIcon(quiz.subject);
                  return (
                    <div
                      key={quiz.id}
                      className="flex items-center gap-4 bg-slate-900/60 backdrop-blur-md border border-slate-800 rounded-xl px-5 py-3.5"
                      data-testid={`quiz-row-${quiz.id}`}
                    >
                      <div className={`w-9 h-9 rounded-lg flex items-center justify-center border ${sc.border} shrink-0`} style={{ backgroundColor: `${sc.hex}15` }}>
                        <SubIcon className="w-4 h-4" style={{ color: sc.hex }} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-slate-200 truncate">{quiz.title}</p>
                        <p className="text-xs text-slate-400">{quiz.topic} | {quiz.level}</p>
                      </div>
                      <Badge className={`text-[10px] font-semibold border ${
                        quiz.status === "published" ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/30" : "bg-amber-500/10 text-amber-400 border-amber-500/30"
                      }`}>
                        {quiz.status}
                      </Badge>
                      <p className="text-[10px] text-slate-500 hidden md:block shrink-0">
                        {quiz.createdAt ? format(new Date(quiz.createdAt), "PP") : ""}
                      </p>
                      <button
                        onClick={() => setDeleteConfirm({ type: "quiz", id: quiz.id, name: quiz.title })}
                        className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center text-red-400/40 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-all shrink-0"
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
      </main>

      {deleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4" onClick={() => setDeleteConfirm(null)}>
          <div className="bg-slate-900 border border-red-900/50 rounded-2xl shadow-2xl max-w-md w-full p-6" onClick={(e) => e.stopPropagation()} data-testid="modal-delete-confirm">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-full bg-red-500/20 border border-red-500/40 flex items-center justify-center">
                <AlertTriangle className="w-5 h-5 text-red-400" />
              </div>
              <div>
                <h3 className="text-lg font-bold text-slate-100">Confirm Deletion</h3>
                <p className="text-xs text-slate-400">This action cannot be undone</p>
              </div>
            </div>
            <p className="text-sm text-slate-300 mb-6">
              Are you sure you want to permanently delete{" "}
              <span className="font-semibold text-red-300">{deleteConfirm.name}</span>?
              {deleteConfirm.type === "user" && " All their data, reports, and comments will also be removed."}
              {deleteConfirm.type === "quiz" && " All questions, reports, and assignments for this assessment will also be removed."}
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setDeleteConfirm(null)}
                className="flex-1 py-3 min-h-[44px] rounded-xl text-sm font-medium bg-slate-800 text-slate-300 border border-slate-700 hover:bg-slate-700 transition-all"
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
                className="flex-1 py-3 min-h-[44px] rounded-xl text-sm font-medium bg-red-600 text-white hover:bg-red-500 disabled:opacity-50 transition-all flex items-center justify-center gap-2"
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

function StatCard({ label, value, color, icon: Icon }: { label: string; value: number; color: string; icon: any }) {
  return (
    <div
      className={CARD_CLASS}
      style={{ borderColor: `${color}20` }}
      data-testid={`stat-${label.toLowerCase().replace(/\s+/g, "-")}`}
    >
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ backgroundColor: `${color}15`, border: `1px solid ${color}30` }}>
          <Icon className="w-5 h-5" style={{ color }} />
        </div>
        <div>
          <p className="text-xl font-bold text-slate-100">{value}</p>
          <p className="text-[10px] text-slate-400 uppercase tracking-wider">{label}</p>
        </div>
      </div>
    </div>
  );
}
