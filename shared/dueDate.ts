// Default due-date policy for quiz assignments.
//
// When a tutor assigns an assessment, the due date defaults to 3 days after the
// assessment was created, floored to the start of that hour. For example, an
// assessment created at 15:23 defaults to a due date 3 days later at 15:00. The
// tutor can always move the date earlier or later before assigning.

export const DEFAULT_DUE_DAYS = 3;

// Compute the default due date: createdAt + 3 days, with minutes/seconds/ms
// floored to the hour. Falls back to "now" when no valid createdAt is given.
export function computeDefaultDueDate(createdAt?: Date | string | null): Date {
  const parsed = createdAt ? new Date(createdAt) : new Date();
  const base = isNaN(parsed.getTime()) ? new Date() : parsed;
  const due = new Date(base);
  due.setDate(due.getDate() + DEFAULT_DUE_DAYS);
  due.setMinutes(0, 0, 0);
  return due;
}

// Format a Date for an <input type="datetime-local"> value (local time,
// "YYYY-MM-DDTHH:mm"). Browser datetime-local inputs expect local time, not ISO.
export function toDatetimeLocalValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// Convenience: the default due date already formatted for a datetime-local input.
export function defaultDueDateInputValue(createdAt?: Date | string | null): string {
  return toDatetimeLocalValue(computeDefaultDueDate(createdAt));
}
