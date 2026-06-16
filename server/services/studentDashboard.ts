/**
 * Student dashboard composer.
 *
 * Builds the composite payload returned from `GET /api/student/dashboard`.
 * Combines stored data (assignments, reports, mastery, notifications) with
 * derived signals (due-today summary, syllabus coverage with AS/A2 awareness,
 * performance trends, recent wins, motivating "what to do now" guidance, and
 * the things-to-remember reminders carousel).
 *
 * Everything is computed server-side so the frontend can stay declarative.
 */

import type { IStorage } from "../storage";
import type {
  SomaQuiz,
  SomaReport,
  QuizAssignment,
  SomaUser,
  StudentSubject,
  StudentTopicMastery,
  StudentNotification,
} from "@shared/schema";
import {
  composeReminders,
  getCurriculumTopics,
  normalizeLevel,
  normalizeSubject,
  pickEffectiveLevel,
  type CurriculumLevel,
  type CurriculumReminder,
  type CurriculumTopic,
} from "./curriculumContent";

export interface AssignmentRow {
  assignmentId: number;
  quizId: number;
  quizTitle: string;
  quizSubject: string | null;
  quizLevel: string | null;
  status: "pending" | "completed" | "overdue";
  dueDate: string | null;
  assignedAt: string;
  reportId: number | null;
  reportStatus: string | null;
  reviewRequested: boolean;
  score: number | null;
  maxScore: number;
  scorePercent: number | null;
  completedAt: string | null;
  questionCount: number;
}

export interface SubjectSummary {
  subject: string;
  level: CurriculumLevel | null;
  rawLevels: string[];
  pendingCount: number;
  completedCount: number;
  overdueCount: number;
  averageScorePercent: number | null;
  recentTrend: "up" | "down" | "flat" | "new";
  topics: Array<CurriculumTopic & {
    status: "mastered" | "in_progress" | "needs_work" | "untested";
    understandingPercent: number;
    attempts: number;
  }>;
  coverage: {
    totalTopics: number;
    coveredTopics: number;
    masteredTopics: number;
    coveragePercent: number;
    masteryPercent: number;
  };
}

export interface PerformanceStats {
  totalCompleted: number;
  totalAssigned: number;
  averageScorePercent: number | null;
  accuracyPercent: number | null;
  recentTrend: "up" | "down" | "flat" | "new";
  bestSubject: string | null;
  focusSubject: string | null;
  message: string;
}

export interface RecentWin {
  type: "high_score" | "first_completion" | "improvement" | "streak" | "mastery";
  title: string;
  detail: string;
  ts: string;
}

export interface NextAction {
  kind: "due_today" | "due_tomorrow" | "overdue" | "review_low_score" | "untested_topic" | "fresh_start";
  title: string;
  detail: string;
  href?: string;
  quizId?: number;
}

export interface DashboardPayload {
  student: { id: string; displayName: string; email: string };
  greeting: string;
  dueSummary: string;
  notifications: {
    items: Array<StudentNotification | DerivedNotification>;
    unreadCount: number;
  };
  subjects: SubjectSummary[];
  assignments: AssignmentRow[];
  completed: AssignmentRow[];
  performance: PerformanceStats;
  recentWins: RecentWin[];
  nextActions: NextAction[];
  reminders: CurriculumReminder[];
}

export interface DerivedNotification {
  id: string;
  type: "due_today" | "due_tomorrow" | "overdue";
  title: string;
  message: string;
  payload: { quizId: number; quizTitle: string; dueDate: string | null };
  readAt: null;
  createdAt: string;
  derived: true;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function daysBetween(a: Date, b: Date): number {
  return Math.round((startOfDay(a).getTime() - startOfDay(b).getTime()) / DAY_MS);
}

function pluralize(n: number, single: string, plural: string): string {
  return n === 1 ? `${n} ${single}` : `${n} ${plural}`;
}

function pickGreeting(name: string, hour: number): string {
  if (hour < 12) return `Good morning, ${name}`;
  if (hour < 18) return `Good afternoon, ${name}`;
  return `Good evening, ${name}`;
}

function buildDueSummary(assignments: AssignmentRow[]): string {
  const now = new Date();
  const today = startOfDay(now);
  let dueToday = 0;
  let dueTomorrow = 0;
  let overdue = 0;
  let dueThisWeek = 0;
  for (const a of assignments) {
    if (a.status === "completed") continue;
    if (!a.dueDate) continue;
    const d = new Date(a.dueDate);
    const delta = daysBetween(d, now);
    if (delta < 0) overdue++;
    else if (delta === 0) dueToday++;
    else if (delta === 1) dueTomorrow++;
    else if (delta <= 7) dueThisWeek++;
    void today;
  }
  const parts: string[] = [];
  if (overdue > 0) parts.push(`${pluralize(overdue, "task is", "tasks are")} overdue`);
  if (dueToday > 0) parts.push(`${pluralize(dueToday, "task is", "tasks are")} due today`);
  if (dueTomorrow > 0) parts.push(`${pluralize(dueTomorrow, "task is", "tasks are")} due tomorrow`);
  if (parts.length === 0) {
    if (dueThisWeek > 0) return `You have ${pluralize(dueThisWeek, "assignment", "assignments")} due this week — plenty of time to plan ahead.`;
    return "Nothing is due right now. A great moment to revise a topic you've been meaning to revisit.";
  }
  return `Heads up: ${parts.join(", ")}.`;
}

function tonePerformanceMessage(stats: Omit<PerformanceStats, "message">): string {
  const { totalCompleted, averageScorePercent, recentTrend, bestSubject, focusSubject } = stats;
  if (totalCompleted === 0) {
    return "Your first assessment will set the baseline. Take it at your own pace — accuracy first, speed later.";
  }
  if (averageScorePercent === null) {
    return "You've started some work — keep going so we can build a clearer picture of where you shine.";
  }
  const avg = averageScorePercent;
  const trendBit = recentTrend === "up"
    ? "and your last few results are trending upward — momentum is on your side."
    : recentTrend === "down"
      ? "and your recent results have dipped slightly — a normal part of learning. Re-attempt one tricky topic to bounce back."
      : "and you've been steady recently — a good time to push for a new personal best.";
  let bandLine: string;
  if (avg >= 80) bandLine = `You're averaging ${avg}% — strong, consistent work`;
  else if (avg >= 65) bandLine = `You're averaging ${avg}% — a solid foundation`;
  else if (avg >= 50) bandLine = `You're averaging ${avg}% — the basics are in place`;
  else bandLine = `You're averaging ${avg}% — room to grow, and that's exactly what assessments are for`;
  const focusLine = focusSubject
    ? ` ${focusSubject} is the one to lean into next.`
    : "";
  const bestLine = bestSubject && bestSubject !== focusSubject
    ? ` ${bestSubject} is currently your strongest area — protect that confidence.`
    : "";
  return `${bandLine} ${trendBit}${focusLine}${bestLine}`.trim();
}

function classifyMasteryStatus(m: StudentTopicMastery | undefined): "mastered" | "in_progress" | "needs_work" | "untested" {
  if (!m || !m.tested) return "untested";
  if (m.masteryAchieved || m.understandingPercent >= 80) return "mastered";
  if (m.understandingPercent >= 50) return "in_progress";
  return "needs_work";
}

/**
 * A quiz is "playable" only when it exists, is not archived, and is published —
 * the exact gate `/api/quizzes/available` and the quiz/questions endpoints
 * enforce (both 404 an archived or unpublished quiz). An assignment to a
 * non-playable quiz produces a dead `/soma/quiz/:id` link that hangs forever on
 * "Loading assessment…", so it must not be surfaced as actionable work.
 */
export function isPlayableQuiz(
  quiz: Pick<SomaQuiz, "isArchived" | "status"> | null | undefined,
): boolean {
  return !!quiz && !quiz.isArchived && quiz.status === "published";
}

function buildAssignmentRow(
  a: QuizAssignment & { quiz: SomaQuiz },
  report: SomaReport | undefined,
  maxScore: number,
  now: Date,
): AssignmentRow {
  const dueDate = a.dueDate ? new Date(a.dueDate) : null;
  const overdue = dueDate ? dueDate.getTime() < now.getTime() && a.status !== "completed" : false;
  const status: AssignmentRow["status"] = a.status === "completed" ? "completed" : overdue ? "overdue" : "pending";
  const scorePercent = report && maxScore > 0 ? Math.round((report.score / maxScore) * 100) : null;
  return {
    assignmentId: a.id,
    quizId: a.quizId,
    quizTitle: a.quiz?.title || "Untitled",
    quizSubject: a.quiz?.subject || null,
    quizLevel: a.quiz?.level || null,
    status,
    dueDate: a.dueDate ? new Date(a.dueDate).toISOString() : null,
    assignedAt: new Date(a.createdAt).toISOString(),
    reportId: report?.id || null,
    reportStatus: report?.status || null,
    reviewRequested: !!report?.reviewRequested,
    score: report?.score ?? null,
    maxScore,
    scorePercent,
    completedAt: report?.completedAt ? new Date(report.completedAt).toISOString() : null,
    questionCount: a.quiz?.questionCount ?? 0,
  };
}

function buildSubjectSummaries(
  assignments: AssignmentRow[],
  studentSubjects: StudentSubject[],
  mastery: StudentTopicMastery[],
): SubjectSummary[] {
  const grouped = new Map<string, AssignmentRow[]>();
  const subjectLevels = new Map<string, Set<string>>();

  for (const sub of studentSubjects) {
    const key = normalizeSubject(sub.subject);
    if (!grouped.has(key)) grouped.set(key, []);
    if (!subjectLevels.has(key)) subjectLevels.set(key, new Set());
    if (sub.level) subjectLevels.get(key)!.add(sub.level);
  }

  for (const a of assignments) {
    if (!a.quizSubject) continue;
    const key = normalizeSubject(a.quizSubject);
    if (!grouped.has(key)) grouped.set(key, []);
    if (!subjectLevels.has(key)) subjectLevels.set(key, new Set());
    grouped.get(key)!.push(a);
    if (a.quizLevel) subjectLevels.get(key)!.add(a.quizLevel);
  }

  const summaries: SubjectSummary[] = [];
  for (const [key, rows] of Array.from(grouped.entries())) {
    const rawLevels = Array.from(subjectLevels.get(key) ?? []);
    const level = pickEffectiveLevel(rawLevels);
    const completed = rows.filter((r) => r.status === "completed");
    const pending = rows.filter((r) => r.status === "pending");
    const overdue = rows.filter((r) => r.status === "overdue");
    const graded = completed.filter((r) => r.scorePercent !== null);
    const avg = graded.length > 0
      ? Math.round(graded.reduce((s, r) => s + (r.scorePercent ?? 0), 0) / graded.length)
      : null;
    const recentTrend = computeTrend(graded.map((r) => ({ ts: r.completedAt, score: r.scorePercent })));

    const topicsList = getCurriculumTopics(key, level);
    const masteryByTopic = new Map<string, StudentTopicMastery>();
    for (const m of mastery) {
      if (normalizeSubject(m.subject) === key) {
        masteryByTopic.set(m.topic.toLowerCase().trim(), m);
      }
    }
    const topics = topicsList.map((t) => {
      const m = masteryByTopic.get(t.topic.toLowerCase().trim());
      const status = classifyMasteryStatus(m);
      return {
        ...t,
        status,
        understandingPercent: m?.understandingPercent ?? 0,
        attempts: m?.attempts ?? 0,
      };
    });

    const coveredTopics = topics.filter((t) => t.status !== "untested").length;
    const masteredTopics = topics.filter((t) => t.status === "mastered").length;
    const totalTopics = topics.length;
    const coveragePercent = totalTopics === 0 ? 0 : Math.round((coveredTopics / totalTopics) * 100);
    const masteryPercent = totalTopics === 0 ? 0 : Math.round((masteredTopics / totalTopics) * 100);

    summaries.push({
      subject: titleCase(key),
      level,
      rawLevels,
      pendingCount: pending.length,
      completedCount: completed.length,
      overdueCount: overdue.length,
      averageScorePercent: avg,
      recentTrend,
      topics,
      coverage: { totalTopics, coveredTopics, masteredTopics, coveragePercent, masteryPercent },
    });
  }
  summaries.sort((a, b) => a.subject.localeCompare(b.subject));
  return summaries;
}

function titleCase(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

function computeTrend(items: Array<{ ts: string | null; score: number | null }>): "up" | "down" | "flat" | "new" {
  const valid = items
    .filter((i): i is { ts: string; score: number } => i.ts !== null && i.score !== null)
    .sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
  if (valid.length < 2) return valid.length === 0 ? "new" : "flat";
  const recent = valid.slice(-3);
  const earlier = valid.slice(0, -3);
  if (earlier.length === 0) {
    const first = recent[0].score;
    const last = recent[recent.length - 1].score;
    if (last - first >= 5) return "up";
    if (first - last >= 5) return "down";
    return "flat";
  }
  const recentAvg = recent.reduce((s, r) => s + r.score, 0) / recent.length;
  const earlierAvg = earlier.reduce((s, r) => s + r.score, 0) / earlier.length;
  if (recentAvg - earlierAvg >= 4) return "up";
  if (earlierAvg - recentAvg >= 4) return "down";
  return "flat";
}

function buildPerformance(assignments: AssignmentRow[], subjects: SubjectSummary[]): PerformanceStats {
  const completed = assignments.filter((a) => a.status === "completed");
  const graded = completed.filter((a) => a.scorePercent !== null);
  const avg = graded.length > 0
    ? Math.round(graded.reduce((s, a) => s + (a.scorePercent ?? 0), 0) / graded.length)
    : null;
  const totalCorrect = graded.reduce((s, a) => s + (a.score ?? 0), 0);
  const totalPossible = graded.reduce((s, a) => s + a.maxScore, 0);
  const accuracy = totalPossible > 0 ? Math.round((totalCorrect / totalPossible) * 100) : null;
  const trend = computeTrend(graded.map((g) => ({ ts: g.completedAt, score: g.scorePercent })));

  let bestSubject: string | null = null;
  let bestAvg = -Infinity;
  let focusSubject: string | null = null;
  let focusAvg = Infinity;
  for (const s of subjects) {
    if (s.averageScorePercent === null) continue;
    if (s.averageScorePercent > bestAvg) {
      bestAvg = s.averageScorePercent;
      bestSubject = s.subject;
    }
    if (s.averageScorePercent < focusAvg) {
      focusAvg = s.averageScorePercent;
      focusSubject = s.subject;
    }
  }

  const base: Omit<PerformanceStats, "message"> = {
    totalCompleted: completed.length,
    totalAssigned: assignments.length,
    averageScorePercent: avg,
    accuracyPercent: accuracy,
    recentTrend: trend,
    bestSubject,
    focusSubject: bestSubject === focusSubject ? null : focusSubject,
  };
  return { ...base, message: tonePerformanceMessage(base) };
}

function buildRecentWins(assignments: AssignmentRow[], subjects: SubjectSummary[]): RecentWin[] {
  const wins: RecentWin[] = [];
  const completed = assignments
    .filter((a) => a.status === "completed" && a.completedAt)
    .sort((a, b) => new Date(b.completedAt!).getTime() - new Date(a.completedAt!).getTime());

  // High score wins (≥85% in the last 14 days)
  const fourteenDaysAgo = Date.now() - 14 * DAY_MS;
  for (const a of completed.slice(0, 10)) {
    if (!a.completedAt || !a.scorePercent) continue;
    if (new Date(a.completedAt).getTime() < fourteenDaysAgo) continue;
    if (a.scorePercent >= 85) {
      wins.push({
        type: "high_score",
        title: `${a.scorePercent}% on "${a.quizTitle}"`,
        detail: a.quizSubject ? `Strong result in ${a.quizSubject}.` : "A strong result — keep this momentum.",
        ts: a.completedAt,
      });
    }
  }

  // First completion ever
  if (completed.length === 1 && completed[0].completedAt) {
    wins.push({
      type: "first_completion",
      title: "First assessment completed",
      detail: "You've taken the first step. Each one from here builds on the last.",
      ts: completed[0].completedAt,
    });
  }

  // Mastery achievements
  for (const s of subjects) {
    const recentlyMastered = s.topics.filter((t) => t.status === "mastered").slice(0, 2);
    for (const t of recentlyMastered.slice(0, 1)) {
      wins.push({
        type: "mastery",
        title: `${t.topic} feels solid`,
        detail: `Your understanding in ${s.subject} → ${t.topic} is at ${t.understandingPercent}%.`,
        ts: new Date().toISOString(),
      });
    }
  }

  return wins.slice(0, 4);
}

function buildNextActions(assignments: AssignmentRow[], subjects: SubjectSummary[]): NextAction[] {
  const actions: NextAction[] = [];
  const now = new Date();
  const overdue = assignments.filter((a) => a.status === "overdue");
  const dueToday = assignments.filter((a) => a.status === "pending" && a.dueDate && daysBetween(new Date(a.dueDate), now) === 0);
  const dueTomorrow = assignments.filter((a) => a.status === "pending" && a.dueDate && daysBetween(new Date(a.dueDate), now) === 1);

  for (const a of overdue.slice(0, 2)) {
    actions.push({
      kind: "overdue",
      title: `Catch up on "${a.quizTitle}"`,
      detail: a.quizSubject ? `${a.quizSubject} — overdue, but the sooner the better.` : "Overdue — the sooner the better.",
      quizId: a.quizId,
      href: `/quiz/${a.quizId}`,
    });
  }
  for (const a of dueToday.slice(0, 2)) {
    actions.push({
      kind: "due_today",
      title: `Today: ${a.quizTitle}`,
      detail: a.quizSubject ? `Lock in ${a.quizSubject} before the day ends.` : "Lock this in before the day ends.",
      quizId: a.quizId,
      href: `/quiz/${a.quizId}`,
    });
  }
  if (actions.length < 3) {
    for (const a of dueTomorrow.slice(0, 1)) {
      actions.push({
        kind: "due_tomorrow",
        title: `Tomorrow: ${a.quizTitle}`,
        detail: a.quizSubject ? `Tomorrow's ${a.quizSubject} task — start early to leave room for review.` : "Start early to leave room for review.",
        quizId: a.quizId,
        href: `/quiz/${a.quizId}`,
      });
    }
  }

  if (actions.length < 3) {
    // Suggest reviewing a low-score completed quiz
    const completedLow = assignments
      .filter((a) => a.status === "completed" && a.scorePercent !== null && a.scorePercent < 60 && a.reportId)
      .sort((a, b) => (a.scorePercent ?? 0) - (b.scorePercent ?? 0));
    for (const a of completedLow.slice(0, 1)) {
      actions.push({
        kind: "review_low_score",
        title: `Revisit "${a.quizTitle}"`,
        detail: `You scored ${a.scorePercent}%. A short review session here could lift your overall average noticeably.`,
        quizId: a.quizId,
        href: a.reportId ? `/report/${a.reportId}` : undefined,
      });
    }
  }

  if (actions.length < 3) {
    // Suggest an untested topic from the focus subject
    const focus = subjects.find((s) => s.topics.some((t) => t.status === "untested"));
    if (focus) {
      const untested = focus.topics.find((t) => t.status === "untested");
      if (untested) {
        actions.push({
          kind: "untested_topic",
          title: `Explore ${untested.topic}`,
          detail: `${focus.subject} → ${untested.topic} hasn't been tested yet. Try a short practice run when you have ten minutes.`,
        });
      }
    }
  }

  if (actions.length === 0) {
    actions.push({
      kind: "fresh_start",
      title: "All clear — pick a topic to explore",
      detail: "Nothing urgent. A great moment to revisit a topic that felt shaky last time.",
    });
  }
  return actions.slice(0, 4);
}

function buildDerivedNotifications(assignments: AssignmentRow[]): DerivedNotification[] {
  const now = new Date();
  const out: DerivedNotification[] = [];
  for (const a of assignments) {
    if (a.status === "completed" || !a.dueDate) continue;
    const delta = daysBetween(new Date(a.dueDate), now);
    if (delta < 0) {
      out.push({
        id: `derived-overdue-${a.assignmentId}`,
        type: "overdue",
        title: "Overdue assessment",
        message: `"${a.quizTitle}" is overdue. Take it as soon as you can.`,
        payload: { quizId: a.quizId, quizTitle: a.quizTitle, dueDate: a.dueDate },
        readAt: null,
        createdAt: a.dueDate,
        derived: true,
      });
    } else if (delta === 0) {
      out.push({
        id: `derived-today-${a.assignmentId}`,
        type: "due_today",
        title: "Due today",
        message: `"${a.quizTitle}" is due today.`,
        payload: { quizId: a.quizId, quizTitle: a.quizTitle, dueDate: a.dueDate },
        readAt: null,
        createdAt: new Date().toISOString(),
        derived: true,
      });
    } else if (delta === 1) {
      out.push({
        id: `derived-tomorrow-${a.assignmentId}`,
        type: "due_tomorrow",
        title: "Due tomorrow",
        message: `"${a.quizTitle}" is due tomorrow.`,
        payload: { quizId: a.quizId, quizTitle: a.quizTitle, dueDate: a.dueDate },
        readAt: null,
        createdAt: new Date().toISOString(),
        derived: true,
      });
    }
  }
  return out;
}

export interface BuildDashboardInput {
  storage: IStorage;
  student: SomaUser;
}

export async function buildStudentDashboard({ storage, student }: BuildDashboardInput): Promise<DashboardPayload> {
  const now = new Date();
  const [assignmentsRaw, reports, studentSubjects, mastery, storedNotifications] = await Promise.all([
    storage.getQuizAssignmentsForStudent(student.id),
    storage.getSomaReportsByStudentId(student.id),
    storage.listStudentSubjects(student.id),
    storage.listStudentTopicMastery(student.id),
    storage.listStudentNotifications(student.id, { limit: 25 }),
  ]);

  const quizIds = Array.from(new Set(assignmentsRaw.map((a) => a.quizId)));
  const maxScoreMap = await storage.getSomaQuestionTotalsByQuizIds(quizIds);
  const reportByQuiz = new Map<number, SomaReport>();
  for (const r of reports) {
    const existing = reportByQuiz.get(r.quizId);
    if (!existing || new Date(r.createdAt).getTime() > new Date(existing.createdAt).getTime()) {
      reportByQuiz.set(r.quizId, r);
    }
  }

  // Drop assignments that can neither be taken nor reviewed: a pending/overdue
  // assignment whose quiz is archived or unpublished would render a dead
  // "/soma/quiz/:id" link that hangs on "Loading assessment…" (the quiz and
  // questions endpoints 404 such quizzes). Completed assignments are always
  // kept — they carry a report and remain reviewable via reportId, preserving
  // score history and stats even after a quiz is later archived.
  const visibleAssignments = assignmentsRaw.filter(
    (a) => isPlayableQuiz(a.quiz) || a.status === "completed",
  );

  const assignmentRows = visibleAssignments.map((a) =>
    buildAssignmentRow(a, reportByQuiz.get(a.quizId), maxScoreMap[a.quizId] ?? 0, now),
  );

  const subjects = buildSubjectSummaries(assignmentRows, studentSubjects, mastery);
  const performance = buildPerformance(assignmentRows, subjects);
  const recentWins = buildRecentWins(assignmentRows, subjects);
  const nextActions = buildNextActions(assignmentRows, subjects);
  const derived = buildDerivedNotifications(assignmentRows);

  const reminders = composeReminders(
    subjects.map((s) => ({ subject: s.subject, level: s.level })),
    { max: 6 },
  );

  const merged: Array<StudentNotification | DerivedNotification> = [
    ...derived,
    ...storedNotifications,
  ];
  merged.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  const unreadCount = merged.filter((n) => !n.readAt).length;

  const completed = assignmentRows
    .filter((a) => a.status === "completed")
    .sort((a, b) => new Date(b.completedAt ?? 0).getTime() - new Date(a.completedAt ?? 0).getTime());

  const displayName = (student.displayName?.trim() || student.email.split("@")[0]).split(" ")[0];

  return {
    student: { id: student.id, displayName, email: student.email },
    greeting: pickGreeting(displayName, now.getHours()),
    dueSummary: buildDueSummary(assignmentRows),
    notifications: { items: merged.slice(0, 30), unreadCount },
    subjects,
    assignments: assignmentRows,
    completed,
    performance,
    recentWins,
    nextActions,
    reminders,
  };
}

export { normalizeLevel, normalizeSubject, pickEffectiveLevel };
export type { CurriculumLevel };
