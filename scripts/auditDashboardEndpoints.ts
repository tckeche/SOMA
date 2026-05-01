/**
 * Tier 1 / Tier 2 — true HTTP endpoint audit.
 *
 * The earlier audit script (`scripts/auditDashboards.ts`) calls
 * service functions directly and skips the HTTP/auth layer entirely.
 * That gives us the data picture but misses three real classes of bug:
 *
 *   1. Auth/middleware bugs (token not accepted, role check wrong,
 *      role list misconfigured for an endpoint).
 *   2. Response-shape mismatch — server sends X but the route's
 *      response wrapper transforms it into Y.
 *   3. HTTP-only failures — 4xx/5xx that the service-layer test
 *      never exercises.
 *
 * This script closes that gap. It picks a real student and tutor
 * from the DB, mints a Supabase-style JWT for each (signed with
 * SUPABASE_JWT_SECRET or JWT_SECRET — same secret the auth middleware
 * verifies with), and curls a curated list of dashboard endpoints
 * against the deployed app. For each endpoint it reports HTTP status,
 * top-level keys returned, and item counts on the tiles we care about.
 *
 * Use this AFTER you've verified the underlying service functions
 * work via auditDashboards.ts. If service-layer audit says HEALTHY
 * but this script says ERROR, the bug is in the HTTP wrapper.
 *
 * Usage:
 *   npx tsx scripts/auditDashboardEndpoints.ts --base-url=https://soma.melaniacalvin.com
 *   npx tsx scripts/auditDashboardEndpoints.ts --student-id=<uuid> --tutor-id=<uuid>
 *   npx tsx scripts/auditDashboardEndpoints.ts --json
 *
 * Environment:
 *   SUPABASE_JWT_SECRET / JWT_SECRET  — required for token signing.
 *   The same secret the deployed app verifies with — read directly
 *   from .env or Replit Secrets via dotenv.
 *
 * Read-only — every call is a GET. Never writes.
 */
import "dotenv/config";
import jwt from "jsonwebtoken";
import { eq, sql } from "drizzle-orm";
import { connectDb, db } from "../server/db";
import { somaUsers, somaReports, somaQuizzes } from "../shared/schema";

interface CliOptions {
  baseUrl: string;
  studentId: string | null;
  tutorId: string | null;
  json: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    baseUrl: "https://soma.melaniacalvin.com",
    studentId: null,
    tutorId: null,
    json: false,
  };
  for (const raw of argv.slice(2)) {
    if (raw === "--json") opts.json = true;
    else if (raw === "--help" || raw === "-h") {
      console.log("Usage: npx tsx scripts/auditDashboardEndpoints.ts [--base-url=URL] [--student-id=UUID] [--tutor-id=UUID] [--json]");
      process.exit(0);
    } else if (raw.startsWith("--base-url=")) opts.baseUrl = raw.slice("--base-url=".length).replace(/\/+$/, "");
    else if (raw.startsWith("--student-id=")) opts.studentId = raw.slice("--student-id=".length);
    else if (raw.startsWith("--tutor-id=")) opts.tutorId = raw.slice("--tutor-id=".length);
    else throw new Error(`unknown flag: ${raw}`);
  }
  return opts;
}

function getJwtSecret(): string {
  return process.env.SUPABASE_JWT_SECRET || process.env.JWT_SECRET || "";
}

interface PickedUser {
  id: string;
  email: string;
  displayName: string | null;
}

async function pickActiveStudent(explicit: string | null): Promise<PickedUser | null> {
  if (!db) return null;
  if (explicit) {
    const [row] = await db.select({ id: somaUsers.id, email: somaUsers.email, displayName: somaUsers.displayName }).from(somaUsers).where(eq(somaUsers.id, explicit));
    return row ?? null;
  }
  const candidates = await db
    .select({ id: somaUsers.id, email: somaUsers.email, displayName: somaUsers.displayName })
    .from(somaUsers)
    .leftJoin(somaReports, eq(somaReports.studentId, somaUsers.id))
    .where(eq(somaUsers.role, "student"))
    .groupBy(somaUsers.id, somaUsers.email, somaUsers.displayName)
    .orderBy(sql`count(${somaReports.id}) desc`)
    .limit(1);
  return candidates[0] ?? null;
}

async function pickActiveTutor(explicit: string | null): Promise<PickedUser | null> {
  if (!db) return null;
  if (explicit) {
    const [row] = await db.select({ id: somaUsers.id, email: somaUsers.email, displayName: somaUsers.displayName }).from(somaUsers).where(eq(somaUsers.id, explicit));
    return row ?? null;
  }
  const candidates = await db
    .select({ id: somaUsers.id, email: somaUsers.email, displayName: somaUsers.displayName })
    .from(somaUsers)
    .leftJoin(somaQuizzes, eq(somaQuizzes.authorId, somaUsers.id))
    .where(eq(somaUsers.role, "tutor"))
    .groupBy(somaUsers.id, somaUsers.email, somaUsers.displayName)
    .orderBy(sql`count(${somaQuizzes.id}) desc`)
    .limit(1);
  return candidates[0] ?? null;
}

function mintToken(user: PickedUser): string {
  const secret = getJwtSecret();
  if (!secret) throw new Error("SUPABASE_JWT_SECRET or JWT_SECRET not set in environment");
  // Mirror the shape verifySupabaseToken() expects: a `sub` claim with
  // the user's id and an optional email. 1-hour expiry is plenty for
  // an audit pass and keeps the issued token from leaking long-term.
  return jwt.sign({ sub: user.id, email: user.email }, secret, { expiresIn: "1h" });
}

interface EndpointResult {
  endpoint: string;
  method: "GET";
  status: number;
  ok: boolean;
  durationMs: number;
  topLevelKeys: string[];
  itemCounts: Record<string, number>;
  error: string | null;
}

async function callEndpoint(
  baseUrl: string,
  path: string,
  token: string,
  countFn?: (body: any) => Record<string, number>,
): Promise<EndpointResult> {
  const url = `${baseUrl}${path}`;
  const start = Date.now();
  try {
    const resp = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(30_000),
    });
    const durationMs = Date.now() - start;
    let body: any = null;
    let parseErr: string | null = null;
    try {
      body = await resp.json();
    } catch (e) {
      parseErr = e instanceof Error ? e.message : String(e);
    }
    const topLevelKeys =
      body && typeof body === "object" && !Array.isArray(body) ? Object.keys(body) : [];
    const itemCounts = body && countFn ? countFn(body) : {};
    return {
      endpoint: path,
      method: "GET",
      status: resp.status,
      ok: resp.ok && parseErr === null,
      durationMs,
      topLevelKeys,
      itemCounts,
      error: parseErr ?? (resp.ok ? null : `HTTP ${resp.status}`),
    };
  } catch (err) {
    return {
      endpoint: path,
      method: "GET",
      status: 0,
      ok: false,
      durationMs: Date.now() - start,
      topLevelKeys: [],
      itemCounts: {},
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv);
  await connectDb();

  const student = await pickActiveStudent(opts.studentId);
  const tutor = await pickActiveTutor(opts.tutorId);
  if (!student && !tutor) {
    console.error("No student or tutor found in DB. Cannot audit any endpoint.");
    process.exit(1);
  }
  if (!getJwtSecret()) {
    console.error("Neither SUPABASE_JWT_SECRET nor JWT_SECRET is set. Cannot mint tokens.");
    console.error("These are read from .env via dotenv — check that .env contains the secret the deployed app uses.");
    process.exit(1);
  }

  const studentToken = student ? mintToken(student) : null;
  const tutorToken = tutor ? mintToken(tutor) : null;

  const results: EndpointResult[] = [];

  if (student && studentToken) {
    results.push(
      await callEndpoint(opts.baseUrl, "/api/student/dashboard", studentToken, (b) => ({
        subjects: Array.isArray(b.subjects) ? b.subjects.length : 0,
        assignments: Array.isArray(b.assignments) ? b.assignments.length : 0,
        completed: Array.isArray(b.completed) ? b.completed.length : 0,
        recentWins: Array.isArray(b.recentWins) ? b.recentWins.length : 0,
        reminders: Array.isArray(b.reminders) ? b.reminders.length : 0,
        nextActions: Array.isArray(b.nextActions) ? b.nextActions.length : 0,
        notifications: Array.isArray(b.notifications?.items) ? b.notifications.items.length : 0,
      })),
    );
    results.push(
      await callEndpoint(
        opts.baseUrl,
        "/api/student/study-tips?subject=Mathematics&syllabusCode=0580",
        studentToken,
        (b) => ({ tips: Array.isArray(b.tips) ? b.tips.length : 0 }),
      ),
    );
    results.push(
      await callEndpoint(opts.baseUrl, "/api/student/mastery-map", studentToken, (b) => ({
        subjects: Array.isArray(b.subjects) ? b.subjects.length : 0,
        totalLeaves: Array.isArray(b.subjects)
          ? b.subjects.reduce(
              (sum: number, s: any) =>
                sum +
                (s.topics ?? []).reduce(
                  (tSum: number, t: any) => tSum + (t.subtopics?.length ?? 0),
                  0,
                ),
              0,
            )
          : 0,
      })),
    );
  }

  if (tutor && tutorToken) {
    results.push(
      await callEndpoint(opts.baseUrl, "/api/tutor/dashboard-stats", tutorToken, (b) => ({
        keys: Object.keys(b ?? {}).length,
      })),
    );
    results.push(
      await callEndpoint(opts.baseUrl, "/api/tutor/cohort-weaknesses", tutorToken, (b) => ({
        topics: Array.isArray(b.topics) ? b.topics.length : 0,
        studentCount: typeof b.studentCount === "number" ? b.studentCount : 0,
      })),
    );
  }

  if (opts.json) {
    console.log(JSON.stringify({ baseUrl: opts.baseUrl, student, tutor, results }, null, 2));
    return;
  }

  const fmt = (n: number) => new Intl.NumberFormat("en-GB").format(n);
  console.log("");
  console.log(`HTTP endpoint audit — base=${opts.baseUrl}`);
  console.log(`Student: ${student?.displayName ?? "(none)"} <${student?.email ?? "?"}>`);
  console.log(`Tutor:   ${tutor?.displayName ?? "(none)"} <${tutor?.email ?? "?"}>`);
  console.log("");
  for (const r of results) {
    const mark = r.ok ? "[ OK ]" : "[FAIL]";
    console.log(`${mark}  ${r.method} ${r.endpoint}`);
    console.log(`        status=${r.status} duration=${fmt(r.durationMs)}ms`);
    if (r.topLevelKeys.length > 0) console.log(`        top-level keys: ${r.topLevelKeys.join(", ")}`);
    const itemEntries = Object.entries(r.itemCounts);
    if (itemEntries.length > 0) {
      console.log(`        item counts: ${itemEntries.map(([k, v]) => `${k}=${fmt(v)}`).join(", ")}`);
    }
    if (r.error) console.log(`        error: ${r.error}`);
    console.log("");
  }
  const failed = results.filter((r) => !r.ok);
  if (failed.length === 0) {
    console.log("OVERALL: [ OK ] — every audited endpoint returned 200 with parseable JSON.");
  } else {
    console.log(`OVERALL: [FAIL] — ${failed.length} of ${results.length} endpoints failed.`);
    console.log("Failed endpoints:");
    for (const r of failed) console.log(`  - ${r.endpoint}  → ${r.error}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    process.exit(1);
  });
