import { describe, expect, test } from "bun:test";
import { runGoalPaceChecks } from "./cron-goal-checks";
import {
  type CronCall,
  countCronCalls,
  cronArgsFor,
  cronContext,
  goalDeps,
  goalRow,
} from "./cron-test-harness";

const baseGoal = goalRow();

describe("runGoalPaceChecks", () => {
  test("nudges a behind-pace goal and skips a funded goal", async () => {
    const calls: CronCall[] = [];

    const result = await runGoalPaceChecks(
      goalDeps(calls, { goals: [baseGoal, goalRow({ id: "goal-2", savedCentavos: 100000 })] }),
      cronContext(),
    );

    expect(result).toEqual({ goalNudges: 1 });
    expect(countCronCalls(calls, "recordNudge")).toBe(1);
    expect(cronArgsFor(calls, "recordNudge")[1]).toBe("goalpace:goal-1");
    expect(countCronCalls(calls, "sendMessage")).toBe(1);
  });

  test("rethrows non-Error goal pace send failures instead of swallowing them", async () => {
    const calls: CronCall[] = [];

    await expect(
      runGoalPaceChecks(
        goalDeps(calls, { goals: [baseGoal], sendThrows: "bad-goal-send" }),
        cronContext(),
      ),
    ).rejects.toBe("bad-goal-send");
  });
});
