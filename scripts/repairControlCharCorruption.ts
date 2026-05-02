/**
 * One-off DB repair for the form-feed / control-char LaTeX corruption that
 * was being written by the AI pipeline before commit XXXX (see Phase 18 in
 * replit.md).
 *
 * What got corrupted: when an LLM emitted under-escaped LaTeX inside its
 * JSON response (e.g. `"\frac"` instead of `"\\frac"`), JSON.parse silently
 * turned `\f` into U+000C (form-feed) and similarly for `\b`, `\t`, `\v`,
 * `\a`. The corrupted strings then got persisted into:
 *   - soma_questions.stem
 *   - soma_questions.options[]   (jsonb array of strings)
 *   - soma_questions.correct_answer
 *   - soma_questions.explanation
 *   - soma_questions.option_rationales[].rationale
 *
 * What this script does: walks every soma_questions row, applies
 * `repairControlCharCorruption` to each affected field, and writes back
 * only the rows that actually changed. Idempotent — re-running on already-
 * clean rows is a no-op.
 *
 * Also fixes the "Option 1" / "Option 2" / "Option 3" / "Option 4"
 * placeholder bug from the old `dedupeOptions` pad logic by emitting a
 * loud sentinel so the tutor regenerates the question. Existing rows that
 * already contain those placeholders are tagged with the
 * "[OPTION GENERATION FAILED — please regenerate #N]" sentinel so they
 * surface to anyone reviewing or grading the quiz.
 *
 * Usage:
 *   npx tsx scripts/repairControlCharCorruption.ts            # dry-run
 *   npx tsx scripts/repairControlCharCorruption.ts --apply    # actually write
 */
import { connectDb, db } from "../server/db";
import { somaQuestions } from "../shared/schema";
import { sql, eq } from "drizzle-orm";
import { repairControlCharCorruption, hasControlCharCorruption } from "../server/services/aiContracts";

const DRY_RUN = !process.argv.includes("--apply");
const OPTION_GAP_PREFIX = "[OPTION GENERATION FAILED — please regenerate";
const PLACEHOLDER_RE = /^Option\s+[1-4]$/;

interface RowDiff {
  id: number;
  before: { stem?: string; options?: string[]; correct_answer?: string; explanation?: string; option_rationales?: any };
  after: { stem?: string; options?: string[]; correct_answer?: string; explanation?: string; option_rationales?: any };
  controlCharFix: boolean;
  placeholderFix: boolean;
}

function diffField<T>(name: string, before: T, after: T, target: RowDiff): boolean {
  if (JSON.stringify(before) === JSON.stringify(after)) return false;
  (target.before as any)[name] = before;
  (target.after as any)[name] = after;
  return true;
}

async function main() {
  await connectDb();
  if (!db) throw new Error("DB connection unavailable");

  console.log(`[repair] ${DRY_RUN ? "DRY-RUN" : "APPLY"} mode — scanning all soma_questions rows…`);

  const all = await db.select().from(somaQuestions);
  console.log(`[repair] loaded ${all.length} rows`);

  let scanned = 0;
  let needsFix = 0;
  let controlCharCount = 0;
  let placeholderCount = 0;
  let written = 0;
  const samples: RowDiff[] = [];

  for (const row of all) {
    scanned++;
    const diff: RowDiff = {
      id: row.id,
      before: {},
      after: {},
      controlCharFix: false,
      placeholderFix: false,
    };

    // --- Control-char corruption pass ---
    const repairedStem = typeof row.stem === "string" ? repairControlCharCorruption(row.stem) : row.stem;
    const repairedCorrect = typeof row.correctAnswer === "string" ? repairControlCharCorruption(row.correctAnswer) : row.correctAnswer;
    const repairedExplanation = typeof row.explanation === "string" ? repairControlCharCorruption(row.explanation) : row.explanation;
    const repairedOptions = Array.isArray(row.options) ? row.options.map((o) => typeof o === "string" ? repairControlCharCorruption(o) : o) : row.options;
    const repairedRationales = row.optionRationales ? repairControlCharCorruption(row.optionRationales) : row.optionRationales;

    let changedThisRow = false;
    if (diffField("stem", row.stem, repairedStem, diff)) { changedThisRow = true; diff.controlCharFix = true; }
    if (diffField("correct_answer", row.correctAnswer, repairedCorrect, diff)) { changedThisRow = true; diff.controlCharFix = true; }
    if (diffField("explanation", row.explanation, repairedExplanation, diff)) { changedThisRow = true; diff.controlCharFix = true; }
    if (diffField("options", row.options, repairedOptions, diff)) { changedThisRow = true; diff.controlCharFix = true; }
    if (diffField("option_rationales", row.optionRationales, repairedRationales, diff)) { changedThisRow = true; diff.controlCharFix = true; }

    // --- Option-N placeholder pass ---
    let cleanedOptions = repairedOptions;
    let cleanedCorrect = repairedCorrect;
    if (Array.isArray(repairedOptions)) {
      let gapCounter = 0;
      cleanedOptions = repairedOptions.map((o: any) => {
        if (typeof o === "string" && PLACEHOLDER_RE.test(o.trim())) {
          gapCounter++;
          return `${OPTION_GAP_PREFIX} #${gapCounter}]`;
        }
        return o;
      });
      if (JSON.stringify(cleanedOptions) !== JSON.stringify(repairedOptions)) {
        // If the correct_answer was the placeholder, leave it (review will catch).
        diff.before.options = repairedOptions;
        diff.after.options = cleanedOptions as string[];
        diff.placeholderFix = true;
        changedThisRow = true;
      }
    }

    if (!changedThisRow) continue;

    needsFix++;
    if (diff.controlCharFix) controlCharCount++;
    if (diff.placeholderFix) placeholderCount++;
    if (samples.length < 5) samples.push(diff);

    if (!DRY_RUN) {
      await db
        .update(somaQuestions)
        .set({
          stem: repairedStem as string,
          correctAnswer: cleanedCorrect as string,
          explanation: repairedExplanation as string,
          options: cleanedOptions as string[],
          optionRationales: repairedRationales as any,
        })
        .where(eq(somaQuestions.id, row.id));
      written++;
    }

    if (scanned % 1000 === 0) console.log(`[repair] scanned ${scanned}/${all.length} (needs fix: ${needsFix})`);
  }

  console.log("\n=== REPAIR SUMMARY ===");
  console.log(`Scanned:                    ${scanned}`);
  console.log(`Need repair:                ${needsFix}`);
  console.log(`  - control-char corrupted: ${controlCharCount}`);
  console.log(`  - "Option N" placeholder: ${placeholderCount}`);
  console.log(`Written:                    ${written}${DRY_RUN ? " (DRY-RUN — re-run with --apply to write)" : ""}`);

  if (samples.length > 0) {
    console.log("\n=== SAMPLE DIFFS (up to 5) ===");
    for (const s of samples) {
      console.log(`\n--- soma_questions.id = ${s.id} ---`);
      console.log("BEFORE:", JSON.stringify(s.before, null, 2));
      console.log("AFTER: ", JSON.stringify(s.after, null, 2));
    }
  }

  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
