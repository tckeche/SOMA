/**
 * Presentable student/user names.
 *
 * Legacy rows often carry an email-derived displayName (the old signup and
 * sync fallbacks stored email.split("@")[0], e.g. "john.smith42"). Until the
 * student's next login self-heals the row server-side, these helpers make
 * sure tutors see "John Smith" rather than a raw email prefix.
 */

function humanizeEmailPrefix(email: string): string | null {
  const words = email.split("@")[0].split(/[._\-+\d]+/).filter(Boolean);
  if (words.length === 0) return null;
  return words.map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
}

function isEmailDerived(name: string, email: string): boolean {
  const n = name.trim().toLowerCase();
  return n === email.toLowerCase() || n === email.split("@")[0].toLowerCase();
}

export function formatPersonName(
  person: { displayName?: string | null; email?: string | null },
  fallback = "Student",
): string {
  const name = (person.displayName || "").trim();
  const email = (person.email || "").trim();
  if (name && (!email || !isEmailDerived(name, email))) return name;
  if (email) return humanizeEmailPrefix(email) ?? fallback;
  return name || fallback;
}
