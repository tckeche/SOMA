/**
 * Tiered automated triage for pending examiner-misconceptions.
 *
 * Sweeps `examiner_misconceptions WHERE status = 'pending'` and decides
 * each row's fate from multiple signal columns at once:
 *
 *   APPROVE  when  confidence >= --min-approve-confidence (default 70)
 *                  AND subtopic_id IS NOT NULL
 *                  AND source_quote IS NOT NULL
 *                  AND frequency IN {very_common, common}
 *
 *   REJECT   when  confidence < --min-reject-confidence (default 40)
 *                  OR  source_quote IS NULL  (hallucination indicator —
 *                                             every legacy bad row had it)
 *
 *   PENDING  otherwise — falls through to the existing human review queue
 *                        at /api/tutor/examiner-misconceptions, untouched.
 *
 * Sits ALONGSIDE the existing reviewer-driven approveInsight /
 * rejectInsight / bulkActionInsights / bulkApproveHighConfidence (which
 * still work for hand-picked rows) and the downstream Maker prompt
 * (`listApprovedSeeds`, which still reads only status='approved'). The
 * only effect on the distractor pipeline is that more qualifying rows
 * become visible to it — no Maker code changes.
 *
 * Each row updated is stamped with reviewedAt + reviewNotes describing
 * which rule fired ("auto-approved: confidence>=70, linked subtopic, has
 * source_quote, frequency in {very_common|common}" or
 * "auto-rejected: missing source_quote"). reviewedById defaults to NULL
 * so audit trails clearly distinguish automated decisions from human
 * reviews; pass --reviewer-id=<uuid> to attribute to a specific user.
 *
 * Usage:
 *   npx tsx scripts/triagePendingMisconceptions.ts --dry-run
 *   npx tsx scripts/triagePendingMisconceptions.ts --syllabus-code=0580
 *   npx tsx scripts/triagePendingMisconceptions.ts --min-approve-confidence=80 --apply
 *
 * Flags:
 *   --apply                              Write decisions. Without this flag the script runs in
 *                                        dry-run mode (counts only, no DB writes) — fail-safe default.
 *   --dry-run                            Explicit dry-run (same as omitting --apply).
 *   --board=<board>                      Restrict to one exam board.
 *   --syllabus-code=<code>               Restrict to one syllabus code.
 *   --document-id=<n>                    Restrict to one source document id.
 *   --reviewer-id=<uuid>                 Stamp this UUID as the reviewer (default: null = "automated").
 *   --min-approve-confidence=<0..100>    Threshold for approve (default 70).
 *   --min-reject-confidence=<0..100>     Threshold for reject (default 40).
 *   --approve-frequencies=a,b,c          CSV of frequencies eligible for approve (default "very_common,common").
 *   --no-require-subtopic-id             Don't require subtopic FK linkage to approve (NOT recommended).
 *   --no-require-source-quote            Don't require source_quote to approve, and don't auto-reject for missing quote.
 *   --limit=<n>                          Cap rows scanned per run (default 10000).
 *   --json                               Emit machine-readable JSON summary instead of human text.
 *
 * Environment:
 *   DATABASE_URL / SUPABASE_DB_URL  — Postgres connection (required)
 */
import "dotenv/config";
import { connectDb } from "../server/db";
import {
  triagePendingMisconceptions,
  type TriageOptions,
} from "../server/services/examinerInsightsReview";

interface CliOptions extends TriageOptions {
  json: boolean;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    dryRun: true, // fail-safe: write only when --apply is passed
    json: false,
  };
  let applySeen = false;
  let dryRunSeen = false;

  for (const raw of argv.slice(2)) {
    if (raw === "--help" || raw === "-h") {
      printHelp();
      process.exit(0);
    } else if (raw === "--apply") {
      applySeen = true;
    } else if (raw === "--dry-run") {
      dryRunSeen = true;
    } else if (raw === "--json") {
      opts.json = true;
    } else if (raw === "--no-require-subtopic-id") {
      opts.requireSubtopicId = false;
    } else if (raw === "--no-require-source-quote") {
      opts.requireSourceQuote = false;
    } else if (raw.startsWith("--board=")) {
      opts.board = raw.slice("--board=".length);
    } else if (raw.startsWith("--syllabus-code=")) {
      opts.syllabusCode = raw.slice("--syllabus-code=".length);
    } else if (raw.startsWith("--document-id=")) {
      const n = Number(raw.slice("--document-id=".length));
      if (!Number.isFinite(n) || n <= 0) throw new Error(`bad ${raw}`);
      opts.documentId = Math.floor(n);
    } else if (raw.startsWith("--reviewer-id=")) {
      const v = raw.slice("--reviewer-id=".length);
      if (!UUID_RE.test(v)) throw new Error(`bad --reviewer-id (expected UUID): ${v}`);
      opts.reviewerId = v;
    } else if (raw.startsWith("--min-approve-confidence=")) {
      const n = Number(raw.slice("--min-approve-confidence=".length));
      if (!Number.isFinite(n) || n < 0 || n > 100) throw new Error(`bad ${raw} (0..100)`);
      opts.minApproveConfidence = Math.floor(n);
    } else if (raw.startsWith("--min-reject-confidence=")) {
      const n = Number(raw.slice("--min-reject-confidence=".length));
      if (!Number.isFinite(n) || n < 0 || n > 100) throw new Error(`bad ${raw} (0..100)`);
      opts.minRejectConfidence = Math.floor(n);
    } else if (raw.startsWith("--approve-frequencies=")) {
      const csv = raw.slice("--approve-frequencies=".length);
      const parts = csv.split(",").map((s) => s.trim()).filter(Boolean);
      if (parts.length === 0) throw new Error(`bad ${raw} (need at least one)`);
      opts.approveFrequencies = parts;
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
  // Cross-check the two confidence thresholds make sense.
  const approveAt = opts.minApproveConfidence ?? 70;
  const rejectAt = opts.minRejectConfidence ?? 40;
  if (rejectAt >= approveAt) {
    throw new Error(
      `--min-reject-confidence (${rejectAt}) must be < --min-approve-confidence (${approveAt})`,
    );
  }
  return opts;
}

function printHelp(): void {
  // The header docstring above is the authoritative reference; this
  // duplicates the synopsis line so --help is useful at the terminal.
  console.log(
    [
      "triagePendingMisconceptions — tiered automated triage of pending AI-extracted misconceptions",
      "",
      "  npx tsx scripts/triagePendingMisconceptions.ts --dry-run",
      "  npx tsx scripts/triagePendingMisconceptions.ts --apply --syllabus-code=0580",
      "  npx tsx scripts/triagePendingMisconceptions.ts --apply --min-approve-confidence=80",
      "",
      "Default mode is dry-run. Pass --apply to actually write.",
      "See the file's header comment for the full flag list.",
    ].join("\n"),
  );
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv);

  await connectDb();

  const result = await triagePendingMisconceptions(opts);

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          mode: opts.dryRun ? "dry-run" : "apply",
          ...result,
        },
        null,
        2,
      ),
    );
    return;
  }

  const fmt = (n: number) => new Intl.NumberFormat("en-GB").format(n);
  const lines: string[] = [];
  lines.push("");
  lines.push(`mode:                 ${opts.dryRun ? "DRY-RUN (no writes)" : "APPLY"}`);
  if (opts.board) lines.push(`board:                ${opts.board}`);
  if (opts.syllabusCode) lines.push(`syllabus code:        ${opts.syllabusCode}`);
  if (opts.documentId) lines.push(`document id:          ${opts.documentId}`);
  lines.push(`min approve conf:     ${result.thresholds.minApproveConfidence}`);
  lines.push(`min reject conf:      ${result.thresholds.minRejectConfidence}`);
  lines.push(`require subtopic FK:  ${result.thresholds.requireSubtopicId}`);
  lines.push(`require source quote: ${result.thresholds.requireSourceQuote}`);
  lines.push(`approve frequencies:  ${result.thresholds.approveFrequencies.join(", ")}`);
  lines.push("");
  lines.push(`scanned:              ${fmt(result.scanned)}`);
  lines.push(`auto-approved:        ${fmt(result.approved)}`);
  lines.push(`auto-rejected:        ${fmt(result.rejected)}`);
  lines.push(`left pending:         ${fmt(result.leftPending)}  (need human review)`);
  lines.push("");
  if (opts.dryRun && (result.approved + result.rejected) > 0) {
    lines.push("re-run with --apply to write these decisions.");
  }
  console.log(lines.join("\n"));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    process.exit(1);
  });
