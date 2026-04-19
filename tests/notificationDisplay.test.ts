import { describe, it, expect } from "vitest";
import {
  getNotificationSeverity,
  severityRank,
  sortNotifications,
  getNotificationTone,
  getNotificationIcon,
  formatDueLabel,
  extractDueDate,
} from "../client/src/lib/notificationDisplay";
import type { DashboardNotification } from "../client/src/types/studentDashboard";

function makeNotif(partial: Partial<DashboardNotification>): DashboardNotification {
  return {
    id: partial.id ?? Math.random(),
    type: partial.type ?? "assignment_new",
    title: partial.title ?? "t",
    message: partial.message ?? "m",
    payload: partial.payload ?? null,
    readAt: partial.readAt ?? null,
    createdAt: partial.createdAt ?? new Date("2026-04-19T12:00:00Z").toISOString(),
    derived: partial.derived,
  };
}

describe("getNotificationSeverity", () => {
  it.each([
    ["overdue", "urgent"],
    ["due_today", "urgent"],
    ["due_tomorrow", "warning"],
    ["feedback_ready", "positive"],
    ["milestone_mastery", "positive"],
    ["assignment_new", "info"],
    ["tutor_comment", "info"],
    ["unknown_xyz", "info"],
  ] as const)("maps %s to %s", (type, expected) => {
    expect(getNotificationSeverity(type)).toBe(expected);
  });
});

describe("severityRank", () => {
  it("ranks urgency from most to least important", () => {
    expect(severityRank("overdue")).toBeLessThan(severityRank("due_today"));
    expect(severityRank("due_today")).toBeLessThan(severityRank("due_tomorrow"));
    expect(severityRank("due_tomorrow")).toBeLessThan(severityRank("feedback_ready"));
    expect(severityRank("feedback_ready")).toBeLessThan(severityRank("assignment_new"));
  });

  it("gives unknown types the highest (least urgent) rank", () => {
    expect(severityRank("mystery")).toBeGreaterThan(severityRank("milestone_mastery"));
  });
});

describe("sortNotifications", () => {
  it("puts unread before read", () => {
    const items = [
      makeNotif({ id: 1, type: "overdue", readAt: "2026-04-19T13:00:00Z" }),
      makeNotif({ id: 2, type: "assignment_new", readAt: null }),
    ];
    const sorted = sortNotifications(items);
    expect(sorted[0].id).toBe(2);
    expect(sorted[1].id).toBe(1);
  });

  it("among unread, sorts by severity", () => {
    const items = [
      makeNotif({ id: 1, type: "assignment_new" }),
      makeNotif({ id: 2, type: "overdue" }),
      makeNotif({ id: 3, type: "due_today" }),
    ];
    const sorted = sortNotifications(items);
    expect(sorted.map((n) => n.id)).toEqual([2, 3, 1]);
  });

  it("within the same severity, sorts newest first", () => {
    const items = [
      makeNotif({ id: 1, type: "overdue", createdAt: "2026-04-18T09:00:00Z" }),
      makeNotif({ id: 2, type: "overdue", createdAt: "2026-04-19T09:00:00Z" }),
    ];
    const sorted = sortNotifications(items);
    expect(sorted.map((n) => n.id)).toEqual([2, 1]);
  });

  it("does not mutate the original array", () => {
    const items = [
      makeNotif({ id: 1, type: "assignment_new" }),
      makeNotif({ id: 2, type: "overdue" }),
    ];
    const original = [...items];
    sortNotifications(items);
    expect(items).toEqual(original);
  });
});

describe("getNotificationTone", () => {
  it("returns urgent-tone classes for overdue and due_today", () => {
    expect(getNotificationTone("overdue").accent).toBe("bg-rose-500");
    expect(getNotificationTone("due_today").accent).toBe("bg-rose-500");
    expect(getNotificationTone("overdue").ariaPrefix).toBe("Urgent");
  });

  it("returns warning tone for due_tomorrow", () => {
    const tone = getNotificationTone("due_tomorrow");
    expect(tone.accent).toBe("bg-amber-400");
    expect(tone.ariaPrefix).toBe("Reminder");
  });

  it("distinguishes milestone (violet) from feedback_ready (emerald)", () => {
    expect(getNotificationTone("milestone_mastery").accent).toBe("bg-violet-400");
    expect(getNotificationTone("feedback_ready").accent).toBe("bg-emerald-400");
  });

  it("distinguishes tutor_comment (cyan) from assignment_new (sky)", () => {
    expect(getNotificationTone("tutor_comment").accent).toBe("bg-cyan-400");
    expect(getNotificationTone("assignment_new").accent).toBe("bg-sky-400");
  });
});

describe("getNotificationIcon", () => {
  it("returns a component for each known type", () => {
    expect(typeof getNotificationIcon("overdue")).toBe("object"); // ForwardRef
    expect(getNotificationIcon("unknown")).toBeDefined();
  });
});

describe("formatDueLabel", () => {
  const now = new Date("2026-04-19T10:30:00Z");

  it("returns null for null / undefined / invalid", () => {
    expect(formatDueLabel(null, now)).toBeNull();
    expect(formatDueLabel(undefined, now)).toBeNull();
    expect(formatDueLabel("not-a-date", now)).toBeNull();
  });

  it("says 'Due today' for today", () => {
    const due = new Date("2026-04-19T18:00:00Z").toISOString();
    expect(formatDueLabel(due, now)).toBe("Due today");
  });

  it("says 'Due tomorrow' for +1 day", () => {
    const due = new Date("2026-04-20T09:00:00Z").toISOString();
    expect(formatDueLabel(due, now)).toBe("Due tomorrow");
  });

  it("pluralises days overdue", () => {
    const oneDayAgo = new Date("2026-04-18T18:00:00Z").toISOString();
    const threeDaysAgo = new Date("2026-04-16T10:00:00Z").toISOString();
    expect(formatDueLabel(oneDayAgo, now)).toBe("1 day overdue");
    expect(formatDueLabel(threeDaysAgo, now)).toBe("3 days overdue");
  });

  it("uses weekday for 2-6 days away", () => {
    const due = new Date("2026-04-22T09:00:00Z").toISOString();
    const label = formatDueLabel(due, now);
    expect(label).toMatch(/^Due /);
    expect(label).not.toBe("Due today");
    expect(label).not.toBe("Due tomorrow");
  });

  it("uses a dated form for 7+ days away", () => {
    const due = new Date("2026-05-01T09:00:00Z").toISOString();
    const label = formatDueLabel(due, now);
    expect(label).toMatch(/^Due /);
    // contains some form of month abbreviation for April/May
    expect(label).toMatch(/\d/); // has a day number
  });
});

describe("extractDueDate", () => {
  it("returns null when payload is null", () => {
    expect(extractDueDate(makeNotif({ payload: null }))).toBeNull();
  });

  it("returns null when payload has no dueDate", () => {
    expect(extractDueDate(makeNotif({ payload: { quizId: 5 } }))).toBeNull();
  });

  it("returns the dueDate when present", () => {
    const iso = "2026-04-22T09:00:00Z";
    expect(extractDueDate(makeNotif({ payload: { dueDate: iso } }))).toBe(iso);
  });
});
