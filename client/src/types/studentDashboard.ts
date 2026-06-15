export type CurriculumLevel = "AS" | "A2" | "IGCSE";

export interface StudentDashboardTopic {
  topic: string;
  subtopic?: string;
  description?: string;
  status: "mastered" | "in_progress" | "needs_work" | "untested";
  understandingPercent: number;
  attempts: number;
}

export interface StudentDashboardSubject {
  subject: string;
  level: CurriculumLevel | null;
  rawLevels: string[];
  pendingCount: number;
  completedCount: number;
  overdueCount: number;
  averageScorePercent: number | null;
  recentTrend: "up" | "down" | "flat" | "new";
  topics: StudentDashboardTopic[];
  coverage: {
    totalTopics: number;
    coveredTopics: number;
    masteredTopics: number;
    coveragePercent: number;
    masteryPercent: number;
  };
}

export interface DashboardAssignmentRow {
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
  score: number | null;
  maxScore: number;
  scorePercent: number | null;
  completedAt: string | null;
  questionCount: number;
}

export interface DashboardPerformance {
  totalCompleted: number;
  totalAssigned: number;
  averageScorePercent: number | null;
  accuracyPercent: number | null;
  recentTrend: "up" | "down" | "flat" | "new";
  bestSubject: string | null;
  focusSubject: string | null;
  message: string;
}

export interface DashboardRecentWin {
  type: "high_score" | "first_completion" | "improvement" | "streak" | "mastery";
  title: string;
  detail: string;
  ts: string;
}

export interface DashboardNextAction {
  kind: "due_today" | "due_tomorrow" | "overdue" | "review_low_score" | "untested_topic" | "fresh_start";
  title: string;
  detail: string;
  href?: string;
  quizId?: number;
}

export interface DashboardReminder {
  id: string;
  topic: string;
  text: string;
  // Optional fields populated by the examiner-misconception study-tips
  // path. Older composed reminders leave these undefined and continue to
  // render exactly as before.
  whyItMatters?: string;
  correctApproach?: string;
  frequency?: "very_common" | "common" | "occasional";
  subject?: string;
}

export interface DashboardNotification {
  id: number | string;
  type: string;
  title: string;
  message: string;
  payload: Record<string, any> | null;
  readAt: string | null;
  createdAt: string;
  derived?: boolean;
}

export interface StudentDashboardPayload {
  student: { id: string; displayName: string; email: string };
  greeting: string;
  dueSummary: string;
  notifications: { items: DashboardNotification[]; unreadCount: number };
  subjects: StudentDashboardSubject[];
  assignments: DashboardAssignmentRow[];
  completed: DashboardAssignmentRow[];
  performance: DashboardPerformance;
  recentWins: DashboardRecentWin[];
  nextActions: DashboardNextAction[];
  reminders: DashboardReminder[];
}
