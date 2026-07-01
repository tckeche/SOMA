import type { SomaRole } from "./types";

const TUTOR_EMAIL_DOMAIN = process.env.TUTOR_EMAIL_DOMAIN || "melaniacalvin.com";
const SUPER_ADMIN_EMAIL = process.env.SUPER_ADMIN_EMAIL || "tckeche@gmail.com";

// Optional comma-separated allowlist of individual emails that may be
// provisioned as tutors at signup without being on TUTOR_EMAIL_DOMAIN.
// Server-side only — a client cannot influence this set.
const TUTOR_EMAIL_ALLOWLIST = new Set(
  (process.env.TUTOR_EMAIL_ALLOWLIST || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean),
);

export function determineRole(email: string, requestedRole?: string): SomaRole {
  const lc = email.toLowerCase();
  if (lc === SUPER_ADMIN_EMAIL.toLowerCase()) return "super_admin";
  const domain = email.split("@")[1]?.toLowerCase();
  if (domain === TUTOR_EMAIL_DOMAIN.toLowerCase()) return "tutor";
  // SECURITY: a client-supplied requested_role must NEVER by itself grant the
  // tutor role — doing so let anyone signing up self-provision the entire tutor
  // API surface (adopt students, author/assign/publish assessments, read
  // rosters, mark, regrade). Honour a requested "tutor" ONLY when the email is
  // on the server-side allowlist (or the tutor domain, handled above);
  // otherwise default to student. super_admin is never self-selectable. This is
  // only consulted for brand-new accounts (see auth/sync), so it cannot escalate
  // an existing account via mutated Supabase user_metadata.
  if (requestedRole === "tutor" && TUTOR_EMAIL_ALLOWLIST.has(lc)) return "tutor";
  return "student";
}
