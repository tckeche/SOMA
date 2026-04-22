import { useMemo } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { authFetch } from "@/lib/supabase";
import { formatDistanceToNow } from "date-fns";
import { Bell, CheckCheck, Inbox } from "lucide-react";
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
  const now = useMemo(() => new Date(), []);

  const unread = useMemo(
    () => sortNotifications(items.filter((n) => !n.readAt)),
    [items],
  );
  const visible = unread.slice(0, 8);

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

  const handleOpen = (n: DashboardNotification) => {
    if (typeof n.id === "number" && !n.readAt) {
      markRead.mutate(n.id);
    }
  };

  return (
    <section
      className="rounded-2xl border border-card-border bg-gradient-to-br from-card/95 to-card/70 p-6 shadow-xl"
      aria-label="Notifications"
      data-testid="panel-notifications"
    >
      <header className="flex items-center justify-between gap-3 mb-4">
        <div className="flex items-center gap-3">
          <div className="relative">
            <div
              className={`w-11 h-11 rounded-xl flex items-center justify-center transition-colors ${
                unreadCount > 0
                  ? "bg-violet-500/15 text-violet-300 border border-violet-500/30"
                  : "bg-muted/60 text-muted-foreground border border-card-border"
              }`}
            >
              <Bell className="w-5 h-5" aria-hidden="true" />
            </div>
            {unreadCount > 0 && (
              <span
                className="absolute -top-1 -right-1 min-w-[20px] h-5 px-1 rounded-full bg-rose-500 text-[10px] font-bold text-white flex items-center justify-center leading-none ring-2 ring-card tabular-nums"
                aria-label={`${unreadCount} unread notifications`}
                data-testid="bell-unread-count"
              >
                {unreadCount > 99 ? "99+" : unreadCount}
              </span>
            )}
          </div>
          <div>
            <h2 className="text-lg font-semibold text-foreground">Notifications</h2>
            <p className="text-xs text-muted-foreground">
              {unreadCount > 0
                ? `${unreadCount} new ${unreadCount === 1 ? "update" : "updates"} to review`
                : "You're all caught up"}
            </p>
          </div>
        </div>
        {unreadCount > 0 && (
          <button
            onClick={() => markAllRead.mutate()}
            disabled={markAllRead.isPending}
            className="text-xs text-foreground/80 hover:text-white px-3 py-1.5 rounded-lg border border-border hover:border-border transition-colors disabled:opacity-60"
            data-testid="button-mark-all-read"
          >
            <CheckCheck className="w-3.5 h-3.5 inline mr-1.5" />
            Mark all read
          </button>
        )}
      </header>

      {unread.length === 0 ? (
        <div
          className="flex flex-col items-center justify-center text-center py-10 px-4 rounded-xl border border-dashed border-card-border bg-card/40"
          data-testid="empty-notifications"
        >
          <div className="w-12 h-12 rounded-full bg-muted/80 flex items-center justify-center mb-3">
            <Inbox className="w-5 h-5 text-muted-foreground" aria-hidden="true" />
          </div>
          <p className="text-sm font-medium text-foreground/80">No new notifications</p>
          <p className="text-xs text-muted-foreground mt-1">
            New work, feedback and reminders will show up here.
          </p>
        </div>
      ) : (
        <ul className="space-y-2" data-testid="list-notifications">
          {visible.map((n) => {
            const tone = getNotificationTone(n.type);
            const ItemIcon = getNotificationIcon(n.type);
            const href = notificationHref(n);
            const dueLabel = formatDueLabel(extractDueDate(n), now);

            const body = (
              <div
                className={`group relative flex items-stretch rounded-xl border overflow-hidden transition-all hover:translate-x-0.5 hover:shadow-lg ${tone.card}`}
                data-severity={n.type}
              >
                <div className={`w-1 shrink-0 ${tone.accent}`} aria-hidden="true" />
                <div className="flex items-start gap-3 p-3.5 flex-1 min-w-0">
                  <div
                    className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${tone.iconWrap}`}
                  >
                    <ItemIcon className="w-4 h-4" aria-hidden="true" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <span
                          className="w-2 h-2 rounded-full bg-rose-500 shrink-0 shadow-[0_0_8px_rgba(244,63,94,0.6)]"
                          aria-label="Unread"
                          data-testid={`notification-dot-${n.id}`}
                        />
                        <p className="text-sm font-semibold text-foreground truncate">
                          <span className="sr-only">{tone.ariaPrefix}: </span>
                          {n.title}
                        </p>
                      </div>
                      <span className="text-[10px] text-muted-foreground whitespace-nowrap shrink-0">
                        {formatDistanceToNow(new Date(n.createdAt), { addSuffix: true })}
                      </span>
                    </div>
                    <p className="text-xs text-foreground/80 mt-1 line-clamp-2">{n.message}</p>
                    {dueLabel && (
                      <span
                        className={`inline-flex items-center gap-1 mt-2 text-[11px] font-medium px-2 py-0.5 rounded-full border ${tone.chip}`}
                        data-testid={`notification-due-${n.id}`}
                      >
                        {dueLabel}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            );
            return (
              <li key={String(n.id)} data-testid={`notification-${n.id}`}>
                {href ? (
                  <Link
                    href={href}
                    onClick={() => handleOpen(n)}
                    className="block cursor-pointer"
                  >
                    {body}
                  </Link>
                ) : (
                  <button
                    type="button"
                    onClick={() => handleOpen(n)}
                    className="block w-full text-left"
                  >
                    {body}
                  </button>
                )}
              </li>
            );
          })}
          {unread.length > visible.length && (
            <li className="pt-1 text-center">
              <p className="text-[11px] text-muted-foreground">
                +{unread.length - visible.length} more unread
              </p>
            </li>
          )}
        </ul>
      )}
    </section>
  );
}
