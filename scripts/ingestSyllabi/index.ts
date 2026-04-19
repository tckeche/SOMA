/**
 * Cambridge syllabus ingestion — CLI entry point (Phase 3a).
 *
 * Usage:
 *   npx tsx scripts/ingestSyllabi/index.ts              # write to DB
 *   npx tsx scripts/ingestSyllabi/index.ts --dry-run    # no DB writes, print plan
 *   npx tsx scripts/ingestSyllabi/index.ts --only=9709  # run one syllabus
 *
 * Environment:
 *   SUPABASE_URL (or DATABASE_URL) — Postgres connection string
 *
 * Phase 3a writes reference data (examining_bodies, levels, competencies),
 * the 29 distinct Cambridge syllabi rows and their subjects. Topics,
 * subtopics, learning_requirements and paper mappings are left for Phases
 * 3b and 3c.
 */

import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "@shared/schema";
import { buildCatalogue, summariseCatalogue, type CatalogueEntry } from "./catalogue";
import { extractPdfText } from "./pdf";
import { classifySyllabus } from "./patterns";
import { seedReferenceData, CAMBRIDGE_BODY_SLUG } from "./reference";
import { upsertSyllabus } from "./upsertSyllabus";

interface CliOptions {
  dryRun: boolean;
  only: string | null;
  skipReference: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = { dryRun: false, only: null, skipReference: false };
  for (const arg of argv.slice(2)) {
    if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--skip-reference") opts.skipReference = true;
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
  --help, -h         Show this help.`);
}

function createPool(): pg.Pool {
  const url = process.env.SUPABASE_URL || process.env.DATABASE_URL;
  if (!url) {
    throw new Error("Set SUPABASE_URL or DATABASE_URL before running the ingestion.");
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
  pattern: string;
  patternReason: string;
  syllabusId?: number;
  wroteRow?: boolean;
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

  // Classify every entry up front so dry-run shows the plan without touching
  // the DB. We also use this to surface unclassified syllabi early.
  const summaries: EntrySummary[] = [];
  for (const entry of filtered) {
    const { text, pageCount } = extractPdfText(entry.absolutePath);
    const classification = classifySyllabus(text, entry.topBand, entry.syllabusCode);
    summaries.push({
      entry,
      pageCount,
      pattern: classification.pattern,
      patternReason: classification.reason,
    });
  }

  printPlan(summaries);

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
      await seedReferenceData(db);
    }

    const bodyRows = await db.select().from(schema.examiningBodies);
    const cambridge = bodyRows.find((b) => b.slug === CAMBRIDGE_BODY_SLUG);
    if (!cambridge) throw new Error("Cambridge examining body row is missing — did the reference seed run?");

    let wrote = 0;
    let unchanged = 0;
    for (const summary of summaries) {
      const result = await upsertSyllabus(db, cambridge.id, summary.entry);
      summary.syllabusId = result.syllabusId;
      summary.wroteRow = result.wroteRow;
      if (result.wroteRow) wrote++;
      else unchanged++;
    }

    console.log(`\nSyllabus upsert: ${wrote} written, ${unchanged} unchanged (hash match).`);
    console.log("Phase 3a complete. Topics/subtopics/learning requirements arrive in Phase 3b.");
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
    console.log(
      `  ${e.topBand.padEnd(8)} ${e.syllabusCode}  ${e.subject.padEnd(24)} ${tiers.padEnd(6)} pages=${String(s.pageCount).padStart(3)} pattern=${s.pattern.padEnd(13)} (${s.patternReason})`,
    );
  }
  const unclassified = summaries.filter((s) => s.pattern === "unclassified");
  if (unclassified.length) {
    console.log(`\n${unclassified.length} syllabi unclassified. They will still get a syllabi row; Phase 3c decides how to handle them.`);
  }
}

main().catch((err) => {
  console.error("[ingestSyllabi] fatal:", err);
  process.exit(1);
});
