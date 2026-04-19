import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { authFetch } from "@/lib/supabase";
import { formatDistanceToNow } from "date-fns";
import { Bell, BellRing, Check, CheckCheck, ChevronDown, ChevronUp } from "lucide-react";
import type { DashboardNotification } from "@/types/studentDashboard";
import {
  sortNotifications,
  getNotificationTone,
  getNotificationIcon,
  formatDueLabel,
  extractDueDate,
} from "@/lib/notificationDisplay";

interface Props {
  items: DashboardNotification[];
  unreadCount: number;
  studentKey: string;
}

function notificationHref(n: DashboardNotification): string | null {
  const payload = n.payload as { quizId?: number; reportId?: number } | null;
  if (payload?.reportId) return `/soma/review/${payload.reportId}`;
  if (payload?.quizId) return `/soma/quiz/${payload.quizId}`;
  return null;
}

export default function NotificationsPanel({ items, unreadCount, studentKey }: Props) {
  const qc = useQueryClient();
  const [expanded, setExpanded] = useState(unreadCount > 0);
  const HeaderIcon = unreadCount > 0 ? BellRing : Bell;
  const now = useMemo(() => new Date(), []);

  const sorted = useMemo(() => sortNotifications(items), [items]);
  const visible = expanded ? sorted.slice(0, 12) : sorted.slice(0, 4);

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

  return (
    <section
      className="rounded-2xl border border-slate-800 bg-gradient-to-br from-slate-900/95 to-slate-900/70 p-6 shadow-xl"
      aria-label="Notifications"
      data-testid="panel-notifications"
    >
      <header className="flex items-start justify-between gap-3 mb-4">
        <div className="flex items-center gap-3">
          <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${unreadCount > 0 ? "bg-violet-500/15 text-violet-300" : "bg-slate-800/60 text-slate-400"}`}>
            <HeaderIcon className="w-5 h-5" />
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
          {sorted.length > 4 && (
            <button
              onClick={() => setExpanded((v) => !v)}
              className="text-xs text-slate-400 hover:text-slate-200 px-2 py-1.5 rounded-lg"
              aria-label={expanded ? "Collapse notifications" : "Expand notifications"}
              data-testid="button-toggle-notifications"
            >
              {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            </button>
          )}
        </div>
      </header>

      {sorted.length === 0 ? (
        <div className="text-center py-8 text-sm text-slate-500" data-testid="empty-notifications">
          No notifications yet — they'll appear here as new work is assigned or feedback arrives.
        </div>
      ) : (
        <ul className="space-y-2.5" data-testid="list-notifications">
          {visible.map((n) => {
            const tone = getNotificationTone(n.type);
            const ItemIcon = getNotificationIcon(n.type);
            const href = notificationHref(n);
            const isUnread = !n.readAt;
            const dueLabel = formatDueLabel(extractDueDate(n), now);

            const body = (
              <div
                className={`relative flex items-stretch rounded-xl border overflow-hidden transition-colors ${tone.card} ${n.readAt ? "opacity-60" : ""}`}
                data-severity={n.type}
              >
                <div className={`w-1 shrink-0 ${tone.accent}`} aria-hidden="true" />
                <div className="flex items-start gap-3 p-3 flex-1 min-w-0">
                  <div className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${tone.iconWrap}`}>
                    <ItemIcon className="w-4 h-4" aria-hidden="true" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-sm font-semibold text-slate-100 truncate">
                        <span className="sr-only">{tone.ariaPrefix}: </span>
                        {n.title}
                      </p>
                      <span className="text-[10px] text-slate-500 whitespace-nowrap">
                        {formatDistanceToNow(new Date(n.createdAt), { addSuffix: true })}
                      </span>
                    </div>
                    <p className="text-xs text-slate-300 mt-0.5 line-clamp-2">{n.message}</p>
                    {dueLabel && (
                      <span
                        className={`inline-flex items-center gap-1 mt-2 text-[11px] font-medium px-2 py-0.5 rounded-full border ${tone.chip}`}
                        data-testid={`notification-due-${n.id}`}
                      >
                        {dueLabel}
                      </span>
                    )}
                  </div>
                  {isUnread && typeof n.id === "number" && (
                    <button
                      onClick={(e) => { e.preventDefault(); markRead.mutate(n.id as number); }}
                      title="Mark as read"
                      aria-label="Mark notification as read"
                      className="p-1.5 rounded-md hover:bg-slate-800 text-slate-400 hover:text-slate-200 shrink-0"
                      data-testid={`button-mark-read-${n.id}`}
                    >
                      <Check className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
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
