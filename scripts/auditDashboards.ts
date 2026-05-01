/**
 * Tier 2 — Dashboard data audit.
 *
 * Picks a real student and a real tutor from the database (or accepts
 * --student-id / --tutor-id), calls the underlying dashboard service
 * functions directly (skipping HTTP/auth), and prints a per-tile
 * verdict so you can see in one shell command:
 *
 *   - Is each dashboard tile populated?
 *   - Is anything stuck on zero?
 *   - Are misconception-attribution panels actually using approved
 *     examiner data, or are they hollow?
 *   - Which dashboards are healthy vs which are starving for data?
 *
 * Calls the SAME service functions the routes call. Bypassing the
 * HTTP layer means we miss any auth-only or response-shape bugs, but
 * we get the actual data picture in one command.
 *
 * Usage:
 *   npx tsx scripts/auditDashboards.ts
 *   npx tsx scripts/auditDashboards.ts --student-id=<uuid>
 *   npx tsx scripts/auditDashboards.ts --tutor-id=<uuid>
 *   npx tsx scripts/auditDashboards.ts --syllabus-code=0580 --subject=Mathematics
 *   npx tsx scripts/auditDashboards.ts --json
 *
 * Read-only — never writes.
 */
import "dotenv/config";
import { desc, eq, sql, isNotNull } from "drizzle-orm";
import { connectDb, db } from "../server/db";
import { initStorage, storage } from "../server/storage";
import {
  somaUsers,
  somaReports,
  somaQuizzes,
  examinerMisconceptions,
} from "../shared/schema";
import { buildStudentDashboard } from "../server/services/studentDashboard";
import { buildMasteryMap } from "../server/services/syllabusMasteryMap";

interface CliOptions {
  studentId: string | null;
  tutorId: string | null;
  syllabusCode: string | null;
  subject: string | null;
  json: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    studentId: null,
    tutorId: null,
    syllabusCode: null,
    subject: null,
    json: false,
  };
  for (const raw of argv.slice(2)) {
    if (raw === "--json") opts.json = true;
    else if (raw === "--help" || raw === "-h") {
      console.log("Usage: npx tsx scripts/auditDashboards.ts [--student-id=UUID] [--tutor-id=UUID] [--syllabus-code=0580] [--subject=Mathematics] [--json]");
      process.exit(0);
    } else if (raw.startsWith("--student-id=")) opts.studentId = raw.slice("--student-id=".length);
    else if (raw.startsWith("--tutor-id=")) opts.tutorId = raw.slice("--tutor-id=".length);
    else if (raw.startsWith("--syllabus-code=")) opts.syllabusCode = raw.slice("--syllabus-code=".length);
    else if (raw.startsWith("--subject=")) opts.subject = raw.slice("--subject=".length);
    else throw new Error(`unknown flag: ${raw}`);
  }
  return opts;
}

type Verdict = "healthy" | "sparse" | "empty" | "error";

interface SectionReport {
  section: string;
  verdict: Verdict;
  headline: string;
  details: string[];
  /** Optional list of "tiles you'd want to investigate". */
  warnings: string[];
}

const fmt = (n: number) => new Intl.NumberFormat("en-GB").format(n);

async function pickStudent(explicitId: string | null): Promise<{ id: string; displayName: string | null; email: string | null } | null> {
  if (!db) return null;
  if (explicitId) {
    const [row] = await db.select({ id: somaUsers.id, displayName: somaUsers.displayName, email: somaUsers.email }).from(somaUsers).where(eq(somaUsers.id, explicitId));
    return row ?? null;
  }
  // Prefer a student that actually has submitted reports — that's the
  // realistic case where dashboards have data to show.
  const candidates = await db
    .select({
      id: somaUsers.id,
      displayName: somaUsers.displayName,
      email: somaUsers.email,
      reportCount: sql<number>`count(${somaReports.id})::int`,
    })
    .from(somaUsers)
    .leftJoin(somaReports, eq(somaReports.studentId, somaUsers.id))
    .where(eq(somaUsers.role, "student"))
    .groupBy(somaUsers.id, somaUsers.displayName, somaUsers.email)
    .orderBy(sql`count(${somaReports.id}) desc`)
    .limit(1);
  return candidates[0] ?? null;
}

async function pickTutor(explicitId: string | null): Promise<{ id: string; displayName: string | null; email: string | null } | null> {
  if (!db) return null;
  if (explicitId) {
    const [row] = await db.select({ id: somaUsers.id, displayName: somaUsers.displayName, email: somaUsers.email }).from(somaUsers).where(eq(somaUsers.id, explicitId));
    return row ?? null;
  }
  // Prefer a tutor with at least one authored quiz — they're more likely
  // to have adopted students and meaningful dashboard data.
  const candidates = await db
    .select({
      id: somaUsers.id,
      displayName: somaUsers.displayName,
      email: somaUsers.email,
      quizCount: sql<number>`count(${somaQuizzes.id})::int`,
    })
    .from(somaUsers)
    .leftJoin(somaQuizzes, eq(somaQuizzes.authorId, somaUsers.id))
    .where(eq(somaUsers.role, "tutor"))
    .groupBy(somaUsers.id, somaUsers.displayName, somaUsers.email)
    .orderBy(sql`count(${somaQuizzes.id}) desc`)
    .limit(1);
  return candidates[0] ?? null;
}

// ── 1. Student dashboard ────────────────────────────────────────────
async function auditStudentDashboard(studentId: string): Promise<SectionReport> {
  if (!db) throw new Error("db not initialised");
  const [student] = await db.select().from(somaUsers).where(eq(somaUsers.id, studentId));
  if (!student) {
    return {
      section: "STUDENT DASHBOARD",
      verdict: "error",
      headline: "student not found",
      details: [],
      warnings: [],
    };
  }
  try {
    const dash = await buildStudentDashboard({ storage, student });
    const warnings: string[] = [];
    // Inspect each major tile. Field names MUST match DashboardPayload
    // in server/services/studentDashboard.ts — the type system can't
    // catch a typo here because dash is `any`-equivalent at the access
    // site (the audit imports the function but not the type).
    const subjectCount = (dash.subjects ?? []).length;
    const remindersCount = (dash.reminders ?? []).length;
    const winsCount = (dash.recentWins ?? []).length;
    const assignmentsCount = (dash.assignments ?? []).length;
    const completedCount = (dash.completed ?? []).length;
    const nextActionsCount = (dash.nextActions ?? []).length;
    const notificationsCount = (dash.notifications?.items ?? []).length;
    const unreadCount = dash.notifications?.unreadCount ?? 0;
    if (subjectCount === 0) warnings.push("subjects tile is empty (student has no enrolled subjects)");
    if (assignmentsCount === 0) warnings.push("no quiz assignments — tutor hasn't assigned anything to this student");
    if (completedCount === 0 && assignmentsCount > 0) warnings.push(`${assignmentsCount} assignments exist but 0 are completed — student hasn't started any quizzes yet`);
    if (winsCount === 0 && completedCount > 0) warnings.push(`${completedCount} completions exist but recentWins is empty — buildRecentWins may be filtering them out`);
    const verdict: Verdict =
      subjectCount === 0 && assignmentsCount === 0 ? "empty"
      : subjectCount > 0 && completedCount > 0 ? "healthy"
      : "sparse";
    return {
      section: "STUDENT DASHBOARD",
      verdict,
      headline: `subjects=${subjectCount} assignments=${assignmentsCount} completed=${completedCount} wins=${winsCount} reminders=${remindersCount} nextActions=${nextActionsCount} notifs=${notificationsCount}(${unreadCount} unread)`,
      details: [
        `student: ${student.displayName ?? "(no name)"} <${student.email ?? "?"}>`,
      ],
      warnings,
    };
  } catch (err) {
    return {
      section: "STUDENT DASHBOARD",
      verdict: "error",
      headline: err instanceof Error ? err.message : String(err),
      details: [`student: ${student.displayName ?? student.id}`],
      warnings: [],
    };
  }
}

// ── 2. Mastery map ──────────────────────────────────────────────────
async function auditMasteryMap(studentId: string): Promise<SectionReport> {
  try {
    const map = await buildMasteryMap(studentId);
    const subjectCount = (map.subjects ?? []).length;
    const totalLeaves = (map.subjects ?? []).reduce((sum: number, s: any) => {
      return sum + (s.topics ?? []).reduce((tSum: number, t: any) => tSum + (t.subtopics?.length ?? 0), 0);
    }, 0);
    const leavesWithMastery = (map.subjects ?? []).reduce((sum: number, s: any) => {
      return sum + (s.topics ?? []).reduce((tSum: number, t: any) => {
        return tSum + (t.subtopics ?? []).filter((st: any) => st.attempts > 0).length;
      }, 0);
    }, 0);
    // Field name is examinerInsightCount (singular, no `s`) — see
    // syllabusMasteryMap.ts SubtopicLeaf type. The plural was a typo
    // in the first version of this script which silently reported 0
    // for everything because undefined ?? 0 is 0.
    const leavesWithExaminerCount = (map.subjects ?? []).reduce((sum: number, s: any) => {
      return sum + (s.topics ?? []).reduce((tSum: number, t: any) => {
        return tSum + (t.subtopics ?? []).filter((st: any) => (st.examinerInsightCount ?? 0) > 0).length;
      }, 0);
    }, 0);
    const warnings: string[] = [];
    if (totalLeaves === 0) warnings.push("mastery tree has no subtopic leaves (catalogue not loaded for student's syllabus?)");
    if (leavesWithMastery === 0 && totalLeaves > 0) warnings.push("no subtopic has been tested yet (student hasn't submitted enough quizzes)");
    if (totalLeaves > 0 && leavesWithExaminerCount === 0) warnings.push("zero subtopics show examiner insight counts — the misconception-attribution layer isn't surfacing on this map");
    const verdict: Verdict =
      totalLeaves === 0 ? "empty"
      : leavesWithMastery > 0 && leavesWithExaminerCount > 0 ? "healthy"
      : "sparse";
    return {
      section: "MASTERY MAP (student)",
      verdict,
      headline: `subjects=${subjectCount} totalLeaves=${fmt(totalLeaves)} testedLeaves=${fmt(leavesWithMastery)} leavesWithExaminerInsights=${fmt(leavesWithExaminerCount)}`,
      details: [],
      warnings,
    };
  } catch (err) {
    return {
      section: "MASTERY MAP (student)",
      verdict: "error",
      headline: err instanceof Error ? err.message : String(err),
      details: [],
      warnings: [],
    };
  }
}

// ── 3. Study tips ───────────────────────────────────────────────────
async function auditStudyTips(opts: { subject: string | null; syllabusCode: string | null }): Promise<SectionReport> {
  const subject = opts.subject ?? "Mathematics";
  const syllabusCode = opts.syllabusCode ?? "0580";
  try {
    const rows = await storage.listExaminerMisconceptions({ subject, syllabusCode, status: "approved" });
    // Mirror the route's subject guard.
    const subjectLc = subject.toLowerCase();
    const guarded = rows.filter((r) => (r.subject ?? "").toLowerCase() === subjectLc);
    // Mirror the route's frequency-weighted topic dedup.
    const weight: Record<string, number> = { very_common: 3, common: 2, occasional: 1 };
    const sorted = [...guarded].sort(
      (a, b) =>
        (weight[(b.frequency ?? "common").toLowerCase()] ?? 0) -
        (weight[(a.frequency ?? "common").toLowerCase()] ?? 0),
    );
    const seen = new Set<string>();
    const tips: typeof sorted = [];
    for (const r of sorted) {
      const k = (r.topic ?? "").toLowerCase().trim();
      if (!k || seen.has(k)) continue;
      seen.add(k);
      tips.push(r);
      if (tips.length >= 5) break;
    }
    const warnings: string[] = [];
    if (rows.length === 0) warnings.push(`no approved misconceptions exist for subject="${subject}" syllabusCode="${syllabusCode}"`);
    if (rows.length > 0 && guarded.length === 0) warnings.push(`approved rows exist but the subject guard filtered all of them out — subject column on misconceptions doesn't match "${subject}"`);
    const verdict: Verdict = tips.length >= 3 ? "healthy" : tips.length > 0 ? "sparse" : "empty";
    return {
      section: `STUDY TIPS (subject="${subject}", code=${syllabusCode})`,
      verdict,
      headline: `approvedRows=${rows.length} subjectGuardedRows=${guarded.length} dedupedTipsToShow=${tips.length}`,
      details: tips.slice(0, 3).map((t, i) => `  tip ${i + 1}: ${t.topic} — ${t.misconception.slice(0, 80)}…`),
      warnings,
    };
  } catch (err) {
    return {
      section: "STUDY TIPS",
      verdict: "error",
      headline: err instanceof Error ? err.message : String(err),
      details: [],
      warnings: [],
    };
  }
}

// ── 4. Tutor cohort weaknesses + dashboard ──────────────────────────
async function auditTutorCohortHeatmap(tutorId: string): Promise<SectionReport> {
  try {
    const adopted = await storage.getAdoptedStudents(tutorId);
    if (adopted.length === 0) {
      return {
        section: "TUTOR COHORT HEATMAP",
        verdict: "empty",
        headline: "tutor has 0 adopted students",
        details: [],
        warnings: ["tutor needs to adopt students before the heatmap has anything to show"],
      };
    }
    const assignedSubjectsByStudent = await storage.getAssignedSubjectsForStudents(adopted.map((s) => s.id));
    const visiblePerStudent = new Map<string, Set<string>>();
    for (const s of adopted) {
      visiblePerStudent.set(s.id, new Set((assignedSubjectsByStudent[s.id] || []).map((x) => x.toLowerCase())));
    }

    // Mirror route's aggregation, summary stats only.
    let totalMasteryRows = 0;
    let testedMasteryRows = 0;
    let belowThresholdRows = 0;
    let topicsCovered = new Set<string>();
    for (const student of adopted) {
      const visible = visiblePerStudent.get(student.id) || new Set<string>();
      if (visible.size === 0) continue;
      const mastery = await storage.listStudentTopicMastery(student.id);
      for (const m of mastery) {
        totalMasteryRows++;
        if (!m.tested) continue;
        if (!visible.has((m.subject || "").toLowerCase())) continue;
        testedMasteryRows++;
        topicsCovered.add(`${m.subject}|||${m.topic}|||${m.subtopic ?? ""}`);
        if (m.understandingPercent < 75) belowThresholdRows++;
      }
    }
    const warnings: string[] = [];
    if (totalMasteryRows === 0) warnings.push("no mastery rows across cohort — students haven't taken any quizzes that touched their tutor-assigned subjects");
    if (testedMasteryRows === 0 && totalMasteryRows > 0) warnings.push("no rows are marked tested AND on a tutor-assigned subject — assignment scope may not match what students are doing");
    const verdict: Verdict =
      testedMasteryRows === 0 ? "empty"
      : topicsCovered.size > 5 && belowThresholdRows > 0 ? "healthy"
      : "sparse";
    return {
      section: "TUTOR COHORT HEATMAP",
      verdict,
      headline: `adoptedStudents=${adopted.length} totalMasteryRows=${totalMasteryRows} testedRowsInScope=${testedMasteryRows} weaknessTopics=${topicsCovered.size} belowThresholdRows=${belowThresholdRows}`,
      details: [],
      warnings,
    };
  } catch (err) {
    return {
      section: "TUTOR COHORT HEATMAP",
      verdict: "error",
      headline: err instanceof Error ? err.message : String(err),
      details: [],
      warnings: [],
    };
  }
}

// ── 5. Misconception-attribution global health ─────────────────────
async function auditAttributionHealth(): Promise<SectionReport> {
  if (!db) throw new Error("db not initialised");
  // Check whether the recent quiz-question slice has any seeded rows
  // — independent of any specific student/tutor. Same source as the
  // smoke test, but framed as "do dashboards have anything to show".
  const [recent] = await db
    .select({
      total: sql<number>`count(*)::int`,
      seeded: sql<number>`sum(case when target_misconception_ids is not null and jsonb_array_length(target_misconception_ids) > 0 then 1 else 0 end)::int`,
    })
    .from(sql`(select target_misconception_ids from soma_questions order by id desc limit 1000) as recent_questions`);
  const totalApproved = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(examinerMisconceptions)
    .where(eq(examinerMisconceptions.status, "approved"));

  const recentTotal = recent.total ?? 0;
  const recentSeeded = recent.seeded ?? 0;
  const approved = totalApproved[0]?.count ?? 0;
  const warnings: string[] = [];
  if (approved === 0) warnings.push("no approved misconceptions exist anywhere — attribution layer cannot work");
  if (recentSeeded === 0 && recentTotal > 0) warnings.push("most recent 1000 quiz questions have ZERO seeds — attribution layer dead in production despite approved data existing");
  const pct = recentTotal === 0 ? 0 : Math.round((recentSeeded / recentTotal) * 100);
  const verdict: Verdict =
    recentSeeded === 0 ? "empty"
    : pct >= 50 ? "healthy"
    : "sparse";
  return {
    section: "MISCONCEPTION ATTRIBUTION (global)",
    verdict,
    headline: `approvedSeedsAvailable=${fmt(approved)} recent1000Questions=${fmt(recentTotal)} seededRecent=${fmt(recentSeeded)} (${pct}%)`,
    details: [],
    warnings,
  };
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv);
  await connectDb();
  initStorage();

  const student = await pickStudent(opts.studentId);
  const tutor = await pickTutor(opts.tutorId);

  if (!student) console.warn("warning: no student found in DB — student-side audits will be skipped.");
  if (!tutor) console.warn("warning: no tutor found in DB — tutor-side audits will be skipped.");

  const sections: SectionReport[] = [];
  sections.push(await auditAttributionHealth());
  if (student) {
    sections.push(await auditStudentDashboard(student.id));
    sections.push(await auditMasteryMap(student.id));
  }
  sections.push(await auditStudyTips({ subject: opts.subject, syllabusCode: opts.syllabusCode }));
  if (tutor) {
    sections.push(await auditTutorCohortHeatmap(tutor.id));
  }

  const overall: Verdict = sections.some((s) => s.verdict === "error")
    ? "error"
    : sections.every((s) => s.verdict === "healthy")
      ? "healthy"
      : sections.some((s) => s.verdict === "empty")
        ? "empty"
        : "sparse";

  if (opts.json) {
    console.log(JSON.stringify({ overall, student, tutor, sections }, null, 2));
    return;
  }

  const mark: Record<Verdict, string> = {
    healthy: "[HEALTHY]",
    sparse: "[ SPARSE]",
    empty: "[  EMPTY]",
    error: "[  ERROR]",
  };

  console.log("");
  console.log(`Dashboard audit — student=${student?.id ?? "(none)"}  tutor=${tutor?.id ?? "(none)"}`);
  console.log("");
  for (const s of sections) {
    console.log(`${mark[s.verdict]}  ${s.section}`);
    console.log(`           ${s.headline}`);
    for (const d of s.details) console.log(`           ${d}`);
    for (const w of s.warnings) console.log(`           ⚠ ${w}`);
    console.log("");
  }
  console.log(`OVERALL: ${mark[overall]}`);
  console.log("");
  console.log("Verdict legend:");
  console.log("  HEALTHY = tile is populated, attribution layer visible");
  console.log("  SPARSE  = tile has some data but not enough — usually \"no submissions yet\" or \"FK linkage incomplete\"");
  console.log("  EMPTY   = nothing for this dashboard tile to show — broken pipe or no upstream data");
  console.log("  ERROR   = the underlying service threw — read the headline for the message");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    process.exit(1);
  });

// Suppress "imported but unused" warnings for utilities pulled in for
// the type-only side of the imports.
void desc;
void isNotNull;
