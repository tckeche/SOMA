import { Link, useLocation } from "wouter";
import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { authFetch } from "@/lib/supabase";
import { useSupabaseSession } from "@/hooks/use-supabase-session";
import { Loader2, ArrowLeft } from "lucide-react";
import { formatDistanceToNow } from "date-fns";

interface TutorDetail {
  tutorId: string;
  tutorEmail: string;
  tutorName: string | null;
  adoptedStudentsCount: number;
  assessmentsCompletedCount: number;
  averageStudentGrade: number | null;
  subjects: string[];
  lastLoginAt: string | null;
  students: Array<{ id: string; name: string | null; email: string }>;
  recentAssessments: Array<{
    reportId: number;
    studentName: string;
    quizId: number;
    quizTitle: string;
    subject: string | null;
    scorePercent: number;
    completedAt: string | null;
    createdAt: string;
  }>;
}

export default function SuperAdminTutorDetail({ params }: { params: { tutorId: string } }) {
  const [, setLocation] = useLocation();
  const { userId } = useSupabaseSession();

  useEffect(() => {
    if (!userId) return;
    authFetch("/api/auth/me")
      .then((r) => r.json())
      .then((me) => {
        if (me.role !== "super_admin") setLocation("/dashboard");
      })
      .catch(() => setLocation("/login"));
  }, [userId, setLocation]);

  const { data, isLoading } = useQuery<TutorDetail>({
    queryKey: ["/api/super-admin/tutors", params.tutorId],
    queryFn: async () => {
      const res = await authFetch(`/api/super-admin/tutors/${params.tutorId}`);
      if (!res.ok) throw new Error("Failed to load tutor details");
      return res.json();
    },
    enabled: !!userId,
  });

  if (isLoading) return <div className="min-h-screen flex items-center justify-center"><Loader2 className="w-8 h-8 animate-spin text-red-500" /></div>;
  if (!data) return <div className="p-8 text-slate-300">Tutor not found.</div>;

  return (
    <main className="max-w-6xl mx-auto px-6 py-8 space-y-6">
      <Link href="/super-admin">
        <button className="inline-flex items-center gap-2 text-sm text-slate-300 hover:text-white">
          <ArrowLeft className="w-4 h-4" /> Back to Super Admin Dashboard
        </button>
      </Link>

      <section className="bg-slate-900/70 border border-slate-800 rounded-xl p-5">
        <h1 className="text-xl font-semibold text-white">{data.tutorName || data.tutorEmail}</h1>
        <p className="text-sm text-slate-400">{data.tutorEmail}</p>
        <p className="text-xs text-slate-500 mt-2">
          Last login: {data.lastLoginAt ? formatDistanceToNow(new Date(data.lastLoginAt), { addSuffix: true }) : "No login tracked yet"}
        </p>
      </section>

      <section className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Metric label="Students" value={data.adoptedStudentsCount} />
        <Metric label="Assessments Done" value={data.assessmentsCompletedCount} />
        <Metric label="Avg Grade" value={data.averageStudentGrade !== null ? `${data.averageStudentGrade}%` : "—"} />
        <Metric label="Subjects" value={data.subjects.length} />
      </section>

      <section className="bg-slate-900/70 border border-slate-800 rounded-xl p-5">
        <h2 className="font-semibold text-white mb-3">Adopted Students</h2>
        {data.students.length === 0 ? <p className="text-sm text-slate-400">No students assigned yet.</p> : (
          <div className="space-y-2">
            {data.students.map((s) => (
              <div key={s.id} className="text-sm text-slate-200 border border-slate-800 rounded-lg px-3 py-2">
                {s.name || s.email} <span className="text-slate-500">({s.email})</span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="bg-slate-900/70 border border-slate-800 rounded-xl p-5">
        <h2 className="font-semibold text-white mb-3">Recent Completed Assessments</h2>
        {data.recentAssessments.length === 0 ? <p className="text-sm text-slate-400">No submissions yet.</p> : (
          <div className="space-y-2">
            {data.recentAssessments.map((r) => (
              <div key={r.reportId} className="text-sm border border-slate-800 rounded-lg px-3 py-2 text-slate-200">
                {r.studentName} • {r.quizTitle} • {r.scorePercent}%
              </div>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return <div className="bg-slate-900/70 border border-slate-800 rounded-xl p-4"><p className="text-xs text-slate-400">{label}</p><p className="text-lg font-semibold text-white">{value}</p></div>;
}
