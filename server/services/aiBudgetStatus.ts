import type { UsageHistorical } from "./aiUsageQueries";

export interface AiBudgetStatus {
  mode: "monitor_only";
  dailyBudgetUsd: number | null;
  rangeBudgetUsd: number | null;
  spendUsd: number;
  projectedDailySpendUsd: number | null;
  budgetUsedPercent: number | null;
  state: "ok" | "watch" | "over_budget" | "unconfigured";
  message: string;
}

function parseUsdEnv(name: string): number | null {
  const raw = process.env[name];
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

export function getAiBudgetStatus(historical: UsageHistorical, rangeDays: number): AiBudgetStatus {
  const dailyBudgetUsd = parseUsdEnv("AI_DAILY_BUDGET_USD");
  const spendUsd = historical.totals.costUsd;
  const projectedDailySpendUsd = rangeDays > 0 ? spendUsd / rangeDays : null;
  const rangeBudgetUsd = dailyBudgetUsd === null ? null : dailyBudgetUsd * rangeDays;
  const budgetUsedPercent = rangeBudgetUsd && rangeBudgetUsd > 0 ? Math.round((spendUsd / rangeBudgetUsd) * 100) : null;

  if (dailyBudgetUsd === null || rangeBudgetUsd === null || budgetUsedPercent === null) {
    return {
      mode: "monitor_only",
      dailyBudgetUsd,
      rangeBudgetUsd,
      spendUsd,
      projectedDailySpendUsd,
      budgetUsedPercent,
      state: "unconfigured",
      message: "AI spend is monitored, but no AI_DAILY_BUDGET_USD limit is configured yet.",
    };
  }

  const state: AiBudgetStatus["state"] = budgetUsedPercent >= 100 ? "over_budget" : budgetUsedPercent >= 80 ? "watch" : "ok";
  const message = state === "over_budget"
    ? "AI spend is above the configured monitor-only budget for this range. Review usage before enabling hard limits."
    : state === "watch"
      ? "AI spend is approaching the configured monitor-only budget for this range."
      : "AI spend is within the configured monitor-only budget for this range.";

  return {
    mode: "monitor_only",
    dailyBudgetUsd,
    rangeBudgetUsd,
    spendUsd,
    projectedDailySpendUsd,
    budgetUsedPercent,
    state,
    message,
  };
}
