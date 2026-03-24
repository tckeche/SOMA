import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import type { SomaQuiz, SomaQuestion } from "@shared/schema";
import { STANDARDIZED_SUBJECTS } from "@shared/schema";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { Link, useLocation, useParams } from "wouter";
import {
  ArrowLeft, Send, Loader2, Sparkles, FileStack, Upload, Trash2,
  FileText, X, Pencil, BookOpen,
  Scan, Brain, Search, CheckCircle2, Eye, PartyPopper, LayoutDashboard
} from "lucide-react";
import 'katex/dist/katex.min.css';
import { renderLatex, unescapeLatex } from '@/lib/render-latex';
import SomaQuizEngine from "./soma-quiz";
import type { StudentQuestion } from "./soma-quiz";
import { supabase } from "@/lib/supabase";
import { createIdentityHeaders } from "@/lib/identityHeaders";
import { useSupabaseSession } from "@/hooks/use-supabase-session";

const LEVEL_OPTIONS = ["University", "Grade 6", "Grade 7", "Grade 8", "Grade 9", "Grade 10", "Grade 11", "Grade 12", "IGCSE", "AS", "A2", "Other"];

const PIPELINE_STAGES = [
  { stage: 1, icon: "search", label: "Reading syllabus & context", aiName: "Context" },
  { stage: 2, icon: "brain", label: "Analysing requirements", aiName: "Analysis" },
  { stage: 3, icon: "scan", label: "Drafting questions & balancing options", aiName: "Drafting" },
  { stage: 4, icon: "pencil", label: "Preparing summary & saving", aiName: "Summary" },
];

const PDF_PIPELINE_STAGES = [
  { label: "Uploading document", detail: "Sending PDF to the server...", icon: Upload },
  { label: "Reading pages", detail: "Parsing document structure and text content...", icon: FileText },
  { label: "Extracting questions", detail: "Gemini AI is analysing the paper and identifying each question...", icon: Brain },
  { label: "Verifying accuracy", detail: "Running two-pass verification against the original document...", icon: Search },
  { label: "Formatting output", detail: "Structuring questions into MCQ format with KaTeX notation...", icon: Scan },
  { label: "Saving questions", detail: "Writing verified questions to the database...", icon: CheckCircle2 },
  { label: "Complete", detail: "All questions imported successfully!", icon: PartyPopper },
];

function PdfExtractionPipeline({ stage, fileName, startTime }: { stage: number; fileName: string; startTime: number }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const iv = setInterval(() => setElapsed(Math.floor((Date.now() - startTime) / 1000)), 1000);
    return () => clearInterval(iv);
  }, [startTime]);

  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;
  const progress = Math.min(((stage + 1) / PDF_PIPELINE_STAGES.length) * 100, 100);
  const isDone = stage >= 6;

  return (
    <div className="mt-4 rounded-2xl border border-violet-500/20 bg-slate-900/90 backdrop-blur-xl overflow-hidden" data-testid="pdf-extraction-pipeline">
      <div className="px-5 pt-4 pb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="relative w-8 h-8">
            <div className="absolute inset-0 rounded-lg bg-violet-500/20 animate-pulse" />
            <div className="absolute inset-0 flex items-center justify-center">
              {isDone ? <CheckCircle2 className="w-5 h-5 text-emerald-400" /> : <Brain className="w-5 h-5 text-violet-400 animate-pulse" />}
            </div>
          </div>
          <div>
            <p className="text-sm font-semibold text-slate-100">
              {isDone ? "Extraction Complete" : "AI Extraction Pipeline"}
            </p>
            <p className="text-[11px] text-slate-500 truncate max-w-[200px]">{fileName}</p>
          </div>
        </div>
        <div className="text-right">
          <span className="text-xs font-mono text-slate-400">{mins}:{secs.toString().padStart(2, "0")}</span>
        </div>
      </div>

      <div className="mx-5 mb-4">
        <div className="h-1.5 rounded-full bg-slate-800 overflow-hidden">
          <div
            className="h-full rounded-full transition-all duration-1000 ease-out"
            style={{
              width: `${progress}%`,
              background: isDone
                ? "linear-gradient(90deg, #10b981, #34d399)"
                : "linear-gradient(90deg, #8b5cf6, #a78bfa, #c4b5fd)",
            }}
          />
        </div>
        <div className="flex justify-between mt-1">
          <span className="text-[10px] text-slate-600">{Math.round(progress)}%</span>
          {!isDone && <span className="text-[10px] text-slate-600">This may take 1-2 minutes</span>}
        </div>
      </div>

      <div className="px-5 pb-4 space-y-1">
        {PDF_PIPELINE_STAGES.map((s, i) => {
          const isActive = i === stage;
          const isComplete = i < stage;
          const isPending = i > stage;
          const Icon = s.icon;
          return (
            <div
              key={i}
              className={`flex items-center gap-3 px-3 py-2 rounded-lg transition-all duration-500 ${
                isActive ? "bg-violet-500/10 border border-violet-500/20" : isComplete ? "opacity-60" : "opacity-30"
              }`}
              data-testid={`pipeline-stage-${i}`}
            >
              <div className={`w-7 h-7 rounded-md flex items-center justify-center shrink-0 ${
                isComplete ? "bg-emerald-500/20" : isActive ? "bg-violet-500/20" : "bg-slate-800/50"
              }`}>
                {isComplete ? (
                  <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                ) : isActive ? (
                  <Icon className="w-4 h-4 text-violet-400 animate-pulse" />
                ) : (
                  <Icon className="w-4 h-4 text-slate-600" />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <p className={`text-xs font-medium ${isComplete ? "text-emerald-400" : isActive ? "text-slate-200" : "text-slate-600"}`}>
                  {s.label}
                </p>
                {isActive && (
                  <p className="text-[11px] text-slate-400 mt-0.5 animate-fadeIn">{s.detail}</p>
                )}
              </div>
              {isActive && !isDone && (
                <Loader2 className="w-4 h-4 text-violet-400 animate-spin shrink-0" />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function BuilderPage() {
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const params = useParams<{ id?: string }>();
  const editId = params.id ? parseInt(params.id) : null;
  const isEditMode = editId !== null;

  const [title, setTitle] = useState("");
  const [syllabus, setSyllabus] = useState("");
  const [level, setLevel] = useState("");
  const [subject, setSubject] = useState("");
  const [timeLimitMinutes, setTimeLimitMinutes] = useState(60);

  const [msg, setMsg] = useState("");
  const [chat, setChat] = useState<{ role: "user" | "ai"; text: string; metadata?: { provider: string; model: string; durationMs: number } }[]>([]);
  const [savedQuestions, setSavedQuestions] = useState<SomaQuestion[]>([]);
  const [populated, setPopulated] = useState(false);
  const [activeQuizId, setActiveQuizId] = useState<number | null>(editId);

  const [pipelineActive, setPipelineActive] = useState(false);
  const [currentStage, setCurrentStage] = useState(0);
  const [completedStages, setCompletedStages] = useState<Set<number>>(new Set());

  const [includeGraphQuestions, setIncludeGraphQuestions] = useState(false);

  const [showPreview, setShowPreview] = useState(false);
  const [showSuccessModal, setShowSuccessModal] = useState(false);
  const [lastSavedCount, setLastSavedCount] = useState(0);
  const [metaDirty, setMetaDirty] = useState(false);
  const [supportingDocs, setSupportingDocs] = useState<{ name: string; type: string; processing: boolean }[]>([]);
  const [docContext, setDocContext] = useState<{ name: string; type: string; fileId: string }[]>([]);
  const [uploadPipeline, setUploadPipeline] = useState<{ active: boolean; stage: number; fileName: string; startTime: number }>({ active: false, stage: 0, fileName: "", startTime: 0 });
  const [syllabusDocs, setSyllabusDocs] = useState<{ id: number; board: string; level: string; syllabusCode: string; filename: string; uploadedAt: string }[]>([]);
  const [selectedSyllabusId, setSelectedSyllabusId] = useState<string>("");
  const [syllabusUpload, setSyllabusUpload] = useState({ board: "Cambridge", level: "", syllabusCode: "" });

  const chatEndRef = useRef<HTMLDivElement>(null);

  const { session: supaSession, isLoading: supaLoading, userId: tutorUserId } = useSupabaseSession();
  const supaAccessToken = supaSession?.access_token;
  const isTutorAuth = !!tutorUserId;
  const backLink = "/tutor/assessments";

  const authHeaders = useCallback((): Record<string, string> => {
    return createIdentityHeaders(
      "x-tutor-id",
      tutorUserId,
      supaAccessToken ? { Authorization: `Bearer ${supaAccessToken}` } : {},
    );
  }, [supaAccessToken, tutorUserId]);

  const authFetch = useCallback(async (url: string, opts: RequestInit = {}): Promise<Response> => {
    const headers = { ...authHeaders(), ...(opts.headers || {}) };
    return fetch(url, { ...opts, headers, credentials: "include" });
  }, [authHeaders]);

  const authApiRequest = useCallback(async (method: string, url: string, data?: unknown): Promise<Response> => {
    const headers: Record<string, string> = { ...authHeaders() };
    if (data) headers["Content-Type"] = "application/json";
    const res = await fetch(url, {
      method,
      headers,
      body: data ? JSON.stringify(data) : undefined,
      credentials: "include",
    });
    if (!res.ok) {
      const text = await res.text();
      try {
        const json = JSON.parse(text);
        throw new Error(json.message || text);
      } catch (e) {
        if (e instanceof Error && e.message) throw e;
        throw new Error(text || res.statusText);
      }
    }
    return res;
  }, [authHeaders]);

  const { data: tutorSession, isLoading: sessionLoading, error: sessionError } = useQuery<{ authenticated: boolean }>({
    queryKey: ["/api/tutor/session", tutorUserId],
    queryFn: async () => {
      const res = await authFetch("/api/tutor/session");
      return res.json();
    },
    enabled: !supaLoading && !!tutorUserId,
  });

  const authenticated = tutorSession?.authenticated === true;

  useEffect(() => {
    if (!authenticated) return;
    authFetch("/api/tutor/syllabus-documents")
      .then((res) => res.ok ? res.json() : [])
      .then((data) => setSyllabusDocs(Array.isArray(data) ? data : []))
      .catch(() => setSyllabusDocs([]));
  }, [authenticated, authFetch]);

  const { data: quizData, isLoading: quizLoading } = useQuery<SomaQuiz & { questions: SomaQuestion[] }>({
    queryKey: ["/api/tutor/quizzes", activeQuizId],
    queryFn: async () => {
      const res = await authFetch(`/api/tutor/quizzes/${activeQuizId}/detail`);
      if (!res.ok) throw new Error("Failed to load quiz");
      return res.json();
    },
    enabled: authenticated && activeQuizId !== null,
  });

  useEffect(() => {
    if (quizData && !populated) {
      setTitle(quizData.title);
      setSyllabus(quizData.syllabus || "");
      setLevel(quizData.level || "");
      setSubject(quizData.subject || "");
      setTimeLimitMinutes(quizData.timeLimitMinutes ?? 60);
      if (quizData.questions) {
        setSavedQuestions(quizData.questions);
      }
      setPopulated(true);
    }
  }, [quizData, populated]);

  useEffect(() => {
    if (quizData?.questions) {
      setSavedQuestions(quizData.questions);
    }
  }, [quizData]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chat]);

  const markMeta = () => { if (activeQuizId) setMetaDirty(true); };

  const ensureQuizExists = async (): Promise<number> => {
    if (activeQuizId) return activeQuizId;
    if (!title.trim()) throw new Error("Please fill in a quiz title before generating questions.");
    const quizRes = await authApiRequest("POST", "/api/tutor/quizzes", {
      title: title.trim(),
      topic: title.trim(),
      syllabus: syllabus || null,
      level: level || null,
      subject: subject || null,
      timeLimitMinutes,
    });
    const quiz = await quizRes.json();
    setActiveQuizId(quiz.id);
    // Update URL so refresh preserves the quiz
    navigate(`/tutor/assessments/edit/${quiz.id}`);
    return quiz.id;
  };

  const animatePipeline = (stage: number) => {
    setPipelineActive(true);
    setCurrentStage(stage);
    setCompletedStages((prev) => {
      const next = new Set(prev);
      for (let i = 1; i < stage; i++) next.add(i);
      return next;
    });
  };

  const finishPipeline = () => {
    setCompletedStages(new Set([1, 2, 3, 4]));
    setCurrentStage(0);
    setTimeout(() => setPipelineActive(false), 1500);
  };

  const chatMutation = useMutation({
    mutationFn: async (message: string) => {
      animatePipeline(1);
      const context = [
        subject && `Subject: ${subject}`,
        level && `Level: ${level}`,
        syllabus && `Syllabus: ${syllabus}`,
      ].filter(Boolean).join(", ");
      const enrichedMessage = context ? `[${context}]\n\n${message}` : message;
      const docIds = docContext.map((d) => d.fileId);
      const selectedSyllabus = syllabusDocs.find((doc) => String(doc.id) === selectedSyllabusId);

      // Build structured assessment context so copilot knows what's already saved
      const topicsCovered = Array.from(new Set(savedQuestions.map((q) => (q as any).topicTag).filter(Boolean))) as string[];
      const subtopicsCovered = Array.from(new Set(savedQuestions.map((q) => (q as any).subtopicTag).filter(Boolean))) as string[];
      const difficultySpread = savedQuestions.reduce((acc, q) => {
        const d = String((q as any).difficultyTag || "").toLowerCase();
        if (d.includes("easy")) acc.easy++;
        else if (d.includes("hard")) acc.hard++;
        else acc.medium++;
        return acc;
      }, { easy: 0, medium: 0, hard: 0 });
      const graphQuestionCount = savedQuestions.filter((q) => (q as any).questionType === "graph").length;
      const recentQuestions = savedQuestions.slice(-6).map((q) => ({
        stem: q.stem,
        type: (q as any).questionType || "multiple_choice",
        topic: (q as any).topicTag || null,
      }));
      const assessmentContext = {
        assessmentMeta: { title, subject, level, syllabus },
        questionCount: savedQuestions.length,
        topicsCovered,
        subtopicsCovered,
        difficultySpread,
        graphQuestionCount,
        recentQuestions,
      };

      animatePipeline(2);
      const res = await authApiRequest("POST", "/api/tutor/copilot-chat", {
        message: enrichedMessage,
        documentIds: docIds.length > 0 ? docIds : undefined,
        chatHistory: chat,
        syllabusSelection: selectedSyllabus ? {
          board: selectedSyllabus.board,
          level: selectedSyllabus.level,
          syllabusCode: selectedSyllabus.syllabusCode,
        } : undefined,
        includeGraphQuestions,
        assessmentContext,
      });
      const data = await res.json();

      if (data.needsClarification) {
        setPipelineActive(false);
        return { ...data, savedToDb: false };
      }

      if (Array.isArray(data.drafts) && data.drafts.length > 0) {
        animatePipeline(3);
        const quizId = await ensureQuizExists();

        animatePipeline(4);
        await authApiRequest("POST", `/api/tutor/quizzes/${quizId}/questions`, { questions: data.drafts });

        await queryClient.refetchQueries({ queryKey: ["/api/tutor/quizzes", quizId] });
        queryClient.invalidateQueries({ queryKey: ["/api/tutor/quizzes"] });

        const refetched = queryClient.getQueryData<SomaQuiz & { questions: SomaQuestion[] }>(["/api/tutor/quizzes", quizId]);
        if (refetched?.questions) {
          setSavedQuestions(refetched.questions);
        }

        finishPipeline();
        return { ...data, savedToDb: true, savedCount: data.drafts.length };
      }

      setPipelineActive(false);
      return { ...data, savedToDb: false };
    },
    onSuccess: (data, message) => {
      setChat((prev) => [...prev, { role: "user", text: message }, { role: "ai", text: data.reply, metadata: data.metadata }]);
      if (data.savedToDb) {
        setLastSavedCount(data.savedCount);
        setShowSuccessModal(true);
      }
      setMsg("");
    },
    onError: (err: Error) => {
      setPipelineActive(false);
      toast({ title: "Copilot failed", description: err.message, variant: "destructive" });
    },
  });

  const updateMetaMutation = useMutation({
    mutationFn: async () => {
      if (!activeQuizId) throw new Error("No quiz to update");
      if (!title.trim()) throw new Error("Title is required");
      await authApiRequest("PUT", `/api/tutor/quizzes/${activeQuizId}`, {
        title: title.trim(),
        syllabus: syllabus || null,
        level: level || null,
        subject: subject || null,
        timeLimitMinutes,
      });
    },
    onSuccess: () => {
      setMetaDirty(false);
      queryClient.invalidateQueries({ queryKey: ["/api/tutor/quizzes", activeQuizId] });
      queryClient.invalidateQueries({ queryKey: ["/api/tutor/quizzes"] });
      toast({ title: "Assessment details updated" });
    },
    onError: (err: Error) => toast({ title: "Failed to update", description: err.message, variant: "destructive" }),
  });

  const deleteQuestionMutation = useMutation({
    mutationFn: async (questionId: number) =>
      authApiRequest("DELETE", `/api/tutor/questions/${questionId}`),
    onSuccess: (_data, questionId) => {
      setSavedQuestions((prev) => prev.filter((q) => q.id !== questionId));
      queryClient.invalidateQueries({ queryKey: ["/api/tutor/quizzes", activeQuizId] });
      toast({ title: "Question deleted" });
    },
    onError: (err: Error) => toast({ title: "Failed to delete question", description: err.message, variant: "destructive" }),
  });

  const handleSupportingDoc = async (file: File, docType: string) => {
    const docEntry = { name: file.name, type: docType, processing: true };
    setSupportingDocs((prev) => [...prev, docEntry]);
    setUploadPipeline({ active: true, stage: 0, fileName: file.name, startTime: Date.now() });
    try {
      const uploadForm = new FormData();
      uploadForm.append("pdf", file);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 270_000);

      const stageTimer1 = setTimeout(() => setUploadPipeline((p) => ({ ...p, stage: 1 })), 2000);
      const stageTimer2 = setTimeout(() => setUploadPipeline((p) => ({ ...p, stage: 2 })), 8000);
      const stageTimer3 = setTimeout(() => setUploadPipeline((p) => ({ ...p, stage: 3 })), 30000);

      const uploadRes = await authFetch("/api/tutor/upload-doc", {
        method: "POST",
        body: uploadForm,
        signal: controller.signal,
      });
      clearTimeout(timeout);
      clearTimeout(stageTimer1);
      clearTimeout(stageTimer2);
      clearTimeout(stageTimer3);

      setUploadPipeline((p) => ({ ...p, stage: 4 }));

      let fileId: string | null = null;
      let extractedDrafts: any[] = [];
      if (uploadRes.ok) {
        const uploadData = await uploadRes.json();
        fileId = uploadData.id;
        extractedDrafts = Array.isArray(uploadData.drafts) ? uploadData.drafts : [];
      } else {
        const errData = await uploadRes.json().catch(() => null);
        toast({ title: "PDF extraction failed", description: errData?.message || `Server error (${uploadRes.status})`, variant: "destructive" });
      }
      setSupportingDocs((prev) =>
        prev.map((d) => (d.name === file.name && d.type === docType ? { ...d, processing: false } : d))
      );
      if (fileId) {
        setDocContext((prev) => [...prev, { name: file.name, type: docType, fileId }]);
      }

      if (extractedDrafts.length > 0) {
        setUploadPipeline((p) => ({ ...p, stage: 5 }));
        const quizId = await ensureQuizExists();
        await authApiRequest("POST", `/api/tutor/quizzes/${quizId}/questions`, { questions: extractedDrafts });

        await queryClient.refetchQueries({ queryKey: ["/api/tutor/quizzes", quizId] });
        queryClient.invalidateQueries({ queryKey: ["/api/tutor/quizzes"] });

        const refetched = queryClient.getQueryData<SomaQuiz & { questions: SomaQuestion[] }>(["/api/tutor/quizzes", quizId]);
        if (refetched?.questions) {
          setSavedQuestions(refetched.questions);
        }
        toast({ title: `Imported ${extractedDrafts.length} question${extractedDrafts.length === 1 ? "" : "s"} from PDF` });
      }
      setUploadPipeline((p) => ({ ...p, stage: 6 }));
      setTimeout(() => setUploadPipeline({ active: false, stage: 0, fileName: "", startTime: 0 }), 2500);
    } catch (err: any) {
      const isTimeout = err?.name === "AbortError";
      toast({ title: isTimeout ? "Upload timed out" : "Upload failed", description: isTimeout ? "The PDF was too large to process. Try a smaller file." : "Something went wrong during extraction.", variant: "destructive" });
      setSupportingDocs((prev) => prev.filter((d) => !(d.name === file.name && d.type === docType)));
      setUploadPipeline({ active: false, stage: 0, fileName: "", startTime: 0 });
    }
  };

  const handleSend = () => {
    if (!msg.trim() || chatMutation.isPending || !authenticated) return;
    chatMutation.mutate(msg);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const totalQuestions = savedQuestions.length;

  const previewQuestions = useMemo(() =>
    savedQuestions.map((q) => ({
      id: q.id,
      quizId: activeQuizId || 0,
      stem: unescapeLatex(q.stem),
      options: q.options,
      marks: q.marks,
      questionType: (q as any).questionType,
      graphSpec: (q as any).graphSpec,
    } as StudentQuestion)), [savedQuestions, activeQuizId]);

  const handleSyllabusUpload = async (file: File) => {
    const form = new FormData();
    form.append("pdf", file);
    form.append("board", syllabusUpload.board);
    form.append("level", syllabusUpload.level);
    form.append("syllabusCode", syllabusUpload.syllabusCode);
    const res = await authFetch("/api/tutor/syllabus-documents", { method: "POST", body: form });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || "Upload failed");
    setSyllabusDocs((prev) => [...prev, data]);
    setSelectedSyllabusId(String(data.id));
    toast({ title: "Syllabus uploaded", description: `${data.board} ${data.level} ${data.syllabusCode}` });
  };

  if (supaLoading || sessionLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-violet-400" />
      </div>
    );
  }

  if (sessionError) {
    return <div className="min-h-screen bg-background p-4 md:p-6 text-red-400">Failed to verify session.</div>;
  }

  if (!authenticated) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <div className="glass-card p-8 text-center">
          <p className="text-slate-300">Please <Link href="/login" className="text-violet-400 underline">log in</Link> to access the builder.</p>
        </div>
      </div>
    );
  }

  if (isEditMode && quizLoading) {
    return (
      <div className="min-h-screen bg-background">
        <header className="border-b border-white/5 bg-white/[0.02] backdrop-blur-sm">
          <div className="max-w-[1400px] mx-auto px-4 md:px-6 py-4">
            <Skeleton className="h-8 w-48 bg-white/5" />
          </div>
        </header>
        <main className="max-w-[1400px] mx-auto p-4 md:p-6 space-y-4">
          <Skeleton className="h-64 w-full bg-white/5" />
          <Skeleton className="h-64 w-full bg-white/5" />
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-white/5 bg-white/[0.02] backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-[1400px] mx-auto px-4 md:px-6 py-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 md:gap-3 min-w-0">
            <Link href={backLink}>
              <Button className="glow-button-outline" size="default" data-testid="button-back-admin">
                <ArrowLeft className="w-4 h-4 md:mr-1" />
                <span>Back</span>
              </Button>
            </Link>
            <div className="flex items-center gap-2 md:gap-3 min-w-0">
              <img src="/MCEC - White Logo.png" alt="MCEC Logo" className="h-7 md:h-8 w-auto object-contain" />
              <div className="min-w-0">
                <h1 className="text-base md:text-lg font-bold gradient-text truncate" data-testid="text-builder-title">
                  {activeQuizId ? "Edit Assessment" : "New Assessment"}
                </h1>
                {activeQuizId && <p className="text-[10px] md:text-xs text-slate-500">ID: {activeQuizId}</p>}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Badge className="bg-white/5 text-slate-400 border-white/10 text-[10px] md:text-xs">
              {totalQuestions} Q{totalQuestions !== 1 ? "s" : ""}
            </Badge>
            <Button
              className="border border-violet-500/30 bg-violet-500/10 text-violet-300 hover:bg-violet-500/20 hover:border-violet-500/50 transition-all"
              size="default"
              onClick={() => setShowPreview(true)}
              disabled={totalQuestions === 0}
              data-testid="button-preview-quiz"
            >
              <Eye className="w-4 h-4 md:mr-1.5" />
              <span className="hidden md:inline">Preview</span>
            </Button>
            <Link href="/tutor/assessments">
              <Button className="border border-red-500/20 bg-red-500/10 text-red-400 hover:bg-red-500/20 hover:border-red-500/30 transition-all" size="default" data-testid="button-exit-builder">
                <X className="w-4 h-4 md:mr-1" />
                <span>Exit Assessment</span>
              </Button>
            </Link>
          </div>
        </div>
      </header>

      {/* Main content — single column on mobile, 2-col grid on desktop */}
      <main className="max-w-[1600px] mx-auto flex flex-col md:grid md:grid-cols-12 gap-4 p-4 md:p-6 lg:p-8">

        {/* LEFT COLUMN (parameters + copilot + pipeline + docs) */}
        <div className="md:col-span-8 flex flex-col gap-4">

          {/* 1. Quiz Parameters */}
          <div className="glass-card p-4 md:p-5">
            <div className="flex items-center gap-2 mb-3">
              <BookOpen className="w-4 h-4 text-violet-400" />
              <h2 className="font-semibold text-slate-100 text-sm">Assessment Parameters</h2>
              {activeQuizId && <Badge className="bg-emerald-500/10 text-emerald-400 border-emerald-500/30 text-[10px] ml-auto">Live &middot; ID {activeQuizId}</Badge>}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
              <div className="space-y-1.5 sm:col-span-2 lg:col-span-2">
                <Label className="text-slate-400 text-xs">Title</Label>
                <Input
                  value={title}
                  onChange={(e) => { setTitle(e.target.value); markMeta(); }}
                  placeholder="e.g. Pure Mathematics Paper 1"
                  className="glass-input text-sm h-12"
                  data-testid="input-quiz-title"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-slate-400 text-xs uppercase">Subject</Label>
                <select
                  value={subject}
                  onChange={(e) => { setSubject(e.target.value); markMeta(); }}
                  className="w-full glass-input px-3 rounded-lg bg-black/20 border border-white/10 text-slate-200 text-sm h-12"
                  data-testid="input-quiz-subject"
                >
                  <option value="">Select subject</option>
                  {STANDARDIZED_SUBJECTS.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-slate-400 text-xs uppercase">Syllabus</Label>
                <Input
                  value={syllabus}
                  onChange={(e) => { setSyllabus(e.target.value); markMeta(); }}
                  placeholder="Cambridge, Edexcel"
                  className="glass-input text-sm h-12"
                  data-testid="input-quiz-syllabus"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-slate-400 text-xs uppercase">Level</Label>
                <select
                  className="w-full glass-input px-3 rounded-lg bg-black/20 border border-white/10 text-slate-200 text-sm h-12"
                  value={level}
                  onChange={(e) => { setLevel(e.target.value); markMeta(); }}
                  data-testid="select-quiz-level"
                >
                  <option value="">Select level</option>
                  {LEVEL_OPTIONS.map((l) => (
                    <option key={l} value={l}>{l}</option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-slate-400 text-xs uppercase">Time Limit (Min)</Label>
                <Input
                  type="number"
                  min={1}
                  max={300}
                  value={timeLimitMinutes}
                  onChange={(e) => { setTimeLimitMinutes(Math.max(1, parseInt(e.target.value) || 60)); markMeta(); }}
                  className="glass-input text-sm h-12"
                  data-testid="input-quiz-time-limit"
                />
              </div>
            </div>
            {metaDirty && activeQuizId && (
              <div className="mt-3 flex justify-end">
                <Button
                  className="glow-button text-xs min-h-[44px]"
                  size="sm"
                  onClick={() => updateMetaMutation.mutate()}
                  disabled={updateMetaMutation.isPending || !title.trim()}
                  data-testid="button-save-metadata"
                >
                  {updateMetaMutation.isPending ? (
                    <><Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />Saving...</>
                  ) : (
                    <>Save Changes</>
                  )}
                </Button>
              </div>
            )}
          </div>

          {/* 2. AI Copilot — Main Focus */}
          <div className="glass-card flex flex-col overflow-hidden" style={{ minHeight: "400px" }}>
            <div className="px-4 py-3 border-b border-white/5 flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-violet-400" />
              <span className="text-sm font-semibold text-slate-200" data-testid="tab-copilot">AI Co-Pilot</span>
              {pipelineActive && <Loader2 className="w-3.5 h-3.5 animate-spin text-violet-400 ml-auto" />}
              {totalQuestions > 0 && !pipelineActive && (
                <Badge className="bg-emerald-500/10 text-emerald-400 border-emerald-500/30 text-[10px] ml-auto">
                  {totalQuestions} saved
                </Badge>
              )}
            </div>

            {/* Pipeline Progress */}
            {pipelineActive && (
              <div className="px-4 py-3 border-b border-white/5">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                  {PIPELINE_STAGES.map((s) => {
                    const isDone = completedStages.has(s.stage);
                    const isActive = currentStage === s.stage && !isDone;
                    return (
                      <div
                        key={s.stage}
                        className={`flex items-center gap-1.5 p-2 rounded-lg border text-xs transition-all ${
                          isDone ? "bg-emerald-500/10 border-emerald-500/30" :
                          isActive ? "bg-violet-500/10 border-violet-500/30 shadow-[0_0_15px_rgba(139,92,246,0.1)]" :
                          "bg-white/[0.02] border-white/5 opacity-40"
                        }`}
                        data-testid={`pipeline-stage-${s.stage}`}
                      >
                        <span className="shrink-0">
                          {s.icon === "scan" && <Scan className="w-3 h-3" />}
                          {s.icon === "brain" && <Brain className="w-3 h-3" />}
                          {s.icon === "pencil" && <Pencil className="w-3 h-3" />}
                          {s.icon === "search" && <Search className="w-3 h-3" />}
                        </span>
                        <span className={`flex-1 truncate ${isDone ? "text-emerald-400" : isActive ? "text-violet-300" : "text-slate-500"}`}>
                          {isActive ? s.label : s.aiName}
                        </span>
                        {isDone ? <CheckCircle2 className="w-3 h-3 text-emerald-400 shrink-0" /> :
                         isActive ? <Loader2 className="w-3 h-3 animate-spin text-violet-400 shrink-0" /> :
                         <div className="w-3 h-3 rounded-full border border-white/10 shrink-0" />}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Chat messages */}
            <div className="flex-1 p-4 overflow-auto space-y-3 h-[50vh] md:h-auto md:min-h-[300px] md:max-h-[500px]">
              {chat.length === 0 && (
                <div className="text-center pt-8 space-y-2">
                  <Sparkles className="w-8 h-8 mx-auto text-violet-400/40" />
                  <p className="text-sm text-slate-400">Ask the AI to generate assessment questions.</p>
                  <p className="text-xs text-slate-500">Questions are auto-saved to the database.</p>
                  <p className="text-xs text-slate-600 italic">"Generate 5 IGCSE quadratics MCQs"</p>
                </div>
              )}
              {docContext.length > 0 && (
                <div className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-xs text-emerald-400">
                  <FileText className="w-3.5 h-3.5 shrink-0" />
                  {docContext.length} document{docContext.length > 1 ? "s" : ""} loaded as context
                </div>
              )}
              {chat.map((m, i) => (
                <div key={i} className={m.role === "user" ? "text-right" : "text-left"}>
                  <div className={`inline-block max-w-[90%] rounded-xl px-3 py-2 text-sm whitespace-pre-wrap leading-relaxed ${
                    m.role === "user"
                      ? "bg-violet-600/20 text-violet-200 border border-violet-500/20"
                      : "bg-white/5 text-slate-300 border border-white/5"
                  }`}>
                    {m.text}
                    {m.metadata && (
                      <div className="mt-1.5 inline-flex items-center gap-1.5 px-1.5 py-0.5 rounded bg-slate-900/50 border border-white/5 text-[9px] text-slate-400 font-mono" data-testid={`badge-telemetry-${i}`}>
                        <span>{m.metadata.model}</span>
                        <span>{(m.metadata.durationMs / 1000).toFixed(2)}s</span>
                      </div>
                    )}
                  </div>
                </div>
              ))}
              <div ref={chatEndRef} />
            </div>

            {/* Chat input */}
            <div className="p-3 md:p-4 border-t border-white/5 space-y-2">
              <div className="flex gap-2">
                <Textarea
                  value={msg}
                  onChange={(e) => setMsg(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder={activeQuizId ? "Ask to edit or add questions..." : "Ask for questions..."}
                  className="glass-input flex-1 min-h-[44px] max-h-[100px] resize-none text-sm"
                  data-testid="input-copilot-message"
                />
                <Button
                  className="glow-button shrink-0 self-end min-h-[44px] min-w-[44px]"
                  size="icon"
                  onClick={handleSend}
                  disabled={!msg.trim() || chatMutation.isPending || !authenticated}
                  data-testid="button-copilot-send"
                >
                  {chatMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                </Button>
              </div>
              <label className="flex items-center gap-2 cursor-pointer select-none w-fit" data-testid="label-include-graph-questions">
                <input
                  type="checkbox"
                  checked={includeGraphQuestions}
                  onChange={(e) => setIncludeGraphQuestions(e.target.checked)}
                  className="w-3.5 h-3.5 accent-violet-500"
                  data-testid="checkbox-include-graph-questions"
                />
                <span className="text-xs text-slate-400">Include some questions with graphs</span>
              </label>
            </div>
          </div>

          {/* 3. Supporting Documents — Below Copilot */}
          <div className="glass-card p-4 md:p-5">
            <div className="flex items-center gap-2 mb-2">
              <Upload className="w-4 h-4 text-violet-400" />
              <h2 className="font-semibold text-slate-100 text-sm">Supporting Documents</h2>
            </div>
            <div className="mb-4 rounded-xl border border-cyan-500/20 bg-cyan-500/5 p-3 space-y-3">
              <p className="text-xs text-slate-300">Upload a Cambridge syllabus PDF and ground generation on the selected board, level, and syllabus code.</p>
              <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                <Input value={syllabusUpload.board} onChange={(e) => setSyllabusUpload((prev) => ({ ...prev, board: e.target.value }))} placeholder="Board" className="glass-input h-11" />
                <Input value={syllabusUpload.level} onChange={(e) => setSyllabusUpload((prev) => ({ ...prev, level: e.target.value }))} placeholder="Level" className="glass-input h-11" />
                <Input value={syllabusUpload.syllabusCode} onChange={(e) => setSyllabusUpload((prev) => ({ ...prev, syllabusCode: e.target.value }))} placeholder="Syllabus code" className="glass-input h-11" />
                <Label htmlFor="syllabus-upload-input" className="cursor-pointer">
                  <div className="flex items-center justify-center gap-2 text-sm text-cyan-200 border border-cyan-500/30 bg-cyan-500/10 rounded-lg px-4 py-2.5 min-h-[44px] hover:bg-cyan-500/20 transition-colors">
                    <Upload className="w-4 h-4" />
                    Upload Syllabus PDF
                  </div>
                  <input
                    id="syllabus-upload-input"
                    type="file"
                    accept=".pdf"
                    className="hidden"
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      try {
                        await handleSyllabusUpload(file);
                      } catch (error: any) {
                        toast({ title: "Syllabus upload failed", description: error.message, variant: "destructive" });
                      } finally {
                        e.target.value = "";
                      }
                    }}
                    data-testid="input-syllabus-doc"
                  />
                </Label>
              </div>
              <select
                value={selectedSyllabusId}
                onChange={(e) => setSelectedSyllabusId(e.target.value)}
                className="w-full glass-input px-3 rounded-lg bg-black/20 border border-white/10 text-slate-200 text-sm h-11"
                data-testid="select-syllabus-context"
              >
                <option value="">No syllabus grounding selected</option>
                {syllabusDocs.map((doc) => (
                  <option key={doc.id} value={doc.id}>{doc.board} · {doc.level} · {doc.syllabusCode}</option>
                ))}
              </select>
            </div>
            <p className="text-xs text-slate-500 mb-3">
              Upload a syllabus, past paper, or any other documents that the AI can help with generating questions from.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <select
                id="doc-type-select"
                className="glass-input px-3 py-2 rounded-lg bg-black/20 border border-white/10 text-slate-200 text-sm min-h-[44px]"
                defaultValue="past-paper"
                data-testid="select-doc-type"
              >
                <option value="past-paper">Past Exam Paper</option>
                <option value="syllabus">Cambridge Syllabus</option>
                <option value="textbook">Textbook Excerpt</option>
                <option value="notes">Custom Notes</option>
              </select>
              <Label htmlFor="supporting-doc-input" className="cursor-pointer">
                <div className="flex items-center gap-1.5 text-sm text-violet-300 border border-violet-500/30 bg-violet-500/10 rounded-lg px-4 py-2.5 min-h-[44px] hover:bg-violet-500/20 transition-colors">
                  <Upload className="w-4 h-4" />
                  Upload PDF
                </div>
                <input
                  id="supporting-doc-input"
                  type="file"
                  accept=".pdf"
                  className="hidden"
                  disabled={pipelineActive}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    const docType = (document.getElementById("doc-type-select") as HTMLSelectElement)?.value || "past-paper";
                    if (file) handleSupportingDoc(file, docType);
                    e.target.value = "";
                  }}
                  data-testid="input-supporting-doc"
                />
              </Label>
            </div>
            {uploadPipeline.active && <PdfExtractionPipeline stage={uploadPipeline.stage} fileName={uploadPipeline.fileName} startTime={uploadPipeline.startTime} />}

            {supportingDocs.length > 0 && !uploadPipeline.active && (
              <div className="mt-3 space-y-2">
                {supportingDocs.map((doc, i) => (
                  <div key={i} className="flex items-center gap-2 text-sm text-slate-400 bg-white/[0.03] border border-white/5 rounded-lg px-4 py-2.5 min-h-[44px]">
                    <FileText className="w-4 h-4 text-violet-400 shrink-0" />
                    <span className="truncate flex-1">{doc.name}</span>
                    <span className="text-[10px] uppercase text-slate-500 shrink-0">{doc.type}</span>
                    {doc.processing ? (
                      <Loader2 className="w-4 h-4 animate-spin text-violet-400 shrink-0" />
                    ) : (
                      <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                    )}
                    <button
                      className="text-slate-500 hover:text-red-400 shrink-0 min-w-[44px] min-h-[44px] flex items-center justify-center"
                      onClick={() => {
                        const removed = supportingDocs[i];
                        setSupportingDocs((prev) => prev.filter((_, j) => j !== i));
                        setDocContext((prev) => prev.filter((d) => !(d.name === removed.name && d.type === removed.type)));
                      }}
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* RIGHT COLUMN — Saved Questions (desktop sidebar) */}
        <div className="md:col-span-4">
          <div className="glass-card p-4 md:p-5 md:sticky md:top-20">
            <div className="flex items-center gap-2 mb-3">
              <FileStack className="w-4 h-4 text-emerald-400" />
              <h2 className="font-semibold text-slate-100 text-sm">Saved Questions</h2>
              <Badge className="bg-white/5 text-slate-400 border-white/10 text-[10px] ml-auto">{totalQuestions}</Badge>
            </div>

            {savedQuestions.length === 0 && !pipelineActive ? (
              <div className="py-8 text-center space-y-2">
                <FileStack className="w-8 h-8 mx-auto text-slate-700" />
                <p className="text-sm text-slate-500">No questions yet.</p>
                <p className="text-xs text-slate-600">Use the AI Co-Pilot to generate and auto-save questions.</p>
              </div>
            ) : (
              <div className="space-y-2 max-h-[60vh] md:max-h-[calc(100vh-180px)] overflow-auto">
                {savedQuestions.map((q, idx) => (
                  <div key={q.id} className="bg-white/[0.03] border border-white/5 rounded-lg p-3 flex items-start gap-2" data-testid={`card-saved-q-${q.id}`}>
                    <span className="text-xs font-mono text-emerald-400 font-medium mt-0.5 shrink-0 w-6">Q{idx + 1}</span>
                    <div className="flex-1 min-w-0">
                      <div className="text-xs text-slate-300 line-clamp-2">{renderLatex(unescapeLatex(q.stem))}</div>
                      <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                        <Badge className="bg-white/5 text-slate-500 border-white/10 text-[10px]">{q.options.length} opts</Badge>
                        <Badge className="bg-white/5 text-slate-500 border-white/10 text-[10px]">{q.marks}m</Badge>
                      </div>
                    </div>
                    <button
                      className="text-slate-600 hover:text-red-400 shrink-0 min-w-[36px] min-h-[36px] flex items-center justify-center rounded-lg transition-colors"
                      onClick={() => {
                        if (confirm("Delete this question permanently?")) {
                          deleteQuestionMutation.mutate(q.id);
                        }
                      }}
                      data-testid={`button-delete-saved-${q.id}`}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </main>

      {/* Success Modal */}
      {showSuccessModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" data-testid="modal-success">
          <div className="glass-card w-full max-w-md p-6 md:p-8 text-center space-y-5 border border-violet-500/20 shadow-[0_0_40px_rgba(139,92,246,0.15)]">
            <div className="w-16 h-16 rounded-full bg-gradient-to-br from-emerald-500/20 to-violet-500/20 flex items-center justify-center mx-auto border border-emerald-500/30">
              <PartyPopper className="w-8 h-8 text-emerald-400" />
            </div>
            <div>
              <h2 className="text-xl font-bold text-slate-100 mb-1" data-testid="text-success-title">Assessment Created Successfully!</h2>
              <p className="text-sm text-slate-400">
                {lastSavedCount} question{lastSavedCount !== 1 ? "s" : ""} generated, audited, and saved to the database.
              </p>
            </div>
            <div className="flex flex-col gap-2.5 pt-2">
              <Button
                className="w-full glow-button min-h-[48px]"
                onClick={() => { setShowSuccessModal(false); setShowPreview(true); }}
                data-testid="button-success-preview"
              >
                <Eye className="w-4 h-4 mr-2" />
                Preview Assessment
              </Button>
              <Link href="/tutor/assessments">
                <Button className="w-full glow-button-outline min-h-[48px]" data-testid="button-success-dashboard">
                  <LayoutDashboard className="w-4 h-4 mr-2" />
                  Back to Assessments
                </Button>
              </Link>
            </div>
          </div>
        </div>
      )}

      {/* Preview Modal */}
      {showPreview && (
        <div className="fixed inset-0 z-50 bg-background overflow-auto" data-testid="modal-preview">
          <SomaQuizEngine
            previewMode={true}
            previewTitle={title || "Untitled Assessment"}
            previewQuestions={previewQuestions}
            onExitPreview={() => setShowPreview(false)}
          />
        </div>
      )}
    </div>
  );
}
