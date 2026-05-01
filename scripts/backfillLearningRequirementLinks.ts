/**
 * Backfill `learning_requirement_id` on `examiner_misconceptions` rows
 * that already have `subtopic_id` populated.
 *
 * The closed-set extractor (Task #26) only constrained the LLM to pick
 * a topic from the syllabus catalogue — it never asked it to pick a
 * specific learning requirement under that topic. This script closes
 * that gap after the fact: for each row with subtopic_id NOT NULL but
 * learning_requirement_id NULL, look up the requirements under that
 * subtopic and assign the best lexical match (Jaccard token overlap).
 *
 * The Maker's distractor pipeline (`listApprovedSeeds`) is unchanged —
 * it queries by `subtopic_id` and never needed `learning_requirement_id`.
 * What this enables is the deeper layer: per-requirement mastery
 * rollups, command-word coaching, and the Cambridge syllabus mastery
 * map can now attribute student errors back to specific learning
 * objectives rather than only to broader subtopics.
 *
 * Defaults to dry-run — pass --apply to write.
 *
 * Usage:
 *   npx tsx scripts/backfillLearningRequirementLinks.ts --dry-run
 *   npx tsx scripts/backfillLearningRequirementLinks.ts --apply
 *   npx tsx scripts/backfillLearningRequirementLinks.ts --apply --syllabus-code=0580
 *
 * Flags:
 *   --apply                       Write the matches. Without this flag, dry-run.
 *   --dry-run                     Explicit dry-run (default).
 *   --board=<board>               Restrict to one exam board.
 *   --syllabus-code=<code>        Restrict to one syllabus code.
 *   --status=<pending|approved|rejected>  Status filter (default: approved).
 *   --min-score=<0..1>            Min Jaccard score to commit a match. Default 0.10.
 *   --min-score-gap=<0..1>        Min lead over runner-up. Default 0.03.
 *   --limit=<n>                   Cap candidate rows scanned. Default 10000.
 *   --json                        Machine-readable JSON output.
 */
import "dotenv/config";
import { connectDb } from "../server/db";
import {
  backfillLearningRequirementLinks,
  type BackfillOptions,
} from "../server/services/learningRequirementResolver";

interface CliOptions extends BackfillOptions {
  json: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = { dryRun: true, json: false };
  let applySeen = false;
  let dryRunSeen = false;

  for (const raw of argv.slice(2)) {
    if (raw === "--help" || raw === "-h") {
      console.log("Usage: npx tsx scripts/backfillLearningRequirementLinks.ts [--apply] [--syllabus-code=X] [--min-score=0.1] ...");
      process.exit(0);
    } else if (raw === "--apply") {
      applySeen = true;
    } else if (raw === "--dry-run") {
      dryRunSeen = true;
    } else if (raw === "--json") {
      opts.json = true;
    } else if (raw.startsWith("--board=")) {
      opts.board = raw.slice("--board=".length);
    } else if (raw.startsWith("--syllabus-code=")) {
      opts.syllabusCode = raw.slice("--syllabus-code=".length);
    } else if (raw.startsWith("--status=")) {
      const v = raw.slice("--status=".length);
      if (v !== "pending" && v !== "approved" && v !== "rejected") {
        throw new Error(`bad --status=${v} (pending|approved|rejected)`);
      }
      opts.status = v;
    } else if (raw.startsWith("--min-score=")) {
      const n = Number(raw.slice("--min-score=".length));
      if (!Number.isFinite(n) || n < 0 || n > 1) throw new Error(`bad ${raw} (0..1)`);
      opts.minScore = n;
    } else if (raw.startsWith("--min-score-gap=")) {
      const n = Number(raw.slice("--min-score-gap=".length));
      if (!Number.isFinite(n) || n < 0 || n > 1) throw new Error(`bad ${raw} (0..1)`);
      opts.minScoreGap = n;
    } else if (raw.startsWith("--limit=")) {
      const n = Number(raw.slice("--limit=".length));
      if (!Number.isFinite(n) || n <= 0) throw new Error(`bad ${raw}`);
      opts.limit = Math.floor(n);
    } else {
      throw new Error(`unknown flag: ${raw}`);
    }
  }

  if (applySeen && dryRunSeen) {
    throw new Error("--apply and --dry-run are mutually exclusive");
  }
  if (applySeen) opts.dryRun = false;
  return opts;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv);
  await connectDb();

  const result = await backfillLearningRequirementLinks(opts);

  if (opts.json) {
    console.log(JSON.stringify({ mode: opts.dryRun ? "dry-run" : "apply", ...result }, null, 2));
    return;
  }

  const fmt = (n: number) => new Intl.NumberFormat("en-GB").format(n);
  console.log("");
  console.log(`mode:                 ${opts.dryRun ? "DRY-RUN (no writes)" : "APPLY"}`);
  if (opts.board) console.log(`board:                ${opts.board}`);
  if (opts.syllabusCode) console.log(`syllabus code:        ${opts.syllabusCode}`);
  console.log(`status filter:        ${opts.status ?? "approved"}`);
  console.log(`min score:            ${result.thresholds.minScore}`);
  console.log(`min score gap:        ${result.thresholds.minScoreGap}`);
  console.log("");
  console.log(`scanned:              ${fmt(result.scanned)}`);
  console.log(`matched (FK assigned):${fmt(result.matched).padStart(7)}`);
  console.log(`skipped low score:    ${fmt(result.skippedLowScore)}`);
  console.log(`skipped ambiguous tie:${fmt(result.skippedAmbiguous).padStart(7)}`);
  console.log(`skipped no candidates:${fmt(result.skippedNoCandidates).padStart(7)}`);
  console.log("");
  if (opts.dryRun && result.matched > 0) {
    console.log("re-run with --apply to write these matches.");
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    process.exit(1);
  });
