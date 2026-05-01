/**
 * Tier 1 — Examiner-Loop end-to-end smoke test.
 *
 * Read-only diagnostic that walks every link in the chain from
 * "approved examiner misconceptions" through to "user-facing dashboards"
 * and reports OK / WARN / FAIL on each, so a single command tells you
 * whether the loop is actually running in production rather than just
 * passing unit tests.
 *
 * The chain checked, in order:
 *
 *   INPUT   examiner_misconceptions WHERE status = 'approved'
 *     ↓
 *   MAKER   soma_questions.target_misconception_ids   (distractor seeding)
 *     ↓
 *   MARK    answer_diagnoses.misconception_id          (per-answer attribution)
 *     ↓
 *   STUDENT student_misconceptions                     (per-student rollup)
 *     ↓
 *   MASTERY student_topic_mastery.{subtopic_id, learning_requirement_id}
 *
 * Each section also reports the most recent timestamp of relevant
 * activity, so you can tell whether the chain is broken historically
 * vs broke recently.
 *
 * Usage:
 *   npx tsx scripts/smokeTestExaminerLoop.ts
 *   npx tsx scripts/smokeTestExaminerLoop.ts --json
 *   npx tsx scripts/smokeTestExaminerLoop.ts --window-days=7
 *
 * Flags:
 *   --window-days=N     Recency window for the "running this week" gauge. Default 7.
 *   --json              Machine-readable output.
 *
 * Read-only — never writes.
 */
import "dotenv/config";
import { and, desc, gte, isNotNull, sql } from "drizzle-orm";
import { connectDb, db } from "../server/db";
import {
  examinerMisconceptions,
  somaQuestions,
  answerDiagnoses,
  studentMisconceptions,
  studentTopicMastery,
} from "../shared/schema";

interface CliOptions {
  windowDays: number;
  json: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = { windowDays: 7, json: false };
  for (const raw of argv.slice(2)) {
    if (raw === "--json") opts.json = true;
    else if (raw === "--help" || raw === "-h") {
      console.log("Usage: npx tsx scripts/smokeTestExaminerLoop.ts [--window-days=7] [--json]");
      process.exit(0);
    } else if (raw.startsWith("--window-days=")) {
      const n = Number(raw.slice("--window-days=".length));
      if (!Number.isFinite(n) || n <= 0) throw new Error(`bad ${raw}`);
      opts.windowDays = Math.floor(n);
    } else throw new Error(`unknown flag: ${raw}`);
  }
  return opts;
}

type Verdict = "OK" | "WARN" | "FAIL";

interface SectionReport {
  section: string;
  verdict: Verdict;
  /** Headline metric that decided the verdict. */
  headline: string;
  /** Supporting facts to print under the headline. */
  details: string[];
  /** Most recent timestamp of relevant activity (ISO), or null. */
  lastActivityAt: string | null;
}

function pct(num: number, denom: number): string {
  if (denom === 0) return "—";
  return `${Math.round((num / denom) * 100)}%`;
}

const fmt = (n: number) => new Intl.NumberFormat("en-GB").format(n);

async function checkApprovedInput(): Promise<SectionReport> {
  if (!db) throw new Error("db not initialised");

  const [totals] = await db
    .select({
      total: sql<number>`count(*)::int`,
      approved: sql<number>`sum(case when ${examinerMisconceptions.status} = 'approved' then 1 else 0 end)::int`,
      approvedWithSubtopic: sql<number>`sum(case when ${examinerMisconceptions.status} = 'approved' and ${examinerMisconceptions.subtopicId} is not null then 1 else 0 end)::int`,
      approvedWithLearnReq: sql<number>`sum(case when ${examinerMisconceptions.status} = 'approved' and ${examinerMisconceptions.learningRequirementId} is not null then 1 else 0 end)::int`,
    })
    .from(examinerMisconceptions);

  const approved = totals.approved ?? 0;
  const withSubtopic = totals.approvedWithSubtopic ?? 0;
  const withLearnReq = totals.approvedWithLearnReq ?? 0;

  // Verdict: FAIL if no approved rows; WARN if subtopic linkage < 30%
  // (Maker can't seed); OK otherwise. Learning-requirement linkage is
  // informational — it powers the deeper coaching layer but the Maker
  // doesn't need it.
  let verdict: Verdict;
  if (approved === 0) verdict = "FAIL";
  else if (withSubtopic === 0 || withSubtopic / approved < 0.3) verdict = "WARN";
  else verdict = "OK";

  return {
    section: "INPUT — approved examiner_misconceptions",
    verdict,
    headline: `${fmt(approved)} approved (of ${fmt(totals.total ?? 0)} total)`,
    details: [
      `with subtopic_id (Maker uses):           ${fmt(withSubtopic)} (${pct(withSubtopic, approved)} of approved)`,
      `with learning_requirement_id (coaching): ${fmt(withLearnReq)} (${pct(withLearnReq, approved)} of approved)`,
    ],
    lastActivityAt: null,
  };
}

async function checkDistractorSeeding(windowDays: number): Promise<SectionReport> {
  if (!db) throw new Error("db not initialised");

  const [totals] = await db
    .select({
      total: sql<number>`count(*)::int`,
      withSeeds: sql<number>`sum(case when ${somaQuestions.targetMisconceptionIds} is not null and jsonb_array_length(${somaQuestions.targetMisconceptionIds}) > 0 then 1 else 0 end)::int`,
    })
    .from(somaQuestions);

  // soma_questions has no createdAt column — use id as a proxy for
  // recency by walking back over the most recent 5,000 ids. Ample for
  // a "is the loop running" check; not a true time-window filter.
  const [recent] = await db
    .select({
      total: sql<number>`count(*)::int`,
      withSeeds: sql<number>`sum(case when ${somaQuestions.targetMisconceptionIds} is not null and jsonb_array_length(${somaQuestions.targetMisconceptionIds}) > 0 then 1 else 0 end)::int`,
    })
    .from(somaQuestions)
    .where(gte(sql`${somaQuestions.id}`, sql`(select min(id) from soma_questions where id in (select id from soma_questions order by id desc limit 5000))`));

  // Most recent seeded question — also via id ordering.
  const [latestSeeded] = await db
    .select({ id: somaQuestions.id, quizId: somaQuestions.quizId })
    .from(somaQuestions)
    .where(
      and(
        isNotNull(somaQuestions.targetMisconceptionIds),
        sql`jsonb_array_length(${somaQuestions.targetMisconceptionIds}) > 0`,
      ),
    )
    .orderBy(desc(somaQuestions.id))
    .limit(1);

  const total = totals.total ?? 0;
  const withSeeds = totals.withSeeds ?? 0;
  const recentTotal = recent.total ?? 0;
  const recentWithSeeds = recent.withSeeds ?? 0;

  // Verdict: FAIL if zero questions ever seeded; WARN if seeded ratio
  // is below 5% (the Maker is mostly bypassed); OK otherwise.
  let verdict: Verdict;
  if (withSeeds === 0) verdict = "FAIL";
  else if (total > 0 && withSeeds / total < 0.05) verdict = "WARN";
  else verdict = "OK";

  return {
    section: "MAKER — distractor seeding (soma_questions.target_misconception_ids)",
    verdict,
    headline: `${fmt(withSeeds)} of ${fmt(total)} questions carry seeds (${pct(withSeeds, total)})`,
    details: [
      `recent slice (last ~5000 ids): ${fmt(recentWithSeeds)} of ${fmt(recentTotal)} seeded (${pct(recentWithSeeds, recentTotal)})`,
      latestSeeded
        ? `most recent seeded question:   id=${latestSeeded.id} (quiz ${latestSeeded.quizId})`
        : `most recent seeded question:   none ever`,
    ],
    lastActivityAt: null,
  };
  // (windowDays accepted for signature parity; soma_questions has no
  // timestamp so we cannot do a true time-windowed recency check here.)
  void windowDays;
}

async function checkAnswerDiagnosis(windowDays: number): Promise<SectionReport> {
  if (!db) throw new Error("db not initialised");

  const [totals] = await db
    .select({
      total: sql<number>`count(*)::int`,
      withMisconceptionLink: sql<number>`sum(case when ${answerDiagnoses.misconceptionId} is not null then 1 else 0 end)::int`,
      wrongAnswers: sql<number>`sum(case when ${answerDiagnoses.correct} = false then 1 else 0 end)::int`,
      wrongAnswersWithLink: sql<number>`sum(case when ${answerDiagnoses.correct} = false and ${answerDiagnoses.misconceptionId} is not null then 1 else 0 end)::int`,
    })
    .from(answerDiagnoses);

  const cutoff = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
  const [recent] = await db
    .select({
      total: sql<number>`count(*)::int`,
      withMisconceptionLink: sql<number>`sum(case when ${answerDiagnoses.misconceptionId} is not null then 1 else 0 end)::int`,
    })
    .from(answerDiagnoses)
    .where(gte(answerDiagnoses.createdAt, cutoff));

  const [latest] = await db
    .select({ createdAt: answerDiagnoses.createdAt })
    .from(answerDiagnoses)
    .where(isNotNull(answerDiagnoses.misconceptionId))
    .orderBy(desc(answerDiagnoses.createdAt))
    .limit(1);

  const total = totals.total ?? 0;
  const wrongAnswers = totals.wrongAnswers ?? 0;
  const wrongLinked = totals.wrongAnswersWithLink ?? 0;

  // Verdict: FAIL if no diagnoses with misconception link ever exist;
  // WARN if recent activity but link rate on wrong answers < 10%; OK
  // otherwise. (Wrong answers are the relevant denominator — correct
  // answers genuinely have no misconception to link.)
  let verdict: Verdict;
  if (totals.withMisconceptionLink === 0) verdict = "FAIL";
  else if (wrongAnswers > 0 && wrongLinked / wrongAnswers < 0.1) verdict = "WARN";
  else verdict = "OK";

  return {
    section: "MARK — answer_diagnoses.misconception_id (per-answer attribution)",
    verdict,
    headline: `${fmt(wrongLinked)} of ${fmt(wrongAnswers)} wrong answers linked to a misconception (${pct(wrongLinked, wrongAnswers)})`,
    details: [
      `total diagnoses written:     ${fmt(total)}`,
      `last ${windowDays}d activity: ${fmt(recent.total ?? 0)} new (${fmt(recent.withMisconceptionLink ?? 0)} with link)`,
    ],
    lastActivityAt: latest?.createdAt ? latest.createdAt.toISOString() : null,
  };
}

async function checkStudentMisconceptions(windowDays: number): Promise<SectionReport> {
  if (!db) throw new Error("db not initialised");

  const [totals] = await db
    .select({
      total: sql<number>`count(*)::int`,
      distinctStudents: sql<number>`count(distinct ${studentMisconceptions.studentId})::int`,
      distinctMisconceptions: sql<number>`count(distinct ${studentMisconceptions.misconceptionId})::int`,
    })
    .from(studentMisconceptions);

  const total = totals.total ?? 0;

  let verdict: Verdict;
  if (total === 0) verdict = "FAIL";
  else verdict = "OK";

  return {
    section: "STUDENT — student_misconceptions (per-student rollup)",
    verdict,
    headline: `${fmt(total)} (student × misconception) rows`,
    details: [
      `distinct students with at least one misconception: ${fmt(totals.distinctStudents ?? 0)}`,
      `distinct misconceptions referenced:                ${fmt(totals.distinctMisconceptions ?? 0)}`,
    ],
    lastActivityAt: null,
  };
  void windowDays;
}

async function checkMasteryRollups(): Promise<SectionReport> {
  if (!db) throw new Error("db not initialised");

  const [totals] = await db
    .select({
      total: sql<number>`count(*)::int`,
      withSubtopicId: sql<number>`sum(case when ${studentTopicMastery.subtopicId} is not null then 1 else 0 end)::int`,
      withLearnReqId: sql<number>`sum(case when ${studentTopicMastery.learningRequirementId} is not null then 1 else 0 end)::int`,
      tested: sql<number>`sum(case when ${studentTopicMastery.tested} = true then 1 else 0 end)::int`,
    })
    .from(studentTopicMastery);

  const [latest] = await db
    .select({ updatedAt: studentTopicMastery.updatedAt })
    .from(studentTopicMastery)
    .orderBy(desc(studentTopicMastery.updatedAt))
    .limit(1);

  const total = totals.total ?? 0;
  const withSubtopic = totals.withSubtopicId ?? 0;
  const withLearnReq = totals.withLearnReqId ?? 0;

  // Verdict: FAIL if no mastery rows; WARN if no subtopic FK on any
  // row (catalogue not migrated); OK otherwise. Learning-requirement
  // FK is informational — coaching layer needs it but mastery still
  // works without.
  let verdict: Verdict;
  if (total === 0) verdict = "FAIL";
  else if (withSubtopic === 0) verdict = "WARN";
  else verdict = "OK";

  return {
    section: "MASTERY — student_topic_mastery (catalogue grain)",
    verdict,
    headline: `${fmt(total)} mastery rows (${fmt(totals.tested ?? 0)} tested)`,
    details: [
      `with subtopic_id:           ${fmt(withSubtopic)} (${pct(withSubtopic, total)})`,
      `with learning_requirement_id: ${fmt(withLearnReq)} (${pct(withLearnReq, total)})`,
    ],
    lastActivityAt: latest?.updatedAt ? latest.updatedAt.toISOString() : null,
  };
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv);
  await connectDb();

  const sections: SectionReport[] = [
    await checkApprovedInput(),
    await checkDistractorSeeding(opts.windowDays),
    await checkAnswerDiagnosis(opts.windowDays),
    await checkStudentMisconceptions(opts.windowDays),
    await checkMasteryRollups(),
  ];

  const overall: Verdict = sections.some((s) => s.verdict === "FAIL")
    ? "FAIL"
    : sections.some((s) => s.verdict === "WARN")
      ? "WARN"
      : "OK";

  if (opts.json) {
    console.log(JSON.stringify({ overall, sections, windowDays: opts.windowDays }, null, 2));
    return;
  }

  // Plain-text status block. Aligned columns and a one-line verdict so
  // the operator can scan it in two seconds.
  const verdictMark: Record<Verdict, string> = { OK: "[ OK ]", WARN: "[WARN]", FAIL: "[FAIL]" };
  console.log("");
  console.log(`Examiner-loop smoke test — window ${opts.windowDays}d`);
  console.log("");
  for (const s of sections) {
    console.log(`${verdictMark[s.verdict]}  ${s.section}`);
    console.log(`         ${s.headline}`);
    for (const d of s.details) console.log(`         ${d}`);
    if (s.lastActivityAt) console.log(`         last activity: ${s.lastActivityAt}`);
    console.log("");
  }
  console.log(`OVERALL: ${verdictMark[overall]}`);
  console.log("");
  if (overall !== "OK") {
    console.log("FAIL = nothing written to that table; the link is broken end-to-end.");
    console.log("WARN = data exists but coverage is suspiciously low; loop may be partly bypassed.");
    console.log("");
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    process.exit(1);
  });
