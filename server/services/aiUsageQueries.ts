/**
 * Historical read queries over `ai_usage_logs`.
 *
 * Powers the Super Admin "AI spend" panel: rollups per tutor (by name/email
 * via join on `soma_users`), per student, per day, and recent calls.
 *
 * All amounts are stored as `cost_micro_usd` in the table; we expose them as
 * USD floats here so the frontend doesn't have to know about the encoding.
 */
import { db } from "../db";
import { aiUsageLogs, somaUsers } from "@shared/schema";
import { and, desc, eq, gte, sql } from "drizzle-orm";

export interface UsageRangeOptions {
  /** ISO timestamp lower bound. Defaults to 30 days ago. */
  since?: Date;
}

export interface UsageByUserRow {
  userId: string;
  email: string | null;
  displayName: string | null;
  role: string | null;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface UsageDailyRow {
  day: string; // YYYY-MM-DD UTC
  calls: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

export interface UsageRecentRow {
  id: number;
  createdAt: string;
  provider: string;
  model: string;
  route: string | null;
  taskType: string | null;
  userId: string | null;
  email: string | null;
  displayName: string | null;
  role: string | null;
  costUsd: number | null;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  success: boolean;
  cached: boolean;
}

export interface UsageHistorical {
  rangeStart: string;
  totals: { calls: number; costUsd: number; inputTokens: number; outputTokens: number };
  byTutor: UsageByUserRow[];
  byStudent: UsageByUserRow[];
  byDay: UsageDailyRow[];
  recent: UsageRecentRow[];
}

const microToUsd = (micro: number | null | undefined): number => {
  if (micro === null || micro === undefined) return 0;
  return micro / 1_000_000;
};

function defaultSince(): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 30);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

export async function getHistoricalUsage(options: UsageRangeOptions = {}): Promise<UsageHistorical> {
  const empty: UsageHistorical = {
    rangeStart: (options.since ?? defaultSince()).toISOString(),
    totals: { calls: 0, costUsd: 0, inputTokens: 0, outputTokens: 0 },
    byTutor: [],
    byStudent: [],
    byDay: [],
    recent: [],
  };
  if (!db) return empty;

  const since = options.since ?? defaultSince();

  // ── Totals ─────────────────────────────────────────────────────────────
  const totalsRows = await db
    .select({
      calls: sql<number>`count(*)::int`,
      costMicro: sql<number>`coalesce(sum(${aiUsageLogs.costMicroUsd}), 0)::bigint`,
      inputTokens: sql<number>`coalesce(sum(${aiUsageLogs.inputTokens}), 0)::bigint`,
      outputTokens: sql<number>`coalesce(sum(${aiUsageLogs.outputTokens}), 0)::bigint`,
    })
    .from(aiUsageLogs)
    .where(gte(aiUsageLogs.createdAt, since));
  const totalsRow = totalsRows[0] ?? { calls: 0, costMicro: 0, inputTokens: 0, outputTokens: 0 };

  // ── By user, joined with soma_users so the dashboard can show names ────
  const byUserRows = await db
    .select({
      userId: aiUsageLogs.userId,
      email: somaUsers.email,
      displayName: somaUsers.displayName,
      role: somaUsers.role,
      calls: sql<number>`count(*)::int`,
      inputTokens: sql<number>`coalesce(sum(${aiUsageLogs.inputTokens}), 0)::bigint`,
      outputTokens: sql<number>`coalesce(sum(${aiUsageLogs.outputTokens}), 0)::bigint`,
      costMicro: sql<number>`coalesce(sum(${aiUsageLogs.costMicroUsd}), 0)::bigint`,
    })
    .from(aiUsageLogs)
    .leftJoin(somaUsers, eq(somaUsers.id, aiUsageLogs.userId))
    .where(and(gte(aiUsageLogs.createdAt, since), sql`${aiUsageLogs.userId} is not null`))
    .groupBy(aiUsageLogs.userId, somaUsers.email, somaUsers.displayName, somaUsers.role)
    .orderBy(desc(sql`coalesce(sum(${aiUsageLogs.costMicroUsd}), 0)`));

  const allByUser: UsageByUserRow[] = byUserRows.map((r) => ({
    userId: r.userId as string,
    email: r.email ?? null,
    displayName: r.displayName ?? null,
    role: r.role ?? null,
    calls: Number(r.calls) || 0,
    inputTokens: Number(r.inputTokens) || 0,
    outputTokens: Number(r.outputTokens) || 0,
    costUsd: microToUsd(Number(r.costMicro) || 0),
  }));

  const byTutor = allByUser.filter((r) => r.role === "tutor" || r.role === "super_admin");
  const byStudent = allByUser.filter((r) => r.role === "student");

  // ── By day (UTC) ───────────────────────────────────────────────────────
  const byDayRows = await db
    .select({
      day: sql<string>`to_char(date_trunc('day', ${aiUsageLogs.createdAt}) at time zone 'UTC', 'YYYY-MM-DD')`,
      calls: sql<number>`count(*)::int`,
      inputTokens: sql<number>`coalesce(sum(${aiUsageLogs.inputTokens}), 0)::bigint`,
      outputTokens: sql<number>`coalesce(sum(${aiUsageLogs.outputTokens}), 0)::bigint`,
      costMicro: sql<number>`coalesce(sum(${aiUsageLogs.costMicroUsd}), 0)::bigint`,
    })
    .from(aiUsageLogs)
    .where(gte(aiUsageLogs.createdAt, since))
    .groupBy(sql`date_trunc('day', ${aiUsageLogs.createdAt})`)
    .orderBy(sql`date_trunc('day', ${aiUsageLogs.createdAt})`);

  const byDay: UsageDailyRow[] = byDayRows.map((r) => ({
    day: r.day,
    calls: Number(r.calls) || 0,
    costUsd: microToUsd(Number(r.costMicro) || 0),
    inputTokens: Number(r.inputTokens) || 0,
    outputTokens: Number(r.outputTokens) || 0,
  }));

  // ── Recent (last 50 calls) ─────────────────────────────────────────────
  const recentRows = await db
    .select({
      id: aiUsageLogs.id,
      createdAt: aiUsageLogs.createdAt,
      provider: aiUsageLogs.provider,
      model: aiUsageLogs.model,
      route: aiUsageLogs.route,
      taskType: aiUsageLogs.taskType,
      userId: aiUsageLogs.userId,
      email: somaUsers.email,
      displayName: somaUsers.displayName,
      role: somaUsers.role,
      costMicro: aiUsageLogs.costMicroUsd,
      inputTokens: aiUsageLogs.inputTokens,
      outputTokens: aiUsageLogs.outputTokens,
      latencyMs: aiUsageLogs.latencyMs,
      success: aiUsageLogs.success,
      cached: aiUsageLogs.cached,
    })
    .from(aiUsageLogs)
    .leftJoin(somaUsers, eq(somaUsers.id, aiUsageLogs.userId))
    .orderBy(desc(aiUsageLogs.createdAt))
    .limit(50);

  const recent: UsageRecentRow[] = recentRows.map((r) => ({
    id: r.id,
    createdAt: r.createdAt.toISOString(),
    provider: r.provider,
    model: r.model,
    route: r.route ?? null,
    taskType: r.taskType ?? null,
    userId: r.userId ?? null,
    email: r.email ?? null,
    displayName: r.displayName ?? null,
    role: r.role ?? null,
    costUsd: r.costMicro === null || r.costMicro === undefined ? null : microToUsd(r.costMicro),
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    latencyMs: r.latencyMs,
    success: r.success,
    cached: r.cached,
  }));

  return {
    rangeStart: since.toISOString(),
    totals: {
      calls: Number(totalsRow.calls) || 0,
      costUsd: microToUsd(Number(totalsRow.costMicro) || 0),
      inputTokens: Number(totalsRow.inputTokens) || 0,
      outputTokens: Number(totalsRow.outputTokens) || 0,
    },
    byTutor,
    byStudent,
    byDay,
    recent,
  };
}
