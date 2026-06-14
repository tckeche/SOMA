// Shared display rules for student notifications.
//
// Centralises severity, colour tone, icon, and due-date formatting so the
// panel and any future surfaces (notification bell in the header, email
// digests mocked client-side, etc.) agree on what "urgent" looks like.

import {
  AlertTriangle, Clock, Calendar, Sparkles, BellRing, MessageCircle, Bell,
} from "lucide-react";
import type { DashboardNotification } from "@/types/studentDashboard";

export type NotificationSeverity = "urgent" | "warning" | "info" | "positive";

export function getNotificationSeverity(type: string): NotificationSeverity {
  switch (type) {
    case "overdue":
    case "due_today":
      return "urgent";
    case "due_tomorrow":
      return "warning";
    case "feedback_ready":
    case "milestone_mastery":
      return "positive";
    case "assignment_new":
    case "tutor_comment":
    default:
      return "info";
  }
}

// Severity rank used for sorting. Lower is more urgent.
export function severityRank(type: string): number {
  switch (type) {
    case "overdue": return 0;
    case "due_today": return 1;
    case "due_tomorrow": return 2;
    case "feedback_ready": return 3;
    case "assignment_new": return 4;
    case "tutor_comment": return 5;
    case "milestone_mastery": return 6;
    default: return 10;
  }
}

// Unread before read; within the same group, more urgent before less urgent;
// within the same severity, newer before older.
export function sortNotifications(
  items: DashboardNotification[],
): DashboardNotification[] {
  return [...items].sort((a, b) => {
    const aUnread = a.readAt ? 1 : 0;
    const bUnread = b.readAt ? 1 : 0;
    if (aUnread !== bUnread) return aUnread - bUnread;
    const rankA = severityRank(a.type);
    const rankB = severityRank(b.type);
    if (rankA !== rankB) return rankA - rankB;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });
}

export interface NotificationTone {
  // Card surface + border
  card: string;
  // Left accent bar colour (used as a 3-4px column)
  accent: string;
  // Icon tile background + text colour
  iconWrap: string;
  // Due-date chip colour
  chip: string;
  // Accessible label prefix (screen-reader-only context)
  ariaPrefix: string;
}

export function getNotificationTone(type: string): NotificationTone {
  const severity = getNotificationSeverity(type);
  switch (severity) {
    case "urgent":
      return {
        card: "border-rose-500/40 bg-rose-500/5",
        accent: "bg-rose-500",
        iconWrap: "bg-rose-500/15 text-rose-300 border border-rose-500/30",
        chip: "bg-rose-500/15 text-rose-200 border-rose-500/30",
        ariaPrefix: "Urgent",
      };
    case "warning":
      return {
        card: "border-amber-500/30 bg-amber-500/5",
        accent: "bg-amber-400",
        iconWrap: "bg-amber-500/15 text-amber-300 border border-amber-500/30",
        chip: "bg-amber-500/15 text-amber-200 border-amber-500/30",
        ariaPrefix: "Reminder",
      };
    case "positive":
      return {
        card: type === "milestone_mastery"
          ? "border-violet-500/30 bg-violet-500/5"
          : "border-emerald-500/30 bg-emerald-500/5",
        accent: type === "milestone_mastery" ? "bg-violet-400" : "bg-emerald-400",
        iconWrap: type === "milestone_mastery"
          ? "bg-violet-500/15 text-violet-300 border border-violet-500/30"
          : "bg-emerald-500/15 text-emerald-300 border border-emerald-500/30",
        chip: type === "milestone_mastery"
          ? "bg-violet-500/15 text-violet-200 border-violet-500/30"
          : "bg-emerald-500/15 text-emerald-200 border-emerald-500/30",
        ariaPrefix: "Good news",
      };
    case "info":
    default:
      return {
        card: type === "tutor_comment"
          ? "border-cyan-500/30 bg-cyan-500/5"
          : "border-sky-500/30 bg-sky-500/5",
        accent: type === "tutor_comment" ? "bg-cyan-400" : "bg-sky-400",
        iconWrap: type === "tutor_comment"
          ? "bg-cyan-500/15 text-cyan-300 border border-cyan-500/30"
          : "bg-sky-500/15 text-sky-300 border border-sky-500/30",
        chip: type === "tutor_comment"
          ? "bg-cyan-500/15 text-cyan-200 border-cyan-500/30"
          : "bg-sky-500/15 text-sky-200 border-sky-500/30",
        ariaPrefix: "Update",
      };
  }
}

export function getNotificationIcon(type: string): typeof Bell {
  switch (type) {
    case "overdue": return AlertTriangle;
    case "due_today": return Clock;
    case "due_tomorrow": return Calendar;
    case "feedback_ready": return Sparkles;
    case "milestone_mastery": return Sparkles;
    case "assignment_new": return BellRing;
    case "tutor_comment": return MessageCircle;
    default: return Bell;
  }
}

// ---------------------------------------------------------------------------
// Explicit 1:1 TYPE -> category + colour mapping.
//
// Unlike getNotificationTone (which buckets by severity), this maps each
// notification type directly to a single category and a distinct colour so the
// panel is colour-coded by *type*. Unknown types fall back to a neutral slate.
// ---------------------------------------------------------------------------

export type NotificationCategory =
  | "Assessments"
  | "Reminders"
  | "Messages"
  | "Milestones"
  | "Other";

export interface NotificationStyle {
  category: NotificationCategory;
  // Tailwind colour name root (e.g. "sky", "rose") for reference / testing.
  color: string;
  // Card surface + border
  card: string;
  // Left accent bar colour
  accent: string;
  // Icon tile background + text colour
  iconWrap: string;
  // Chip colour (due-date pill)
  chip: string;
  // Section/category text colour
  label: string;
}

export const NOTIFICATION_TYPE_STYLES: Record<string, NotificationStyle> = {
  // Assessments
  assignment_new: {
    category: "Assessments",
    color: "sky",
    card: "border-sky-500/30 bg-sky-500/5",
    accent: "bg-sky-400",
    iconWrap: "bg-sky-500/15 text-sky-300 border border-sky-500/30",
    chip: "bg-sky-500/15 text-sky-200 border-sky-500/30",
    label: "text-sky-300",
  },
  feedback_ready: {
    category: "Assessments",
    color: "emerald",
    card: "border-emerald-500/30 bg-emerald-500/5",
    accent: "bg-emerald-400",
    iconWrap: "bg-emerald-500/15 text-emerald-300 border border-emerald-500/30",
    chip: "bg-emerald-500/15 text-emerald-200 border-emerald-500/30",
    label: "text-emerald-300",
  },
  // Reminders
  due_today: {
    category: "Reminders",
    color: "rose",
    card: "border-rose-500/40 bg-rose-500/5",
    accent: "bg-rose-500",
    iconWrap: "bg-rose-500/15 text-rose-300 border border-rose-500/30",
    chip: "bg-rose-500/15 text-rose-200 border-rose-500/30",
    label: "text-rose-300",
  },
  overdue: {
    category: "Reminders",
    color: "rose",
    card: "border-rose-500/40 bg-rose-500/5",
    accent: "bg-rose-500",
    iconWrap: "bg-rose-500/15 text-rose-300 border border-rose-500/30",
    chip: "bg-rose-500/15 text-rose-200 border-rose-500/30",
    label: "text-rose-300",
  },
  due_tomorrow: {
    category: "Reminders",
    color: "amber",
    card: "border-amber-500/30 bg-amber-500/5",
    accent: "bg-amber-400",
    iconWrap: "bg-amber-500/15 text-amber-300 border border-amber-500/30",
    chip: "bg-amber-500/15 text-amber-200 border-amber-500/30",
    label: "text-amber-300",
  },
  // Messages
  tutor_comment: {
    category: "Messages",
    color: "cyan",
    card: "border-cyan-500/30 bg-cyan-500/5",
    accent: "bg-cyan-400",
    iconWrap: "bg-cyan-500/15 text-cyan-300 border border-cyan-500/30",
    chip: "bg-cyan-500/15 text-cyan-200 border-cyan-500/30",
    label: "text-cyan-300",
  },
  // Milestones
  milestone_mastery: {
    category: "Milestones",
    color: "violet",
    card: "border-violet-500/30 bg-violet-500/5",
    accent: "bg-violet-400",
    iconWrap: "bg-violet-500/15 text-violet-300 border border-violet-500/30",
    chip: "bg-violet-500/15 text-violet-200 border-violet-500/30",
    label: "text-violet-300",
  },
};

export const NOTIFICATION_FALLBACK_STYLE: NotificationStyle = {
  category: "Other",
  color: "slate",
  card: "border-slate-500/30 bg-slate-500/5",
  accent: "bg-slate-400",
  iconWrap: "bg-slate-500/15 text-slate-300 border border-slate-500/30",
  chip: "bg-slate-500/15 text-slate-200 border-slate-500/30",
  label: "text-slate-300",
};

// 1:1 type -> style lookup with a neutral fallback for unknown types.
export function getNotificationStyle(type: string): NotificationStyle {
  return NOTIFICATION_TYPE_STYLES[type] ?? NOTIFICATION_FALLBACK_STYLE;
}

// ---------------------------------------------------------------------------
// Date grouping: bucket notifications into Today / Yesterday / Earlier by
// createdAt (local calendar day). Exported for testability.
// ---------------------------------------------------------------------------

export type NotificationDateBucket = "Today" | "Yesterday" | "Earlier";

export function getNotificationDateBucket(
  createdAt: string | Date,
  now: Date = new Date(),
): NotificationDateBucket {
  const created = createdAt instanceof Date ? createdAt : new Date(createdAt);
  if (Number.isNaN(created.getTime())) return "Earlier";

  const startOfDay = (d: Date) => {
    const copy = new Date(d);
    copy.setHours(0, 0, 0, 0);
    return copy;
  };
  const msPerDay = 24 * 60 * 60 * 1000;
  const days = Math.round(
    (startOfDay(now).getTime() - startOfDay(created).getTime()) / msPerDay,
  );
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  return "Earlier";
}

export interface NotificationGroup {
  bucket: NotificationDateBucket;
  items: DashboardNotification[];
}

// Groups notifications into ordered Today / Yesterday / Earlier sections.
// Empty buckets are omitted. Order within each bucket is preserved (callers
// typically pass already-sorted items).
export function groupNotificationsByDate(
  items: DashboardNotification[],
  now: Date = new Date(),
): NotificationGroup[] {
  const order: NotificationDateBucket[] = ["Today", "Yesterday", "Earlier"];
  const map = new Map<NotificationDateBucket, DashboardNotification[]>();
  for (const n of items) {
    const bucket = getNotificationDateBucket(n.createdAt, now);
    if (!map.has(bucket)) map.set(bucket, []);
    map.get(bucket)!.push(n);
  }
  return order
    .filter((b) => map.has(b))
    .map((bucket) => ({ bucket, items: map.get(bucket)! }));
}

// Returns a short, human-friendly due-date label, or null if no date.
// Examples:
//   "3 days overdue", "1 day overdue"
//   "Due today", "Due tomorrow"
//   "Due Tue, 22 Apr"
export function formatDueLabel(
  dueIso: string | null | undefined,
  now: Date = new Date(),
): string | null {
  if (!dueIso) return null;
  const due = new Date(dueIso);
  if (Number.isNaN(due.getTime())) return null;

  const startOfDay = (d: Date) => {
    const copy = new Date(d);
    copy.setHours(0, 0, 0, 0);
    return copy;
  };
  const nowMid = startOfDay(now);
  const dueMid = startOfDay(due);
  const msPerDay = 24 * 60 * 60 * 1000;
  const days = Math.round((dueMid.getTime() - nowMid.getTime()) / msPerDay);

  if (days < 0) {
    const abs = Math.abs(days);
    return `${abs} day${abs === 1 ? "" : "s"} overdue`;
  }
  if (days === 0) return "Due today";
  if (days === 1) return "Due tomorrow";
  if (days < 7) {
    return `Due ${due.toLocaleDateString(undefined, { weekday: "long" })}`;
  }
  return `Due ${due.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}`;
}

// Extract a due date from a notification payload when present. The server
// stamps this onto assignment_new and derived overdue/due_today/due_tomorrow
// notifications; older stored rows may be missing it.
export function extractDueDate(n: DashboardNotification): string | null {
  const payload = n.payload as { dueDate?: string | null } | null;
  if (!payload) return null;
  return payload.dueDate ?? null;
}
