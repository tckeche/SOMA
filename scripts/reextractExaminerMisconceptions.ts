/**
 * Phase 16 — Re-extract examiner misconceptions with the closed-set
 * catalogue constraint.
 *
 * The legacy 3,485 rows in `examiner_misconceptions` were produced before
 * Phase 2's source-quote guard *and* before Task #26's catalogue closed-set
 * constraint. Forensics: every legacy row has `source_quote IS NULL` and
 * the topics were drawn from a fabricated maths-flavoured taxonomy
 * regardless of subject (e.g. Accounting paper 9706 tagged "Algebra").
 *
 * This script wipes the legacy rows for a chosen scope and re-runs
 * `extractAndStoreMisconceptions` with `useStrictCatalogueConstraint: true`
 * so the LLM is forced to pick from the syllabus's actual catalogue
 * topics. Defaults to gpt-4o-mini (~16× cheaper than gpt-4o, and the task
 * is now pure classification against a closed set).
 *
 * Usage:
 *   npx tsx scripts/reextractExaminerMisconceptions.ts --syllabus-code=9706
 *   npx tsx scripts/reextractExaminerMisconceptions.ts --syllabus-code=9706 --limit=1
 *   npx tsx scripts/reextractExaminerMisconceptions.ts --syllabus-code=9706 --dry-run
 *   npx tsx scripts/reextractExaminerMisconceptions.ts --board=Cambridge
 *
 * Flags:
 *   --board=Cambridge        (default; matches `syllabus_documents.board` case-insensitively)
 *   --syllabus-code=XXXX     (optional; restrict to one syllabus code)
 *   --limit=N                (cap the number of documents processed; useful for pilots)
 *   --model=mini|default     (default = mini → gpt-4o-mini; default → orchestrator chain starting at gpt-4o)
 *   --dry-run                (count + plan only; no DELETE, no extraction, no API spend)
 *   --keep-existing          (skip the DELETE step; merges new rows alongside legacy ones — use only if you know what you're doing)
 *
 * Environment:
 *   DATABASE_URL / SUPABASE_DB_URL  — Postgres connection (required)
 *   OPENAI_API_KEY                  — required unless --dry-run
 */
import "dotenv/config";
import { and, eq, ilike, inArray, isNotNull, sql } from "drizzle-orm";
import { connectDb, db as sharedDb } from "../server/db";
import {
  examinerMisconceptions,
  syllabusDocuments,
  type SyllabusDocument,
} from "../shared/schema";
import {
  extractAndStoreMisconceptions,
  type ExtractInputDoc,
  type ExtractResult,
} from "../server/services/extractAndStoreMisconceptions";

interface CliOptions {
  board: string;
  syllabusCode: string | null;
  limit: number | null;
  model: "mini" | "default";
  dryRun: boolean;
  keepExisting: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    board: "Cambridge",
    syllabusCode: null,
    limit: null,
    model: "mini",
    dryRun: false,
    keepExisting: false,
  };
  for (const raw of argv.slice(2)) {
    if (raw === "--dry-run") opts.dryRun = true;
    else if (raw === "--keep-existing") opts.keepExisting = true;
    else if (raw.startsWith("--board=")) opts.board = raw.slice("--board=".length);
    else if (raw.startsWith("--syllabus-code=")) opts.syllabusCode = raw.slice("--syllabus-code=".length);
    else if (raw.startsWith("--limit=")) {
      const n = Number(raw.slice("--limit=".length));
      if (!Number.isFinite(n) || n <= 0) throw new Error(`bad --limit=${raw}`);
      opts.limit = Math.floor(n);
    } else if (raw.startsWith("--model=")) {
      const v = raw.slice("--model=".length);
      if (v !== "mini" && v !== "default") throw new Error(`bad --model=${v} (mini|default)`);
      opts.model = v;
    } else {
      throw new Error(`unknown flag: ${raw}`);
    }
  }
  return opts;
}

function formatNumber(n: number): string {
  return new Intl.NumberFormat("en-GB").format(n);
}

async function listTargetDocuments(opts: CliOptions): Promise<SyllabusDocument[]> {
  if (!sharedDb) throw new Error("db not initialised");
  const conditions = [
    eq(syllabusDocuments.documentType, "examiner_report"),
    isNotNull(syllabusDocuments.extractedText),
    ilike(syllabusDocuments.board, opts.board),
  ];
  if (opts.syllabusCode) {
    conditions.push(eq(syllabusDocuments.syllabusCode, opts.syllabusCode));
  }
  const rows = await sharedDb
    .select()
    .from(syllabusDocuments)
    .where(and(...conditions))
    .orderBy(syllabusDocuments.syllabusCode, syllabusDocuments.id);
  return opts.limit ? rows.slice(0, opts.limit) : rows;
}

async function countExistingMisconceptions(docIds: number[]): Promise<{ total: number; linked: number }> {
  if (!sharedDb || docIds.length === 0) return { total: 0, linked: 0 };
  const [{ total, linked }] = await sharedDb
    .select({
      total: sql<number>`count(*)::int`,
      linked: sql<number>`sum(case when ${examinerMisconceptions.subtopicId} is not null then 1 else 0 end)::int`,
    })
    .from(examinerMisconceptions)
    .where(inArray(examinerMisconceptions.documentId, docIds));
  return { total: Number(total ?? 0), linked: Number(linked ?? 0) };
}

async function deleteExistingForDocs(docIds: number[]): Promise<number> {
  if (!sharedDb || docIds.length === 0) return 0;
  const deleted = await sharedDb
    .delete(examinerMisconceptions)
    .where(inArray(examinerMisconceptions.documentId, docIds))
    .returning({ id: examinerMisconceptions.id });
  return deleted.length;
}

interface DocOutcome {
  doc: SyllabusDocument;
  result: ExtractResult | null;
  error: string | null;
  durationMs: number;
}

async function processDocument(
  doc: SyllabusDocument,
  opts: CliOptions,
): Promise<DocOutcome> {
  const started = Date.now();
  const input: ExtractInputDoc = {
    id: doc.id,
    board: doc.board,
    syllabusCode: doc.syllabusCode,
    subject: doc.subject ?? null,
    extractedText: doc.extractedText ?? "",
    filename: doc.filename ?? null,
  };
  try {
    const result = await extractAndStoreMisconceptions(input, {
      force: true,
      useStrictCatalogueConstraint: true,
      preferredProvider: opts.model === "mini" ? "openai-mini" : "default",
    });
    return { doc, result, error: null, durationMs: Date.now() - started };
  } catch (err: any) {
    return {
      doc,
      result: null,
      error: err?.message ?? String(err),
      durationMs: Date.now() - started,
    };
  }
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv);

  await connectDb();
  if (!sharedDb) throw new Error("connectDb returned without populating shared db");

  console.log("=== Examiner-misconception re-extraction (Phase 16) ===");
  console.log(`board:           ${opts.board}`);
  console.log(`syllabus-code:   ${opts.syllabusCode ?? "(all)"}`);
  console.log(`limit:           ${opts.limit ?? "(none)"}`);
  console.log(`model:           ${opts.model === "mini" ? "gpt-4o-mini (direct)" : "orchestrator chain (gpt-4o → fallbacks)"}`);
  console.log(`dry-run:         ${opts.dryRun}`);
  console.log(`keep-existing:   ${opts.keepExisting}`);
  console.log("");

  const docs = await listTargetDocuments(opts);
  if (docs.length === 0) {
    console.log("No matching examiner-report documents found. Exiting.");
    return;
  }
  console.log(`Found ${docs.length} matching examiner-report document(s).`);

  const docIds = docs.map((d) => d.id);
  const before = await countExistingMisconceptions(docIds);
  console.log(`Existing rows for those docs: ${formatNumber(before.total)} total, ${formatNumber(before.linked)} linked to a subtopic.`);

  if (opts.dryRun) {
    console.log("\nDry run — no DELETE, no extraction performed.");
    console.log("Sample of first 5 documents that WOULD be re-extracted:");
    for (const d of docs.slice(0, 5)) {
      const chars = (d.extractedText ?? "").length;
      console.log(`  - id=${d.id} syllabus=${d.syllabusCode} subject=${d.subject ?? "(none)"} file=${d.filename ?? "(no filename)"} chars=${formatNumber(chars)}`);
    }
    return;
  }

  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required (set it in Replit Secrets) to run a non-dry extraction.");
  }

  if (!opts.keepExisting) {
    const deleted = await deleteExistingForDocs(docIds);
    console.log(`Deleted ${formatNumber(deleted)} legacy row(s) for those documents.`);
  } else {
    console.log("--keep-existing set: skipping the wipe step. New rows will be inserted alongside legacy ones.");
  }

  const outcomes: DocOutcome[] = [];
  let processed = 0;
  for (const doc of docs) {
    processed += 1;
    process.stdout.write(`[${processed}/${docs.length}] doc=${doc.id} ${doc.syllabusCode} ${doc.filename ?? ""} … `);
    const outcome = await processDocument(doc, opts);
    outcomes.push(outcome);
    if (outcome.error) {
      console.log(`ERROR: ${outcome.error} (${outcome.durationMs}ms)`);
      continue;
    }
    const r = outcome.result!;
    if (r.skipped) {
      console.log(`skipped (${r.reason}) closedSet=${r.closedSetTopicCount ?? "?"} (${outcome.durationMs}ms)`);
      continue;
    }
    console.log(
      `inserted=${r.count} chunks=${r.chunkCount ?? "?"} raw=${r.rawItemCount ?? "?"} taxonomyDrops=${r.taxonomyDrops ?? 0} closedSet=${r.closedSetTopicCount ?? "?"} (${outcome.durationMs}ms)`,
    );
  }

  const after = await countExistingMisconceptions(docIds);
  console.log("");
  console.log("=== Re-extraction complete ===");
  console.log(`Documents processed:       ${outcomes.length}`);
  console.log(`Documents with errors:     ${outcomes.filter((o) => o.error).length}`);
  console.log(`Rows before:               ${formatNumber(before.total)} total, ${formatNumber(before.linked)} linked`);
  console.log(`Rows after:                ${formatNumber(after.total)} total, ${formatNumber(after.linked)} linked`);
  console.log(`Net change:                ${after.total - before.total >= 0 ? "+" : ""}${formatNumber(after.total - before.total)} total, ${after.linked - before.linked >= 0 ? "+" : ""}${formatNumber(after.linked - before.linked)} linked`);
  if (after.total > 0) {
    const linkRate = (after.linked / after.total) * 100;
    console.log(`Link rate (after):         ${linkRate.toFixed(1)}%`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("FATAL:", err);
    process.exit(1);
  });
