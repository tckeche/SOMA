/**
 * One-shot timing harness for the study-tips in-memory cache.
 * Calls cachedListExaminerMisconceptions twice with the same filter:
 * call #1 = cold (DB hit), call #2 = warm (cache hit).
 * Prints both elapsed times in ms.
 */
import "dotenv/config";
import {
  cachedListExaminerMisconceptions,
  _resetExaminerMisconceptionsCache,
} from "../server/services/examinerMisconceptionsCache";
import { storage } from "../server/storage";

async function main() {
  const filter = {
    board: "Cambridge",
    syllabusCode: "9709",
    subject: "Mathematics",
  };
  _resetExaminerMisconceptionsCache();

  const fetcher = () =>
    storage.listExaminerMisconceptions({ ...filter, status: "approved" });

  const cold = await cachedListExaminerMisconceptions(filter, fetcher);
  const warm = await cachedListExaminerMisconceptions(filter, fetcher);

  console.log(JSON.stringify({
    filter,
    cold: { rows: cold.rows.length, cacheHit: cold.cacheHit, ms: +cold.ms.toFixed(2) },
    warm: { rows: warm.rows.length, cacheHit: warm.cacheHit, ms: +warm.ms.toFixed(3) },
  }, null, 2));

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
