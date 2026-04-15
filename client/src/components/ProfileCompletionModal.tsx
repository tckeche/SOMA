import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { authFetch } from "@/lib/supabase";
import { useSupabaseSession } from "@/hooks/use-supabase-session";
import {
  X, Loader2, User, School, BookOpen, GraduationCap, CheckCircle2, ChevronRight,
} from "lucide-react";

const LEVELS = [
  "Form 1", "Form 2", "Form 3", "Form 4",
  "Lower Sixth", "Upper Sixth", "Other",
] as const;

const SUBJECTS = [
  "Mathematics", "Physics", "Chemistry", "Biology",
  "Economics", "English", "Computer Science", "Accounting",
  "Geography", "History", "Business Studies", "French",
  "Art", "Music", "Physical Education",
] as const;

interface StudentProfile {
  id: number;
  userId: string;
  age: number | null;
  school: string | null;
  syllabus: string | null;
  level: string | null;
  tutoredSubjects: string[] | null;
}

function isProfileComplete(profile: StudentProfile | null): boolean {
  if (!profile) return false;
  return !!(
    profile.age &&
    profile.school &&
    profile.level &&
    profile.tutoredSubjects &&
    profile.tutoredSubjects.length > 0
  );
}

export default function ProfileCompletionModal() {
  const queryClient = useQueryClient();
  const { userId } = useSupabaseSession();
  const [dismissed, setDismissed] = useState(false);
  const [step, setStep] = useState(0); // 0 = basic info, 1 = subjects

  const [age, setAge] = useState("");
  const [school, setSchool] = useState("");
  const [syllabus, setSyllabus] = useState("");
  const [level, setLevel] = useState("");
  const [selectedSubjects, setSelectedSubjects] = useState<Set<string>>(new Set());

  const { data: profile, isLoading } = useQuery<StudentProfile | null>({
    queryKey: ["/api/student/profile", userId],
    queryFn: async () => {
      if (!userId) return null;
      const res = await authFetch("/api/student/profile");
      if (!res.ok) return null;
      return res.json();
    },
    enabled: !!userId,
  });

  // Pre-fill from existing profile data
  useEffect(() => {
    if (profile) {
      if (profile.age) setAge(String(profile.age));
      if (profile.school) setSchool(profile.school);
      if (profile.syllabus) setSyllabus(profile.syllabus);
      if (profile.level) setLevel(profile.level);
      if (profile.tutoredSubjects && profile.tutoredSubjects.length > 0) {
        setSelectedSubjects(new Set(profile.tutoredSubjects));
      }
    }
  }, [profile]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const res = await authFetch("/api/student/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          age: age ? Number(age) : null,
          school: school.trim() || null,
          syllabus: syllabus.trim() || null,
          level: level || null,
          tutoredSubjects: Array.from(selectedSubjects),
        }),
      });
      if (!res.ok) throw new Error("Failed to save profile");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/student/profile"] });
      setDismissed(true);
    },
  });

  const toggleSubject = (subject: string) => {
    setSelectedSubjects((prev) => {
      const next = new Set(prev);
      if (next.has(subject)) next.delete(subject);
      else next.add(subject);
      return next;
    });
  };

  // Don't show if loading, dismissed, or profile is already complete
  if (isLoading || dismissed || !userId) return null;
  if (isProfileComplete(profile ?? null)) return null;

  const canProceedStep0 = age && school && level;
  const canSubmit = selectedSubjects.size > 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-lg p-4">
      <div
        className="glass-panel-elite max-w-lg w-full max-h-[85vh] overflow-y-auto p-0"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="relative px-6 pt-6 pb-4 border-b border-white/[0.06]">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-violet-500/20 border border-violet-500/40 flex items-center justify-center">
              <User className="w-5 h-5 text-violet-400" />
            </div>
            <div>
              <h3 className="text-lg font-bold text-slate-100">Complete Your Profile</h3>
              <p className="text-xs text-slate-400 mt-0.5">Help your tutor get to know you better</p>
            </div>
          </div>
          <button
            onClick={() => setDismissed(true)}
            className="absolute top-4 right-4 text-slate-500 hover:text-slate-300 p-2 rounded-lg hover:bg-white/[0.04] transition-colors"
            aria-label="Dismiss"
          >
            <X className="w-4 h-4" />
          </button>
          {/* Step indicator */}
          <div className="flex items-center gap-2 mt-4">
            <div className={`h-1 flex-1 rounded-full transition-colors ${step >= 0 ? "bg-violet-500" : "bg-slate-700"}`} />
            <div className={`h-1 flex-1 rounded-full transition-colors ${step >= 1 ? "bg-violet-500" : "bg-slate-700"}`} />
          </div>
        </div>

        {/* Body */}
        <div className="px-6 py-5">
          {step === 0 ? (
            <div className="space-y-4">
              <p className="text-sm text-slate-300 mb-4">Tell us a bit about yourself so your tutor can tailor your experience.</p>

              {/* Age */}
              <div>
                <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1.5 block">
                  <span className="flex items-center gap-1.5"><User className="w-3 h-3" /> Age</span>
                </label>
                <input
                  type="number"
                  min={5}
                  max={99}
                  value={age}
                  onChange={(e) => setAge(e.target.value)}
                  placeholder="Enter your age"
                  className="w-full h-11 px-4 rounded-xl bg-slate-900/60 border border-slate-700 text-sm text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-violet-500/50 transition-colors"
                />
              </div>

              {/* School */}
              <div>
                <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1.5 block">
                  <span className="flex items-center gap-1.5"><School className="w-3 h-3" /> School</span>
                </label>
                <input
                  type="text"
                  value={school}
                  onChange={(e) => setSchool(e.target.value)}
                  placeholder="Enter your school name"
                  className="w-full h-11 px-4 rounded-xl bg-slate-900/60 border border-slate-700 text-sm text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-violet-500/50 transition-colors"
                />
              </div>

              {/* Syllabus */}
              <div>
                <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1.5 block">
                  <span className="flex items-center gap-1.5"><BookOpen className="w-3 h-3" /> Syllabus (optional)</span>
                </label>
                <input
                  type="text"
                  value={syllabus}
                  onChange={(e) => setSyllabus(e.target.value)}
                  placeholder="e.g. Cambridge IGCSE, ZIMSEC, IEB"
                  className="w-full h-11 px-4 rounded-xl bg-slate-900/60 border border-slate-700 text-sm text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-violet-500/50 transition-colors"
                />
              </div>

              {/* Level */}
              <div>
                <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1.5 block">
                  <span className="flex items-center gap-1.5"><GraduationCap className="w-3 h-3" /> Level</span>
                </label>
                <div className="grid grid-cols-2 gap-2">
                  {LEVELS.map((l) => (
                    <button
                      key={l}
                      onClick={() => setLevel(l)}
                      className={`px-3 py-2.5 rounded-xl text-sm font-medium transition-all text-left ${
                        level === l
                          ? "bg-violet-500/20 border border-violet-500/50 text-violet-300"
                          : "bg-slate-800/40 border border-slate-700/50 text-slate-400 hover:bg-slate-800/60 hover:text-slate-300"
                      }`}
                    >
                      {l}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <p className="text-sm text-slate-300 mb-4">
                Which subjects is MCEC tutoring you in? Select all that apply.
              </p>
              <div className="grid grid-cols-2 gap-2">
                {SUBJECTS.map((subject) => {
                  const selected = selectedSubjects.has(subject);
                  return (
                    <button
                      key={subject}
                      onClick={() => toggleSubject(subject)}
                      className={`flex items-center gap-2 px-3 py-2.5 rounded-xl text-sm font-medium transition-all text-left ${
                        selected
                          ? "bg-violet-500/20 border border-violet-500/50 text-violet-300"
                          : "bg-slate-800/40 border border-slate-700/50 text-slate-400 hover:bg-slate-800/60 hover:text-slate-300"
                      }`}
                    >
                      <div className={`w-4 h-4 rounded-md border flex items-center justify-center shrink-0 ${
                        selected ? "bg-violet-500 border-violet-500" : "border-slate-600"
                      }`}>
                        {selected && <CheckCircle2 className="w-3 h-3 text-white" />}
                      </div>
                      {subject}
                    </button>
                  );
                })}
              </div>
              {selectedSubjects.size > 0 && (
                <p className="text-xs text-slate-500 mt-2">
                  {selectedSubjects.size} subject{selectedSubjects.size !== 1 ? "s" : ""} selected
                </p>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 pb-6 flex items-center justify-between gap-3">
          {step === 1 ? (
            <button
              onClick={() => setStep(0)}
              className="px-4 py-2.5 rounded-xl text-sm font-medium text-slate-400 hover:text-slate-200 transition-colors"
            >
              Back
            </button>
          ) : (
            <button
              onClick={() => setDismissed(true)}
              className="px-4 py-2.5 rounded-xl text-sm font-medium text-slate-500 hover:text-slate-300 transition-colors"
            >
              Skip for now
            </button>
          )}

          {step === 0 ? (
            <button
              onClick={() => setStep(1)}
              disabled={!canProceedStep0}
              className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-medium bg-violet-600 text-white hover:bg-violet-500 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
            >
              Next <ChevronRight className="w-4 h-4" />
            </button>
          ) : (
            <button
              onClick={() => saveMutation.mutate()}
              disabled={!canSubmit || saveMutation.isPending}
              className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-medium bg-violet-600 text-white hover:bg-violet-500 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
            >
              {saveMutation.isPending ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <>Save Profile <CheckCircle2 className="w-4 h-4" /></>
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
