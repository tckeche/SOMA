import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { authFetch } from "@/lib/supabase";
import { formatDistanceToNow } from "date-fns";
import { Bell, CheckCheck, Inbox, X, ChevronDown } from "lucide-react";
import type { DashboardNotification } from "@/types/studentDashboard";
import {
  sortNotifications,
  getNotificationStyle,
  getNotificationIcon,
  formatDueLabel,
  extractDueDate,
  groupNotificationsByDate,
  type NotificationGroup,
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

// A notification is "recent" (always shown) if it is unread or from today.
function isRecent(n: DashboardNotification, now: Date): boolean {
  if (!n.readAt) return true;
  const created = new Date(n.createdAt);
  return (
    created.getFullYear() === now.getFullYear() &&
    created.getMonth() === now.getMonth() &&
    created.getDate() === now.getDate()
  );
}

export default function NotificationsPanel({ items, unreadCount, studentKey }: Props) {
  const qc = useQueryClient();
  const now = useMemo(() => new Date(), []);
  const [showEarlier, setShowEarlier] = useState(false);

  // Sort everything (unread first, then by urgency/recency).
  const sorted = useMemo(() => sortNotifications(items), [items]);

  // Split into always-visible (recent/unread) and collapsible (older + read).
  const { recent, earlier } = useMemo(() => {
    const recent: DashboardNotification[] = [];
    const earlier: DashboardNotification[] = [];
    for (const n of sorted) {
      if (isRecent(n, now)) recent.push(n);
      else earlier.push(n);
    }
    return { recent, earlier };
  }, [sorted, now]);

  const displayed = showEarlier ? sorted : recent;
  const groups = useMemo(
    () => groupNotificationsByDate(displayed, now),
    [displayed, now],
  );

  const invalidate = () =>
    qc.invalidateQueries({ queryKey: ["/api/student/dashboard", studentKey] });

  const markRead = useMutation({
    mutationFn: async (id: number) => {
      const res = await authFetch(`/api/student/notifications/${id}/read`, { method: "POST" });
      if (!res.ok) throw new Error("Failed to mark read");
      return res.json();
    },
    onSuccess: invalidate,
  });

  const markAllRead = useMutation({
    mutationFn: async () => {
      const res = await authFetch(`/api/student/notifications/read-all`, { method: "POST" });
      if (!res.ok) throw new Error("Failed to mark all read");
      return res.json();
    },
    onSuccess: invalidate,
  });

  const dismiss = useMutation({
    mutationFn: async (id: number) => {
      const res = await authFetch(`/api/student/notifications/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to dismiss");
      return res.json();
    },
    onSuccess: invalidate,
  });

  const handleOpen = (n: DashboardNotification) => {
    if (typeof n.id === "number" && !n.readAt) {
      markRead.mutate(n.id);
    }
  };

  const renderItem = (n: DashboardNotification) => {
    const style = getNotificationStyle(n.type);
    const ItemIcon = getNotificationIcon(n.type);
    const href = notificationHref(n);
    const dueLabel = formatDueLabel(extractDueDate(n), now);
    const isUnread = !n.readAt;
    const canDismiss = typeof n.id === "number";

    const body = (
      <div
        className={`group relative flex items-stretch rounded-xl border overflow-hidden transition-all hover:translate-x-0.5 hover:shadow-lg ${style.card} ${
          isUnread ? "" : "opacity-60"
        }`}
        data-type={n.type}
        data-category={style.category}
        data-read={isUnread ? "false" : "true"}
      >
        <div className={`w-1 shrink-0 ${style.accent}`} aria-hidden="true" />
        <div className="flex items-start gap-3 p-3.5 flex-1 min-w-0">
          <div
            className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${style.iconWrap}`}
          >
            <ItemIcon className="w-4 h-4" aria-hidden="true" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                {isUnread && (
                  <span
                    className="w-2 h-2 rounded-full bg-danger shrink-0 shadow-[0_0_8px_rgba(244,63,94,0.6)]"
                    aria-label="Unread"
                    data-testid={`notification-dot-${n.id}`}
                  />
                )}
                <p
                  className={`text-sm truncate ${
                    isUnread ? "font-semibold text-foreground" : "font-medium text-foreground/80"
                  }`}
                >
                  <span className="sr-only">{style.category}: </span>
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
                className={`inline-flex items-center gap-1 mt-2 text-[11px] font-medium px-2 py-0.5 rounded-full border ${style.chip}`}
                data-testid={`notification-due-${n.id}`}
              >
                {dueLabel}
              </span>
            )}
          </div>
        </div>
        {canDismiss && (
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              dismiss.mutate(n.id as number);
            }}
            disabled={dismiss.isPending}
            aria-label="Dismiss notification"
            data-testid={`notif-dismiss-${n.id}`}
            className="absolute top-2 right-2 w-6 h-6 rounded-md flex items-center justify-center text-muted-foreground/70 hover:text-foreground hover:bg-muted/60 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity disabled:opacity-40"
          >
            <X className="w-3.5 h-3.5" aria-hidden="true" />
          </button>
        )}
      </div>
    );

    return (
      <li key={String(n.id)} data-testid={`notification-${n.id}`}>
        {href ? (
          <Link href={href} onClick={() => handleOpen(n)} className="block cursor-pointer">
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
                  ? "bg-primary/15 text-primary border border-primary/30"
                  : "bg-muted/60 text-muted-foreground border border-card-border"
              }`}
            >
              <Bell className="w-5 h-5" aria-hidden="true" />
            </div>
            {unreadCount > 0 && (
              <span
                className="absolute -top-1 -right-1 min-w-[20px] h-5 px-1 rounded-full bg-danger text-[10px] font-bold text-white flex items-center justify-center leading-none ring-2 ring-card tabular-nums"
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
            data-testid="notif-mark-all-read"
          >
            <CheckCheck className="w-3.5 h-3.5 inline mr-1.5" />
            Mark all read
          </button>
        )}
      </header>

      {sorted.length === 0 ? (
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
        <div className="space-y-4" data-testid="list-notifications">
          {groups.map((group: NotificationGroup) => (
            <div key={group.bucket}>
              <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                {group.bucket}
              </h3>
              <ul className="space-y-2">{group.items.map(renderItem)}</ul>
            </div>
          ))}
          {!showEarlier && earlier.length > 0 && (
            <button
              type="button"
              onClick={() => setShowEarlier(true)}
              data-testid="notif-show-earlier"
              className="w-full flex items-center justify-center gap-1.5 text-xs text-muted-foreground hover:text-foreground py-2 rounded-lg border border-dashed border-card-border hover:border-border transition-colors"
            >
              <ChevronDown className="w-3.5 h-3.5" aria-hidden="true" />
              Show earlier ({earlier.length})
            </button>
          )}
        </div>
      )}
    </section>
  );
}
