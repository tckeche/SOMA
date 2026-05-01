/**
 * Dry-run integration test for `scripts/ingestCurriculumDocs.ts`.
 *
 * Exercises the new `--dry-run` plumbing end-to-end against a PGlite
 * database with a 2-file fixture directory: one PDF whose SHA is already
 * present in `syllabus_documents` (must skip), and one fresh PDF (must
 * land in the "would ingest" bucket *without* writing any rows).
 *
 * The PDF parser (`parsePdfTextFromBuffer`) and the syllabus chunker
 * (`buildSyllabusChunks`) are mocked so we don't need a real PDF on disk
 * — only the SHA-256 of the file's bytes matters for the dedup check,
 * and we control the parsed text directly.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createTestDb, type TestDbHarness } from "./helpers/pglite";
import { syllabusChunks, syllabusDocuments, examinerMisconceptions } from "@shared/schema";

vi.mock("../server/services/aiPipeline", () => ({
  parsePdfTextFromBuffer: vi.fn(async (buf: Buffer) =>
    // Long enough to clear MIN_WORD_COUNT (50). Buffer-derived so the two
    // fixtures get different texts and we can be sure mocks aren't returning
    // the same blob for both.
    `Syllabus body for fixture ${buf.byteLength}. ` + "Lorem ipsum dolor sit amet ".repeat(20),
  ),
}));

vi.mock("../server/services/assessmentGeneration", () => ({
  buildSyllabusChunks: vi.fn(() => [
    { chunkIndex: 0, content: "chunk-0", contentPreview: "chunk-0-preview" },
  ]),
}));

vi.mock("../server/services/extractAndStoreMisconceptions", () => ({
  // Should never be invoked under dry-run. If the test ever hits this,
  // the dry-run gate is broken — fail loudly so the regression is obvious.
  extractAndStoreMisconceptions: vi.fn(async () => {
    throw new Error(
      "extractAndStoreMisconceptions called during dry-run — dry-run gate is broken",
    );
  }),
}));

// `connectDb` and the shared db handle are only used by the script's
// `main()`. The tests drive `processFiles` directly with the PGlite db,
// so these can be no-ops.
vi.mock("../server/db", () => ({
  connectDb: async () => {},
  db: null,
  pool: null,
}));

const TMP_ROOT = path.join(os.tmpdir(), `ingest-dryrun-${process.pid}-${Date.now()}`);
const ALREADY_INGESTED_FIXTURE = path.join(TMP_ROOT, "cambridge", "igcse", "0580_already.pdf");
const FRESH_FIXTURE = path.join(TMP_ROOT, "cambridge", "igcse", "0580_fresh.pdf");

let harness: TestDbHarness | null = null;

beforeAll(async () => {
  fs.mkdirSync(path.dirname(ALREADY_INGESTED_FIXTURE), { recursive: true });
  fs.writeFileSync(ALREADY_INGESTED_FIXTURE, Buffer.from("FAKE PDF — already ingested"));
  fs.writeFileSync(FRESH_FIXTURE, Buffer.from("FAKE PDF — fresh, never seen"));

  harness = await createTestDb();
}, 60_000);

afterAll(async () => {
  await harness?.teardown();
  harness = null;
  try {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

beforeEach(async () => {
  if (!harness) throw new Error("harness not ready");
  // Reset DB tables this test cares about.
  await harness.db.delete(examinerMisconceptions);
  await harness.db.delete(syllabusChunks);
  await harness.db.delete(syllabusDocuments);

  // Seed the "already ingested" doc with the matching SHA-256.
  const buf = fs.readFileSync(ALREADY_INGESTED_FIXTURE);
  const hash = crypto.createHash("sha256").update(buf).digest("hex");
  await harness.db.insert(syllabusDocuments).values({
    tutorId: null,
    board: "Cambridge",
    level: "IGCSE",
    syllabusCode: "0580",
    filename: path.basename(ALREADY_INGESTED_FIXTURE),
    extractedText: "pre-existing extracted text",
    documentType: "syllabus",
    subject: null,
    originalPath: ALREADY_INGESTED_FIXTURE,
    contentHash: hash,
  });
});

describe("ingestCurriculumDocs dry-run", () => {
  it("plans the ingestion without writing rows", async () => {
    const { processFiles, summarize } = await import("../scripts/ingestCurriculumDocs");
    if (!harness) throw new Error("harness missing");

    const results = await processFiles(
      [ALREADY_INGESTED_FIXTURE, FRESH_FIXTURE],
      harness.db,
      { dryRun: true, quiet: true },
    );

    expect(results).toHaveLength(2);

    const summary = summarize(results);
    expect(summary.total).toBe(2);
    expect(summary.wouldIngest).toBe(1);
    expect(summary.wouldSkip).toBe(1);
    expect(summary.wouldExtractMisconceptions).toBe(0);
    expect(summary.failed).toBe(0);
    expect(summary.misconceptions).toBe(0);

    // No new rows in syllabus_documents (still just the seeded one).
    const docs = await harness.db.select().from(syllabusDocuments);
    expect(docs).toHaveLength(1);
    expect(docs[0].originalPath).toBe(ALREADY_INGESTED_FIXTURE);

    // No chunks at all — the dry-run skipped both inserts.
    const chunks = await harness.db.select().from(syllabusChunks);
    expect(chunks).toHaveLength(0);

    // No misconception rows — extractor was never called.
    const misc = await harness.db.select().from(examinerMisconceptions);
    expect(misc).toHaveLength(0);
  }, 30_000);

  it("flags examiner-report files as wouldExtractMisconceptions under dry-run", async () => {
    if (!harness) throw new Error("harness missing");
    const { processFiles, summarize } = await import("../scripts/ingestCurriculumDocs");

    // Build an examiner-report fixture in a path containing "examiner-report"
    // so `inferDocumentType` classifies it as such.
    const erDir = path.join(TMP_ROOT, "cambridge", "igcse", "examiner-report");
    fs.mkdirSync(erDir, { recursive: true });
    const erFixture = path.join(erDir, "0580_w24_er.pdf");
    fs.writeFileSync(erFixture, Buffer.from("FAKE EXAMINER REPORT PDF bytes"));

    try {
      const results = await processFiles([erFixture], harness.db, {
        dryRun: true,
        quiet: true,
      });

      expect(results).toHaveLength(1);
      const r = results[0];
      expect(r.status).toBe("ingested");
      expect(r.wouldExtractMisconceptions).toBe(true);

      const summary = summarize(results);
      expect(summary.wouldIngest).toBe(1);
      expect(summary.wouldExtractMisconceptions).toBe(1);

      // Still no rows written.
      const docs = await harness.db.select().from(syllabusDocuments);
      expect(docs).toHaveLength(1); // the seeded fixture from beforeEach
      const misc = await harness.db.select().from(examinerMisconceptions);
      expect(misc).toHaveLength(0);
    } finally {
      fs.rmSync(erDir, { recursive: true, force: true });
    }
  }, 30_000);
});
