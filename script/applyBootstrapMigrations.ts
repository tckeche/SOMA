import { connectDb, pool } from "../server/db";
import { applyBootstrapMigrations } from "../server/bootstrap";
import { verifySchemaMatchesDb, hasDrift, formatDriftReport } from "../server/schemaVerifier";

async function main() {
  await connectDb();
  if (!pool) throw new Error("Database connection unavailable");
  await applyBootstrapMigrations();
  const drift = await verifySchemaMatchesDb(pool);
  if (hasDrift(drift)) throw new Error(`Schema drift detected after bootstrap:\n${formatDriftReport(drift)}`);
}
main().then(async () => { await pool?.end(); console.log("Bootstrap migrations applied and schema verified."); }).catch(async (err) => { await pool?.end(); console.error(err instanceof Error ? err.message : "Schema verification failed"); process.exit(1); });
