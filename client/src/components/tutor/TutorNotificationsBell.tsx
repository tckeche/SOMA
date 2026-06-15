// Tutor notifications bell + dropdown panel for the Warm Editorial dashboard.
// Self-contained: owns its own query, mark-read mutation and popover state.
// Reuses the original query key / endpoints / mutation so behaviour is unchanged.
import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { Bell, Clock, Eye, FileText, CheckCircle2 } from "lucide-react";
import { format } from "date-fns";
import { authFetch } from "@/lib/supabase";

interface TutorNotification {
  id: number;
  type: string;
  title: string;
  message: string;
  payload: Record<string, any> | null;
  readAt: string | null;
  createdAt: string;
}

export function TutorNotificationsBell({ userId }: { userId: string | null | undefined }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  const { data: notificationsData } = useQuery<{ notifications: TutorNotification[]; unreadCount: number }>({
    queryKey: ["/api/tutor/notifications", userId],
    queryFn: async () => {
      const res = await authFetch("/api/tutor/notifications");
      if (!res.ok) return { notifications: [], unreadCount: 0 };
      return res.json();
    },
    enabled: !!userId,
    refetchInterval: 10000,
  });

  const markReadMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await authFetch(`/api/tutor/notifications/${id}/read`, { method: "POST" });
      if (!res.ok) throw new Error("Failed to mark as read");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/tutor/notifications"] });
    },
  });

  const unreadCount = notificationsData?.unreadCount ?? 0;
  const unreadItems = (notificationsData?.notifications ?? []).filter((n) => !n.readAt);

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
            <span className="text-muted-foreground" style={{ fontSize: 11 }}>
              {unreadItems.length > 0
                ? `${unreadItems.length} unread`
                : "All caught up"}
            </span>
          </div>

          {unreadItems.length === 0 ? (
            <div className="px-5 py-12 text-center">
              <CheckCircle2 className="w-8 h-8 mx-auto text-success/40 mb-2" />
              <p className="text-[13px] text-foreground font-semibold">All caught up</p>
              <p className="text-[11px] text-muted-foreground mt-1">
                New submissions and generation updates will appear here
              </p>
            </div>
          ) : (
            <div>
              {unreadItems.map((item) => {
                const reportId = Number(item.payload?.reportId || 0) || null;
                const quizId = Number(item.payload?.quizId || 0) || null;
                const target = reportId ? `/soma/review/${reportId}` : quizId ? `/soma/quiz/${quizId}` : null;
                const handleOpen = () => {
                  markReadMutation.mutate(item.id);
                  setOpen(false);
                };
                const inner = (
                  <div
                    className="flex items-start gap-3 w-full text-left hover:bg-foreground/[0.03] transition-colors cursor-pointer"
                    style={{ padding: "12px 16px", borderBottom: "1px solid hsl(var(--border))" }}
                    data-testid={`notification-${item.id}`}
                  >
                    <span className="relative shrink-0">
                      <span className="grid place-items-center" style={{ width: 34, height: 34, borderRadius: 9, background: "hsl(var(--primary) / 0.12)", color: "hsl(var(--primary))", border: "1px solid hsl(var(--primary) / 0.22)" }}>
                        <Bell className="w-4 h-4" />
                      </span>
                      <span
                        className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-danger ring-2 ring-background"
                        aria-label="Unread"
                        data-testid={`notification-dot-${item.id}`}
                      />
                    </span>
                    <span className="flex-1 min-w-0">
                      <span className="block text-[13px] font-semibold text-foreground truncate">{item.title}</span>
                      <span className="block text-[12px] text-muted-foreground mt-0.5 line-clamp-2">{item.message}</span>
                      <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground font-medium mt-1.5">
                        <Clock className="w-3 h-3" />
                        <span>{format(new Date(item.createdAt), "MMM d, h:mm a")}</span>
                        {reportId ? (
                          <span className="flex items-center gap-1 ml-auto text-foreground/70"><Eye className="w-3 h-3" /> Review</span>
                        ) : quizId ? (
                          <span className="flex items-center gap-1 ml-auto text-foreground/70"><FileText className="w-3 h-3" /> Open</span>
                        ) : null}
                      </span>
                    </span>
                  </div>
                );
                return target ? (
                  <Link key={item.id} href={target} onClick={handleOpen} className="block">
                    {inner}
                  </Link>
                ) : (
                  <button
                    key={item.id}
                    type="button"
                    onClick={handleOpen}
                    className="block w-full text-left"
                  >
                    {inner}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default TutorNotificationsBell;
