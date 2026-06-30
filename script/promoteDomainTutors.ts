/**
 * Promote existing student accounts on the tutor email domain to `tutor`.
 *
 * New signups from TUTOR_EMAIL_DOMAIN are provisioned as tutors automatically
 * (see determineRole in server/routes.ts), but that only runs for brand-new
 * accounts at /api/auth/sync. Anyone from the domain who already had an account
 * before tutor-domain provisioning was in place keeps their stored role. This
 * one-shot script closes that gap.
 *
 * SAFE BY DEFAULT: a bare run is a DRY RUN that only lists who WOULD change.
 * Pass --apply to actually write the role change.
 *
 *   npm run db:promote-domain-tutors            # dry run (lists candidates)
 *   npm run db:promote-domain-tutors -- --apply # performs the promotion
 *
 * The domain comes from TUTOR_EMAIL_DOMAIN (default "melaniacalvin.com"), and
 * the suffix match is end-anchored (`%@<domain>`) so it matches exactly the
 * same accounts the signup-time domain check (email.split("@")[1] === domain)
 * would — never a subdomain or look-alike. super_admins are never touched; only
 * rows currently role='student' are promoted.
 */
import { db } from "../server/db";
import { somaUsers } from "../shared/schema";
import { and, eq, ilike } from "drizzle-orm";

const APPLY = process.argv.includes("--apply");
const DOMAIN = (process.env.TUTOR_EMAIL_DOMAIN || "melaniacalvin.com").trim().toLowerCase();

async function main() {
  if (!db) throw new Error("Database is not configured (set DATABASE_URL).");
  if (!DOMAIN) throw new Error("TUTOR_EMAIL_DOMAIN resolved empty — refusing to run.");

  const where = and(eq(somaUsers.role, "student"), ilike(somaUsers.email, `%@${DOMAIN}`));

  const candidates = await db
    .select({ id: somaUsers.id, email: somaUsers.email })
    .from(somaUsers)
    .where(where);

  if (candidates.length === 0) {
    console.log(`No student accounts on @${DOMAIN} to promote. Nothing to do.`);
    return;
  }

  console.log(`Found ${candidates.length} student account(s) on @${DOMAIN}:`);
  for (const u of candidates) console.log(`  - ${u.email} (${u.id})`);

  if (!APPLY) {
    console.log(`\nDRY RUN — no changes made. Re-run with --apply to promote these to tutor.`);
    return;
  }

  const updated = await db
    .update(somaUsers)
    .set({ role: "tutor" })
    .where(where)
    .returning({ id: somaUsers.id });
  console.log(`\nPromoted ${updated.length} account(s) on @${DOMAIN} to tutor.`);
}

main().catch((error) => {
  console.error("Promotion failed:", error);
  process.exit(1);
});
