import { Link, useLocation } from "wouter";
import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { authFetch } from "@/lib/supabase";
import { useSupabaseSession } from "@/hooks/use-supabase-session";
import { Loader2, ArrowLeft } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { ThemeToggle } from "@/components/ThemeToggle";

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

  if (isLoading) return <div className="min-h-screen flex items-center justify-center"><Loader2 className="w-8 h-8 animate-spin text-danger" /></div>;
  if (!data) return <div className="p-8 text-foreground/80">Tutor not found.</div>;

  return (
    <main className="max-w-6xl mx-auto px-6 py-8 space-y-6">
      <div className="flex items-center justify-between">
        <Link href="/super-admin">
          <button className="inline-flex items-center gap-2 text-sm text-foreground/80 hover:text-foreground">
            <ArrowLeft className="w-4 h-4" /> Back to Super Admin Dashboard
          </button>
        </Link>
        <ThemeToggle />
      </div>

      <section className="glass-card p-5">
        <p className="eyebrow text-danger mb-1">Tutor Profile</p>
        <h1 className="text-xl soma-display text-foreground">{data.tutorName || data.tutorEmail}</h1>
        <p className="text-sm text-muted-foreground">{data.tutorEmail}</p>
        <p className="text-xs text-muted-foreground mt-2">
          Last login: {data.lastLoginAt ? formatDistanceToNow(new Date(data.lastLoginAt), { addSuffix: true }) : "No login tracked yet"}
        </p>
      </section>

      <section className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Metric label="Students" value={data.adoptedStudentsCount} />
        <Metric label="Assessments Done" value={data.assessmentsCompletedCount} />
        <Metric label="Avg Grade" value={data.averageStudentGrade !== null ? `${data.averageStudentGrade}%` : "—"} />
        <Metric label="Subjects" value={data.subjects.length} />
      </section>

      <section className="glass-card p-5">
        <p className="eyebrow mb-3">Adopted Students</p>
        {data.students.length === 0 ? <p className="text-sm text-muted-foreground">No students assigned yet.</p> : (
          <div className="space-y-2">
            {data.students.map((s) => (
              <div key={s.id} className="text-sm text-foreground border border-card-border rounded-lg px-3 py-2">
                {s.name || s.email} <span className="text-muted-foreground">({s.email})</span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="glass-card p-5">
        <p className="eyebrow mb-3">Recent Completed Assessments</p>
        {data.recentAssessments.length === 0 ? <p className="text-sm text-muted-foreground">No submissions yet.</p> : (
          <div className="space-y-2">
            {data.recentAssessments.map((r) => (
              <div key={r.reportId} className="text-sm border border-card-border rounded-lg px-3 py-2 text-foreground">
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
  return <div className="stat-card p-4"><p className="eyebrow">{label}</p><p className="text-lg font-semibold text-foreground mt-1">{value}</p></div>;
}
