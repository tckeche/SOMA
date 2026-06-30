import type { SomaRole } from "./types";

const TUTOR_EMAIL_DOMAIN = process.env.TUTOR_EMAIL_DOMAIN || "melaniacalvin.com";
const SUPER_ADMIN_EMAIL = process.env.SUPER_ADMIN_EMAIL || "tckeche@gmail.com";

export function determineRole(email: string, requestedRole?: string): SomaRole {
  if (email.toLowerCase() === SUPER_ADMIN_EMAIL.toLowerCase()) return "super_admin";
  const domain = email.split("@")[1]?.toLowerCase();
  if (domain === TUTOR_EMAIL_DOMAIN.toLowerCase()) return "tutor";
  if (requestedRole === "tutor") return "tutor";
  return "student";
}
