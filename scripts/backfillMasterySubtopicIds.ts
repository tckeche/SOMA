/**
 * Backfill `student_topic_mastery.subtopic_id` for legacy mastery
 * rows that predate the catalogue FK migration.
 *
 * The Tier 2 dashboard audit found `student_topic_mastery` has 968
 * rows but only 195 (20%) carry `subtopic_id`. Without that linkage,
 * the mastery map dashboard can't render at the catalogue grain
 * (subtopics whose `subtopic_id` is null show as un-anchored leaves).
 *
 * For each mastery row with `subtopic_id IS NULL`, look up the
 * canonical subtopic id by feeding (subject, topic, subtopic) text
 * into the same `resolveSubtopicId` service the AI extractors use at
 * insert time. Rows that resolve cleanly get the FK written; rows
 * that resolve ambiguously or not at all are left null and
 * counted under "skipped".
 *
 * The Maker pipeline does NOT depend on this backfill — it queries by
 * (board, syllabusCode) and works fine without subtopic_id on the
 * mastery rows. What this enables is the deeper coaching layer: the
 * mastery map's per-subtopic detail, the cohort heatmap's catalogue
 * grouping, and any future feature that joins
 * `student_topic_mastery` against the catalogue tree.
 *
 * Defaults to dry-run. Pass --apply to write.
 *
 * Usage:
 *   npx tsx scripts/backfillMasterySubtopicIds.ts --dry-run
 *   npx tsx scripts/backfillMasterySubtopicIds.ts --apply
 *   npx tsx scripts/backfillMasterySubtopicIds.ts --apply --student-id=<uuid>
 *   npx tsx scripts/backfillMasterySubtopicIds.ts --apply --syllabus-code=0580 --board=Cambridge
 *
 * Read-only when --dry-run; otherwise updates `subtopic_id` only on
 * rows where it is currently NULL.
 */
import "dotenv/config";
import { and, eq, isNull, inArray } from "drizzle-orm";
import { connectDb, db } from "../server/db";
import { studentTopicMastery } from "../shared/schema";
import { resolveSubtopicId } from "../server/services/subtopicResolver";

interface CliOptions {
  studentId: string | null;
  syllabusCode: string | null;
  board: string | null;
  limit: number;
  dryRun: boolean;
  json: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    studentId: null,
    syllabusCode: null,
    board: null,
    limit: 10_000,
    dryRun: true,
    json: false,
  };
  let applySeen = false;
  let dryRunSeen = false;
  for (const raw of argv.slice(2)) {
    if (raw === "--apply") applySeen = true;
    else if (raw === "--dry-run") dryRunSeen = true;
    else if (raw === "--json") opts.json = true;
    else if (raw === "--help" || raw === "-h") {
      console.log("Usage: npx tsx scripts/backfillMasterySubtopicIds.ts [--apply] [--student-id=UUID] [--syllabus-code=0580] [--board=Cambridge] [--limit=10000]");
      process.exit(0);
    } else if (raw.startsWith("--student-id=")) opts.studentId = raw.slice("--student-id=".length);
    else if (raw.startsWith("--syllabus-code=")) opts.syllabusCode = raw.slice("--syllabus-code=".length);
    else if (raw.startsWith("--board=")) opts.board = raw.slice("--board=".length);
    else if (raw.startsWith("--limit=")) {
      const n = Number(raw.slice("--limit=".length));
      if (!Number.isFinite(n) || n <= 0) throw new Error(`bad ${raw}`);
      opts.limit = Math.floor(n);
    } else throw new Error(`unknown flag: ${raw}`);
  }
  if (applySeen && dryRunSeen) throw new Error("--apply and --dry-run are mutually exclusive");
  if (applySeen) opts.dryRun = false;
  return opts;
}

const fmt = (n: number) => new Intl.NumberFormat("en-GB").format(n);

async function main(): Promise<void> {
  const opts = parseArgs(process.argv);
  await connectDb();
  if (!db) throw new Error("db not initialised");

  // Pull every mastery row missing the FK. Optional filters narrow the
  // batch when you want to test on one student or one syllabus first.
  const conditions = [isNull(studentTopicMastery.subtopicId)];
  if (opts.studentId) conditions.push(eq(studentTopicMastery.studentId, opts.studentId));

  const rows = await db
    .select({
      id: studentTopicMastery.id,
      studentId: studentTopicMastery.studentId,
      subject: studentTopicMastery.subject,
      topic: studentTopicMastery.topic,
      subtopic: studentTopicMastery.subtopic,
    })
    .from(studentTopicMastery)
    .where(and(...conditions))
    .limit(opts.limit);

  if (rows.length === 0) {
    console.log("");
    console.log("No mastery rows match the scope. Nothing to do.");
    process.exit(0);
  }

  // Bucket per resolved subtopic id so we can do one UPDATE per id
  // rather than N round-trips.
  const buckets = new Map<number, number[]>();
  let resolved = 0;
  let ambiguous = 0;
  let unresolvable = 0;

  for (const row of rows) {
    const result = await resolveSubtopicId({
      subject: row.subject,
      topic: row.topic,
      subtopic: row.subtopic,
      syllabusCode: opts.syllabusCode,
    });
    if (result.subtopicId !== null) {
      resolved += 1;
      const list = buckets.get(result.subtopicId) ?? [];
      list.push(row.id);
      buckets.set(result.subtopicId, list);
    } else if (result.ambiguous) {
      ambiguous += 1;
    } else {
      unresolvable += 1;
    }
  }

  const matchedRowIds = Array.from(buckets.values()).flat();
  const summary = {
    mode: opts.dryRun ? "dry-run" : "apply",
    scanned: rows.length,
    resolved,
    ambiguous,
    unresolvable,
    distinctSubtopicsHit: buckets.size,
    sampleMatches: Array.from(buckets.entries()).slice(0, 5).map(([subtopicId, ids]) => ({
      subtopicId,
      masteryRowCount: ids.length,
    })),
  };

  if (!opts.dryRun) {
    const bucketEntries = Array.from(buckets.entries());
    for (const [subtopicId, ids] of bucketEntries) {
      if (ids.length === 0) continue;
      await db
        .update(studentTopicMastery)
        .set({ subtopicId })
        .where(inArray(studentTopicMastery.id, ids));
    }
  }

  if (opts.json) {
    console.log(JSON.stringify({ ...summary, matchedRowCount: matchedRowIds.length }, null, 2));
    return;
  }

  console.log("");
  console.log(`mode:                  ${summary.mode === "apply" ? "APPLY" : "DRY-RUN (no writes)"}`);
  if (opts.studentId) console.log(`student id:            ${opts.studentId}`);
  if (opts.syllabusCode) console.log(`syllabus code scope:   ${opts.syllabusCode}`);
  if (opts.board) console.log(`board scope:           ${opts.board}`);
  console.log("");
  console.log(`scanned:               ${fmt(rows.length)}`);
  console.log(`resolved (FK assigned):${fmt(resolved).padStart(7)}`);
  console.log(`ambiguous:             ${fmt(ambiguous)}  (multiple subtopics matched the text equally — left null)`);
  console.log(`unresolvable:          ${fmt(unresolvable)}  (no catalogue match found at all)`);
  console.log(`distinct subtopics hit:${fmt(buckets.size).padStart(7)}`);
  console.log("");
  if (opts.dryRun && resolved > 0) {
    console.log("re-run with --apply to write these matches.");
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    process.exit(1);
  });
