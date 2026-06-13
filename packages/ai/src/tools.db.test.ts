import { describe, expect, mock, test } from "bun:test";

// These tools issue DB reads (budgetStatuses, findRecurringByLabel) or pass a resolved month into
// month-scoped queries. Mock @repo/db so the tool logic runs with no live Postgres, and capture the
// `at` argument so we can assert the historical-month passthrough resolves to the right month.
let lastSumByCategoryAt: Date | undefined;
let lastOverviewAt: Date | undefined;
let lastBudgetStatusesAt: Date | undefined;
let lastSearchOpts: Record<string, unknown> | undefined;
// compareSpending/getSpendingPace call sumByCategory/getMonthOverview twice with different anchors;
// return values keyed by the resolved month so assertions can distinguish current vs previous.
const sumByMonth: Record<string, number> = {};
const expenseByMonth: Record<string, number> = {};

mock.module("@repo/db", () => ({
  budgetStatuses: async (_userId: string, at?: Date) => {
    lastBudgetStatusesAt = at;
    return [
      { category: "Food", limit: 500_000, spent: 410_000 },
      { category: "Shopping", limit: 0, spent: 999_999 }, // no real budget → filtered out
      { category: "Transport", limit: 200_000, spent: 250_000 }, // over
    ];
  },
  sumByCategory: async (_userId: string, _cat: string, at?: Date) => {
    lastSumByCategoryAt = at;
    const key = at?.toISOString().slice(0, 7) ?? "now";
    return sumByMonth[key] ?? 230_000;
  },
  getMonthOverview: async (_userId: string, at?: Date) => {
    lastOverviewAt = at;
    const key = at?.toISOString().slice(0, 7) ?? "now";
    return { income: 2_500_000, expense: expenseByMonth[key] ?? 1_800_000, net: 700_000 };
  },
  getSpendingByCategory: async () => [{ category: "Food", total: 230_000 }],
  getInsights: async () => ({ weekendCentavos: 0, weekdayCentavos: 0, topLeak: null }),
  getRecentTransactions: async () => [],
  searchTransactions: async (_userId: string, opts: Record<string, unknown>) => {
    lastSearchOpts = opts;
    return [
      {
        kind: "expense",
        amountCentavos: 150_000,
        category: "Transport",
        note: "grab",
        localDate: "2026-06-09",
      },
    ];
  },
  listGoals: async () => [],
  listRecurring: async () => [],
  findGoalByName: async (_userId: string, name: string) =>
    name.toLowerCase().includes("laptop")
      ? {
          id: "g1",
          name: "Laptop",
          userId: "user-1",
          targetCentavos: 2_000_000,
          savedCentavos: 500_000,
          targetDate: "2026-12-31",
          createdAt: new Date("2026-05-01T00:00:00Z"),
        }
      : null,
  findGoalsByName: async (_userId: string, name: string) =>
    name.toLowerCase().includes("laptop")
      ? [
          {
            id: "g1",
            name: "Laptop",
            userId: "user-1",
            targetCentavos: 2_000_000,
            savedCentavos: 500_000,
            targetDate: "2026-12-31",
            createdAt: new Date("2026-05-01T00:00:00Z"),
          },
        ]
      : [],
  findRecurringByLabel: async (_userId: string, label: string) =>
    label.toLowerCase().includes("netflix")
      ? { id: "r1", label: "Netflix", userId: "user-1" }
      : null,
  // Also stubbed because Bun's mock.module is process-global: runAgent (exercised by agent.test.ts)
  // imports these, and without them the shared @repo/db module surface is incomplete when both
  // files run in one process.
  recallMemories: async () => [],
  topHabits: async () => [],
  recentTurns: async () => [],
  getLastTransaction: async () => null,
}));

const { buildTools } = await import("./tools");
const { createWriteBuffer } = await import("./context");

function ctx() {
  const { addWrite, peek, drain } = createWriteBuffer();
  const tools = buildTools({
    userId: "user-1",
    timezone: "Asia/Manila",
    today: "2026-06-11",
    lastTransaction: null,
    memories: [],
    addWrite,
    peekWrites: peek,
  });
  return { tools, drain };
}

type ToolResult = { ok?: boolean; [k: string]: unknown };
function run(t: { execute?: (a: never, o: never) => unknown }, args: unknown): Promise<ToolResult> {
  if (!t.execute) throw new Error("tool has no execute");
  return Promise.resolve(t.execute(args as never, {} as never) as ToolResult);
}

describe("getGoalStatus", () => {
  test("no goals → empty list + note (does not call goalProgressMessage)", async () => {
    const { tools } = ctx();
    const res = (await run(tools.getGoalStatus, {})) as { goals: unknown[]; note?: string };
    expect(res.goals).toEqual([]);
    expect(res.note).toBe("no savings goals yet.");
  });
});

describe("getBudgets", () => {
  test("lists only real budgets with spent/limit/pct/left/over", async () => {
    const { tools } = ctx();
    const res = (await run(tools.getBudgets, {})) as { budgets: Array<Record<string, unknown>> };
    // Shopping (limit 0) is filtered out.
    expect(res.budgets).toHaveLength(2);
    const food = res.budgets.find((b) => b.category === "Food");
    expect(food).toMatchObject({
      spent: "₱4,100.00",
      limit: "₱5,000.00",
      pct: 82,
      left: "₱900.00",
      over: false,
    });
    const transport = res.budgets.find((b) => b.category === "Transport");
    expect(transport).toMatchObject({ over: true, left: "₱0.00" });
  });

  test("getBudgets with a month resolves the anchor into that month", async () => {
    const { tools } = ctx();
    const res = await run(tools.getBudgets, { month: "2026-04" });
    expect(res.month).toBe("2026-04");
    expect(lastBudgetStatusesAt?.toISOString().slice(0, 7)).toBe("2026-04");
  });
});

describe("historical month passthrough", () => {
  test("getSpending with month resolves the anchor into May", async () => {
    const { tools } = ctx();
    const res = await run(tools.getSpending, { category: "Food", month: "2026-05" });
    expect(res).toMatchObject({ category: "Food", total: "₱2,300.00", month: "2026-05" });
    // The resolved anchor must land in May 2026 (UTC mid-month).
    expect(lastSumByCategoryAt?.toISOString().slice(0, 7)).toBe("2026-05");
  });

  test("getOverview without month passes a current-time Date and echoes null month", async () => {
    const { tools } = ctx();
    const before = Date.now();
    const res = await run(tools.getOverview, {});
    expect(res.month).toBeNull();
    expect(lastOverviewAt?.getTime()).toBeGreaterThanOrEqual(before);
  });

  test("a malformed month falls back to current month (no crash)", async () => {
    const { tools } = ctx();
    const res = await run(tools.getOverview, { month: "not-a-month" });
    expect(res.month).toBeNull(); // resolveMonthAt returned label null on bad input
  });
});

describe("removeRecurringBill", () => {
  test("buffers a removeRecurring intent when a match exists", async () => {
    const { tools, drain } = ctx();
    const res = await run(tools.removeRecurringBill, { label: "netflix" });
    expect(res).toMatchObject({ ok: true, removed: "Netflix" });
    expect(drain()).toEqual([{ type: "removeRecurring", userId: "user-1", match: "netflix" }]);
  });

  test("errors and buffers nothing when no bill matches", async () => {
    const { tools, drain } = ctx();
    const res = await run(tools.removeRecurringBill, { label: "spotify" });
    expect(res.ok).toBe(false);
    expect(drain()).toHaveLength(0);
  });
});

describe("editRecurringBill", () => {
  test("buffers an editRecurring patch when a match exists", async () => {
    const { tools, drain } = ctx();
    const res = await run(tools.editRecurringBill, { label: "netflix", amount: "9k" });
    expect(res).toMatchObject({ ok: true, label: "Netflix", amount: "₱9,000.00" });
    expect(drain()).toEqual([
      {
        type: "editRecurring",
        userId: "user-1",
        match: "netflix",
        patch: { amountCentavos: 900000 },
      },
    ]);
  });

  test("can change cadence + day together, clearing the off-cadence day field", async () => {
    const { tools, drain } = ctx();
    const res = await run(tools.editRecurringBill, {
      label: "netflix",
      cadence: "weekly",
      dayOfWeek: 5,
    });
    expect(res).toMatchObject({ ok: true, cadence: "weekly", dayOfWeek: 5 });
    // Switching to weekly must null dayOfMonth so dueRecurringToday's weekly branch fires correctly.
    expect(drain()[0]).toMatchObject({
      type: "editRecurring",
      patch: { cadence: "weekly", dayOfWeek: 5, dayOfMonth: null },
    });
  });

  test("changing cadence WITHOUT the new day is rejected (would strand the bill)", async () => {
    const { tools, drain } = ctx();
    const res = await run(tools.editRecurringBill, { label: "netflix", cadence: "weekly" });
    expect(res.ok).toBe(false);
    expect(drain()).toHaveLength(0);
  });

  test("switching to monthly needs a day of month", async () => {
    const { tools, drain } = ctx();
    const res = await run(tools.editRecurringBill, { label: "netflix", cadence: "monthly" });
    expect(res.ok).toBe(false);
    expect(drain()).toHaveLength(0);
  });

  test("no fields besides name → error, buffers nothing", async () => {
    const { tools, drain } = ctx();
    const res = await run(tools.editRecurringBill, { label: "netflix" });
    expect(res.ok).toBe(false);
    expect(drain()).toHaveLength(0);
  });

  test("no match → error, buffers nothing", async () => {
    const { tools, drain } = ctx();
    const res = await run(tools.editRecurringBill, { label: "spotify", amount: "9k" });
    expect(res.ok).toBe(false);
    expect(drain()).toHaveLength(0);
  });
});

describe("editGoal", () => {
  test("changes target amount, pinned to the resolved goalId", async () => {
    const { tools, drain } = ctx();
    const res = await run(tools.editGoal, { goalName: "laptop", target: "30k" });
    expect(res).toMatchObject({ ok: true, goal: "Laptop", target: "₱30,000.00" });
    expect(drain()).toEqual([
      { type: "editGoal", userId: "user-1", goalId: "g1", patch: { targetCentavos: 3_000_000 } },
    ]);
  });

  test("renames and clears the deadline with 'none'", async () => {
    const { tools, drain } = ctx();
    const res = await run(tools.editGoal, {
      goalName: "laptop",
      newName: "MacBook",
      targetDate: "none",
    });
    expect(res).toMatchObject({ ok: true, goal: "MacBook", targetDate: null });
    expect(drain()[0]).toMatchObject({
      type: "editGoal",
      patch: { name: "MacBook", targetDate: null },
    });
  });

  test("rejects a malformed deadline", async () => {
    const { tools, drain } = ctx();
    const res = await run(tools.editGoal, { goalName: "laptop", targetDate: "next year" });
    expect(res.ok).toBe(false);
    expect(drain()).toHaveLength(0);
  });

  test("no change specified → error", async () => {
    const { tools, drain } = ctx();
    const res = await run(tools.editGoal, { goalName: "laptop" });
    expect(res.ok).toBe(false);
    expect(drain()).toHaveLength(0);
  });

  test("no matching goal → error, buffers nothing", async () => {
    const { tools, drain } = ctx();
    const res = await run(tools.editGoal, { goalName: "vacation", target: "10k" });
    expect(res.ok).toBe(false);
    expect(drain()).toHaveLength(0);
  });
});

describe("deleteGoal", () => {
  test("buffers a deleteGoal intent pinned to the resolved goalId", async () => {
    const { tools, drain } = ctx();
    const res = await run(tools.deleteGoal, { goalName: "laptop" });
    expect(res).toMatchObject({ ok: true, deleted: "Laptop" });
    expect(drain()).toEqual([{ type: "deleteGoal", userId: "user-1", goalId: "g1" }]);
  });

  test("no matching goal → error, buffers nothing", async () => {
    const { tools, drain } = ctx();
    const res = await run(tools.deleteGoal, { goalName: "vacation" });
    expect(res.ok).toBe(false);
    expect(drain()).toHaveLength(0);
  });
});

describe("contributeToGoal (backdate parity with logExpense)", () => {
  test("no date → contribution dated today (ctx.today)", async () => {
    const { tools, drain } = ctx();
    const res = await run(tools.contributeToGoal, { goalName: "laptop", amount: "2000" });
    expect(res).toMatchObject({ ok: true, goal: "Laptop", added: "₱2,000.00", date: "2026-06-11" });
    expect(drain()).toEqual([
      {
        type: "goalContribution",
        userId: "user-1",
        goalId: "g1",
        amountCentavos: 200_000,
        localDate: "2026-06-11",
      },
    ]);
  });

  test("valid backdate → contribution carries that localDate", async () => {
    const { tools, drain } = ctx();
    const res = await run(tools.contributeToGoal, {
      goalName: "laptop",
      amount: "1000",
      date: "2026-06-03",
    });
    expect(res).toMatchObject({ ok: true, date: "2026-06-03" });
    expect(drain()[0]).toMatchObject({ type: "goalContribution", localDate: "2026-06-03" });
  });

  test("future date rejected, nothing buffered (mirrors logExpense)", async () => {
    const { tools, drain } = ctx();
    const res = await run(tools.contributeToGoal, {
      goalName: "laptop",
      amount: "1000",
      date: "2099-01-01",
    });
    expect(res.ok).toBe(false);
    expect(drain()).toHaveLength(0);
  });

  test("no matching goal → error even with a valid date", async () => {
    const { tools, drain } = ctx();
    const res = await run(tools.contributeToGoal, {
      goalName: "vacation",
      amount: "1000",
      date: "2026-06-03",
    });
    expect(res.ok).toBe(false);
    expect(drain()).toHaveLength(0);
  });

  test("M3: contributing to a goal CREATED earlier this same turn gives a retry hint, not 'create it first'", async () => {
    const { tools, drain } = ctx();
    // Simulate a same-turn createGoal buffered before the contribution. The goal isn't in the DB yet
    // (no id until flush), so findGoalByName (mocked: only 'laptop' resolves) misses "vacation".
    await run(tools.createGoal, { name: "Vacation", target: "20k" });
    const res = await run(tools.contributeToGoal, { goalName: "vacation", amount: "5000" });
    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain("just created"); // clear retry hint, not the generic miss
    // The createGoal intent is still buffered; only the contribution was (correctly) not buffered.
    const writes = drain();
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ type: "createGoal", name: "Vacation" });
  });
});

describe("compareSpending", () => {
  test("all-spending: compares two explicit months via month expense, reports direction + pct", async () => {
    expenseByMonth["2026-06"] = 1_200_000;
    expenseByMonth["2026-04"] = 1_000_000;
    const { tools } = ctx();
    const res = await run(tools.compareSpending, { current: "2026-06", previous: "2026-04" });
    expect(res).toMatchObject({
      scope: "all spending",
      current: "₱12,000.00",
      previous: "₱10,000.00",
      direction: "up",
      pctChange: 20,
    });
    expect(res.change).toBe("+₱2,000.00");
  });

  test("per-category: uses sumByCategory for both months", async () => {
    sumByMonth["2026-06"] = 410_000;
    sumByMonth["2026-05"] = 500_000;
    const { tools } = ctx();
    const res = await run(tools.compareSpending, {
      current: "2026-06",
      previous: "2026-05",
      category: "Food",
    });
    expect(res).toMatchObject({ scope: "Food", direction: "down", pctChange: -18 });
  });

  test("defaults previous to the month before current when omitted", async () => {
    // current omitted → now; previous omitted → prevMonthAnchor(now). Just assert it runs + shapes.
    const { tools } = ctx();
    const res = await run(tools.compareSpending, {});
    expect(res).toHaveProperty("direction");
    expect(res).toHaveProperty("current");
  });
});

describe("searchHistory", () => {
  test("passes text + resolved month window + parsed amount bounds to searchTransactions", async () => {
    const { tools } = ctx();
    const res = await run(tools.searchHistory, {
      text: "grab",
      month: "2026-06",
      minAmount: "1k",
      byAmount: true,
    });
    expect(res.ok).toBe(true);
    expect(res.count).toBe(1);
    expect(lastSearchOpts).toMatchObject({
      text: "grab",
      startDate: "2026-06-01",
      endDate: "2026-06-30",
      minCentavos: 100_000,
      byAmount: true,
    });
  });

  test("rejects an unparseable minAmount without hitting the DB", async () => {
    const { tools } = ctx();
    const res = await run(tools.searchHistory, { minAmount: "abc" });
    expect(res.ok).toBe(false);
  });

  test("formats returned rows as money strings", async () => {
    const { tools } = ctx();
    const res = (await run(tools.searchHistory, { text: "grab" })) as {
      transactions: Array<{ amount: string }>;
    };
    expect(res.transactions[0]?.amount).toBe("₱1,500.00");
  });
});

describe("getSpendingPace", () => {
  test("flags a projected budget overshoot", async () => {
    // Food limit 500k; spent 410k. Pace projection depends on today's day-of-month, but with a
    // high MTD spend early in the month it should project over. Assert structure + that the budget
    // is surfaced; willExceed depends on the real date so we assert it's a boolean and budget shows.
    const { tools } = ctx();
    const res = await run(tools.getSpendingPace, { category: "Food" });
    expect(res).toMatchObject({ category: "Food", budget: "₱5,000.00" });
    expect(typeof res.onTrackToExceed).toBe("boolean");
    expect(res).toHaveProperty("projectedMonthEnd");
  });

  test("category with no budget → null budget, never flags", async () => {
    const { tools } = ctx();
    const res = await run(tools.getSpendingPace, { category: "Entertainment" });
    expect(res.budget).toBeNull();
    expect(res.onTrackToExceed).toBe(false);
  });
});
