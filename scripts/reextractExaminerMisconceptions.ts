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
import { listAllowedTopicsForSyllabusCode } from "../server/services/catalogueInventory";

interface CliOptions {
  board: string;
  syllabusCode: string | null;
  limit: number | null;
  model: "mini" | "default";
  dryRun: boolean;
  keepExisting: boolean;
  reextractAll: boolean;
  docConcurrency: number;
  chunkConcurrency: number;
  requireCatalogue: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    board: "Cambridge",
    syllabusCode: null,
    limit: null,
    model: "mini",
    dryRun: false,
    keepExisting: false,
    reextractAll: false,
    docConcurrency: 3,
    chunkConcurrency: 4,
    requireCatalogue: false,
  };
  for (const raw of argv.slice(2)) {
    if (raw === "--dry-run") opts.dryRun = true;
    else if (raw === "--keep-existing") opts.keepExisting = true;
    else if (raw === "--reextract-all") opts.reextractAll = true;
    else if (raw === "--require-catalogue") opts.requireCatalogue = true;
    else if (raw.startsWith("--board=")) opts.board = raw.slice("--board=".length);
    else if (raw.startsWith("--syllabus-code=")) opts.syllabusCode = raw.slice("--syllabus-code=".length);
    else if (raw.startsWith("--limit=")) {
      const n = Number(raw.slice("--limit=".length));
      if (!Number.isFinite(n) || n <= 0) throw new Error(`bad --limit=${raw}`);
      opts.limit = Math.floor(n);
    } else if (raw.startsWith("--doc-concurrency=")) {
      const n = Number(raw.slice("--doc-concurrency=".length));
      if (!Number.isFinite(n) || n <= 0 || n > 10) throw new Error(`bad --doc-concurrency=${raw} (1..10)`);
      opts.docConcurrency = Math.floor(n);
    } else if (raw.startsWith("--chunk-concurrency=")) {
      const n = Number(raw.slice("--chunk-concurrency=".length));
      if (!Number.isFinite(n) || n <= 0 || n > 10) throw new Error(`bad --chunk-concurrency=${raw} (1..10)`);
      opts.chunkConcurrency = Math.floor(n);
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

/** A doc is "already re-extracted" iff at least one of its rows has source_quote populated. Legacy hallucinations all have source_quote NULL; the new closed-set extractor always populates it from a verbatim chunk substring. */
async function listAlreadyReextractedDocIds(docIds: number[]): Promise<Set<number>> {
  if (!sharedDb || docIds.length === 0) return new Set();
  const rows = await sharedDb
    .selectDistinct({ documentId: examinerMisconceptions.documentId })
    .from(examinerMisconceptions)
    .where(and(
      inArray(examinerMisconceptions.documentId, docIds),
      isNotNull(examinerMisconceptions.sourceQuote),
    ));
  return new Set(rows.map((r) => r.documentId).filter((x): x is number => x != null));
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

  let filtered = rows;
  if (opts.requireCatalogue) {
    const codes = Array.from(new Set(rows.map((r) => r.syllabusCode).filter((c): c is string => !!c)));
    const codesWithCatalogue = new Set<string>();
    for (const code of codes) {
      const inv = await listAllowedTopicsForSyllabusCode(code);
      if (inv.length > 0) codesWithCatalogue.add(code);
    }
    const before = filtered.length;
    filtered = rows.filter((r) => r.syllabusCode && codesWithCatalogue.has(r.syllabusCode));
    const skipped = before - filtered.length;
    const skippedCodes = Array.from(new Set(rows.filter((r) => r.syllabusCode && !codesWithCatalogue.has(r.syllabusCode)).map((r) => r.syllabusCode)));
    if (skipped > 0) {
      console.log(`--require-catalogue: skipping ${skipped} doc(s) across ${skippedCodes.length} catalogue-less syllabus code(s) [${skippedCodes.join(", ")}]`);
    }
  }
  // NB: --limit is applied AFTER the resumable-skip filter in main(), not here.
  // Applying it here would let already-completed docs eat into the budget,
  // which on a bash-loop wrapper means the loop just spins on the first N
  // already-done docs and never advances past them.
  return filtered;
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
      concurrency: opts.chunkConcurrency,
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
  console.log(`reextract-all:   ${opts.reextractAll}`);
  console.log(`doc-concurrency: ${opts.docConcurrency}`);
  console.log("");

  const allDocs = await listTargetDocuments(opts);
  if (allDocs.length === 0) {
    console.log("No matching examiner-report documents found. Exiting.");
    return;
  }
  console.log(`Found ${allDocs.length} matching examiner-report document(s).`);

  // Resumable-skip: a doc whose rows already have source_quote populated has
  // already been re-extracted by the new closed-set pipeline. Skip it unless
  // --reextract-all was passed. Legacy hallucinated rows have NULL source_quote
  // and so will not be skipped.
  let docs = allDocs;
  if (!opts.reextractAll && !opts.keepExisting) {
    const allIds = allDocs.map((d) => d.id);
    const alreadyDone = await listAlreadyReextractedDocIds(allIds);
    if (alreadyDone.size > 0) {
      docs = allDocs.filter((d) => !alreadyDone.has(d.id));
      console.log(`Resumable-skip: ${alreadyDone.size} doc(s) already re-extracted (have source_quote). Pass --reextract-all to force a redo.`);
    }
  }
  if (opts.limit && docs.length > opts.limit) {
    docs = docs.slice(0, opts.limit);
    console.log(`--limit=${opts.limit} applied AFTER resumable-skip.`);
  }
  console.log(`Documents to process this run: ${docs.length}`);

  const docIds = docs.map((d) => d.id);
  const before = await countExistingMisconceptions(docIds);
  console.log(`Existing rows for THESE-RUN docs: ${formatNumber(before.total)} total, ${formatNumber(before.linked)} linked to a subtopic.`);

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

  if (opts.keepExisting) {
    console.log("--keep-existing set: skipping per-doc wipe. New rows will be inserted alongside legacy ones.");
  } else {
    console.log("Per-doc wipe + re-extract: each doc's legacy rows are deleted immediately before its re-extraction, so an interrupted run only loses one doc's rows (the one in flight).");
  }

  const outcomes: DocOutcome[] = [];
  let processed = 0;
  let totalDeleted = 0;
  const queue = [...docs];
  function logOutcome(doc: SyllabusDocument, outcome: DocOutcome, deleted: number) {
    processed += 1;
    const mem = process.memoryUsage();
    const memTag = ` rss=${Math.round(mem.rss / 1024 / 1024)}MB heap=${Math.round(mem.heapUsed / 1024 / 1024)}/${Math.round(mem.heapTotal / 1024 / 1024)}MB`;
    const prefix = `[${processed}/${docs.length}]${memTag} doc=${doc.id} ${doc.syllabusCode} ${doc.filename ?? ""}`;
    const wipedTag = deleted > 0 ? ` (wiped ${deleted})` : "";
    if (outcome.error) {
      console.log(`${prefix}${wipedTag} ERROR: ${outcome.error} (${outcome.durationMs}ms)`);
      return;
    }
    const r = outcome.result!;
    if (r.skipped) {
      console.log(`${prefix}${wipedTag} skipped (${r.reason}) closedSet=${r.closedSetTopicCount ?? "?"} (${outcome.durationMs}ms)`);
      return;
    }
    console.log(`${prefix}${wipedTag} inserted=${r.count} chunks=${r.chunkCount ?? "?"} raw=${r.rawItemCount ?? "?"} taxonomyDrops=${r.taxonomyDrops ?? 0} closedSet=${r.closedSetTopicCount ?? "?"} (${outcome.durationMs}ms)`);
  }
  async function worker() {
    while (queue.length > 0) {
      const doc = queue.shift();
      if (!doc) break;
      let deleted = 0;
      if (!opts.keepExisting) {
        deleted = await deleteExistingForDocs([doc.id]);
        totalDeleted += deleted;
      }
      const outcome = await processDocument(doc, opts);
      outcomes.push(outcome);
      logOutcome(doc, outcome, deleted);
      // If the closed-set extractor produced 0 rows for this doc, insert a
      // sentinel row so the resumable-skip logic on the NEXT iteration
      // treats this doc as done. Without this, a bash loop that re-invokes
      // the script picks the same no-items doc forever and never advances.
      // The sentinel uses status="rejected" so it never reaches dashboards
      // (those filter status="approved"), and source_quote is populated
      // (which is what listAlreadyReextractedDocIds keys off).
      //
      // CRITICAL gate: refuse to insert the sentinel when ANY chunk failed.
      // A doc whose every chunk crashed on a transient LLM/network error
      // would otherwise be marked done forever — and the whole goal of
      // Task #26 is reliable replacement of the 3,485 corrupted rows. So
      // chunkFailures>0 means "skip this doc this run, but leave it
      // re-tryable for the next run". The doc-skipped reasons that are
      // genuinely terminal (`empty-text`, `no-chunks`, `already-extracted`)
      // do still drop a sentinel — those won't change on retry.
      const r = outcome.result;
      const noRowsInserted = !outcome.error && (!r || r.skipped || r.count === 0);
      const hadChunkFailures = (r?.chunkFailures ?? 0) > 0;
      if (noRowsInserted && hadChunkFailures) {
        console.warn(
          `  warn: doc=${doc.id} produced 0 rows BUT had ${r?.chunkFailures} chunk failure(s) — leaving re-tryable (no sentinel)`,
        );
      }
      if (noRowsInserted && !hadChunkFailures && !opts.keepExisting && sharedDb) {
        const reason = r?.skipped ? `skipped:${r.reason ?? "unknown"}` : "zero-items";
        try {
          await sharedDb.insert(examinerMisconceptions).values({
            documentId: doc.id,
            board: doc.board ?? "Cambridge",
            syllabusCode: doc.syllabusCode ?? "unknown",
            subject: doc.subject ?? null,
            topic: "[NO-ITEMS]",
            subtopic: null,
            misconception: `[no extractable misconceptions: ${reason}]`,
            studentError: "[no extractable misconceptions]",
            correctApproach: "[no extractable misconceptions]",
            frequency: "common",
            status: "rejected",
            sourceQuote: `[NO-ITEMS sentinel: ${reason}]`,
            sourcePage: null,
          });
        } catch (e: any) {
          console.warn(`  warn: sentinel insert failed for doc=${doc.id}: ${e?.message ?? e}`);
        }
      }
      // Drop the heavy extracted_text reference and force GC so the
      // openai SDK's response buffers don't accumulate across docs.
      (doc as any).extractedText = null;
      if (typeof (globalThis as any).gc === "function") {
        try { (globalThis as any).gc(); } catch {}
      }
    }
  }
  const workers = Array.from({ length: Math.min(opts.docConcurrency, docs.length) }, () => worker());
  await Promise.all(workers);

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
