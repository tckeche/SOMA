/**
 * Bulk curriculum document ingestion script.
 *
 * ⚠️  LEGACY (Phase 10) — retained only for syllabi not yet in the
 *     structured catalogue (seeds under `scripts/ingestSyllabi/`). New
 *     curriculum coverage should go through the catalogue + topic embeddings
 *     path (`scripts/embedTopics.ts`), which powers the Phase 9 semantic
 *     retrieval in `loadCopilotContext`. The text-chunk path below is kept
 *     as a bridge for PDFs that haven't been structured yet; once a syllabus
 *     is in the catalogue, the copilot-chat route prefers the catalogue
 *     context and treats these chunks as optional supporting text.
 *
 * Usage:
 *   npx tsx scripts/ingestCurriculumDocs.ts
 *
 * Scans the /curriculum-docs folder recursively, classifies each PDF as
 * "syllabus" or "examiner_report" based on its folder path, parses text,
 * chunks it, and stores everything in the database. Examiner reports are
 * then passed to the LLM-backed misconception extractor so the
 * `examiner_misconceptions` table is populated in the same pass.
 *
 * Idempotent: files already ingested (detected by SHA-256 hash) are skipped;
 * documents whose misconceptions have already been extracted are skipped at
 * the extractor's existence check.
 *
 * Concurrency: bounded by `min(8, os.cpus().length)`. PDF parsing is
 * CPU-bound and the LLM provider rate limits make a higher cap unsafe.
 */

import "dotenv/config";
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import pLimit from "p-limit";
import * as schema from "../shared/schema";
import { eq } from "drizzle-orm";
import { parsePdfTextFromBuffer } from "../server/services/aiPipeline";
import { buildSyllabusChunks } from "../server/services/assessmentGeneration";
import { extractAndStoreMisconceptions } from "../server/services/extractAndStoreMisconceptions";
import { connectDb, db as sharedDb } from "../server/db";

const { syllabusDocuments, syllabusChunks } = schema;

const CURRICULUM_DOCS_ROOT = path.resolve(process.cwd(), "curriculum-docs");
const ERRORS_LOG = path.resolve(process.cwd(), "ingestion-errors.log");
const MIN_WORD_COUNT = 50;
const CONCURRENCY = Math.min(8, Math.max(1, os.cpus().length));

interface IngestResult {
  file: string;
  status: "ingested" | "skipped" | "failed" | "needs-ocr";
  reason?: string;
  docId?: number;
  chunkCount?: number;
  misconceptionCount?: number;
  misconceptionSkipReason?: string;
}

function createPool(): pg.Pool {
  const url = process.env.SUPABASE_URL;
  if (!url) throw new Error("SUPABASE_URL environment variable is not set.");
  const useSsl = url.toLowerCase().includes("supabase.co");
  const connectionString = useSsl ? url.replace(/[?&]sslmode=[^&]*/gi, "").replace(/\?$/, "") : url;
  return new pg.Pool({
    connectionString,
    ssl: useSsl ? { rejectUnauthorized: false } : undefined,
    max: 8,
    connectionTimeoutMillis: 15000,
  });
}

function sha256(buffer: Buffer): string {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function collectPdfs(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectPdfs(full));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".pdf")) {
      results.push(full);
    }
  }
  return results;
}

function inferDocumentType(filePath: string): "syllabus" | "examiner_report" {
  const rel = filePath.replace(CURRICULUM_DOCS_ROOT, "").toLowerCase();
  return rel.includes("examiner-report") ? "examiner_report" : "syllabus";
}

function inferBoard(filePath: string): string {
  const rel = filePath.replace(CURRICULUM_DOCS_ROOT, "");
  const parts = rel.split(path.sep).filter(Boolean);
  const board = parts[0] ?? "unknown";
  return board.charAt(0).toUpperCase() + board.slice(1);
}

function inferLevel(filePath: string): string {
  const rel = filePath.replace(CURRICULUM_DOCS_ROOT, "").toLowerCase();
  if (rel.includes("/igcse/") || rel.includes("_igcse_")) return "IGCSE";
  if (rel.includes("/a_level/") || rel.includes("/a-level/") || rel.includes("/alevel/")) return "A Level";
  if (rel.includes("/a2/") || rel.includes("_a2_")) return "A2";
  if (rel.includes("/as/") || rel.includes("_as_")) return "AS";
  return "Unknown";
}

function inferSyllabusCode(filename: string): string {
  const startMatch = filename.match(/^(\d{4})/);
  if (startMatch) return startMatch[1];
  const anyMatch = filename.match(/_(\d{4})[_\-.]/);
  if (anyMatch) return anyMatch[1];
  return path.basename(filename, ".pdf").replace(/[_\s]+/g, "-").toLowerCase();
}

function inferSubject(filename: string): string | undefined {
  const SUBJECTS = [
    "pure mathematics", "further mathematics", "mathematics",
    "additional mathematics", "statistics", "mechanics",
    "physics", "chemistry", "biology",
    "economics", "geography", "history",
    "english language", "english literature", "english as a second language",
    "english first language", "english",
    "literature in english", "literature", "french foreign language", "french",
    "computer science",
    "business studies", "business", "accounting",
    "design and technology", "design",
    "information and communication technology",
  ];
  const lower = filename.toLowerCase();
  return SUBJECTS.find((s) =>
    lower.includes(s.replace(/ /g, "_")) ||
    lower.includes(s.replace(/ /g, "-")) ||
    lower.includes(s)
  );
}

interface DocRow {
  id: number;
  board: string;
  syllabusCode: string;
  subject: string | null;
  extractedText: string;
  documentType: "syllabus" | "examiner_report";
}

async function ingestFile(
  filePath: string,
  db: ReturnType<typeof drizzle<typeof schema>>,
): Promise<{ result: IngestResult; doc?: DocRow }> {
  const filename = path.basename(filePath);
  const relPath = path.relative(process.cwd(), filePath);

  let buffer: Buffer;
  try {
    buffer = fs.readFileSync(filePath);
  } catch (e: any) {
    return { result: { file: relPath, status: "failed", reason: `Cannot read file: ${e.message}` } };
  }

  const hash = sha256(buffer);

  const [existing] = await db.select({
    id: syllabusDocuments.id,
    board: syllabusDocuments.board,
    syllabusCode: syllabusDocuments.syllabusCode,
    subject: syllabusDocuments.subject,
    extractedText: syllabusDocuments.extractedText,
    documentType: syllabusDocuments.documentType,
  })
    .from(syllabusDocuments)
    .where(eq(syllabusDocuments.contentHash, hash));

  if (existing) {
    return {
      result: { file: relPath, status: "skipped", reason: `Already ingested (id=${existing.id})`, docId: existing.id, chunkCount: 0 },
      doc: { ...existing, documentType: existing.documentType as "syllabus" | "examiner_report" },
    };
  }

  let extractedText: string;
  try {
    extractedText = await parsePdfTextFromBuffer(buffer);
  } catch (e: any) {
    return { result: { file: relPath, status: "failed", reason: `PDF parse failed: ${e.message}` } };
  }

  if (extractedText.split(/\s+/).filter(Boolean).length < MIN_WORD_COUNT) {
    return { result: { file: relPath, status: "needs-ocr", reason: "PDF appears to be image-only or has too little text." } };
  }

  const chunks = buildSyllabusChunks(extractedText);
  const documentType = inferDocumentType(filePath);
  const board = inferBoard(filePath);
  const level = inferLevel(filePath);
  const syllabusCode = inferSyllabusCode(filename);
  const subject = inferSubject(filename);

  const [doc] = await db.insert(syllabusDocuments).values({
    tutorId: null,
    board,
    level,
    syllabusCode,
    filename,
    extractedText,
    documentType,
    subject: subject ?? null,
    originalPath: relPath,
    contentHash: hash,
  }).returning();

  if (chunks.length > 0) {
    await db.insert(syllabusChunks).values(
      chunks.map((c) => ({ documentId: doc.id, chunkIndex: c.chunkIndex, content: c.content, contentPreview: c.contentPreview }))
    );
  }

  return {
    result: { file: relPath, status: "ingested", docId: doc.id, chunkCount: chunks.length },
    doc: {
      id: doc.id,
      board: doc.board,
      syllabusCode: doc.syllabusCode,
      subject: doc.subject,
      extractedText: doc.extractedText,
      documentType: documentType,
    },
  };
}

function logError(payload: Record<string, unknown>) {
  try {
    fs.appendFileSync(ERRORS_LOG, JSON.stringify({ ts: new Date().toISOString(), ...payload }) + "\n");
  } catch {
    // best-effort — never abort the run on logger failure
  }
}

let persistenceAsserted = false;
/**
 * Sanity check that misconception rows are actually being persisted to the
 * database, not silently routed to in-process MemoryStorage. Runs exactly
 * once, after the first file has had a chance to extract. If the row count
 * is still zero, the script aborts to avoid burning hundreds more LLM calls
 * on a broken persistence path.
 */
async function maybeAssertPersistence(pool: pg.Pool, idx: number) {
  if (persistenceAsserted) return;
  // Only check after enough files have completed for at least one extraction
  // to have finished end-to-end (concurrency 4 → wait until file #5).
  if (idx < 5) return;
  persistenceAsserted = true;
  try {
    const r = await pool.query<{ n: number }>(
      "SELECT COUNT(*)::int AS n FROM examiner_misconceptions",
    );
    const n = r.rows[0]?.n ?? 0;
    if (n === 0) {
      console.error(
        "\n[FATAL] examiner_misconceptions has 0 rows after the first batch.\n" +
          "        Misconceptions are not being persisted to PostgreSQL.\n" +
          "        Aborting before more LLM tokens are wasted.",
      );
      process.exit(1);
    }
    console.log(`[persistence-check] OK — ${n} row(s) in examiner_misconceptions after ${idx} files.\n`);
  } catch (e: any) {
    console.error("[persistence-check] query failed:", e?.message ?? e);
    process.exit(1);
  }
}

async function main() {
  console.log("\n========================================");
  console.log("  SOMA Curriculum Document Ingestion");
  console.log("========================================\n");
  console.log(`  Concurrency: ${CONCURRENCY} (min(8, ${os.cpus().length} cpus))`);
  console.log(`  Errors log : ${path.relative(process.cwd(), ERRORS_LOG)}\n`);

  const pool = createPool();
  let db: ReturnType<typeof drizzle<typeof schema>>;
  try {
    await pool.query("SELECT 1");
    db = drizzle(pool, { schema });
    // Also initialise the shared db used by the `storage` proxy so that
    // extractAndStoreMisconceptions writes to PostgreSQL (DatabaseStorage)
    // instead of the in-process MemoryStorage fallback.
    await connectDb();
    if (!sharedDb) {
      console.error("[db] Shared db handle is null after connectDb() — aborting.");
      process.exit(1);
    }
    console.log("[db] Connected (script pool + shared storage).\n");
  } catch (e: any) {
    console.error("[db] Connection failed:", e.message);
    process.exit(1);
  }

  const pdfs = collectPdfs(CURRICULUM_DOCS_ROOT);
  if (pdfs.length === 0) {
    console.log(`No PDFs found under ${CURRICULUM_DOCS_ROOT}.`);
    await pool.end();
    return;
  }

  console.log(`Found ${pdfs.length} PDF(s). Processing...\n`);

  const limit = pLimit(CONCURRENCY);
  const results: IngestResult[] = [];
  let done = 0;

  await Promise.all(
    pdfs.map((filePath) =>
      limit(async () => {
        const idx = ++done;
        const rel = path.relative(process.cwd(), filePath);
        const t0 = Date.now();
        try {
          const { result, doc } = await ingestFile(filePath, db);
          // Sanity check: after the very first examiner_report extraction
          // completes, verify rows actually landed in the database. If they
          // did not, abort before burning hundreds more LLM calls.
          await maybeAssertPersistence(pool, idx);

          // Examiner reports get a misconception extraction pass under the
          // same limiter slot — i.e. a fresh slot is taken once parse+insert
          // is done. We schedule it inline so we stay within CONCURRENCY for
          // both CPU-bound parsing and the LLM call.
          if (
            (result.status === "ingested" || result.status === "skipped") &&
            doc &&
            doc.documentType === "examiner_report"
          ) {
            try {
              const extracted = await extractAndStoreMisconceptions(doc, { preferredProvider: "openai" });
              if (extracted.skipped) {
                result.misconceptionCount = 0;
                result.misconceptionSkipReason = extracted.reason;
              } else {
                result.misconceptionCount = extracted.count;
              }
            } catch (e: any) {
              result.misconceptionCount = 0;
              result.misconceptionSkipReason = `extract-failed: ${e?.message ?? String(e)}`;
              logError({ phase: "extract", file: rel, docId: doc.id, message: e?.message ?? String(e) });
            }
          }

          results.push(result);
          const ms = Date.now() - t0;
          const tag =
            result.status === "ingested" ? "OK   " :
            result.status === "skipped"  ? "SKIP " :
            result.status === "needs-ocr" ? "OCR  " : "FAIL ";
          const extra =
            result.misconceptionCount !== undefined
              ? ` — ${result.misconceptionCount} misconceptions`
              : result.chunkCount !== undefined && result.status === "ingested"
                ? ` — ${result.chunkCount} chunks`
                : "";
          console.log(`[${idx}/${pdfs.length}] ${tag}${path.basename(filePath).padEnd(50)}${extra} (${ms}ms)`);
        } catch (e: any) {
          const result: IngestResult = { file: rel, status: "failed", reason: e?.message ?? String(e) };
          results.push(result);
          logError({ phase: "ingest", file: rel, message: result.reason });
          console.log(`[${idx}/${pdfs.length}] FAIL ${path.basename(filePath)} — ${result.reason}`);
        }
      })
    )
  );

  await pool.end();

  const ingested  = results.filter((r) => r.status === "ingested");
  const skipped   = results.filter((r) => r.status === "skipped");
  const failed    = results.filter((r) => r.status === "failed");
  const needsOcr  = results.filter((r) => r.status === "needs-ocr");
  const totalMisc = results.reduce((acc, r) => acc + (r.misconceptionCount ?? 0), 0);

  console.log("\n========================================");
  console.log(`  Summary`);
  console.log("========================================");
  console.log(`  Total found        : ${results.length}`);
  console.log(`  Ingested           : ${ingested.length}`);
  console.log(`  Skipped            : ${skipped.length}`);
  console.log(`  Needs OCR          : ${needsOcr.length}`);
  console.log(`  Failed             : ${failed.length}`);
  console.log(`  Misconceptions     : ${totalMisc} (across ${results.filter(r => (r.misconceptionCount ?? 0) > 0).length} reports)`);

  if (needsOcr.length > 0) {
    console.log("\n  Files that need OCR (image-only PDFs):");
    for (const f of needsOcr) console.log(`    - ${f.file}`);
  }
  if (failed.length > 0) {
    console.log("\n  Failed files:");
    for (const f of failed) console.log(`    - ${f.file}: ${f.reason}`);
  }
  console.log("========================================\n");
}

main().catch((e) => {
  console.error("Unexpected error:", e);
  process.exit(1);
});
