/**
 * LLM-judge fallback for the learning_requirement_id backfill.
 *
 * Run AFTER the lexical backfill (`scripts/backfillLearningRequirementLinks.ts`)
 * has picked off the easy wins. This script targets the same column
 * (learning_requirement_id IS NULL on rows with subtopic_id NOT NULL)
 * but uses gpt-4o-mini (via the existing AI orchestrator's fallback
 * chain) to make the judgement call instead of pure word overlap.
 *
 * The judge gets the misconception's belief + typical wrong working +
 * correct approach plus the numbered list of candidate requirement
 * statements under the row's subtopic, and is constrained to either
 * pick exactly one id from that list or report "none" with a
 * confidence rating. Only "medium" or "high" confidence results are
 * committed by default.
 *
 * Cost: rough order ~$0.0005 per call with gpt-4o-mini, so 1,633 rows
 * ≈ $0.80–1.50 depending on prompt length and provider routing. The
 * orchestrator's idempotency cache means re-runs are free for any row
 * that's already been judged.
 *
 * Defaults to dry-run. The script ALWAYS prints a small sample of the
 * judge's match decisions before applying so you can spot-check
 * before committing the wider batch.
 *
 * Usage:
 *   npx tsx scripts/llmBackfillLearningRequirementLinks.ts --dry-run --limit=10
 *   npx tsx scripts/llmBackfillLearningRequirementLinks.ts --apply
 *   npx tsx scripts/llmBackfillLearningRequirementLinks.ts --apply --limit=200
 *
 * Flags:
 *   --apply                       Write the matches. Without this flag, dry-run.
 *   --dry-run                     Explicit dry-run (default).
 *   --board=<board>               Restrict to one exam board.
 *   --syllabus-code=<code>        Restrict to one syllabus code.
 *   --status=<pending|approved|rejected>  Status filter (default: approved).
 *   --limit=<n>                   Cap candidate rows scanned. Default 10000.
 *                                 USE A SMALL VALUE (e.g. --limit=20) FOR THE FIRST PAID RUN.
 *   --concurrency=<1..20>         Parallel LLM calls. Default 5.
 *   --min-confidence=<low|medium|high>   Min judge confidence to commit. Default medium.
 *   --json                        Machine-readable JSON output.
 */
import "dotenv/config";
import { connectDb } from "../server/db";
import {
  llmBackfillLearningRequirementLinks,
  type JudgeBackfillOptions,
} from "../server/services/learningRequirementResolver";

interface CliOptions extends JudgeBackfillOptions {
  json: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = { dryRun: true, json: false };
  let applySeen = false;
  let dryRunSeen = false;

  for (const raw of argv.slice(2)) {
    if (raw === "--help" || raw === "-h") {
      console.log(
        "Usage: npx tsx scripts/llmBackfillLearningRequirementLinks.ts [--apply] [--limit=N] [--concurrency=5] ...",
      );
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
    } else if (raw.startsWith("--limit=")) {
      const n = Number(raw.slice("--limit=".length));
      if (!Number.isFinite(n) || n <= 0) throw new Error(`bad ${raw}`);
      opts.limit = Math.floor(n);
    } else if (raw.startsWith("--concurrency=")) {
      const n = Number(raw.slice("--concurrency=".length));
      if (!Number.isFinite(n) || n <= 0 || n > 20) throw new Error(`bad ${raw} (1..20)`);
      opts.concurrency = Math.floor(n);
    } else if (raw.startsWith("--min-confidence=")) {
      const v = raw.slice("--min-confidence=".length);
      if (v !== "low" && v !== "medium" && v !== "high") {
        throw new Error(`bad --min-confidence=${v} (low|medium|high)`);
      }
      opts.minConfidence = v;
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

  // Live progress so the operator can tell the LLM is making progress
  // on long batches. Skipped in --json mode to keep output clean.
  let lastReport = Date.now();
  if (!opts.json) {
    opts.onProgress = (done, total) => {
      const now = Date.now();
      if (now - lastReport > 2_000 || done === total) {
        process.stderr.write(`  judged ${done}/${total} ...\r`);
        lastReport = now;
      }
    };
  }

  const result = await llmBackfillLearningRequirementLinks(opts);

  if (!opts.json) process.stderr.write("\n");

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
  console.log(`min confidence:       ${opts.minConfidence ?? "medium"}`);
  console.log(`concurrency:          ${opts.concurrency ?? 5}`);
  console.log("");
  console.log(`scanned:                  ${fmt(result.scanned)}`);
  console.log(`matched (FK assigned):    ${fmt(result.matched)}`);
  console.log(`skipped judge=none:       ${fmt(result.skippedJudgeNone)}`);
  console.log(`skipped low confidence:   ${fmt(result.skippedJudgeLowConfidence)}`);
  console.log(`skipped invalid judge id: ${fmt(result.skippedJudgeInvalidId)}`);
  console.log(`skipped no candidates:    ${fmt(result.skippedNoCandidates)}`);
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
