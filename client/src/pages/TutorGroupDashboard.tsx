import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useParams, Link } from "wouter";
import { authFetch } from "@/lib/supabase";
import { useSupabaseSession } from "@/hooks/use-supabase-session";
import { getSubjectColor } from "@/lib/subjectColors";
import {
  ArrowLeft, Loader2, Users, BookOpen, Target, Award,
  TrendingDown, TrendingUp, Minus, AlertTriangle, Folder,
  ChevronRight, BarChart3,
} from "lucide-react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Cell, PieChart, Pie,
  RadarChart, PolarGrid, PolarAngleAxis, Radar,
} from "recharts";

const GP = "glass-panel-elite";

interface StudentGroup {
  id: number;
  name: string;
  description: string | null;
  tutorId: string;
  createdAt: string;
}

interface SomaUser {
  id: string;
  email: string;
  displayName: string | null;
}

interface StudentInsight {
  studentId: string;
  studentName: string;
  assigned: number;
  completed: number;
  avgScore: number | null;
  trend: "improving" | "declining" | "stable";
  weakTopics: string[];
}

interface GroupDashboardData {
  group: StudentGroup;
  students: SomaUser[];
  totalAssigned: number;
  totalCompleted: number;
  avgScore: number | null;
  subjectBreakdown: { subject: string; average: number; count: number }[];
  studentInsights: StudentInsight[];
}

interface StudentProfileInfo {
  level: string | null;
  school: string | null;
  syllabus: string | null;
  tutoredSubjects: string[] | null;
}

function TrendBadge({ trend }: { trend: "improving" | "declining" | "stable" }) {
  const Icon = trend === "declining" ? TrendingDown : trend === "improving" ? TrendingUp : Minus;
  const color = trend === "declining" ? "text-red-400 bg-red-500/10" : trend === "improving" ? "text-emerald-400 bg-emerald-500/10" : "text-slate-500 bg-slate-500/10";
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-semibold ${color}`}>
      <Icon className="w-3 h-3" /> {trend}
    </span>
  );
}

function StatCard({ label, value, suffix, icon, accent }: { label: string; value: string | number | null; suffix?: string; icon: React.ReactNode; accent: string }) {
  return (
    <div className="stat-card rounded-xl px-4 py-3.5" style={{ borderLeft: `3px solid ${accent}` }}>
      <div className="flex items-center gap-2 mb-1">
        <span className="opacity-50">{icon}</span>
        <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">{label}</span>
      </div>
      <p className="text-xl font-bold text-slate-100">
        {value !== null && value !== undefined ? value : "—"}
        {suffix && <span className="text-sm font-medium text-slate-500 ml-0.5">{suffix}</span>}
      </p>
    </div>
  );
}

function ChartTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-slate-900/95 border border-slate-700/50 backdrop-blur-md rounded-lg px-3 py-2 shadow-xl">
      <p className="text-xs font-semibold text-slate-300 mb-1">{label}</p>
      {payload.map((entry: any, i: number) => (
        <p key={i} className="text-[11px] text-slate-400">
          <span style={{ color: entry.color }} className="font-medium">{entry.name || "Avg"}</span>: {Math.round(entry.value)}%
        </p>
      ))}
    </div>
  );
}

export default function TutorGroupDashboard() {
  const params = useParams<{ id: string }>();
  const groupId = params.id || "";
  const { userId } = useSupabaseSession();

  const { data, isLoading, isError } = useQuery<GroupDashboardData>({
    queryKey: ["/api/tutor/groups", groupId, "dashboard"],
    queryFn: async () => {
      const res = await authFetch(`/api/tutor/groups/${groupId}/dashboard`);
      if (!res.ok) throw new Error("Failed to load");
      return res.json();
    },
    enabled: !!userId && !!groupId,
    refetchInterval: 30000,
  });

  const { data: studentProfiles = {} } = useQuery<Record<string, StudentProfileInfo>>({
    queryKey: ["/api/tutor/students/profiles", userId],
    queryFn: async () => {
      if (!userId) return {};
      const res = await authFetch("/api/tutor/students/profiles");
      if (!res.ok) return {};
      return res.json();
    },
    enabled: !!userId,
  });

  const group = data?.group;
  const students = data?.students || [];
  const insights = data?.studentInsights || [];
  const subjectBreakdown = data?.subjectBreakdown || [];

  const completionRate = data && data.totalAssigned > 0
    ? Math.round((data.totalCompleted / data.totalAssigned) * 100) : null;

  const atRiskStudents = useMemo(() =>
    insights.filter((s) => s.trend === "declining" || (s.avgScore !== null && s.avgScore < 50) || s.weakTopics.length >= 2),
    [insights],
  );

  const sortedInsights = useMemo(() =>
    [...insights].sort((a, b) => {
      if (a.avgScore === null && b.avgScore === null) return 0;
      if (a.avgScore === null) return 1;
      if (b.avgScore === null) return -1;
      return a.avgScore - b.avgScore;
    }),
    [insights],
  );

  // Radar data for subject breakdown
  const radarData = useMemo(() =>
    subjectBreakdown.map((s) => ({ subject: s.subject.length > 12 ? s.subject.slice(0, 10) + "..." : s.subject, average: s.average, fullMark: 100 })),
    [subjectBreakdown],
  );

  // Donut data for completion
  const donutData = useMemo(() => {
    if (!data) return [];
    return [
      { name: "Completed", value: data.totalCompleted },
      { name: "Pending", value: data.totalAssigned - data.totalCompleted },
    ];
  }, [data]);

  return (
    <div className="min-h-screen">
      {/* ── Header ──────────────────────────────────── */}
      <header className="sticky top-0 z-30 border-b border-white/[0.06] backdrop-blur-2xl" style={{ background: "linear-gradient(180deg, rgba(8,13,26,0.92) 0%, rgba(8,13,26,0.85) 100%)" }}>
        <div className="max-w-[1440px] mx-auto px-6 lg:px-10 py-3.5 flex items-center justify-between">
          <Link href="/tutor/students">
            <span className="flex items-center gap-2 text-[13px] text-slate-500 hover:text-emerald-400 transition-colors cursor-pointer font-medium">
              <ArrowLeft className="w-3.5 h-3.5" />
              Groups
            </span>
          </Link>
          <div className="flex items-center gap-3">
            <Link href="/tutor">
              <span className="text-[12px] text-slate-600 hover:text-slate-400 transition-colors cursor-pointer font-medium">Dashboard</span>
            </Link>
            <span className="text-slate-700">/</span>
            <Link href="/tutor/students">
              <span className="text-[12px] text-slate-600 hover:text-slate-400 transition-colors cursor-pointer font-medium">Students</span>
            </Link>
            <span className="text-slate-700">/</span>
            <span className="text-[12px] text-emerald-400 font-medium truncate max-w-[200px]">{group?.name || "Group"}</span>
          </div>
        </div>
      </header>

      <main className="max-w-[1440px] mx-auto px-6 lg:px-10 py-7 space-y-6">
        {isError ? (
          <div className="flex flex-col items-center justify-center py-32 gap-4">
            <AlertTriangle className="w-10 h-10 text-amber-400/70" />
            <p className="text-sm text-slate-400 font-medium">Unable to load group data</p>
            <p className="text-xs text-slate-600">The group may have been deleted, or check your connection</p>
          </div>
        ) : isLoading ? (
          <div className="flex justify-center py-24"><Loader2 className="w-6 h-6 text-emerald-500 animate-spin" /></div>
        ) : data ? (
          <div className="space-y-7 animate-in fade-in duration-500">

            {/* ── Group Header ────────────────────────── */}
            <div className={GP}>
              <div className="p-6 flex flex-col sm:flex-row sm:items-center gap-5">
                <div className="flex items-center gap-4 flex-1">
                  <div className="w-14 h-14 rounded-2xl bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center shrink-0">
                    <Folder className="w-7 h-7 text-emerald-400" />
                  </div>
                  <div>
                    <h2 className="text-xl font-bold text-slate-100 tracking-tight">{group?.name}</h2>
                    <div className="flex items-center gap-3 mt-1.5 flex-wrap">
                      <span className="text-[12px] text-slate-400 font-medium">{students.length} student{students.length !== 1 ? "s" : ""}</span>
                      {group?.description && (
                        <span className="text-[11px] text-slate-500">{group.description}</span>
                      )}
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <StatCard label="Students" value={students.length} icon={<Users className="w-3.5 h-3.5 text-violet-500" />} accent="rgb(139,92,246)" />
                  <StatCard label="Avg Score" value={data.avgScore !== null ? `${data.avgScore}` : null} suffix="%" icon={<Award className="w-3.5 h-3.5 text-emerald-500" />} accent="rgb(16,185,129)" />
                  <StatCard label="Completion" value={completionRate !== null ? `${completionRate}` : null} suffix="%" icon={<Target className="w-3.5 h-3.5 text-cyan-500" />} accent="rgb(6,182,212)" />
                  <StatCard label="At Risk" value={atRiskStudents.length} icon={<AlertTriangle className="w-3.5 h-3.5 text-amber-500" />} accent="rgb(245,158,11)" />
                </div>
              </div>
            </div>

            {/* ── Charts Row ─────────────────────────── */}
            {(subjectBreakdown.length > 0 || data.totalAssigned > 0) && (
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

                {/* Subject Breakdown Bar Chart */}
                {subjectBreakdown.length > 0 && (
                  <div className={`${GP} p-5 lg:col-span-2`}>
                    <h3 className="text-sm font-bold text-slate-200 mb-4 flex items-center gap-2">
                      <BarChart3 className="w-4 h-4 text-violet-400" /> Subject Performance
                    </h3>
                    <div className="h-[260px]">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={subjectBreakdown} margin={{ top: 5, right: 10, left: -10, bottom: 5 }}>
                          <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,0.08)" />
                          <XAxis dataKey="subject" tick={{ fill: "#94a3b8", fontSize: 11 }} axisLine={false} tickLine={false} />
                          <YAxis domain={[0, 100]} tick={{ fill: "#64748b", fontSize: 10 }} axisLine={false} tickLine={false} />
                          <Tooltip content={<ChartTooltip />} />
                          <Bar dataKey="average" name="Average" radius={[6, 6, 0, 0]} maxBarSize={48}>
                            {subjectBreakdown.map((entry) => {
                              const sc = getSubjectColor(entry.subject);
                              return <Cell key={entry.subject} fill={sc.hex} fillOpacity={0.8} />;
                            })}
                          </Bar>
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  </div>
                )}

                {/* Right column: Donut + Radar */}
                <div className="space-y-6">
                  {/* Completion Donut */}
                  {data.totalAssigned > 0 && (
                    <div className={`${GP} p-5`}>
                      <h3 className="text-sm font-bold text-slate-200 mb-3 flex items-center gap-2">
                        <Target className="w-4 h-4 text-cyan-400" /> Completion
                      </h3>
                      <div className="h-[140px] relative">
                        <ResponsiveContainer width="100%" height="100%">
                          <PieChart>
                            <Pie
                              data={donutData}
                              cx="50%"
                              cy="50%"
                              innerRadius={40}
                              outerRadius={60}
                              startAngle={90}
                              endAngle={-270}
                              dataKey="value"
                              stroke="none"
                              cornerRadius={4}
                            >
                              <Cell fill="rgb(16,185,129)" fillOpacity={0.8} />
                              <Cell fill="rgba(148,163,184,0.1)" />
                            </Pie>
                          </PieChart>
                        </ResponsiveContainer>
                        <div className="absolute inset-0 flex flex-col items-center justify-center">
                          <span className="text-2xl font-bold text-slate-100">{data.totalCompleted}</span>
                          <span className="text-[10px] text-slate-500 font-medium">of {data.totalAssigned}</span>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Subject Radar */}
                  {radarData.length >= 3 && (
                    <div className={`${GP} p-5`}>
                      <h3 className="text-sm font-bold text-slate-200 mb-3 flex items-center gap-2">
                        <BookOpen className="w-4 h-4 text-violet-400" /> Coverage
                      </h3>
                      <div className="h-[180px]">
                        <ResponsiveContainer width="100%" height="100%">
                          <RadarChart data={radarData}>
                            <PolarGrid stroke="rgba(148,163,184,0.1)" />
                            <PolarAngleAxis dataKey="subject" tick={{ fill: "#94a3b8", fontSize: 10 }} />
                            <Radar name="Average" dataKey="average" stroke="rgb(139,92,246)" fill="rgb(139,92,246)" fillOpacity={0.2} strokeWidth={2} />
                          </RadarChart>
                        </ResponsiveContainer>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* ── Student Insights Table ──────────────── */}
            {insights.length > 0 && (
              <div className={GP}>
                <div className="p-5 border-b border-white/[0.04]">
                  <h3 className="text-sm font-bold text-slate-200 flex items-center gap-2">
                    <Users className="w-4 h-4 text-emerald-400" /> Student Performance
                  </h3>
                  <p className="text-[11px] text-slate-500 mt-0.5">{insights.length} students in this group</p>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead>
                      <tr className="border-b border-white/[0.04]">
                        <th className="text-left px-5 py-3 text-[10px] font-semibold text-slate-500 uppercase tracking-wider">Student</th>
                        <th className="text-center px-3 py-3 text-[10px] font-semibold text-slate-500 uppercase tracking-wider">Avg Score</th>
                        <th className="text-center px-3 py-3 text-[10px] font-semibold text-slate-500 uppercase tracking-wider">Completion</th>
                        <th className="text-center px-3 py-3 text-[10px] font-semibold text-slate-500 uppercase tracking-wider">Trend</th>
                        <th className="text-left px-3 py-3 text-[10px] font-semibold text-slate-500 uppercase tracking-wider">Weak Areas</th>
                        <th className="px-3 py-3"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {sortedInsights.map((student) => {
                        const initials = student.studentName.split(" ").map((n: string) => n[0]).filter(Boolean).join("").toUpperCase().slice(0, 2);
                        const profile = studentProfiles[student.studentId];
                        const completionPct = student.assigned > 0 ? Math.round((student.completed / student.assigned) * 100) : null;
                        const isAtRisk = student.trend === "declining" || (student.avgScore !== null && student.avgScore < 50);

                        return (
                          <tr key={student.studentId} className={`border-b border-white/[0.02] hover:bg-white/[0.02] transition-colors ${isAtRisk ? "bg-red-500/[0.03]" : ""}`}>
                            <td className="px-5 py-3.5">
                              <div className="flex items-center gap-3">
                                <div className="w-8 h-8 rounded-full bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center text-[10px] font-bold text-emerald-300 shrink-0">
                                  {initials}
                                </div>
                                <div className="min-w-0">
                                  <p className="text-sm font-medium text-slate-200 truncate">{student.studentName}</p>
                                  {profile && (
                                    <div className="flex items-center gap-1 mt-0.5">
                                      {profile.level && <span className="text-[9px] text-indigo-400/80 font-medium bg-indigo-500/10 px-1 py-0.5 rounded">{profile.level}</span>}
                                      {profile.school && <span className="text-[9px] text-slate-500 font-medium bg-slate-800/60 px-1 py-0.5 rounded">{profile.school}</span>}
                                    </div>
                                  )}
                                </div>
                              </div>
                            </td>
                            <td className="text-center px-3 py-3.5">
                              {student.avgScore !== null ? (
                                <span className={`text-sm font-bold ${student.avgScore >= 70 ? "text-emerald-400" : student.avgScore >= 50 ? "text-amber-400" : "text-red-400"}`}>
                                  {student.avgScore}%
                                </span>
                              ) : (
                                <span className="text-xs text-slate-600">—</span>
                              )}
                            </td>
                            <td className="text-center px-3 py-3.5">
                              {completionPct !== null ? (
                                <div className="flex flex-col items-center gap-1">
                                  <span className="text-xs font-medium text-slate-300">{student.completed}/{student.assigned}</span>
                                  <div className="w-16 h-1.5 rounded-full bg-slate-800 overflow-hidden">
                                    <div className="h-full rounded-full bg-emerald-500/70 transition-all" style={{ width: `${completionPct}%` }} />
                                  </div>
                                </div>
                              ) : (
                                <span className="text-xs text-slate-600">—</span>
                              )}
                            </td>
                            <td className="text-center px-3 py-3.5">
                              <TrendBadge trend={student.trend} />
                            </td>
                            <td className="px-3 py-3.5">
                              {student.weakTopics.length > 0 ? (
                                <div className="flex flex-wrap gap-1">
                                  {student.weakTopics.map((topic) => {
                                    const sc = getSubjectColor(topic);
                                    return <span key={topic} className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${sc.bg} ${sc.label}`}>{topic}</span>;
                                  })}
                                </div>
                              ) : (
                                <span className="text-[10px] text-slate-600">None</span>
                              )}
                            </td>
                            <td className="px-3 py-3.5">
                              <Link href={`/tutor/students/${student.studentId}`}>
                                <span className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-medium text-violet-300 bg-violet-500/10 hover:bg-violet-500/20 transition-all cursor-pointer">
                                  View <ChevronRight className="w-3 h-3" />
                                </span>
                              </Link>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* ── Empty state ────────────────────────── */}
            {insights.length === 0 && students.length === 0 && (
              <div className={`${GP} text-center py-14 px-6`}>
                <Users className="w-10 h-10 mx-auto text-slate-700 mb-3" />
                <p className="text-[13px] text-slate-400 font-medium">No students in this group</p>
                <p className="text-[11px] text-slate-600 mt-1">Go to the Students page and add members to this group</p>
                <Link href="/tutor/students">
                  <span className="inline-flex items-center gap-1.5 mt-4 px-4 py-2 rounded-xl text-xs font-medium text-emerald-300 bg-emerald-500/10 border border-emerald-500/20 hover:bg-emerald-500/20 transition-all cursor-pointer">
                    <Users className="w-3.5 h-3.5" /> Manage Groups
                  </span>
                </Link>
              </div>
            )}
          </div>
        ) : null}
      </main>
    </div>
  );
}
