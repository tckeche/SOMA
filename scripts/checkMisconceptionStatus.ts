/**
 * Read-only diagnostic — prints the current split of
 * examiner_misconceptions by status, with a breakdown of how many of
 * those decisions were automated by triagePendingMisconceptions.
 *
 * Uses the same connectDb() path the triage script uses, so it always
 * sees the same database — avoids shell vs Node env-var mismatches.
 *
 * Usage:
 *   npx tsx scripts/checkMisconceptionStatus.ts
 *   npx tsx scripts/checkMisconceptionStatus.ts --syllabus-code=0580
 *   npx tsx scripts/checkMisconceptionStatus.ts --json
 */
import "dotenv/config";
import { and, eq, isNull, like, sql } from "drizzle-orm";
import { connectDb, db } from "../server/db";
import { examinerMisconceptions } from "../shared/schema";

interface CliOptions {
  board: string | null;
  syllabusCode: string | null;
  json: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = { board: null, syllabusCode: null, json: false };
  for (const raw of argv.slice(2)) {
    if (raw === "--json") opts.json = true;
    else if (raw.startsWith("--board=")) opts.board = raw.slice("--board=".length);
    else if (raw.startsWith("--syllabus-code=")) opts.syllabusCode = raw.slice("--syllabus-code=".length);
    else if (raw === "--help" || raw === "-h") {
      console.log("Usage: npx tsx scripts/checkMisconceptionStatus.ts [--board=X] [--syllabus-code=Y] [--json]");
      process.exit(0);
    } else throw new Error(`unknown flag: ${raw}`);
  }
  return opts;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv);
  await connectDb();
  if (!db) throw new Error("db not initialised after connectDb()");

  const scopeConditions = [];
  if (opts.board) scopeConditions.push(eq(examinerMisconceptions.board, opts.board));
  if (opts.syllabusCode) scopeConditions.push(eq(examinerMisconceptions.syllabusCode, opts.syllabusCode));
  const scopeWhere = scopeConditions.length > 0 ? and(...scopeConditions) : undefined;

  // Total split by status.
  const byStatus = await db
    .select({
      status: examinerMisconceptions.status,
      count: sql<number>`count(*)::int`,
    })
    .from(examinerMisconceptions)
    .where(scopeWhere)
    .groupBy(examinerMisconceptions.status);

  // Subset that came from triagePendingMisconceptions: reviewed_by_id
  // IS NULL AND review_notes LIKE 'auto-%'.
  const autoConditions = [
    isNull(examinerMisconceptions.reviewedById),
    like(examinerMisconceptions.reviewNotes, "auto-%"),
  ];
  if (scopeWhere) autoConditions.push(scopeWhere);
  const byAutoStatus = await db
    .select({
      status: examinerMisconceptions.status,
      count: sql<number>`count(*)::int`,
    })
    .from(examinerMisconceptions)
    .where(and(...autoConditions))
    .groupBy(examinerMisconceptions.status);

  // Recent auto-decision review_notes — handy to eyeball the rules that fired.
  const recentNotes = await db
    .select({
      note: examinerMisconceptions.reviewNotes,
      count: sql<number>`count(*)::int`,
    })
    .from(examinerMisconceptions)
    .where(and(...autoConditions))
    .groupBy(examinerMisconceptions.reviewNotes)
    .orderBy(sql`count(*) desc`)
    .limit(10);

  // Catalogue linkage breakdown: every row carries TWO FKs to the
  // catalogue tree — subtopic_id (broader) and learning_requirement_id
  // (finer-grained). Reports both as "of the rows in this status, how
  // many are linked / orphaned". The Maker's listApprovedSeeds queries
  // by subtopic_id; the learning_requirement_id is used by the mastery
  // rollups + per-requirement coaching UI downstream.
  const linkageRows = await db
    .select({
      status: examinerMisconceptions.status,
      total: sql<number>`count(*)::int`,
      withSubtopic: sql<number>`sum(case when ${examinerMisconceptions.subtopicId} is not null then 1 else 0 end)::int`,
      withLearningReq: sql<number>`sum(case when ${examinerMisconceptions.learningRequirementId} is not null then 1 else 0 end)::int`,
      withBoth: sql<number>`sum(case when ${examinerMisconceptions.subtopicId} is not null and ${examinerMisconceptions.learningRequirementId} is not null then 1 else 0 end)::int`,
    })
    .from(examinerMisconceptions)
    .where(scopeWhere)
    .groupBy(examinerMisconceptions.status);

  const total = byStatus.reduce((sum, r) => sum + r.count, 0);
  const totalAuto = byAutoStatus.reduce((sum, r) => sum + r.count, 0);

  if (opts.json) {
    console.log(JSON.stringify({ scope: { board: opts.board, syllabusCode: opts.syllabusCode }, total, byStatus, totalAuto, byAutoStatus, recentNotes, linkage: linkageRows }, null, 2));
    return;
  }

  const fmt = (n: number) => new Intl.NumberFormat("en-GB").format(n);
  console.log("");
  if (opts.board || opts.syllabusCode) {
    console.log(`scope: board=${opts.board ?? "*"}, syllabus=${opts.syllabusCode ?? "*"}`);
  }
  console.log(`total rows:        ${fmt(total)}`);
  console.log("");
  console.log("by status:");
  for (const r of byStatus) console.log(`  ${r.status.padEnd(10)} ${fmt(r.count)}`);
  console.log("");
  console.log(`auto-decided (reviewed_by_id IS NULL AND review_notes LIKE 'auto-%'): ${fmt(totalAuto)}`);
  for (const r of byAutoStatus) console.log(`  ${r.status.padEnd(10)} ${fmt(r.count)}`);
  if (recentNotes.length > 0) {
    console.log("");
    console.log("auto-decision rules fired:");
    for (const r of recentNotes) console.log(`  ${fmt(r.count).padStart(6)}  ${r.note ?? "(null)"}`);
  }
  if (linkageRows.length > 0) {
    console.log("");
    console.log("catalogue linkage (of N rows in each status, how many are FK-linked):");
    console.log(`  ${"status".padEnd(10)} ${"total".padStart(7)} ${"subtopic".padStart(10)} ${"learn-req".padStart(10)} ${"both".padStart(7)}`);
    for (const r of linkageRows) {
      const pct = (n: number) => r.total === 0 ? "" : ` (${Math.round((n / r.total) * 100)}%)`;
      console.log(
        `  ${r.status.padEnd(10)} ${fmt(r.total).padStart(7)} ${(`${fmt(r.withSubtopic)}${pct(r.withSubtopic)}`).padStart(14)} ${(`${fmt(r.withLearningReq)}${pct(r.withLearningReq)}`).padStart(14)} ${(`${fmt(r.withBoth)}${pct(r.withBoth)}`).padStart(11)}`,
      );
    }
  }
  console.log("");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    process.exit(1);
  });
