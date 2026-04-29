/**
 * Verification script for the examiner-report ingestion + study-tips path.
 * Exercises:
 *  - the three new indexes are present
 *  - examiner_misconceptions row counts by subject (no cross-leakage)
 *  - cold vs warm cache timing via cachedListExaminerMisconceptions
 *  - returned tips for Mathematics+9709 are mathematics-only
 */
import { Pool } from "pg";
import { storage } from "../server/storage";
import { cachedListExaminerMisconceptions } from "../server/services/examinerMisconceptionsCache";

function makePool(): Pool {
  const url = process.env.SUPABASE_URL;
  if (!url) throw new Error("SUPABASE_URL is not set.");
  const useSsl =
    url.toLowerCase().includes("supabase.co") ||
    url.toLowerCase().includes("sslmode=require");
  return new Pool({
    connectionString: useSsl ? url.replace(/[?&]sslmode=require/i, "") : url,
    ssl: useSsl ? { rejectUnauthorized: false } : undefined,
    max: 5,
  });
}

async function main() {
  const pool = makePool();

  console.log("=== 1. Index check ===");
  const idx = await pool.query(
    `SELECT indexname FROM pg_indexes
     WHERE schemaname = 'public'
       AND (indexname LIKE 'idx_examiner%' OR indexname LIKE 'idx_syllabus_documents%')
     ORDER BY indexname`,
  );
  for (const r of idx.rows) console.log("  ", r.indexname);

  console.log("\n=== 2. Misconception totals ===");
  const tot = await pool.query(`SELECT COUNT(*)::int AS n FROM examiner_misconceptions`);
  console.log("  total rows:", tot.rows[0].n);
  const docTot = await pool.query(
    `SELECT COUNT(*)::int AS n FROM syllabus_documents WHERE document_type = 'examiner_report'`,
  );
  console.log("  examiner_report documents:", docTot.rows[0].n);

  console.log("\n=== 3. Rows per subject (top 15) ===");
  const subj = await pool.query(
    `SELECT subject, COUNT(*)::int AS n
     FROM examiner_misconceptions
     WHERE subject IS NOT NULL
     GROUP BY subject
     ORDER BY n DESC
     LIMIT 15`,
  );
  for (const r of subj.rows) console.log(`  ${r.n.toString().padStart(4)}  ${r.subject}`);

  console.log("\n=== 4. Cold vs warm cache (board=Cambridge, syllabus=9709, subject=Mathematics) ===");
  const filter = { board: "Cambridge", syllabusCode: "9709", subject: "Mathematics" } as const;

  const t1 = process.hrtime.bigint();
  const cold = await cachedListExaminerMisconceptions(filter, async () =>
    storage.listExaminerMisconceptions(filter),
  );
  const tCold = Number(process.hrtime.bigint() - t1) / 1e6;
  console.log(`  cold: ${cold.length} rows in ${tCold.toFixed(1)} ms`);

  const t2 = process.hrtime.bigint();
  const warm = await cachedListExaminerMisconceptions(filter, async () =>
    storage.listExaminerMisconceptions(filter),
  );
  const tWarm = Number(process.hrtime.bigint() - t2) / 1e6;
  console.log(`  warm: ${warm.length} rows in ${tWarm.toFixed(1)} ms`);
  console.log(`  speedup: ${(tCold / Math.max(tWarm, 0.01)).toFixed(0)}x`);

  console.log("\n=== 5. Cross-subject leakage check ===");
  const distinct = new Set(cold.map((r) => (r.subject ?? "").toLowerCase().trim()));
  console.log("  distinct subjects in result:", Array.from(distinct).join(", ") || "(none)");
  if (distinct.size === 1 && distinct.has("mathematics")) {
    console.log("  PASS — all rows are Mathematics");
  } else {
    console.log("  WARN — rows are not exclusively Mathematics");
  }

  console.log("\n=== 6. Sample tips ===");
  for (const m of cold.slice(0, 3)) {
    console.log(`  • [${m.topic}] ${m.misconception.slice(0, 90)}…`);
  }

  await pool.end();
}

main().catch((e) => {
  console.error("[verify] failed:", e);
  process.exit(1);
});
