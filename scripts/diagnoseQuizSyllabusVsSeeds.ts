/**
 * Diagnostic — for the most recent N quizzes in `soma_quizzes`, parse
 * the `syllabus` field the same way the route handler does and count
 * how many approved examiner_misconceptions match that scope. Lets us
 * tell whether the Maker's distractor seeding is silently returning
 * empty because the tutor-side syllabus strings don't line up with
 * the misconceptions' (board, syllabusCode), without needing to spin
 * up a real generation request.
 *
 * If the per-row "approved seeds available" column is ZERO for the
 * recent quizzes, the data is misaligned (no fix to the storage layer
 * will help — the seeding had nothing to seed with). If it is non-zero
 * but the quizzes nonetheless were not seeded, the issue is in the
 * runtime path (deployment, route handler, or storage layer).
 *
 * Usage:
 *   npx tsx scripts/diagnoseQuizSyllabusVsSeeds.ts
 *   npx tsx scripts/diagnoseQuizSyllabusVsSeeds.ts --limit=20
 *   npx tsx scripts/diagnoseQuizSyllabusVsSeeds.ts --json
 *
 * Read-only — never writes.
 */
import "dotenv/config";
import { desc, eq, sql } from "drizzle-orm";
import { connectDb, db } from "../server/db";
import { examinerMisconceptions, somaQuizzes } from "../shared/schema";
import { listApprovedSeeds } from "../server/services/examinerDistractorSeeds";

interface CliOptions {
  limit: number;
  json: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = { limit: 10, json: false };
  for (const raw of argv.slice(2)) {
    if (raw === "--json") opts.json = true;
    else if (raw === "--help" || raw === "-h") {
      console.log("Usage: npx tsx scripts/diagnoseQuizSyllabusVsSeeds.ts [--limit=10] [--json]");
      process.exit(0);
    } else if (raw.startsWith("--limit=")) {
      const n = Number(raw.slice("--limit=".length));
      if (!Number.isFinite(n) || n <= 0) throw new Error(`bad ${raw}`);
      opts.limit = Math.floor(n);
    } else throw new Error(`unknown flag: ${raw}`);
  }
  return opts;
}

/** Mirrors `parseBoardAndSyllabusCode` in server/routes.ts:4609. */
function parseSyllabus(raw: string | null): { board: string; syllabusCode: string } | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const codeMatch = trimmed.match(/\b(\d{3,6}[A-Za-z]?)\b/);
  if (!codeMatch) {
    return { board: trimmed, syllabusCode: trimmed };
  }
  const syllabusCode = codeMatch[1];
  const board = trimmed.replace(syllabusCode, "").trim() || trimmed;
  return { board, syllabusCode };
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv);
  await connectDb();
  if (!db) throw new Error("db not initialised");

  // Most recent quizzes (most recent activity is the most diagnostic).
  const recentQuizzes = await db
    .select({
      id: somaQuizzes.id,
      title: somaQuizzes.title,
      syllabus: somaQuizzes.syllabus,
      topic: somaQuizzes.topic,
      subject: somaQuizzes.subject,
      level: somaQuizzes.level,
    })
    .from(somaQuizzes)
    .orderBy(desc(somaQuizzes.id))
    .limit(opts.limit);

  // Approved-misconception count by (board, syllabusCode). Used only
  // for the global "top scopes" summary at the bottom of the report —
  // per-quiz "available seeds" comes from the actual listApprovedSeeds
  // function below so the diagnostic can never drift from production
  // logic.
  const approvedByScope = await db
    .select({
      board: examinerMisconceptions.board,
      syllabusCode: examinerMisconceptions.syllabusCode,
      count: sql<number>`count(*)::int`,
    })
    .from(examinerMisconceptions)
    .where(eq(examinerMisconceptions.status, "approved"))
    .groupBy(examinerMisconceptions.board, examinerMisconceptions.syllabusCode);

  // For each recent quiz, call the same listApprovedSeeds function the
  // route handler uses. This mirrors the production code path exactly,
  // so any future change to the matching logic shows up here without
  // needing to update the diagnostic. Use a generous limit so the
  // count reflects "how many seeds would have been available" rather
  // than the runtime cap (default 6).
  const rows = await Promise.all(
    recentQuizzes.map(async (q) => {
      const parsed = parseSyllabus(q.syllabus);
      const seeds = parsed
        ? await listApprovedSeeds({
            board: parsed.board,
            syllabusCode: parsed.syllabusCode,
            limit: 20,
          })
        : [];
      return {
        quizId: q.id,
        title: q.title,
        syllabus: q.syllabus,
        parsedBoard: parsed?.board ?? null,
        parsedSyllabusCode: parsed?.syllabusCode ?? null,
        approvedSeedsAvailable: seeds.length,
      };
    }),
  );

  if (opts.json) {
    console.log(JSON.stringify({ rows, allScopes: approvedByScope }, null, 2));
    return;
  }

  const fmt = (n: number) => new Intl.NumberFormat("en-GB").format(n);

  console.log("");
  console.log(`Most recent ${recentQuizzes.length} quizzes — does each scope have approved seeds?`);
  console.log("");
  console.log("  quizId | parsed board / syllabus           | approved seeds | original syllabus string");
  console.log("  ------ | --------------------------------- | -------------- | ------------------------");
  for (const r of rows) {
    const scope = r.parsedBoard
      ? `${r.parsedBoard} / ${r.parsedSyllabusCode}`.padEnd(33)
      : "(unparseable)".padEnd(33);
    const seedDisplay = `${fmt(r.approvedSeedsAvailable)}`.padStart(14);
    console.log(`  ${String(r.quizId).padStart(6)} | ${scope} | ${seedDisplay} | ${r.syllabus ?? "(null)"}`);
  }

  // Summary aggregates — easier to reason about than per-row.
  const withSeeds = rows.filter((r) => r.approvedSeedsAvailable > 0).length;
  console.log("");
  console.log(`${fmt(withSeeds)} of ${fmt(rows.length)} recent quizzes are on a scope with available approved seeds.`);
  console.log("");

  console.log("All approved-misconception scopes (top 20 by count):");
  console.log("");
  console.log("  board                              | syllabusCode | approved");
  console.log("  ---------------------------------- | ------------ | --------");
  approvedByScope
    .sort((a, b) => b.count - a.count)
    .slice(0, 20)
    .forEach((s) => {
      console.log(
        `  ${(s.board ?? "(null)").padEnd(34)} | ${(s.syllabusCode ?? "(null)").padEnd(12)} | ${fmt(s.count).padStart(7)}`,
      );
    });
  console.log("");

  if (withSeeds === 0) {
    console.log("DIAGNOSIS: every recent quiz is on a scope with ZERO approved seeds available.");
    console.log("           The seeding silently returned empty — there was nothing to seed with.");
    console.log("           Check whether the tutor's syllabus string format matches the");
    console.log("           (board, syllabusCode) values stored on examiner_misconceptions.");
  } else if (withSeeds < rows.length) {
    console.log("DIAGNOSIS: some recent quizzes are on scopes WITHOUT approved seeds, others have them.");
    console.log("           The unseeded ones are honest empties; the rest should have been seeded —");
    console.log("           if they are not in soma_questions.target_misconception_ids, the runtime");
    console.log("           is the suspect (deployment lag, route bypass, storage path).");
  } else {
    console.log("DIAGNOSIS: every recent quiz is on a scope with approved seeds available, yet none");
    console.log("           are seeded. The data alignment is fine — the bug is in the runtime path.");
    console.log("           Likely culprit: deployed app is running pre-fix code (storage was silently");
    console.log("           dropping target_misconception_ids before the storage.ts fix landed).");
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    process.exit(1);
  });
