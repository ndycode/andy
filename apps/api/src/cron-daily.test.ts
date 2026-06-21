import { beforeEach, describe, expect, test } from "bun:test";
import { runDailyChecks } from "./cron-daily";
import {
  CRON_PHONE,
  type CronCall,
  countCronCalls,
  cronArgsFor,
  dailyCronDeps,
  goalRow,
  recurringRow,
} from "./cron-test-harness";

/**
 * Unit tests for the daily cron orchestration via dependency injection (NOT module mocks) — fully
 * deterministic, no DB/LLM/network. We assert the date-INDEPENDENT behavior: record-before-send
 * gating (only send when the weekly/day slot claim wins), per-item try/catch isolation, recurring +
 * goal-pace gating, and that all three hygiene reapers run.
 */

process.env.ALLOWED_PHONE = CRON_PHONE;

const behindGoal = goalRow({ id: "g1" });
const fundedGoal = goalRow({ id: "g2", savedCentavos: 100000 });

let calls: CronCall[];
beforeEach(() => {
  calls = [];
});

describe("runDailyChecks — orchestration (DI, deterministic)", () => {
  test("budget ≥80%: claims the weekly slot, composes, and sends exactly once", async () => {
    const res = await runDailyChecks(
      dailyCronDeps(calls, { budgets: [{ category: "Food", limit: 500000, spent: 450000 }] }),
    );
    expect(res.nudges).toBe(1);
    expect(countCronCalls(calls, "recordNudge")).toBe(1);
    expect(cronArgsFor(calls, "recordNudge")[1]).toBe("budget:Food");
    expect(countCronCalls(calls, "sendMessage")).toBe(1);
    // What's sent is composeProactive's RESULT (the "composed:" sentinel proves msg, not the raw
    // fallback, reaches sendMessage), and it names the budget category.
    expect(cronArgsFor(calls, "sendMessage")[1]).toStartWith("composed:");
    expect(cronArgsFor(calls, "sendMessage")[1]).toContain("Food");
  });

  test("record-before-send: a lost weekly claim sends nothing", async () => {
    const res = await runDailyChecks(
      dailyCronDeps(calls, {
        budgets: [{ category: "Food", limit: 500000, spent: 450000 }],
        recordNudge: false, // already nudged this week
      }),
    );
    expect(res.nudges).toBe(0);
    expect(countCronCalls(calls, "sendMessage")).toBe(0);
  });

  test("a well-under-budget category triggers neither a nudge nor a send", async () => {
    const res = await runDailyChecks(
      dailyCronDeps(calls, { budgets: [{ category: "Food", limit: 500000, spent: 50000 }] }),
    );
    expect(res.nudges).toBe(0);
    expect(countCronCalls(calls, "sendMessage")).toBe(0);
  });

  test("budget pace warnings use the injected run date instead of wall-clock time", async () => {
    const res = await runDailyChecks(
      dailyCronDeps(calls, {
        budgets: [{ category: "Food", limit: 100000, spent: 40000 }],
        categoryAmounts: [40000],
      }),
      { now: new Date("2026-02-10T00:00:00+08:00") },
    );
    expect(res.paceWarnings).toBe(1);
    expect(cronArgsFor(calls, "recordNudge")[1]).toBe("pace:Food");
    expect(cronArgsFor(calls, "sendMessage")[1]).toContain("Food");
  });

  test("recurring reminder: claims the day's slot before sending; a lost claim is silent", async () => {
    const due = [recurringRow({ id: "r1" })];
    const won = await runDailyChecks(dailyCronDeps(calls, { due }));
    expect(won.reminders).toBe(1);
    expect(countCronCalls(calls, "claimReminder")).toBe(1);
    expect(countCronCalls(calls, "sendMessage")).toBe(1);

    calls = [];
    const lost = await runDailyChecks(dailyCronDeps(calls, { due, claimReminder: false }));
    expect(lost.reminders).toBe(0);
    expect(countCronCalls(calls, "sendMessage")).toBe(0);
  });

  test("goal-pace: a behind-pace goal nudges; an on-track goal does not", async () => {
    const behind = await runDailyChecks(dailyCronDeps(calls, { goals: [behindGoal] }));
    expect(behind.goalNudges).toBe(1);
    expect(countCronCalls(calls, "sendMessage")).toBe(1);

    calls = [];
    const onTrack = await runDailyChecks(dailyCronDeps(calls, { goals: [fundedGoal] }));
    expect(onTrack.goalNudges).toBe(0);
    expect(countCronCalls(calls, "sendMessage")).toBe(0);
  });

  test("all three hygiene reapers run and their counts are reported", async () => {
    const res = await runDailyChecks(dailyCronDeps(calls));
    expect(res.reaped).toBe(3);
    expect(res.reapedNudges).toBe(2);
    expect(res.reapedSummaries).toBe(1);
  });

  test("per-item isolation: a send failure on a nudge is caught and the reapers still run", async () => {
    const res = await runDailyChecks(
      dailyCronDeps(calls, {
        budgets: [{ category: "Food", limit: 500000, spent: 450000 }],
        sendThrows: new Error("network down"),
      }),
    );
    expect(res.nudges).toBe(0); // the send threw → not counted
    // …but hygiene still ran (the failure was isolated to that one item).
    expect(res.reaped).toBe(3);
    expect(res.reapedNudges).toBe(2);
    expect(res.reapedSummaries).toBe(1);
  });

  test("rethrows non-Error weekly recap failures instead of swallowing them", async () => {
    await expect(
      runDailyChecks(dailyCronDeps(calls, { weeklySummaryThrows: "bad-weekly-recap" })),
    ).rejects.toBe("bad-weekly-recap");
  });
});
