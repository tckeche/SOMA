/**
 * Phase 1 backfill — populate catalogue FK columns on legacy rows.
 *
 * Targets:
 *   - student_topic_mastery.subtopic_id       (and learning_requirement_id when an exact LR match exists)
 *   - soma_questions.subtopic_id              (using topic_tag / subtopic_tag)
 *   - examiner_misconceptions.subtopic_id     (using topic / subtopic strings)
 *
 * Strategy
 * ────────
 * Pure SQL / Drizzle, no AI. For each legacy row we look for a catalogue
 * subtopic whose title matches the legacy `subtopic` (or `subtopicTag`)
 * field case-insensitively, scoped to a syllabus the user / quiz /
 * misconception is actually attached to. Where multiple subtopics share a
 * title (rare but possible across syllabi) we leave the row null and log
 * the conflict — humans can resolve via a follow-up review.
 *
 * Idempotent: rows that already have `subtopic_id` set are skipped.
 *
 * Usage:
 *   npx tsx scripts/backfillCatalogueFks.ts             # run all backfills
 *   npx tsx scripts/backfillCatalogueFks.ts --dry-run   # report only
 *   npx tsx scripts/backfillCatalogueFks.ts --table=mastery|questions|misconceptions
 *
 * Environment:
 *   DATABASE_URL  — Postgres connection (required)
 */
import "dotenv/config";
import { eq, inArray } from "drizzle-orm";
import { connectDb, db } from "../server/db";
import {
  examinerMisconceptions,
  somaQuestions,
  somaQuizzes,
  studentSubjects,
  studentTopicMastery,
  syllabi,
} from "../shared/schema";
import { resolveSubtopicId } from "../server/services/subtopicResolver";
import { extractSyllabusCode } from "../server/services/syllabusNormalizer";
import { normalizeQuestionTag } from "../server/services/questionTagNormalizer";

interface CliOptions {
  dryRun: boolean;
  table: "all" | "mastery" | "questions" | "misconceptions";
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = { dryRun: false, table: "all" };
  for (const arg of argv.slice(2)) {
    if (arg === "--dry-run") opts.dryRun = true;
    else if (arg.startsWith("--table=")) {
      const t = arg.split("=")[1];
      if (t === "mastery" || t === "questions" || t === "misconceptions") opts.table = t;
      else throw new Error(`Unknown --table value: ${t}`);
    }
  }
  return opts;
}

interface Stats {
  scanned: number;
  matched: number;
  ambiguous: number;
  unmatched: number;
  skipped: number;
  written: number;
}

function emptyStats(): Stats {
  return { scanned: 0, matched: 0, ambiguous: 0, unmatched: 0, skipped: 0, written: 0 };
}

function printStats(label: string, s: Stats, dryRun: boolean): void {
  const action = dryRun ? "would write" : "wrote";
  console.log(
    `[${label}] scanned=${s.scanned} matched=${s.matched} ${action}=${s.written} ambiguous=${s.ambiguous} unmatched=${s.unmatched} skipped=${s.skipped}`,
  );
}

async function getStudentCandidateSyllabusIds(studentId: string): Promise<number[]> {
  if (!db) return [];
  const enrollments = await db
    .select({ examBody: studentSubjects.examBody, syllabusCode: studentSubjects.syllabusCode })
    .from(studentSubjects)
    .where(eq(studentSubjects.studentId, studentId));
  if (enrollments.length === 0) return [];
  const codes = Array.from(new Set(enrollments.map((e) => e.syllabusCode)));
  const ids = await db
    .select({ id: syllabi.id })
    .from(syllabi)
    .where(inArray(syllabi.syllabusCode, codes));
  return ids.map((r) => r.id);
}

async function backfillMastery(dryRun: boolean): Promise<Stats> {
  const stats = emptyStats();
  if (!db) return stats;

  const rows = await db
    .select({
      id: studentTopicMastery.id,
      studentId: studentTopicMastery.studentId,
      subject: studentTopicMastery.subject,
      topic: studentTopicMastery.topic,
      subtopic: studentTopicMastery.subtopic,
      currentSubtopicId: studentTopicMastery.subtopicId,
    })
    .from(studentTopicMastery);

  for (const row of rows) {
    stats.scanned++;
    if (row.currentSubtopicId !== null) {
      stats.skipped++;
      continue;
    }
    const candidateSyllabusIds = await getStudentCandidateSyllabusIds(row.studentId);
    const { subtopicId, ambiguous } = await resolveSubtopicId({
      subject: row.subject,
      topic: row.topic,
      subtopic: row.subtopic ?? null,
      candidateSyllabusIds: candidateSyllabusIds.length > 0 ? candidateSyllabusIds : undefined,
    });
    if (ambiguous) {
      stats.ambiguous++;
      continue;
    }
    if (subtopicId === null) {
      stats.unmatched++;
      continue;
    }
    stats.matched++;
    if (!dryRun) {
      await db.update(studentTopicMastery).set({ subtopicId }).where(eq(studentTopicMastery.id, row.id));
      stats.written++;
    } else {
      stats.written++; // counts intent in dry-run mode
    }
  }
  return stats;
}

async function getQuizCandidateSyllabusIds(quizId: number): Promise<number[]> {
  if (!db) return [];
  const [quiz] = await db
    .select({ syllabus: somaQuizzes.syllabus, subject: somaQuizzes.subject })
    .from(somaQuizzes)
    .where(eq(somaQuizzes.id, quizId));
  if (!quiz) return [];
  // The `syllabus` column is free-text — common values include
  // "Cambridge Syllabus · 9709", "Cambridge", "cambridge", "Cambridgee",
  // "Cambridge · mathematics-0580-…" and bare codes like "9709".
  // Pull the embedded 4-digit code so the catalogue join resolves.
  const code = extractSyllabusCode(quiz.syllabus);
  if (!code) return [];
  const ids = await db
    .select({ id: syllabi.id })
    .from(syllabi)
    .where(eq(syllabi.syllabusCode, code));
  return ids.map((r) => r.id);
}

async function backfillQuestions(dryRun: boolean): Promise<Stats> {
  const stats = emptyStats();
  if (!db) return stats;

  const rows = await db
    .select({
      id: somaQuestions.id,
      quizId: somaQuestions.quizId,
      topicTag: somaQuestions.topicTag,
      subtopicTag: somaQuestions.subtopicTag,
      currentSubtopicId: somaQuestions.subtopicId,
      quizSubject: somaQuizzes.subject,
    })
    .from(somaQuestions)
    .leftJoin(somaQuizzes, eq(somaQuizzes.id, somaQuestions.quizId));

  // Cache candidate-syllabus lookups per quiz.
  const candidatesByQuiz = new Map<number, number[]>();
  for (const row of rows) {
    stats.scanned++;
    if (row.currentSubtopicId !== null) {
      stats.skipped++;
      continue;
    }
    if (!candidatesByQuiz.has(row.quizId)) {
      candidatesByQuiz.set(row.quizId, await getQuizCandidateSyllabusIds(row.quizId));
    }
    const candidateSyllabusIds = candidatesByQuiz.get(row.quizId) ?? [];
    const { subtopicId, ambiguous } = await resolveSubtopicId({
      subject: row.quizSubject ?? null,
      topic: normalizeQuestionTag(row.topicTag) ?? row.topicTag,
      subtopic: normalizeQuestionTag(row.subtopicTag) ?? row.subtopicTag,
      candidateSyllabusIds: candidateSyllabusIds.length > 0 ? candidateSyllabusIds : undefined,
    });
    if (ambiguous) {
      stats.ambiguous++;
      continue;
    }
    if (subtopicId === null) {
      stats.unmatched++;
      continue;
    }
    stats.matched++;
    if (!dryRun) {
      await db.update(somaQuestions).set({ subtopicId }).where(eq(somaQuestions.id, row.id));
      stats.written++;
    } else {
      stats.written++;
    }
  }
  return stats;
}

async function backfillMisconceptions(dryRun: boolean): Promise<Stats> {
  const stats = emptyStats();
  if (!db) return stats;

  const rows = await db
    .select({
      id: examinerMisconceptions.id,
      board: examinerMisconceptions.board,
      syllabusCode: examinerMisconceptions.syllabusCode,
      subject: examinerMisconceptions.subject,
      topic: examinerMisconceptions.topic,
      subtopic: examinerMisconceptions.subtopic,
      currentSubtopicId: examinerMisconceptions.subtopicId,
    })
    .from(examinerMisconceptions);

  // Cache candidate-syllabus lookups per syllabusCode.
  const candidatesByCode = new Map<string, number[]>();
  for (const row of rows) {
    stats.scanned++;
    if (row.currentSubtopicId !== null) {
      stats.skipped++;
      continue;
    }
    if (!candidatesByCode.has(row.syllabusCode)) {
      const ids = await db
        .select({ id: syllabi.id })
        .from(syllabi)
        .where(eq(syllabi.syllabusCode, row.syllabusCode));
      candidatesByCode.set(row.syllabusCode, ids.map((r) => r.id));
    }
    const candidateSyllabusIds = candidatesByCode.get(row.syllabusCode) ?? [];
    const { subtopicId, ambiguous } = await resolveSubtopicId({
      subject: row.subject,
      topic: row.topic,
      subtopic: row.subtopic,
      candidateSyllabusIds: candidateSyllabusIds.length > 0 ? candidateSyllabusIds : undefined,
    });
    if (ambiguous) {
      stats.ambiguous++;
      continue;
    }
    if (subtopicId === null) {
      stats.unmatched++;
      continue;
    }
    stats.matched++;
    if (!dryRun) {
      await db.update(examinerMisconceptions).set({ subtopicId }).where(eq(examinerMisconceptions.id, row.id));
      stats.written++;
    } else {
      stats.written++;
    }
  }
  return stats;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv);
  await connectDb();
  if (!db) {
    console.error("DATABASE_URL not configured — backfill cannot proceed.");
    process.exit(1);
  }

  console.log(`[backfill] mode=${opts.dryRun ? "DRY RUN" : "LIVE"} table=${opts.table}`);

  if (opts.table === "all" || opts.table === "mastery") {
    printStats("mastery", await backfillMastery(opts.dryRun), opts.dryRun);
  }
  if (opts.table === "all" || opts.table === "questions") {
    printStats("questions", await backfillQuestions(opts.dryRun), opts.dryRun);
  }
  if (opts.table === "all" || opts.table === "misconceptions") {
    printStats("misconceptions", await backfillMisconceptions(opts.dryRun), opts.dryRun);
  }

  console.log(`[backfill] done.${opts.dryRun ? " (no rows written)" : ""}`);
  process.exit(0);
}

main().catch((err) => {
  console.error("[backfill] fatal:", err);
  process.exit(1);
});
