import { useState, useMemo, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import { supabase, authFetch } from "@/lib/supabase";
import { useSupabaseSession } from "@/hooks/use-supabase-session";
import {
  Users, UserPlus, X, Loader2, Check, ChevronRight,
  BookOpen, LogOut, LayoutDashboard, Search, RotateCcw,
  FolderPlus, Folder, Pencil, Trash2, BarChart3,
} from "lucide-react";

interface SomaUser {
  id: string;
  email: string;
  displayName: string | null;
  role: string;
}

interface StudentGroup {
  id: number;
  tutorId: string;
  name: string;
  description: string | null;
  memberCount: number;
  createdAt: string;
}

interface StudentProfileInfo {
  level: string | null;
  school: string | null;
  syllabus: string | null;
  tutoredSubjects: string[] | null;
}

function formatStudentName(student: SomaUser): string {
  const fromDisplay = (student.displayName || "").trim();
  if (fromDisplay) return fromDisplay;
  return "Student";
}

const GP = "glass-panel-elite";

type Tab = "students" | "groups";

export default function TutorStudents() {
  const queryClient = useQueryClient();
  const [, setLocation] = useLocation();
  const [activeTab, setActiveTab] = useState<Tab>("students");
  const [showAdoptModal, setShowAdoptModal] = useState(false);
  const [selectedStudentIds, setSelectedStudentIds] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState("");

  // ── Group modals ──
  const [showCreateGroupModal, setShowCreateGroupModal] = useState(false);
  const [editingGroup, setEditingGroup] = useState<StudentGroup | null>(null);
  const [groupName, setGroupName] = useState("");
  const [groupDescription, setGroupDescription] = useState("");
  const [deletingGroupId, setDeletingGroupId] = useState<number | null>(null);

  // ── Group member management ──
  const [managingGroup, setManagingGroup] = useState<StudentGroup | null>(null);
  const [memberSearchQuery, setMemberSearchQuery] = useState("");
  const [selectedMemberIds, setSelectedMemberIds] = useState<Set<string>>(new Set());

  const { session, userId, isLoading: authLoading } = useSupabaseSession();
  const displayName = session?.user?.user_metadata?.display_name || session?.user?.email?.split("@")[0] || "Tutor";
  const initials = displayName.split(" ").map((n: string) => n[0]).join("").toUpperCase().slice(0, 2);

  // ── Queries ──

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

  const { data: studentProfiles = {} } = useQuery<Record<string, StudentProfileInfo>>({
    queryKey: ["/api/tutor/students/profiles", userId],
    queryFn: async () => {
      if (!userId) return {};
      const res = await authFetch("/api/tutor/students/profiles");
      if (!res.ok) return {};
      return res.json();
    },
    enabled: !!userId && adoptedStudents.length > 0,
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

  const { data: groups = [], isLoading: groupsLoading } = useQuery<StudentGroup[]>({
    queryKey: ["/api/tutor/groups", userId],
    queryFn: async () => {
      if (!userId) return [];
      const res = await authFetch("/api/tutor/groups");
      if (!res.ok) return [];
      return res.json();
    },
    enabled: !!userId,
  });

  const { data: managingGroupMembers = [] } = useQuery<SomaUser[]>({
    queryKey: ["/api/tutor/groups", managingGroup?.id, "members"],
    queryFn: async () => {
      if (!managingGroup) return [];
      const res = await authFetch(`/api/tutor/groups/${managingGroup.id}/members`);
      if (!res.ok) return [];
      return res.json();
    },
    enabled: !!managingGroup,
  });

  // ── Mutations ──

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
      const res = await authFetch(`/api/tutor/students/${studentId}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to remove");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/tutor/students"] });
      queryClient.invalidateQueries({ queryKey: ["/api/tutor/students/available"] });
    },
  });

  const createGroupMutation = useMutation({
    mutationFn: async () => {
      const res = await authFetch("/api/tutor/groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: groupName.trim(), description: groupDescription.trim() || null }),
      });
      if (!res.ok) throw new Error("Failed to create group");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/tutor/groups"] });
      setShowCreateGroupModal(false);
      setGroupName("");
      setGroupDescription("");
    },
  });

  const updateGroupMutation = useMutation({
    mutationFn: async () => {
      if (!editingGroup) return;
      const res = await authFetch(`/api/tutor/groups/${editingGroup.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: groupName.trim(), description: groupDescription.trim() || null }),
      });
      if (!res.ok) throw new Error("Failed to update group");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/tutor/groups"] });
      setEditingGroup(null);
      setGroupName("");
      setGroupDescription("");
    },
  });

  const deleteGroupMutation = useMutation({
    mutationFn: async (groupId: number) => {
      const res = await authFetch(`/api/tutor/groups/${groupId}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to delete group");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/tutor/groups"] });
      setDeletingGroupId(null);
    },
  });

  const addMembersMutation = useMutation({
    mutationFn: async ({ groupId, studentIds }: { groupId: number; studentIds: string[] }) => {
      const res = await authFetch(`/api/tutor/groups/${groupId}/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ studentIds }),
      });
      if (!res.ok) throw new Error("Failed to add members");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/tutor/groups"] });
      if (managingGroup) queryClient.invalidateQueries({ queryKey: ["/api/tutor/groups", managingGroup.id, "members"] });
      setSelectedMemberIds(new Set());
    },
  });

  const removeMemberMutation = useMutation({
    mutationFn: async ({ groupId, studentId }: { groupId: number; studentId: string }) => {
      const res = await authFetch(`/api/tutor/groups/${groupId}/members/${studentId}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to remove member");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/tutor/groups"] });
      if (managingGroup) queryClient.invalidateQueries({ queryKey: ["/api/tutor/groups", managingGroup.id, "members"] });
    },
  });

  // ── Helpers ──

  const toggleStudentSelection = useCallback((id: string) => {
    setSelectedStudentIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const toggleMemberSelection = useCallback((id: string) => {
    setSelectedMemberIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const filteredStudents = useMemo(() => {
    const sorted = [...adoptedStudents].sort((a, b) => formatStudentName(a).localeCompare(formatStudentName(b)));
    if (!searchQuery.trim()) return sorted;
    const q = searchQuery.toLowerCase();
    return sorted.filter((s) => formatStudentName(s).toLowerCase().includes(q));
  }, [adoptedStudents, searchQuery]);

  const memberIdSet = useMemo(() => new Set(managingGroupMembers.map((m) => m.id)), [managingGroupMembers]);

  const nonMembers = useMemo(() => {
    const sorted = [...adoptedStudents].filter((s) => !memberIdSet.has(s.id)).sort((a, b) => formatStudentName(a).localeCompare(formatStudentName(b)));
    if (!memberSearchQuery.trim()) return sorted;
    const q = memberSearchQuery.toLowerCase();
    return sorted.filter((s) => formatStudentName(s).toLowerCase().includes(q));
  }, [adoptedStudents, memberIdSet, memberSearchQuery]);

  const handleLogout = async () => {
    await supabase.auth.signOut();
    setLocation("/login");
  };

  const openEditGroup = (group: StudentGroup) => {
    setGroupName(group.name);
    setGroupDescription(group.description || "");
    setEditingGroup(group);
  };

  const openManageGroup = (group: StudentGroup) => {
    setManagingGroup(group);
    setSelectedMemberIds(new Set());
    setMemberSearchQuery("");
  };

  // ── Render ──

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-30 border-b border-white/[0.06] backdrop-blur-2xl" style={{ background: "linear-gradient(180deg, rgba(8,13,26,0.92) 0%, rgba(8,13,26,0.85) 100%)" }}>
        <div className="max-w-[1440px] mx-auto px-6 lg:px-10 py-3.5 flex items-center justify-between">
          <Link href="/">
            <div className="flex items-center gap-3.5 cursor-pointer group">
              <img src="/MCEC - White Logo.png" alt="MCEC Logo" loading="lazy" className="h-9 w-auto object-contain opacity-90 group-hover:opacity-100 transition-opacity" />
              <div>
                <h1 className="text-base font-bold tracking-tight gradient-text leading-none">SOMA</h1>
                <p className="text-[9px] text-slate-500 tracking-[0.25em] uppercase font-semibold mt-0.5">Control Centre</p>
              </div>
            </div>
          </Link>
          <div className="flex items-center gap-5">
            <nav className="hidden md:flex items-center gap-0.5 mr-2">
              <Link href="/tutor">
                <span className="flex items-center gap-2 px-4 py-2 text-[13px] font-medium text-slate-500 hover:text-slate-300 border-b-2 border-transparent transition-all cursor-pointer" data-testid="nav-dashboard">
                  <LayoutDashboard className="w-3.5 h-3.5" /> Dashboard
                </span>
              </Link>
              <span className="flex items-center gap-2 px-4 py-2 text-[13px] font-semibold text-violet-300 border-b-2 border-violet-500 cursor-default" data-testid="nav-students">
                <Users className="w-3.5 h-3.5" /> Students
              </span>
              <Link href="/tutor/assessments">
                <span className="flex items-center gap-2 px-4 py-2 text-[13px] font-medium text-slate-500 hover:text-slate-300 border-b-2 border-transparent transition-all cursor-pointer" data-testid="nav-assessments">
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
                <p className="text-[13px] font-medium text-slate-200 leading-none">{displayName}</p>
                <p className="text-[9px] text-violet-400/70 font-bold uppercase tracking-[0.2em] mt-0.5">Tutor</p>
              </div>
            </div>
            <button onClick={handleLogout} className="text-slate-600 hover:text-slate-300 transition-colors p-2 min-h-[44px] min-w-[44px] rounded-lg hover:bg-white/[0.03]" aria-label="Log out">
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-[1440px] mx-auto px-6 lg:px-10 py-7 space-y-6">

        {/* ── Tab Switcher + Action Button ───────────────── */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div className="flex items-center gap-1 bg-slate-900/60 backdrop-blur-md border border-slate-800 rounded-xl p-1">
            <button
              onClick={() => setActiveTab("students")}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg text-[13px] font-medium transition-all ${
                activeTab === "students"
                  ? "bg-violet-500/20 text-violet-300 border border-violet-500/30"
                  : "text-slate-500 hover:text-slate-300 border border-transparent"
              }`}
              data-testid="tab-students"
            >
              <Users className="w-3.5 h-3.5" />
              Students
              <span className="text-[11px] opacity-60">{adoptedStudents.length}</span>
            </button>
            <button
              onClick={() => setActiveTab("groups")}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg text-[13px] font-medium transition-all ${
                activeTab === "groups"
                  ? "bg-violet-500/20 text-violet-300 border border-violet-500/30"
                  : "text-slate-500 hover:text-slate-300 border border-transparent"
              }`}
              data-testid="tab-groups"
            >
              <Folder className="w-3.5 h-3.5" />
              Groups
              <span className="text-[11px] opacity-60">{groups.length}</span>
            </button>
          </div>

          {activeTab === "students" ? (
            <button
              onClick={() => { setShowAdoptModal(true); setSelectedStudentIds(new Set()); }}
              className="flex items-center gap-2 px-5 py-2.5 min-h-[44px] rounded-xl text-sm font-medium bg-violet-500/20 text-violet-300 border border-violet-500/40 hover:bg-violet-500/30 transition-all"
              data-testid="button-adopt-students"
            >
              <UserPlus className="w-4 h-4" />
              Add Students
            </button>
          ) : (
            <button
              onClick={() => { setShowCreateGroupModal(true); setGroupName(""); setGroupDescription(""); }}
              className="flex items-center gap-2 px-5 py-2.5 min-h-[44px] rounded-xl text-sm font-medium bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 hover:bg-emerald-500/30 transition-all"
              data-testid="button-create-group"
            >
              <FolderPlus className="w-4 h-4" />
              New Group
            </button>
          )}
        </div>

        {/* ── STUDENTS TAB ─────────────────────────────── */}
        {activeTab === "students" && (
          <>
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
                  <button onClick={() => setSearchQuery("")} className="absolute right-3 top-1/2 -translate-y-1/2 p-2 text-slate-500 hover:text-slate-300" aria-label="Clear search" data-testid="button-clear-search-students">
                    <RotateCcw className="w-4 h-4" />
                  </button>
                )}
              </div>
            )}

            {authLoading || studentsLoading ? (
              <div className="flex justify-center py-16"><Loader2 className="w-6 h-6 text-violet-500 animate-spin" /></div>
            ) : filteredStudents.length === 0 ? (
              <div className={`${GP} text-center py-14 px-6`}>
                <Users className="w-10 h-10 mx-auto text-slate-700 mb-3" />
                <p className="text-[13px] text-slate-400 font-medium">{searchQuery ? "No matching students found" : "No students yet"}</p>
                {!searchQuery && <p className="text-[11px] text-slate-600 mt-1">Click "Add Students" to add students to your cohort</p>}
              </div>
            ) : (
              <div className="grid gap-3">
                {filteredStudents.map((student) => {
                  const name = formatStudentName(student);
                  const si = name.split(" ").map((n: string) => n[0]).join("").toUpperCase().slice(0, 2);
                  return (
                    <div key={student.id} className="group flex items-center gap-4 bg-slate-900/60 backdrop-blur-md border border-slate-800 rounded-xl px-5 py-4 hover:border-slate-700 transition-all" data-testid={`student-card-${student.id}`}>
                      <div className="w-10 h-10 rounded-full bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center text-xs font-bold text-emerald-300 shrink-0">{si}</div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-slate-200">{name}</p>
                        {studentProfiles[student.id] && (
                          <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                            {studentProfiles[student.id].level && (
                              <span className="text-[10px] text-indigo-400/80 font-medium bg-indigo-500/10 px-1.5 py-0.5 rounded">{studentProfiles[student.id].level}</span>
                            )}
                            {studentProfiles[student.id].school && (
                              <span className="text-[10px] text-slate-400 font-medium bg-slate-800/60 px-1.5 py-0.5 rounded">{studentProfiles[student.id].school}</span>
                            )}
                          </div>
                        )}
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <button onClick={(e) => { e.stopPropagation(); removeMutation.mutate(student.id); }} className="text-red-400/40 hover:text-red-400 transition-colors p-2 min-h-[44px] min-w-[44px] flex items-center justify-center" title="Remove student" data-testid={`button-remove-${student.id}`}>
                          <X className="w-4 h-4" />
                        </button>
                        <Link href={`/tutor/students/${student.id}`}>
                          <span className="flex items-center gap-1 px-3 py-2 min-h-[44px] rounded-lg text-xs font-medium text-violet-300 bg-violet-500/10 border border-violet-500/20 hover:bg-violet-500/20 transition-all cursor-pointer" data-testid={`link-view-${student.id}`}>
                            View <ChevronRight className="w-3 h-3" />
                          </span>
                        </Link>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}

        {/* ── GROUPS TAB ───────────────────────────────── */}
        {activeTab === "groups" && (
          <>
            {authLoading || groupsLoading ? (
              <div className="flex justify-center py-16"><Loader2 className="w-6 h-6 text-emerald-500 animate-spin" /></div>
            ) : groups.length === 0 ? (
              <div className={`${GP} text-center py-14 px-6`}>
                <Folder className="w-10 h-10 mx-auto text-slate-700 mb-3" />
                <p className="text-[13px] text-slate-400 font-medium">No groups yet</p>
                <p className="text-[11px] text-slate-600 mt-1">Create groups like "IGCSE", "AS Level", or "A Level" to organise your students</p>
              </div>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {groups.map((group) => (
                  <div key={group.id} className={`${GP} p-5 flex flex-col gap-3 hover:border-slate-700 transition-all`} data-testid={`group-card-${group.id}`}>
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="w-10 h-10 rounded-xl bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center shrink-0">
                          <Folder className="w-5 h-5 text-emerald-400" />
                        </div>
                        <div className="min-w-0">
                          <h3 className="text-sm font-bold text-slate-100 truncate">{group.name}</h3>
                          <p className="text-[11px] text-slate-500 mt-0.5">
                            {group.memberCount} student{group.memberCount !== 1 ? "s" : ""}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          onClick={() => openEditGroup(group)}
                          className="p-2 text-slate-600 hover:text-slate-300 rounded-lg hover:bg-white/[0.04] transition-colors"
                          title="Edit group"
                          data-testid={`button-edit-group-${group.id}`}
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => setDeletingGroupId(group.id)}
                          className="p-2 text-red-400/40 hover:text-red-400 rounded-lg hover:bg-white/[0.04] transition-colors"
                          title="Delete group"
                          data-testid={`button-delete-group-${group.id}`}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                    {group.description && (
                      <p className="text-[11px] text-slate-500 leading-relaxed line-clamp-2">{group.description}</p>
                    )}
                    <div className="flex items-center gap-2 pt-1 mt-auto">
                      <button
                        onClick={() => openManageGroup(group)}
                        className="flex items-center gap-1.5 px-3 py-2 min-h-[40px] rounded-lg text-xs font-medium text-emerald-300 bg-emerald-500/10 border border-emerald-500/20 hover:bg-emerald-500/20 transition-all flex-1 justify-center"
                        data-testid={`button-manage-${group.id}`}
                      >
                        <Users className="w-3.5 h-3.5" /> Manage
                      </button>
                      <Link href={`/tutor/groups/${group.id}`}>
                        <span className="flex items-center gap-1.5 px-3 py-2 min-h-[40px] rounded-lg text-xs font-medium text-violet-300 bg-violet-500/10 border border-violet-500/20 hover:bg-violet-500/20 transition-all cursor-pointer" data-testid={`button-dashboard-${group.id}`}>
                          <BarChart3 className="w-3.5 h-3.5" /> Dashboard
                        </span>
                      </Link>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </main>

      {/* ── ADOPT STUDENTS MODAL ─────────────────────── */}
      {showAdoptModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-lg p-4" onClick={() => setShowAdoptModal(false)}>
          <div className="glass-panel-elite max-w-lg w-full max-h-[80vh] overflow-y-auto p-6" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between gap-3 mb-5">
              <h3 className="text-base font-bold text-slate-100">Add Students</h3>
              <button onClick={() => setShowAdoptModal(false)} className="text-slate-500 hover:text-slate-300 p-1.5 rounded-lg hover:bg-white/[0.04] transition-colors"><X className="w-4 h-4" /></button>
            </div>
            {availableStudents.length === 0 ? (
              <p className="text-sm text-slate-400 text-center py-8">No students available to add</p>
            ) : (
              <>
                <div className="space-y-2 max-h-[50vh] overflow-y-auto">
                  {[...availableStudents].sort((a, b) => formatStudentName(a).localeCompare(formatStudentName(b))).map((student) => {
                    const name = formatStudentName(student);
                    const si = name.split(" ").map((n: string) => n[0]).join("").toUpperCase().slice(0, 2);
                    return (
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
                        <div className="w-8 h-8 rounded-full bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center text-[10px] font-bold text-emerald-300 shrink-0">{si}</div>
                        <p className="text-sm font-medium text-slate-200">{name}</p>
                      </button>
                    );
                  })}
                </div>
                <button
                  onClick={() => adoptMutation.mutate(Array.from(selectedStudentIds))}
                  disabled={selectedStudentIds.size === 0 || adoptMutation.isPending}
                  className="w-full mt-4 py-3 min-h-[44px] rounded-xl text-sm font-medium bg-violet-600 text-white hover:bg-violet-500 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
                  data-testid="button-confirm-adopt"
                >
                  {adoptMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mx-auto" /> : `Add ${selectedStudentIds.size} Student${selectedStudentIds.size !== 1 ? "s" : ""}`}
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {/* ── CREATE GROUP MODAL ───────────────────────── */}
      {showCreateGroupModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-lg p-4" onClick={() => setShowCreateGroupModal(false)}>
          <div className="glass-panel-elite max-w-md w-full p-6" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between gap-3 mb-5">
              <h3 className="text-base font-bold text-slate-100">Create Group</h3>
              <button onClick={() => setShowCreateGroupModal(false)} className="text-slate-500 hover:text-slate-300 p-1.5 rounded-lg hover:bg-white/[0.04] transition-colors"><X className="w-4 h-4" /></button>
            </div>
            <div className="space-y-4">
              <div>
                <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1.5 block">Group Name</label>
                <input
                  type="text"
                  value={groupName}
                  onChange={(e) => setGroupName(e.target.value)}
                  placeholder="e.g. IGCSE, AS Level, A Level"
                  className="w-full h-11 px-4 rounded-xl bg-slate-900/60 border border-slate-700 text-sm text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-emerald-500/50 transition-colors"
                  autoFocus
                  data-testid="input-group-name"
                />
              </div>
              <div>
                <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1.5 block">Description (optional)</label>
                <textarea
                  value={groupDescription}
                  onChange={(e) => setGroupDescription(e.target.value)}
                  placeholder="Brief description of this group..."
                  rows={3}
                  className="w-full px-4 py-3 rounded-xl bg-slate-900/60 border border-slate-700 text-sm text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-emerald-500/50 transition-colors resize-none"
                  data-testid="input-group-description"
                />
              </div>
              <button
                onClick={() => createGroupMutation.mutate()}
                disabled={!groupName.trim() || createGroupMutation.isPending}
                className="w-full py-3 min-h-[44px] rounded-xl text-sm font-medium bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
                data-testid="button-confirm-create-group"
              >
                {createGroupMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mx-auto" /> : "Create Group"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── EDIT GROUP MODAL ─────────────────────────── */}
      {editingGroup && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-lg p-4" onClick={() => setEditingGroup(null)}>
          <div className="glass-panel-elite max-w-md w-full p-6" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between gap-3 mb-5">
              <h3 className="text-base font-bold text-slate-100">Edit Group</h3>
              <button onClick={() => setEditingGroup(null)} className="text-slate-500 hover:text-slate-300 p-1.5 rounded-lg hover:bg-white/[0.04] transition-colors"><X className="w-4 h-4" /></button>
            </div>
            <div className="space-y-4">
              <div>
                <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1.5 block">Group Name</label>
                <input
                  type="text"
                  value={groupName}
                  onChange={(e) => setGroupName(e.target.value)}
                  className="w-full h-11 px-4 rounded-xl bg-slate-900/60 border border-slate-700 text-sm text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-violet-500/50 transition-colors"
                  autoFocus
                />
              </div>
              <div>
                <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1.5 block">Description (optional)</label>
                <textarea
                  value={groupDescription}
                  onChange={(e) => setGroupDescription(e.target.value)}
                  rows={3}
                  className="w-full px-4 py-3 rounded-xl bg-slate-900/60 border border-slate-700 text-sm text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-violet-500/50 transition-colors resize-none"
                />
              </div>
              <button
                onClick={() => updateGroupMutation.mutate()}
                disabled={!groupName.trim() || updateGroupMutation.isPending}
                className="w-full py-3 min-h-[44px] rounded-xl text-sm font-medium bg-violet-600 text-white hover:bg-violet-500 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
              >
                {updateGroupMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mx-auto" /> : "Save Changes"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── DELETE CONFIRM ────────────────────────────── */}
      {deletingGroupId !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-lg p-4" onClick={() => setDeletingGroupId(null)}>
          <div className="glass-panel-elite max-w-sm w-full p-6" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-base font-bold text-slate-100 mb-2">Delete Group?</h3>
            <p className="text-sm text-slate-400 mb-5">This will remove the group and unlink all students from it. Students themselves won't be deleted.</p>
            <div className="flex items-center gap-3">
              <button onClick={() => setDeletingGroupId(null)} className="flex-1 py-2.5 min-h-[44px] rounded-xl text-sm font-medium bg-slate-800 text-slate-300 hover:bg-slate-700 transition-all">Cancel</button>
              <button
                onClick={() => deleteGroupMutation.mutate(deletingGroupId)}
                disabled={deleteGroupMutation.isPending}
                className="flex-1 py-2.5 min-h-[44px] rounded-xl text-sm font-medium bg-red-600 text-white hover:bg-red-500 disabled:opacity-50 transition-all"
                data-testid="button-confirm-delete-group"
              >
                {deleteGroupMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mx-auto" /> : "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── MANAGE GROUP MEMBERS MODAL ────────────────── */}
      {managingGroup && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-lg p-4" onClick={() => setManagingGroup(null)}>
          <div className="glass-panel-elite max-w-lg w-full max-h-[85vh] overflow-hidden flex flex-col" onClick={(e) => e.stopPropagation()}>
            {/* Header */}
            <div className="px-6 pt-6 pb-4 border-b border-white/[0.06] shrink-0">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-xl bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center">
                    <Folder className="w-4 h-4 text-emerald-400" />
                  </div>
                  <div>
                    <h3 className="text-base font-bold text-slate-100">{managingGroup.name}</h3>
                    <p className="text-[11px] text-slate-500">{managingGroupMembers.length} member{managingGroupMembers.length !== 1 ? "s" : ""}</p>
                  </div>
                </div>
                <button onClick={() => setManagingGroup(null)} className="text-slate-500 hover:text-slate-300 p-1.5 rounded-lg hover:bg-white/[0.04] transition-colors"><X className="w-4 h-4" /></button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto px-6 py-4 space-y-5">
              {/* Current Members */}
              <div>
                <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Current Members</h4>
                {managingGroupMembers.length === 0 ? (
                  <p className="text-xs text-slate-500 py-3">No students in this group yet</p>
                ) : (
                  <div className="space-y-1.5">
                    {managingGroupMembers.map((student) => {
                      const name = formatStudentName(student);
                      const si = name.split(" ").map((n: string) => n[0]).join("").toUpperCase().slice(0, 2);
                      return (
                        <div key={student.id} className="flex items-center gap-3 px-3 py-2 rounded-lg bg-slate-800/30 border border-slate-800/50">
                          <div className="w-7 h-7 rounded-full bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center text-[9px] font-bold text-emerald-300 shrink-0">{si}</div>
                          <span className="text-sm text-slate-200 flex-1 truncate">{name}</span>
                          {studentProfiles[student.id]?.level && (
                            <span className="text-[10px] text-indigo-400/80 font-medium bg-indigo-500/10 px-1.5 py-0.5 rounded">{studentProfiles[student.id].level}</span>
                          )}
                          <button
                            onClick={() => removeMemberMutation.mutate({ groupId: managingGroup.id, studentId: student.id })}
                            className="text-red-400/40 hover:text-red-400 p-1.5 rounded-md hover:bg-white/[0.04] transition-colors shrink-0"
                            title="Remove from group"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Add Members */}
              {nonMembers.length > 0 && (
                <div>
                  <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Add Students</h4>
                  {adoptedStudents.length > 5 && (
                    <div className="relative mb-2">
                      <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-500" />
                      <input
                        type="text"
                        value={memberSearchQuery}
                        onChange={(e) => setMemberSearchQuery(e.target.value)}
                        placeholder="Search..."
                        className="w-full h-9 pl-9 pr-3 rounded-lg bg-slate-900/60 border border-slate-800 text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-emerald-500/40"
                      />
                    </div>
                  )}
                  <div className="space-y-1.5 max-h-[200px] overflow-y-auto">
                    {nonMembers.map((student) => {
                      const name = formatStudentName(student);
                      const si = name.split(" ").map((n: string) => n[0]).join("").toUpperCase().slice(0, 2);
                      const selected = selectedMemberIds.has(student.id);
                      return (
                        <button
                          key={student.id}
                          onClick={() => toggleMemberSelection(student.id)}
                          className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg transition-all text-left ${
                            selected ? "bg-emerald-500/15 border border-emerald-500/30" : "bg-slate-800/20 border border-slate-800/40 hover:bg-slate-800/40"
                          }`}
                        >
                          <div className={`w-4 h-4 rounded-md border flex items-center justify-center shrink-0 ${
                            selected ? "bg-emerald-500 border-emerald-500" : "border-slate-600"
                          }`}>
                            {selected && <Check className="w-2.5 h-2.5 text-white" />}
                          </div>
                          <div className="w-7 h-7 rounded-full bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-[9px] font-bold text-emerald-300 shrink-0">{si}</div>
                          <span className="text-sm text-slate-300 truncate">{name}</span>
                          {studentProfiles[student.id]?.level && (
                            <span className="text-[10px] text-indigo-400/60 font-medium bg-indigo-500/8 px-1.5 py-0.5 rounded ml-auto shrink-0">{studentProfiles[student.id].level}</span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                  {selectedMemberIds.size > 0 && (
                    <button
                      onClick={() => addMembersMutation.mutate({ groupId: managingGroup.id, studentIds: Array.from(selectedMemberIds) })}
                      disabled={addMembersMutation.isPending}
                      className="w-full mt-3 py-2.5 min-h-[40px] rounded-xl text-sm font-medium bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
                    >
                      {addMembersMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mx-auto" /> : `Add ${selectedMemberIds.size} to ${managingGroup.name}`}
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
