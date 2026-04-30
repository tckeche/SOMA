/**
 * Re-parse syllabus_documents using the real `pdf-parse` v2 library.
 *
 * Background: the original ingestion stored raw PDF binary in
 * `extracted_text` because `parsePdfTextFromBuffer` (server/services/aiPipeline.ts)
 * returns the latin1 byte stream when its hand-rolled "extractTextOperators"
 * heuristic fails — which is every PDF in this corpus. As a result, all 325
 * examiner-report rows hold compressed FlateDecode bytes that no LLM can
 * understand, and every misconception extracted from them was a hallucination.
 *
 * This script reads each document's PDF from disk (via `original_path`), runs
 * the v2 `PDFParse` class, validates the result is real text (not binary),
 * and overwrites `extracted_text`.
 *
 * Flags:
 *   --document-type=examiner_report|syllabus|all   default: examiner_report
 *   --syllabus-code=XXXX                            optional filter
 *   --limit=N                                       optional row cap
 *   --concurrency=N                                 default 4
 *   --dry-run                                       no DB writes, just parse + report
 *   --force                                         re-parse even if existing text already looks clean
 */

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { PDFParse } from "pdf-parse";
import * as schema from "../shared/schema";
import { syllabusDocuments } from "../shared/schema";

interface Args {
  documentType: "examiner_report" | "syllabus" | "all";
  syllabusCode: string | null;
  limit: number | null;
  concurrency: number;
  dryRun: boolean;
  force: boolean;
}

function parseArgs(): Args {
  const args: Args = {
    documentType: "examiner_report",
    syllabusCode: null,
    limit: null,
    concurrency: 4,
    dryRun: false,
    force: false,
  };
  for (const raw of process.argv.slice(2)) {
    if (raw === "--dry-run") { args.dryRun = true; continue; }
    if (raw === "--force") { args.force = true; continue; }
    const eq = raw.indexOf("=");
    if (eq < 0) continue;
    const k = raw.slice(0, eq);
    const v = raw.slice(eq + 1);
    if (k === "--document-type") args.documentType = v as Args["documentType"];
    else if (k === "--syllabus-code") args.syllabusCode = v;
    else if (k === "--limit") args.limit = Number(v) || null;
    else if (k === "--concurrency") args.concurrency = Math.max(1, Number(v) || 4);
  }
  return args;
}

function isLikelyBinary(text: string): boolean {
  if (!text) return false;
  // PDF source bytes always start with %PDF-1.x.
  if (text.startsWith("%PDF")) return true;
  // High ratio of non-printable / control bytes is a giveaway.
  const sample = text.slice(0, 4000);
  const printable = sample.replace(/[^\x20-\x7E\n\r\t]/g, "").length;
  return sample.length > 0 && printable / sample.length < 0.85;
}

interface DocRow {
  id: number;
  filename: string;
  syllabusCode: string | null;
  subject: string | null;
  documentType: string;
  originalPath: string | null;
  extractedTextLen: number;
  extractedHead: string;
}

async function listDocuments(pool: Pool, args: Args): Promise<DocRow[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (args.documentType !== "all") {
    params.push(args.documentType);
    where.push(`document_type = $${params.length}`);
  }
  if (args.syllabusCode) {
    params.push(args.syllabusCode);
    where.push(`syllabus_code = $${params.length}`);
  }
  let sql = `
    SELECT id, filename, syllabus_code, subject, document_type, original_path,
           COALESCE(LENGTH(extracted_text), 0) AS extracted_text_len,
           COALESCE(SUBSTRING(extracted_text, 1, 16), '') AS extracted_head
    FROM syllabus_documents
  `;
  if (where.length) sql += ` WHERE ${where.join(" AND ")}`;
  sql += " ORDER BY id";
  if (args.limit) sql += ` LIMIT ${args.limit}`;
  const r = await pool.query(sql, params);
  return r.rows.map((row) => ({
    id: row.id,
    filename: row.filename,
    syllabusCode: row.syllabus_code,
    subject: row.subject,
    documentType: row.document_type,
    originalPath: row.original_path,
    extractedTextLen: Number(row.extracted_text_len),
    extractedHead: row.extracted_head,
  }));
}

interface DocResult {
  id: number;
  filename: string;
  status: "ok" | "skipped-clean" | "missing-file" | "parse-failed" | "still-binary" | "too-short";
  oldLen: number;
  newLen: number;
  ms: number;
  reason?: string;
}

const MIN_PARSED_WORDS = 50;

async function reparseOne(doc: DocRow, args: Args, db: ReturnType<typeof drizzle>): Promise<DocResult> {
  const t0 = Date.now();
  const oldLen = doc.extractedTextLen;
  const wasBinary = isLikelyBinary(doc.extractedHead);
  if (!args.force && !wasBinary && oldLen >= 1000) {
    return { id: doc.id, filename: doc.filename, status: "skipped-clean", oldLen, newLen: oldLen, ms: Date.now() - t0 };
  }
  if (!doc.originalPath) {
    return { id: doc.id, filename: doc.filename, status: "missing-file", oldLen, newLen: 0, ms: Date.now() - t0, reason: "no original_path" };
  }
  const filePath = path.isAbsolute(doc.originalPath) ? doc.originalPath : path.join(process.cwd(), doc.originalPath);
  if (!fs.existsSync(filePath)) {
    return { id: doc.id, filename: doc.filename, status: "missing-file", oldLen, newLen: 0, ms: Date.now() - t0, reason: filePath };
  }
  const buf = fs.readFileSync(filePath);
  let text: string;
  let parser: PDFParse | null = null;
  try {
    parser = new PDFParse({ data: buf });
    const r = await parser.getText();
    text = (r.text || "").trim();
  } catch (e: any) {
    return { id: doc.id, filename: doc.filename, status: "parse-failed", oldLen, newLen: 0, ms: Date.now() - t0, reason: String(e?.message ?? e).slice(0, 200) };
  } finally {
    try { await parser?.destroy?.(); } catch { /* noop */ }
  }
  if (isLikelyBinary(text)) {
    return { id: doc.id, filename: doc.filename, status: "still-binary", oldLen, newLen: text.length, ms: Date.now() - t0 };
  }
  if (text.split(/\s+/).filter(Boolean).length < MIN_PARSED_WORDS) {
    return { id: doc.id, filename: doc.filename, status: "too-short", oldLen, newLen: text.length, ms: Date.now() - t0 };
  }
  if (!args.dryRun) {
    await db.update(syllabusDocuments).set({ extractedText: text }).where(eq(syllabusDocuments.id, doc.id));
  }
  return { id: doc.id, filename: doc.filename, status: "ok", oldLen, newLen: text.length, ms: Date.now() - t0 };
}

/** Lightweight pLimit-equivalent that returns nothing fancy. */
function makeLimiter(n: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  const next = () => {
    if (active >= n) return;
    const job = queue.shift();
    if (!job) return;
    active++;
    job();
  };
  return <T>(fn: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const run = () => {
        fn().then((v) => { active--; next(); resolve(v); }, (e) => { active--; next(); reject(e); });
      };
      queue.push(run);
      next();
    });
}

async function main() {
  const args = parseArgs();
  console.log("=== Syllabus document re-parse (pdf-parse v2) ===");
  console.log("document-type:", args.documentType);
  console.log("syllabus-code:", args.syllabusCode ?? "(any)");
  console.log("limit:        ", args.limit ?? "(none)");
  console.log("concurrency:  ", args.concurrency);
  console.log("dry-run:      ", args.dryRun);
  console.log("force:        ", args.force);

  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is required");
    process.exit(2);
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  pool.on("error", (e) => console.error("[pg pool error]", e.message));
  const db = drizzle(pool, { schema });

  const docs = await listDocuments(pool, args);
  console.log(`\nFound ${docs.length} document(s) matching the filter.`);
  const binaryNow = docs.filter((d) => isLikelyBinary(d.extractedHead)).length;
  console.log(`Of those, ${binaryNow} currently look like raw PDF binary.`);

  const limiter = makeLimiter(args.concurrency);
  const results: DocResult[] = [];
  let done = 0;
  await Promise.all(docs.map((doc) => limiter(async () => {
    const r = await reparseOne(doc, args, db);
    done++;
    const tag = r.status === "ok" ? "OK   " : r.status === "skipped-clean" ? "SKIP " : "FAIL ";
    console.log(`[${done}/${docs.length}] ${tag} ${r.filename.padEnd(50)} ${r.oldLen} → ${r.newLen} chars (${r.ms}ms)${r.reason ? ` — ${r.reason}` : ""}`);
    results.push(r);
  })));

  const summary = {
    total: results.length,
    ok: results.filter((r) => r.status === "ok").length,
    skippedClean: results.filter((r) => r.status === "skipped-clean").length,
    missingFile: results.filter((r) => r.status === "missing-file").length,
    parseFailed: results.filter((r) => r.status === "parse-failed").length,
    stillBinary: results.filter((r) => r.status === "still-binary").length,
    tooShort: results.filter((r) => r.status === "too-short").length,
  };
  console.log("\n=== Summary ===");
  console.table(summary);
  if (summary.parseFailed > 0) {
    console.log("\nParse failures:");
    for (const r of results.filter((r) => r.status === "parse-failed")) {
      console.log(`  - id=${r.id} ${r.filename}: ${r.reason}`);
    }
  }
  if (summary.missingFile > 0) {
    console.log("\nMissing files:");
    for (const r of results.filter((r) => r.status === "missing-file")) {
      console.log(`  - id=${r.id} ${r.filename}: ${r.reason}`);
    }
  }
  await pool.end();
}

main().catch((e) => {
  console.error("[fatal]", e);
  process.exit(1);
});
