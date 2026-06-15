// Student notifications bell + dropdown popover for the Warm Editorial dashboard.
// Lives in the SomaHeader rightActions slot. Mirrors TutorNotificationsBell's
// structure (bell button with bg-danger unread dot + a .soma-card popover,
// outside-click / Escape to close, mark-read on open) but reuses the SAME
// student endpoints, query key, and display helpers as NotificationsPanel.
// It does not own its own query: items + unreadCount are passed in from
// data.notifications in StudentDashboard.
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { formatDistanceToNow } from "date-fns";
import { Bell, CheckCheck, Inbox, X } from "lucide-react";
import { authFetch } from "@/lib/supabase";
import type { DashboardNotification } from "@/types/studentDashboard";
import {
  sortNotifications,
  getNotificationStyle,
  getNotificationIcon,
  formatDueLabel,
  extractDueDate,
} from "@/lib/notificationDisplay";

interface Props {
  items: DashboardNotification[];
  unreadCount: number;
  studentKey: string;
}

// Same target resolution as NotificationsPanel: report review, then quiz.
function notificationHref(n: DashboardNotification): string | null {
  const payload = n.payload as { quizId?: number; reportId?: number } | null;
  if (payload?.reportId) return `/soma/review/${payload.reportId}`;
  if (payload?.quizId) return `/soma/quiz/${payload.quizId}`;
  return null;
}

export function StudentNotificationsBell({ items, unreadCount, studentKey }: Props) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const now = useMemo(() => new Date(), []);

  // Unread-first, urgency, recency — same ordering as the panel.
  const sorted = useMemo(() => sortNotifications(items), [items]);

  // Same invalidation target / endpoints as NotificationsPanel.
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
    setOpen(false);
  };

  // Close the popover on outside click or Escape.
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const renderItem = (n: DashboardNotification) => {
    const style = getNotificationStyle(n.type);
    const ItemIcon = getNotificationIcon(n.type);
    const href = notificationHref(n);
    const dueLabel = formatDueLabel(extractDueDate(n), now);
    const isUnread = !n.readAt;
    const canDismiss = typeof n.id === "number";

    const inner = (
      <div
        className={`group relative flex items-start gap-3 w-full text-left transition-colors cursor-pointer hover:bg-foreground/[0.03] ${
          isUnread ? "" : "opacity-60"
        }`}
        style={{ padding: "12px 16px", borderBottom: "1px solid hsl(var(--border))" }}
        data-type={n.type}
        data-category={style.category}
        data-read={isUnread ? "false" : "true"}
        data-testid={`notification-${n.id}`}
      >
        <span className="relative shrink-0">
          <span
            className="grid place-items-center"
            style={{
              width: 34,
              height: 34,
              borderRadius: 9,
              background: "hsl(var(--primary) / 0.12)",
              color: "hsl(var(--primary))",
              border: "1px solid hsl(var(--primary) / 0.22)",
            }}
          >
            <ItemIcon className="w-4 h-4" aria-hidden="true" />
          </span>
          {isUnread && (
            <span
              className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-danger ring-2 ring-background"
              aria-label="Unread"
              data-testid={`notification-dot-${n.id}`}
            />
          )}
        </span>
        <span className="flex-1 min-w-0">
          <span className="flex items-start justify-between gap-2">
            <span
              className={`block text-[13px] truncate ${
                isUnread ? "font-semibold text-foreground" : "font-medium text-foreground/80"
              }`}
            >
              <span className="sr-only">{style.category}: </span>
              {n.title}
            </span>
            <span className="text-[10px] text-muted-foreground whitespace-nowrap shrink-0">
              {formatDistanceToNow(new Date(n.createdAt), { addSuffix: true })}
            </span>
          </span>
          <span className="block text-[12px] text-muted-foreground mt-0.5 line-clamp-2">{n.message}</span>
          {dueLabel && (
            <span
              className="chip mt-1.5"
              style={{ fontSize: 11 }}
              data-testid={`notification-due-${n.id}`}
            >
              {dueLabel}
            </span>
          )}
        </span>
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

    return href ? (
      <Link key={String(n.id)} href={href} onClick={() => handleOpen(n)} className="block">
        {inner}
      </Link>
    ) : (
      <button
        key={String(n.id)}
        type="button"
        onClick={() => handleOpen(n)}
        className="block w-full text-left"
      >
        {inner}
      </button>
    );
  };

  return (
    <div className="relative" ref={wrapRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="btn btn-quiet btn-sm px-2 relative"
        aria-label="Notifications"
        aria-expanded={open}
        data-testid="button-notifications"
      >
        <Bell className="w-4 h-4" />
        {unreadCount > 0 && (
          <span
            className="absolute top-1 right-1 w-2 h-2 rounded-full bg-danger ring-2 ring-background"
            aria-label={`${unreadCount} unread`}
            data-testid="notifications-unread-dot"
          />
        )}
      </button>

      {open && (
        <div
          className="soma-card absolute right-0 mt-2 w-[340px] max-h-[460px] overflow-auto z-50"
          style={{ padding: 0 }}
          role="menu"
          data-testid="notifications-panel"
        >
          <div
            className="flex items-center justify-between sticky top-0 bg-background z-10"
            style={{ padding: "14px 16px", borderBottom: "1px solid hsl(var(--border))" }}
          >
            <span className="eyebrow">Notifications</span>
            {unreadCount > 0 ? (
              <button
                type="button"
                onClick={() => markAllRead.mutate()}
                disabled={markAllRead.isPending}
                className="btn btn-quiet btn-sm"
                style={{ fontSize: 11 }}
                data-testid="notif-mark-all-read"
              >
                <CheckCheck className="w-3.5 h-3.5" />
                Mark all read
              </button>
            ) : (
              <span className="text-muted-foreground" style={{ fontSize: 11 }}>
                All caught up
              </span>
            )}
          </div>

          {sorted.length === 0 ? (
            <div className="px-5 py-12 text-center" data-testid="empty-notifications">
              <Inbox className="w-8 h-8 mx-auto text-muted-foreground/50 mb-2" aria-hidden="true" />
              <p className="text-[13px] text-foreground font-semibold">No new notifications</p>
              <p className="text-[11px] text-muted-foreground mt-1">
                New work, feedback and reminders will show up here.
              </p>
            </div>
          ) : (
            <div data-testid="list-notifications">{sorted.map(renderItem)}</div>
          )}
        </div>
      )}
    </div>
  );
}

export default StudentNotificationsBell;
