import { useState, useMemo, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import { supabase, authFetch } from "@/lib/supabase";
import { useSupabaseSession } from "@/hooks/use-supabase-session";
import {
  Users, UserPlus, X, Loader2, Check, ChevronRight,
  BookOpen, LogOut, LayoutDashboard, Search, RotateCcw,
} from "lucide-react";

interface SomaUser {
  id: string;
  email: string;
  displayName: string | null;
  role: string;
}

function formatStudentName(student: SomaUser): string {
  const fromDisplay = (student.displayName || "").trim();
  if (fromDisplay) return fromDisplay;
  const local = student.email.split("@")[0] || "Student";
  return local
    .replace(/[._-]+/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(" ");
}

const CARD_CLASS = "bg-slate-900/80 backdrop-blur-md border border-slate-800 rounded-2xl p-6 shadow-2xl";

export default function TutorStudents() {
  const queryClient = useQueryClient();
  const [, setLocation] = useLocation();
  const [showAdoptModal, setShowAdoptModal] = useState(false);
  const [selectedStudentIds, setSelectedStudentIds] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState("");

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
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/tutor/students"] });
      queryClient.invalidateQueries({ queryKey: ["/api/tutor/students/available"] });
      setShowAdoptModal(false);
      setSelectedStudentIds(new Set());
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
      formatStudentName(s).toLowerCase().includes(q)
    );
  }, [adoptedStudents, searchQuery]);

  const handleLogout = async () => {
    await supabase.auth.signOut();
    setLocation("/login");
  };

  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-800/60 bg-slate-950/80 backdrop-blur-xl sticky top-0 z-20">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <Link href="/">
            <div className="flex items-center gap-3 cursor-pointer">
              <img src="/MCEC - White Logo.png" alt="MCEC Logo" loading="lazy" className="h-10 w-auto object-contain" />
              <div>
                <h1 className="text-lg font-bold gradient-text">SOMA</h1>
                <p className="text-[10px] text-slate-400 tracking-widest uppercase">Tutor Portal</p>
              </div>
            </div>
          </Link>
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-3">
              <div
                className="w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold text-white"
                style={{ backgroundColor: "rgba(139,92,246,0.3)", boxShadow: "0 0 16px rgba(139,92,246,0.3)", border: "2px solid #8B5CF6" }}
              >
                {initials}
              </div>
              <div className="hidden sm:block">
                <p className="text-sm font-medium text-slate-200">{displayName}</p>
                <p className="text-[10px] text-violet-400 font-semibold uppercase tracking-wider">Tutor</p>
              </div>
            </div>
            <button onClick={handleLogout} className="text-slate-400 hover:text-slate-300 transition-colors p-2 min-h-[44px] min-w-[44px]" aria-label="Log out">
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
      </header>

      <nav className="border-b border-slate-800/40 bg-slate-950/40 backdrop-blur-md">
        <div className="max-w-6xl mx-auto px-6 flex gap-1">
          <Link href="/tutor">
            <span className="flex items-center gap-2 px-4 py-3 text-sm font-medium text-slate-400 hover:text-slate-300 border-b-2 border-transparent transition-all cursor-pointer" data-testid="nav-dashboard">
              <LayoutDashboard className="w-4 h-4" />
              Dashboard
            </span>
          </Link>
          <span className="flex items-center gap-2 px-4 py-3 text-sm font-medium text-violet-300 border-b-2 border-violet-500 cursor-default" data-testid="nav-students">
            <Users className="w-4 h-4" />
            Students
          </span>
          <Link href="/tutor/assessments">
            <span className="flex items-center gap-2 px-4 py-3 text-sm font-medium text-slate-400 hover:text-slate-300 border-b-2 border-transparent transition-all cursor-pointer" data-testid="nav-assessments">
              <BookOpen className="w-4 h-4" />
              Assessments
            </span>
          </Link>
        </div>
      </nav>

      <main className="max-w-6xl mx-auto px-6 py-8 space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h2 className="text-2xl font-bold text-slate-100">My Students</h2>
            <p className="text-sm text-slate-400 mt-1">{adoptedStudents.length} student{adoptedStudents.length !== 1 ? "s" : ""} in your cohort</p>
          </div>
          <button
            onClick={() => { setShowAdoptModal(true); setSelectedStudentIds(new Set()); }}
            className="flex items-center gap-2 px-5 py-2.5 min-h-[44px] rounded-xl text-sm font-medium bg-violet-500/20 text-violet-300 border border-violet-500/40 hover:bg-violet-500/30 transition-all"
            data-testid="button-adopt-students"
          >
            <UserPlus className="w-4 h-4" />
            Add Students
          </button>
        </div>

        {(adoptedStudents.length > 3 || searchQuery) && (
          <div className="relative">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search students..."
              className="w-full h-12 pl-11 pr-4 rounded-xl bg-slate-900/60 border border-slate-800 text-sm text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-violet-500/40"
              data-testid="input-search-students"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery("")}
                className="absolute right-3 top-1/2 -translate-y-1/2 p-2 text-slate-500 hover:text-slate-300"
                aria-label="Clear search"
                data-testid="button-clear-search-students"
              >
                <RotateCcw className="w-4 h-4" />
              </button>
            )}
          </div>
        )}

        {authLoading || studentsLoading ? (
          <div className="flex justify-center py-16">
            <Loader2 className="w-6 h-6 text-violet-500 animate-spin" />
          </div>
        ) : filteredStudents.length === 0 ? (
          <div className={`${CARD_CLASS} text-center py-12`}>
            <Users className="w-12 h-12 mx-auto text-slate-600 mb-4" />
            <p className="text-sm text-slate-400">{searchQuery ? "No matching students found" : "No students adopted yet"}</p>
            {!searchQuery && <p className="text-xs text-slate-500 mt-1">Click "Add Students" to add students to your cohort</p>}
          </div>
        ) : (
          <div className="grid gap-3">
            {filteredStudents.map((student) => {
              const name = formatStudentName(student);
              const si = name.split(" ").map((n: string) => n[0]).join("").toUpperCase().slice(0, 2);
              return (
                <div
                  key={student.id}
                  className="group flex items-center gap-4 bg-slate-900/60 backdrop-blur-md border border-slate-800 rounded-xl px-5 py-4 hover:border-slate-700 transition-all"
                  data-testid={`student-card-${student.id}`}
                >
                  <div className="w-10 h-10 rounded-full bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center text-xs font-bold text-emerald-300 shrink-0">
                    {si}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-slate-200">{name}</p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      onClick={(e) => { e.stopPropagation(); removeMutation.mutate(student.id); }}
                      className="text-red-400/40 hover:text-red-400 transition-colors p-2 min-h-[44px] min-w-[44px] flex items-center justify-center"
                      title="Remove student"
                      data-testid={`button-remove-${student.id}`}
                    >
                      <X className="w-4 h-4" />
                    </button>
                    <Link href={`/tutor/students/${student.id}`}>
                      <span className="flex items-center gap-1 px-3 py-2 min-h-[44px] rounded-lg text-xs font-medium text-violet-300 bg-violet-500/10 border border-violet-500/20 hover:bg-violet-500/20 transition-all cursor-pointer" data-testid={`link-view-${student.id}`}>
                        View
                        <ChevronRight className="w-3 h-3" />
                      </span>
                    </Link>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </main>

      {showAdoptModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={() => setShowAdoptModal(false)}>
          <div className="bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl max-w-lg w-full max-h-[80vh] overflow-y-auto p-6" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between gap-3 mb-5">
              <h3 className="text-lg font-bold text-slate-200">Add Students</h3>
              <button onClick={() => setShowAdoptModal(false)} className="text-slate-400 hover:text-slate-300 p-1">
                <X className="w-5 h-5" />
              </button>
            </div>
            {availableStudents.length === 0 ? (
              <p className="text-sm text-slate-400 text-center py-8">No students available to add</p>
            ) : (
              <>
                <div className="space-y-2 max-h-[50vh] overflow-y-auto">
                  {[...availableStudents].sort((a, b) => formatStudentName(a).localeCompare(formatStudentName(b))).map((student) => (
                    <button
                      key={student.id}
                      onClick={() => toggleStudentSelection(student.id)}
                      className={`w-full min-h-[44px] flex items-center gap-3 px-4 py-3 rounded-xl transition-all text-left ${
                        selectedStudentIds.has(student.id)
                          ? "bg-violet-500/20 border border-violet-500/40"
                          : "bg-slate-800/40 border border-slate-700/50 hover:bg-slate-800/60"
                      }`}
                      data-testid={`adopt-student-${student.id}`}
                    >
                      <div className={`w-5 h-5 rounded-md border flex items-center justify-center ${
                        selectedStudentIds.has(student.id) ? "bg-violet-500 border-violet-500" : "border-slate-600"
                      }`}>
                        {selectedStudentIds.has(student.id) && <Check className="w-3 h-3 text-white" />}
                      </div>
                      <div>
                        <p className="text-sm font-medium text-slate-200">{formatStudentName(student)}</p>
                      </div>
                    </button>
                  ))}
                </div>
                <button
                  onClick={() => adoptMutation.mutate(Array.from(selectedStudentIds))}
                  disabled={selectedStudentIds.size === 0 || adoptMutation.isPending}
                  className="w-full mt-4 py-3 min-h-[44px] rounded-xl text-sm font-medium bg-violet-600 text-white hover:bg-violet-500 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
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
