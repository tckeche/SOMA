/**
 * Startup schema-drift detector.
 *
 * Walks every `pgTable(...)` declared in `shared/schema.ts`, asks the live
 * database which columns those tables actually have, and reports anything
 * the schema declares but the DB is missing.
 *
 * This exists because schema changes have a single runtime authority —
 * `BOOTSTRAP_QUERIES` in `server/bootstrap.ts` — and humans forget to keep
 * it in sync with `shared/schema.ts`. When that happens, the column is
 * silently absent in production and the first SELECT that touches it 500s
 * (e.g. the `option_rationales does not exist` outage). Running this
 * check at startup turns that "discovered in production at runtime" failure
 * into "logged loudly before the server accepts traffic" (and in production,
 * a hard startup failure).
 *
 * The check is one-way on purpose: extra columns/tables in the DB that
 * aren't in `shared/schema.ts` are fine (legacy / not-yet-removed columns
 * shouldn't block startup). Only missing-from-DB drift is an error.
 */
import { is } from "drizzle-orm";
import { PgTable, getTableConfig } from "drizzle-orm/pg-core";
import type { Pool } from "pg";
import * as schema from "@shared/schema";

export interface SchemaDriftReport {
  missingTables: string[];
  missingColumns: Array<{ table: string; column: string }>;
}

interface DeclaredTable {
  name: string;
  columns: string[];
}

/**
 * Collect every `pgTable(...)` exported from `shared/schema.ts` together
 * with its declared column names. Exported for tests so they can assert
 * the introspection finds the tables we expect without standing up a DB.
 */
export function collectDeclaredTables(): DeclaredTable[] {
  const tables: DeclaredTable[] = [];
  for (const exported of Object.values(schema)) {
    if (!is(exported, PgTable)) continue;
    const cfg = getTableConfig(exported as PgTable);
    tables.push({
      name: cfg.name,
      columns: cfg.columns.map((c) => c.name),
    });
  }
  return tables;
}

/**
 * Pure diff between what `shared/schema.ts` declares and what the live DB
 * reports via `information_schema.columns`. Pulled out so the unit test
 * can exercise it without standing up Postgres.
 */
export function diffDeclaredAgainstLive(
  declared: DeclaredTable[],
  liveRows: Array<{ table_name: string; column_name: string }>,
): SchemaDriftReport {
  const liveColumns = new Map<string, Set<string>>();
  for (const row of liveRows) {
    let set = liveColumns.get(row.table_name);
    if (!set) {
      set = new Set();
      liveColumns.set(row.table_name, set);
    }
    set.add(row.column_name);
  }

  const missingTables: string[] = [];
  const missingColumns: Array<{ table: string; column: string }> = [];

  for (const table of declared) {
    const live = liveColumns.get(table.name);
    if (!live || live.size === 0) {
      missingTables.push(table.name);
      continue;
    }
    for (const col of table.columns) {
      if (!live.has(col)) {
        missingColumns.push({ table: table.name, column: col });
      }
    }
  }

  return { missingTables, missingColumns };
}

/**
 * Run the drift check against a live `pg.Pool`. Returns the report; the
 * caller decides what to do with non-empty drift (bootstrap.ts throws in
 * production, warns in dev).
 */
export async function verifySchemaMatchesDb(
  pool: Pool,
): Promise<SchemaDriftReport> {
  const declared = collectDeclaredTables();
  const tableNames = declared.map((t) => t.name);

  if (tableNames.length === 0) {
    return { missingTables: [], missingColumns: [] };
  }

  const result = await pool.query<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = ANY($1::text[])`,
    [tableNames],
  );

  return diffDeclaredAgainstLive(declared, result.rows);
}

/**
 * Format a `SchemaDriftReport` into a multi-line message suitable for
 * surfacing in logs and `Error` messages.
 */
export function formatDriftReport(report: SchemaDriftReport): string {
  const lines: string[] = [];
  for (const t of report.missingTables) {
    lines.push(`  - missing table: ${t}`);
  }
  for (const c of report.missingColumns) {
    lines.push(`  - missing column: ${c.table}.${c.column}`);
  }
  return lines.join("\n");
}

export function hasDrift(report: SchemaDriftReport): boolean {
  return report.missingTables.length > 0 || report.missingColumns.length > 0;
}
