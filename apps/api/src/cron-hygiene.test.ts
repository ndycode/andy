import { describe, expect, test } from "bun:test";
import { runDailyHygiene } from "./cron-hygiene";
import { CRON_USER_ID, type CronCall, cronArgsFor, hygieneDeps } from "./cron-test-harness";

describe("runDailyHygiene", () => {
  test("runs all daily reapers and reports their counts", async () => {
    const calls: CronCall[] = [];

    const result = await runDailyHygiene(hygieneDeps(calls), CRON_USER_ID);

    expect(result).toEqual({ reaped: 3, reapedNudges: 2, reapedSummaries: 1, degraded: false });
    expect(calls.map((call) => call.fn)).toEqual([
      "reapProcessedMessages",
      "reapMessages",
      "reconcileGoalBalances",
      "reapNudges",
      "reapSummaryRuns",
    ]);
    expect(cronArgsFor(calls, "reapMessages")).toEqual([CRON_USER_ID]);
    expect(cronArgsFor(calls, "reconcileGoalBalances")).toEqual([CRON_USER_ID]);
  });

  test("isolates a throwing reaper: error swallowed, downstream reapers still run, degraded=true", async () => {
    const calls: CronCall[] = [];
    const deps = hygieneDeps(calls);

    const result = await runDailyHygiene(
      {
        ...deps,
        reapMessages: async () => {
          throw new Error("reaper boom");
        },
      },
      CRON_USER_ID,
    );

    expect(result.degraded).toBe(true);
    // The failure was isolated — every OTHER reaper still ran and reported its count.
    expect(result).toMatchObject({ reaped: 3, reapedNudges: 2, reapedSummaries: 1 });
    expect(calls.map((call) => call.fn)).toEqual([
      "reapProcessedMessages",
      "reconcileGoalBalances",
      "reapNudges",
      "reapSummaryRuns",
    ]);
  });

  test("reconcileGoalBalances > 0 exercises the corrected warn branch without marking degraded", async () => {
    const calls: CronCall[] = [];
    const result = await runDailyHygiene(
      { ...hygieneDeps(calls), reconcileGoalBalances: async () => 5 },
      CRON_USER_ID,
    );
    expect(result.degraded).toBe(false);
    expect(result).toMatchObject({ reaped: 3, reapedNudges: 2, reapedSummaries: 1 });
  });

  test("rethrows non-Error reaper failures instead of swallowing them", async () => {
    const calls: CronCall[] = [];
    const deps = hygieneDeps(calls);

    await expect(
      runDailyHygiene(
        {
          ...deps,
          reapMessages: async () => {
            throw "bad-reaper-value";
          },
        },
        CRON_USER_ID,
      ),
    ).rejects.toBe("bad-reaper-value");
  });
});
