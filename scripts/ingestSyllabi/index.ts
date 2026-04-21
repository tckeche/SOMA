/**
 * Cambridge syllabus ingestion — CLI entry point.
 *
 * Usage:
 *   npx tsx scripts/ingestSyllabi/index.ts                 # full run, write to DB
 *   npx tsx scripts/ingestSyllabi/index.ts --dry-run       # parse only, no DB
 *   npx tsx scripts/ingestSyllabi/index.ts --only=9709     # one syllabus
 *   npx tsx scripts/ingestSyllabi/index.ts --dump-json     # write extracted JSON
 *
 * Environment:
 *   SUPABASE_URL (or DATABASE_URL) — Postgres connection string
 *
 * Phase 3b.1 added Pattern A (A Level sciences) and Pattern D (IGCSE
 * Core/Extended). Phase 3b.2 adds Pattern B (9709 Mathematics) and Pattern C
 * (9708 / 9609 / 9706), plus papers and paper↔topic / paper↔subtopic
 * mappings for every syllabus that exposes them (today, just Patterns B and
 * C). Unclassified syllabi still receive a syllabi row and are deferred to
 * Phase 3c.
 */

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "@shared/schema";
import { buildCatalogue, summariseCatalogue, type CatalogueEntry } from "./catalogue";
import { extractPdfText } from "./pdf";
import { classifySyllabus, type SyllabusPattern } from "./patterns";
import { seedReferenceData, CAMBRIDGE_BODY_SLUG } from "./reference";
import { upsertSyllabus } from "./upsertSyllabus";
import { parseSyllabus, type ParsedSyllabus } from "./parsers";
import { upsertParsedSyllabus } from "./upsertParsed";

interface CliOptions {
  dryRun: boolean;
  only: string | null;
  skipReference: boolean;
  dumpJson: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = { dryRun: false, only: null, skipReference: false, dumpJson: false };
  for (const arg of argv.slice(2)) {
    if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--skip-reference") opts.skipReference = true;
    else if (arg === "--dump-json") opts.dumpJson = true;
    else if (arg.startsWith("--only=")) opts.only = arg.slice("--only=".length);
    else if (arg === "-h" || arg === "--help") {
      printHelp();
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${arg}`);
      printHelp();
      process.exit(1);
    }
  }
  return opts;
}

function printHelp(): void {
  console.log(`Usage: tsx scripts/ingestSyllabi/index.ts [options]

Options:
  --dry-run          Parse PDFs and classify patterns; do not write to the DB.
  --skip-reference   Skip the reference-data seed (bodies/levels/competencies).
  --only=<code>      Restrict to a single syllabus code (e.g. 9709, 0580).
  --dump-json        Write extracted JSON artefacts under
                     curriculum-docs/cambridge/extracted/ for review.
  --help, -h         Show this help.`);
}

function createPool(): pg.Pool {
  // Prefer DATABASE_URL (the workflow sets it explicitly to the Postgres
  // connection string). Fall back to SUPABASE_URL only if it actually looks
  // like a Postgres URL — Replit's SUPABASE_URL secret holds the HTTPS API
  // origin (https://*.supabase.co) which would silently hang the pg pool.
  const candidates = [process.env.DATABASE_URL, process.env.SUPABASE_DB_URL, process.env.SUPABASE_URL];
  const url = candidates.find((c) => typeof c === "string" && /^postgres(ql)?:\/\//i.test(c));
  if (!url) {
    throw new Error(
      "Set DATABASE_URL (or SUPABASE_DB_URL) to a postgres:// connection string before running the ingestion. " +
      "SUPABASE_URL is the HTTPS API origin and cannot be used as a database URL.",
    );
  }
  const lower = url.toLowerCase();
  const useSsl = lower.includes("supabase.co") || lower.includes("sslmode=require");
  const connectionString = useSsl ? url.replace(/[?&]sslmode=[^&]*/gi, "").replace(/\?$/, "") : url;
  return new pg.Pool({
    connectionString,
    ssl: useSsl ? { rejectUnauthorized: false } : undefined,
    max: 3,
    connectionTimeoutMillis: 15_000,
  });
}

interface EntrySummary {
  entry: CatalogueEntry;
  pageCount: number;
  pattern: SyllabusPattern;
  patternReason: string;
  parsed: ParsedSyllabus | null;
  syllabusId?: number;
  wroteRow?: boolean;
  topicsWritten?: number;
  subtopicsWritten?: number;
  requirementsWritten?: number;
  papersWritten?: number;
  paperMappingsWritten?: number;
  writeWarnings?: string[];
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv);

  const catalogue = buildCatalogue();
  const filtered = opts.only ? catalogue.filter((e) => e.syllabusCode === opts.only) : catalogue;
  if (opts.only && filtered.length === 0) {
    console.error(`No syllabus in the catalogue matches --only=${opts.only}`);
    process.exit(2);
  }

  console.log(summariseCatalogue(catalogue));
  if (opts.only) console.log(`Filter: --only=${opts.only} → ${filtered.length} entries`);
  console.log(opts.dryRun ? "Mode: DRY RUN (no DB writes)" : "Mode: WRITE");

  const summaries: EntrySummary[] = [];
  for (const entry of filtered) {
    const { text, pageCount } = extractPdfText(entry.absolutePath);
    const classification = classifySyllabus(text, entry.topBand, entry.syllabusCode);
    const parsed = parseSyllabus({
      syllabusCode: entry.syllabusCode,
      pattern: classification.pattern,
      text,
    });
    summaries.push({
      entry,
      pageCount,
      pattern: classification.pattern,
      patternReason: classification.reason,
      parsed,
    });
  }

  printPlan(summaries);

  if (opts.dumpJson) {
    dumpJsonArtefacts(summaries);
  }

  if (opts.dryRun) {
    console.log("\nDry run complete — no rows written.");
    return;
  }

  const pool = createPool();
  try {
    await pool.query("SELECT 1");
    const db = drizzle(pool, { schema });

    if (!opts.skipReference) {
      console.log("\nSeeding reference data …");
      const seedStart = Date.now();
      await seedReferenceData(db);
      console.log(`Seed reference data done in ${Date.now() - seedStart}ms.`);
    }

    console.log(`[trace] selecting examining_bodies …`);
    const bodyRows = await db.select().from(schema.examiningBodies);
    console.log(`[trace] got ${bodyRows.length} bodies`);
    const cambridge = bodyRows.find((b) => b.slug === CAMBRIDGE_BODY_SLUG);
    if (!cambridge) throw new Error("Cambridge examining body row is missing — did the reference seed run?");

    let wrote = 0;
    let unchanged = 0;
    let parsedCount = 0;
    let totalTopics = 0;
    let totalSubtopics = 0;
    let totalRequirements = 0;
    let totalPapers = 0;
    let totalPaperMappings = 0;

    for (const summary of summaries) {
      const t0 = Date.now();
      console.log(`[trace] [${summary.entry.syllabusCode}] upsertSyllabus …`);
      const result = await upsertSyllabus(db, cambridge.id, summary.entry);
      console.log(`[trace] [${summary.entry.syllabusCode}] upsertSyllabus done in ${Date.now() - t0}ms (wroteRow=${result.wroteRow})`);
      summary.syllabusId = result.syllabusId;
      summary.wroteRow = result.wroteRow;
      if (result.wroteRow) wrote++;
      else unchanged++;

      if (summary.parsed) {
        const t1 = Date.now();
        console.log(`[trace] [${summary.entry.syllabusCode}] upsertParsedSyllabus (topics=${summary.parsed.topics.length}) …`);
        const write = await upsertParsedSyllabus(db, result.syllabusId, summary.parsed);
        console.log(`[trace] [${summary.entry.syllabusCode}] upsertParsedSyllabus done in ${Date.now() - t1}ms (topics=${write.topicsWritten}, subs=${write.subtopicsWritten}, LRs=${write.requirementsWritten})`);
        summary.topicsWritten = write.topicsWritten;
        summary.subtopicsWritten = write.subtopicsWritten;
        summary.requirementsWritten = write.requirementsWritten;
        summary.papersWritten = write.papersWritten;
        summary.paperMappingsWritten = write.paperMappingsWritten;
        summary.writeWarnings = write.warnings;
        parsedCount++;
        totalTopics += write.topicsWritten;
        totalSubtopics += write.subtopicsWritten;
        totalRequirements += write.requirementsWritten;
        totalPapers += write.papersWritten;
        totalPaperMappings += write.paperMappingsWritten;
      }
    }

    console.log(`\nSyllabus upsert: ${wrote} written, ${unchanged} unchanged (hash match).`);
    console.log(`Content extraction: ${parsedCount} syllabi parsed → ${totalTopics} topics, ${totalSubtopics} subtopics, ${totalRequirements} learning requirements.`);
    console.log(`Papers: ${totalPapers} rows, ${totalPaperMappings} paper↔topic/subtopic mappings.`);
    const skipped = summaries.filter((s) => !s.parsed).length;
    if (skipped) {
      console.log(`Skipped ${skipped} syllabi with no parser (unclassified — handled in Phase 3c).`);
    }
  } finally {
    await pool.end();
  }
}

function printPlan(summaries: EntrySummary[]): void {
  console.log("");
  console.log("Plan:");
  for (const s of summaries) {
    const e = s.entry;
    const tiers = e.supportedTiers.join("+");
    const parseCounts = s.parsed
      ? ` topics=${s.parsed.topics.length} subtopics=${countSubtopics(s.parsed)} LRs=${countRequirements(s.parsed)} papers=${s.parsed.papers.length}`
      : " (no parser)";
    console.log(
      `  ${e.topBand.padEnd(8)} ${e.syllabusCode}  ${e.subject.padEnd(24)} ${tiers.padEnd(6)} pages=${String(s.pageCount).padStart(3)} pattern=${s.pattern.padEnd(13)}${parseCounts}`,
    );
  }
  const unclassified = summaries.filter((s) => s.pattern === "unclassified");
  if (unclassified.length) {
    console.log(`\n${unclassified.length} syllabi unclassified. They will still get a syllabi row; Phase 3c decides how to handle them.`);
  }
  const withWarnings = summaries.filter((s) => s.parsed && s.parsed.warnings.length);
  if (withWarnings.length) {
    console.log("\nParser warnings:");
    for (const s of withWarnings) {
      for (const w of s.parsed!.warnings) {
        console.log(`  [${s.entry.syllabusCode}] ${w}`);
      }
    }
  }
}

function dumpJsonArtefacts(summaries: EntrySummary[]): void {
  const outDir = path.join(process.cwd(), "curriculum-docs", "cambridge", "extracted");
  fs.mkdirSync(outDir, { recursive: true });
  let written = 0;
  for (const s of summaries) {
    if (!s.parsed) continue;
    const file = path.join(outDir, `${s.entry.syllabusCode}.json`);
    fs.writeFileSync(file, JSON.stringify(s.parsed, null, 2) + "\n", "utf8");
    written++;
  }
  console.log(`\nWrote ${written} JSON artefacts to ${path.relative(process.cwd(), outDir)}/`);
}

function countSubtopics(p: ParsedSyllabus): number {
  return p.topics.reduce((acc, t) => acc + t.subtopics.length, 0);
}

function countRequirements(p: ParsedSyllabus): number {
  return p.topics.reduce(
    (acc, t) => acc + t.subtopics.reduce((a, s) => a + s.requirements.length, 0),
    0,
  );
}

main().catch((err) => {
  console.error("[ingestSyllabi] fatal:", err);
  process.exit(1);
});
