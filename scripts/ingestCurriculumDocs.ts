/**
 * Bulk curriculum document ingestion script.
 *
 * Usage:
 *   npx tsx scripts/ingestCurriculumDocs.ts
 *   (or via the npm script: npm run curriculum:ingest)
 *
 * Scans the /curriculum-docs folder recursively, classifies each PDF as
 * "syllabus" or "examiner_report" based on its folder path, parses text,
 * chunks it, and stores everything in the database.
 *
 * Idempotent: files already ingested (detected by SHA-256 hash) are skipped.
 */

import "dotenv/config";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "../shared/schema";
import { eq } from "drizzle-orm";
import { parsePdfTextFromBuffer } from "../server/services/aiPipeline";
import { buildSyllabusChunks } from "../server/services/assessmentGeneration";

const { syllabusDocuments, syllabusChunks } = schema;

const CURRICULUM_DOCS_ROOT = path.resolve(process.cwd(), "curriculum-docs");
const MIN_WORD_COUNT = 50;

interface IngestResult {
  file: string;
  status: "ingested" | "skipped" | "failed";
  reason?: string;
  docId?: number;
  chunkCount?: number;
}

function createPool(): pg.Pool {
  const url = process.env.SUPABASE_URL;
  if (!url) throw new Error("SUPABASE_URL environment variable is not set.");
  const useSsl = url.toLowerCase().includes("supabase.co");
  const connectionString = useSsl ? url.replace(/[?&]sslmode=[^&]*/gi, "").replace(/\?$/, "") : url;
  return new pg.Pool({
    connectionString,
    ssl: useSsl ? { rejectUnauthorized: false } : undefined,
    max: 3,
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

/**
 * Infer document_type from folder path.
 * Paths containing "examiner-report" → "examiner_report", else → "syllabus".
 */
function inferDocumentType(filePath: string): "syllabus" | "examiner_report" {
  const rel = filePath.replace(CURRICULUM_DOCS_ROOT, "").toLowerCase();
  return rel.includes("examiner-report") ? "examiner_report" : "syllabus";
}

/**
 * Infer board from path segment (e.g. "cambridge").
 */
function inferBoard(filePath: string): string {
  const rel = filePath.replace(CURRICULUM_DOCS_ROOT, "");
  const parts = rel.split(path.sep).filter(Boolean);
  const board = parts[0] ?? "unknown";
  return board.charAt(0).toUpperCase() + board.slice(1);
}

/**
 * Infer level from path segment (igcse, as, a2, a_level, a-level) or filename.
 */
function inferLevel(filePath: string): string {
  const rel = filePath.replace(CURRICULUM_DOCS_ROOT, "").toLowerCase();
  if (rel.includes("/igcse/") || rel.includes("_igcse_")) return "IGCSE";
  if (rel.includes("/a_level/") || rel.includes("/a-level/") || rel.includes("/alevel/")) return "A Level";
  if (rel.includes("/a2/")    || rel.includes("_a2_"))    return "A2";
  if (rel.includes("/as/")    || rel.includes("_as_"))    return "AS";
  return "Unknown";
}

/**
 * Infer syllabus code from filename.
 * Handles both "0580_maths.pdf" (code at start) and "Biology_9700_2028.pdf" (code in middle).
 * Falls back to a slug of the filename.
 */
function inferSyllabusCode(filename: string): string {
  // Try 4-digit code at start of filename
  const startMatch = filename.match(/^(\d{4})/);
  if (startMatch) return startMatch[1];
  // Try 4-digit code anywhere (e.g. Biology_9700_2028-2030.pdf)
  const anyMatch = filename.match(/_(\d{4})[_\-.]/);
  if (anyMatch) return anyMatch[1];
  return path.basename(filename, ".pdf").replace(/[_\s]+/g, "-").toLowerCase();
}

/**
 * Infer subject from filename tokens.
 * Supports underscore-separated filenames like "Biology_9700_2028-2030.pdf".
 */
function inferSubject(filename: string): string | undefined {
  const SUBJECTS = [
    "pure mathematics", "further mathematics", "mathematics",
    "additional mathematics", "statistics", "mechanics",
    "physics", "chemistry", "biology",
    "economics", "geography", "history",
    "english language", "english literature", "english",
    "literature", "french", "computer science",
    "business studies", "business", "accounting",
    "design and technology", "design",
  ];
  const lower = filename.toLowerCase();
  // Try each subject — check underscored, hyphenated, and space variants
  return SUBJECTS.find((s) =>
    lower.includes(s.replace(/ /g, "_")) ||
    lower.includes(s.replace(/ /g, "-")) ||
    lower.includes(s)
  );
}

async function ingestFile(
  filePath: string,
  db: ReturnType<typeof drizzle<typeof schema>>,
): Promise<IngestResult> {
  const filename = path.basename(filePath);
  const relPath = path.relative(process.cwd(), filePath);

  let buffer: Buffer;
  try {
    buffer = fs.readFileSync(filePath);
  } catch (e: any) {
    return { file: relPath, status: "failed", reason: `Cannot read file: ${e.message}` };
  }

  const hash = sha256(buffer);

  const [existing] = await db.select({ id: syllabusDocuments.id })
    .from(syllabusDocuments)
    .where(eq(syllabusDocuments.contentHash, hash));
  if (existing) {
    return { file: relPath, status: "skipped", reason: `Already ingested (id=${existing.id})` };
  }

  let extractedText: string;
  try {
    extractedText = await parsePdfTextFromBuffer(buffer);
  } catch (e: any) {
    return { file: relPath, status: "failed", reason: `PDF parse failed: ${e.message}` };
  }

  if (extractedText.split(/\s+/).filter(Boolean).length < MIN_WORD_COUNT) {
    return { file: relPath, status: "failed", reason: "PDF appears to be image-only or has too little text." };
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

  return { file: relPath, status: "ingested", docId: doc.id, chunkCount: chunks.length };
}

async function main() {
  console.log("\n========================================");
  console.log("  SOMA Curriculum Document Ingestion");
  console.log("========================================\n");

  const pool = createPool();
  let db: ReturnType<typeof drizzle<typeof schema>>;
  try {
    await pool.query("SELECT 1");
    db = drizzle(pool, { schema });
    console.log("[db] Connected.\n");
  } catch (e: any) {
    console.error("[db] Connection failed:", e.message);
    process.exit(1);
  }

  const pdfs = collectPdfs(CURRICULUM_DOCS_ROOT);
  if (pdfs.length === 0) {
    console.log(`No PDFs found under ${CURRICULUM_DOCS_ROOT}.`);
    console.log("Place your PDFs in the curriculum-docs folder and re-run.\n");
    await pool.end();
    return;
  }

  console.log(`Found ${pdfs.length} PDF(s). Processing...\n`);

  const results: IngestResult[] = [];
  for (const filePath of pdfs) {
    process.stdout.write(`  Processing: ${path.relative(process.cwd(), filePath)} ... `);
    const result = await ingestFile(filePath, db);
    results.push(result);
    if (result.status === "ingested") {
      console.log(`✓  ingested (id=${result.docId}, ${result.chunkCount} chunks)`);
    } else if (result.status === "skipped") {
      console.log(`—  skipped  (${result.reason})`);
    } else {
      console.log(`✗  failed   (${result.reason})`);
    }
  }

  await pool.end();

  const ingested = results.filter((r) => r.status === "ingested");
  const skipped  = results.filter((r) => r.status === "skipped");
  const failed   = results.filter((r) => r.status === "failed");

  console.log("\n========================================");
  console.log(`  Summary`);
  console.log("========================================");
  console.log(`  Total found : ${results.length}`);
  console.log(`  Ingested    : ${ingested.length}`);
  console.log(`  Skipped     : ${skipped.length}`);
  console.log(`  Failed      : ${failed.length}`);
  if (failed.length > 0) {
    console.log("\n  Failed files:");
    for (const f of failed) {
      console.log(`    - ${f.file}: ${f.reason}`);
    }
  }
  console.log("========================================\n");
}

main().catch((e) => {
  console.error("Unexpected error:", e);
  process.exit(1);
});
