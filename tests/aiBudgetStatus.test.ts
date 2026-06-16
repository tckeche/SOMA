import { afterEach, describe, expect, it } from "vitest";
import { getAiBudgetStatus } from "../server/services/aiBudgetStatus";
import type { UsageHistorical } from "../server/services/aiUsageQueries";

function historical(costUsd: number): UsageHistorical {
  return {
    rangeStart: new Date(0).toISOString(),
    totals: { calls: 10, costUsd, inputTokens: 100, outputTokens: 200 },
    byTutor: [],
    byStudent: [],
    byDay: [],
    recent: [],
  };
}

describe("getAiBudgetStatus", () => {
  afterEach(() => { delete process.env.AI_DAILY_BUDGET_USD; });

  it("reports unconfigured when no monitor budget is set", () => {
    const status = getAiBudgetStatus(historical(5), 5);
    expect(status.state).toBe("unconfigured");
    expect(status.mode).toBe("monitor_only");
  });

  it("reports watch and over-budget states against the selected range", () => {
    process.env.AI_DAILY_BUDGET_USD = "10";
    expect(getAiBudgetStatus(historical(75), 10).state).toBe("ok");
    expect(getAiBudgetStatus(historical(85), 10).state).toBe("watch");
    expect(getAiBudgetStatus(historical(105), 10).state).toBe("over_budget");
  });
});
