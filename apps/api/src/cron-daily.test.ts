import { beforeEach, describe, expect, test } from "bun:test";
import { type CronDeps, runDailyChecks } from "./cron-daily";

/**
 * Unit tests for the daily cron orchestration via dependency injection (NOT module mocks) — fully
 * deterministic, no DB/LLM/network. We assert the date-INDEPENDENT behavior: record-before-send
 * gating (only send when the weekly/day slot claim wins), per-item try/catch isolation, recurring +
 * goal-pace gating, and that all three hygiene reapers run. Pace-warning thresholds depend on the
 * real calendar day (the cron reads `new Date()` internally), so we don't assert those here.
 */

process.env.ALLOWED_PHONE = "+639171234567";

type Call = { fn: string; args: unknown[] };
type GoalRow = Awaited<ReturnType<CronDeps["listGoals"]>>[number];

function cronDeps(
  calls: Call[],
  over: {
    budgets?: { category: "Food" | "Transport"; limit: number; spent: number }[];
    due?: Awaited<ReturnType<CronDeps["dueRecurringToday"]>>;
    goals?: GoalRow[];
    recordNudge?: boolean;
    claimReminder?: boolean;
    sendThrows?: boolean;
  } = {},
): CronDeps {
  const rec =
    (fn: string) =>
    (...args: unknown[]) => {
      calls.push({ fn, args });
    };
  return {
    resolveUserId: async () => "user-1",
    budgetStatuses: async () => over.budgets ?? [],
    categoryAmountsThisMonth: async () => [],
    recordNudge: async (...a) => {
      rec("recordNudge")(...a);
      return over.recordNudge ?? true;
    },
    claimReminder: async (...a) => {
      rec("claimReminder")(...a);
      return over.claimReminder ?? true;
    },
    dueRecurringToday: async () => over.due ?? [],
    listGoals: async () => over.goals ?? [],
    reapProcessedMessages: async () => 3,
    reapMessages: async () => 0,
    reconcileGoalBalances: async () => 0,
    reapNudges: async () => 2,
    reapSummaryRuns: async () => 1,
    composeProactive: async (_brief, fallback) => {
      rec("composeProactive")(_brief, fallback);
      // Sentinel-prefix the return so a test can prove the cron sends composeProactive's RESULT
      // (msg), not the raw fallback string, while staying deterministic (no real LLM).
      return `composed:${fallback}`;
    },
    sendMessage: async (...a) => {
      rec("sendMessage")(...a);
      if (over.sendThrows) throw new Error("network down");
    },
    runWeeklySummary: async () => ({ sent: false }),
  };
}

const count = (calls: Call[], fn: string) => calls.filter((c) => c.fn === fn).length;

const behindGoal: GoalRow = {
  id: "g1",
  name: "Trip",
  targetCentavos: 100000,
  savedCentavos: 0, // 0 saved with a past deadline → unambiguously behind
  createdAt: new Date("2020-01-01T00:00:00Z"),
  targetDate: "2020-02-01",
};
const fundedGoal: GoalRow = { ...behindGoal, id: "g2", savedCentavos: 100000 };

let calls: Call[];
beforeEach(() => {
  calls = [];
});

describe("runDailyChecks — orchestration (DI, deterministic)", () => {
  test("budget ≥80%: claims the weekly slot, composes, and sends exactly once", async () => {
    const res = await runDailyChecks(
      cronDeps(calls, { budgets: [{ category: "Food", limit: 500000, spent: 450000 }] }),
    );
    expect(res.nudges).toBe(1);
    expect(count(calls, "recordNudge")).toBe(1);
    expect((calls.find((c) => c.fn === "recordNudge")?.args as unknown[])[1]).toBe("budget:Food");
    expect(count(calls, "sendMessage")).toBe(1);
    // What's sent is composeProactive's RESULT (the "composed:" sentinel proves msg, not the raw
    // fallback, reaches sendMessage), and it names the budget category.
    const sent = calls.find((c) => c.fn === "sendMessage")?.args[1] as string;
    expect(sent).toStartWith("composed:");
    expect(sent).toContain("Food");
  });

  test("record-before-send: a lost weekly claim sends nothing", async () => {
    const res = await runDailyChecks(
      cronDeps(calls, {
        budgets: [{ category: "Food", limit: 500000, spent: 450000 }],
        recordNudge: false, // already nudged this week
      }),
    );
    expect(res.nudges).toBe(0);
    expect(count(calls, "sendMessage")).toBe(0);
  });

  test("a well-under-budget category triggers neither a nudge nor a send", async () => {
    const res = await runDailyChecks(
      cronDeps(calls, { budgets: [{ category: "Food", limit: 500000, spent: 50000 }] }),
    );
    expect(res.nudges).toBe(0);
    expect(count(calls, "sendMessage")).toBe(0);
  });

  test("recurring reminder: claims the day's slot before sending; a lost claim is silent", async () => {
    const due = [
      {
        id: "r1",
        userId: "user-1",
        label: "Rent",
        kind: "expense" as const,
        amountCentavos: 800000,
        category: "Bills" as const,
        cadence: "monthly" as const,
        dayOfMonth: 5,
        dayOfWeek: null,
        lastRemindedDate: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];
    const won = await runDailyChecks(cronDeps(calls, { due }));
    expect(won.reminders).toBe(1);
    expect(count(calls, "claimReminder")).toBe(1);
    expect(count(calls, "sendMessage")).toBe(1);

    calls = [];
    const lost = await runDailyChecks(cronDeps(calls, { due, claimReminder: false }));
    expect(lost.reminders).toBe(0);
    expect(count(calls, "sendMessage")).toBe(0);
  });

  test("goal-pace: a behind-pace goal nudges; an on-track goal does not", async () => {
    const behind = await runDailyChecks(cronDeps(calls, { goals: [behindGoal] }));
    expect(behind.goalNudges).toBe(1);
    expect(count(calls, "sendMessage")).toBe(1);

    calls = [];
    const onTrack = await runDailyChecks(cronDeps(calls, { goals: [fundedGoal] }));
    expect(onTrack.goalNudges).toBe(0);
    expect(count(calls, "sendMessage")).toBe(0);
  });

  test("all three hygiene reapers run and their counts are reported", async () => {
    const res = await runDailyChecks(cronDeps(calls));
    expect(res.reaped).toBe(3);
    expect(res.reapedNudges).toBe(2);
    expect(res.reapedSummaries).toBe(1);
  });

  test("per-item isolation: a send failure on a nudge is caught and the reapers still run", async () => {
    const res = await runDailyChecks(
      cronDeps(calls, {
        budgets: [{ category: "Food", limit: 500000, spent: 450000 }],
        sendThrows: true,
      }),
    );
    expect(res.nudges).toBe(0); // the send threw → not counted
    // …but hygiene still ran (the failure was isolated to that one item).
    expect(res.reaped).toBe(3);
    expect(res.reapedNudges).toBe(2);
    expect(res.reapedSummaries).toBe(1);
  });
});
