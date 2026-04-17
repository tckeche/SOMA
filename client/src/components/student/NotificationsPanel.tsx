import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { authFetch } from "@/lib/supabase";
import { formatDistanceToNow } from "date-fns";
import { Bell, BellRing, Check, CheckCheck, ChevronDown, ChevronUp, Clock, AlertTriangle, Sparkles, MessageCircle } from "lucide-react";
import type { DashboardNotification } from "@/types/studentDashboard";

interface Props {
  items: DashboardNotification[];
  unreadCount: number;
  studentKey: string;
}

const ICONS: Record<string, typeof Bell> = {
  assignment_new: BellRing,
  feedback_ready: Sparkles,
  milestone_mastery: Sparkles,
  due_today: Clock,
  due_tomorrow: Clock,
  overdue: AlertTriangle,
  tutor_comment: MessageCircle,
};

const TYPE_TONE: Record<string, string> = {
  overdue: "border-rose-500/30 bg-rose-500/5 text-rose-300",
  due_today: "border-amber-500/30 bg-amber-500/5 text-amber-300",
  due_tomorrow: "border-amber-400/20 bg-amber-400/5 text-amber-300",
  feedback_ready: "border-emerald-500/30 bg-emerald-500/5 text-emerald-300",
  milestone_mastery: "border-violet-500/30 bg-violet-500/5 text-violet-300",
  assignment_new: "border-sky-500/30 bg-sky-500/5 text-sky-300",
  tutor_comment: "border-cyan-500/30 bg-cyan-500/5 text-cyan-300",
};

function notificationHref(n: DashboardNotification): string | null {
  const payload = n.payload as { quizId?: number; reportId?: number } | null;
  if (payload?.reportId) return `/soma/review/${payload.reportId}`;
  if (payload?.quizId) return `/soma/quiz/${payload.quizId}`;
  return null;
}

export default function NotificationsPanel({ items, unreadCount, studentKey }: Props) {
  const qc = useQueryClient();
  const [expanded, setExpanded] = useState(unreadCount > 0);
  const Icon = unreadCount > 0 ? BellRing : Bell;

  const markRead = useMutation({
    mutationFn: async (id: number) => {
      const res = await authFetch(`/api/student/notifications/${id}/read`, { method: "POST" });
      if (!res.ok) throw new Error("Failed to mark read");
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/student/dashboard", studentKey] });
    },
  });

  const markAllRead = useMutation({
    mutationFn: async () => {
      const res = await authFetch(`/api/student/notifications/read-all`, { method: "POST" });
      if (!res.ok) throw new Error("Failed to mark all read");
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/student/dashboard", studentKey] });
    },
  });

  const visible = expanded ? items.slice(0, 12) : items.slice(0, 4);

  return (
    <section
      className="rounded-2xl border border-slate-800 bg-gradient-to-br from-slate-900/95 to-slate-900/70 p-6 shadow-xl"
      aria-label="Notifications"
      data-testid="panel-notifications"
    >
      <header className="flex items-start justify-between gap-3 mb-4">
        <div className="flex items-center gap-3">
          <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${unreadCount > 0 ? "bg-violet-500/15 text-violet-300" : "bg-slate-800/60 text-slate-400"}`}>
            <Icon className="w-5 h-5" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-slate-100">Notifications</h2>
            <p className="text-xs text-slate-400">
              {unreadCount > 0
                ? `${unreadCount} new ${unreadCount === 1 ? "update" : "updates"} since you were last here`
                : "You're all caught up — nice and clear"}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {unreadCount > 0 && (
            <button
              onClick={() => markAllRead.mutate()}
              disabled={markAllRead.isPending}
              className="text-xs text-slate-300 hover:text-white px-3 py-1.5 rounded-lg border border-slate-700 hover:border-slate-500 transition-colors disabled:opacity-60"
              data-testid="button-mark-all-read"
            >
              <CheckCheck className="w-3.5 h-3.5 inline mr-1.5" />
              Mark all read
            </button>
          )}
          {items.length > 4 && (
            <button
              onClick={() => setExpanded((v) => !v)}
              className="text-xs text-slate-400 hover:text-slate-200 px-2 py-1.5 rounded-lg"
              data-testid="button-toggle-notifications"
            >
              {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            </button>
          )}
        </div>
      </header>

      {items.length === 0 ? (
        <div className="text-center py-8 text-sm text-slate-500" data-testid="empty-notifications">
          No notifications yet — they'll appear here as new work is assigned or feedback arrives.
        </div>
      ) : (
        <ul className="space-y-2.5" data-testid="list-notifications">
          {visible.map((n) => {
            const ItemIcon = ICONS[n.type] ?? Bell;
            const tone = TYPE_TONE[n.type] ?? "border-slate-700 bg-slate-800/40 text-slate-200";
            const href = notificationHref(n);
            const body = (
              <div className={`flex items-start gap-3 rounded-xl border p-3 transition-colors ${tone} ${n.readAt ? "opacity-60" : ""}`}>
                <ItemIcon className="w-4 h-4 mt-0.5 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-sm font-medium text-slate-100 truncate">{n.title}</p>
                    <span className="text-[10px] text-slate-500 whitespace-nowrap">
                      {formatDistanceToNow(new Date(n.createdAt), { addSuffix: true })}
                    </span>
                  </div>
                  <p className="text-xs text-slate-300 mt-0.5">{n.message}</p>
                </div>
                {!n.readAt && typeof n.id === "number" && (
                  <button
                    onClick={(e) => { e.preventDefault(); markRead.mutate(n.id as number); }}
                    title="Mark as read"
                    className="p-1 rounded-md hover:bg-slate-800 text-slate-400 hover:text-slate-200"
                    data-testid={`button-mark-read-${n.id}`}
                  >
                    <Check className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            );
            return (
              <li key={String(n.id)} data-testid={`notification-${n.id}`}>
                {href ? <Link href={href}>{body}</Link> : body}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
