import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "@shared/schema";

function shouldUseSsl(url: string): boolean {
  const lower = url.toLowerCase();
  return lower.includes("supabase.co") || lower.includes("sslmode=require") || process.env.PGSSLMODE === "require";
}

function stripSslMode(url: string): string {
  return url.replace(/[?&]sslmode=[^&]*/gi, "").replace(/\?$/, "");
}

function createPool(rawUrl: string): pg.Pool {
  const useSsl = shouldUseSsl(rawUrl);
  const connectionString = useSsl ? stripSslMode(rawUrl) : rawUrl;
  return new pg.Pool({
    connectionString,
    ssl: useSsl ? { rejectUnauthorized: false } : undefined,
    max: Number(process.env.PG_POOL_MAX || 10),
    connectionTimeoutMillis: Number(process.env.PG_CONNECT_TIMEOUT_MS || 10000),
    idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT_MS || 30000),
  });
}

export let pool: pg.Pool | null = null;
export let db: ReturnType<typeof drizzle<typeof schema>> | null = null;

export async function connectDb() {
  // Preference order matters:
  //   1. SUPABASE_DB_URL — explicit Supabase Postgres URL (set in .replit
  //      [userenv.shared], available to BOTH workflow and ad-hoc shells).
  //   2. SUPABASE_URL — legacy name kept for backwards compatibility with
  //      the existing Replit Secret. Workflow-only.
  //   3. DATABASE_URL — generic fallback. NOTE: Replit auto-injects this
  //      pointing at its built-in Postgres, which is NOT the Supabase
  //      database used by this app. Kept last on purpose.
  const url =
    process.env.SUPABASE_DB_URL ||
    process.env.SUPABASE_URL ||
    process.env.DATABASE_URL;
  if (!url) {
    console.error(
      "[db] No database URL set — looked for SUPABASE_DB_URL, SUPABASE_URL, DATABASE_URL",
    );
    pool = null;
    db = null;
    return;
  }

  try {
    const p = createPool(url);
    await p.query("SELECT 1");
    const host = url.split("@")[1]?.split("/")[0] || "unknown";
    console.log(`[db] connected to ${host}`);
    pool = p;
    db = drizzle(p, { schema });
  } catch (e: any) {
    const host = url.split("@")[1]?.split("/")[0] || "unknown";
    console.error(`[db] failed to connect to ${host}: ${e.message}`);
    pool = null;
    db = null;
  }
}
