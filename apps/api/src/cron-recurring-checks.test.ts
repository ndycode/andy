import { describe, expect, test } from "bun:test";
import { runRecurringReminders } from "./cron-recurring-checks";
import {
  CRON_PHONE,
  CRON_USER_ID,
  type CronCall,
  countCronCalls,
  recurringDeps,
  recurringRow,
} from "./cron-test-harness";

const dueReminder = recurringRow();

describe("runRecurringReminders", () => {
  test("claims the daily reminder slot before sending", async () => {
    const calls: CronCall[] = [];

    const result = await runRecurringReminders(
      recurringDeps(calls, { due: [dueReminder] }),
      CRON_USER_ID,
      CRON_PHONE,
    );

    expect(result).toEqual({ reminders: 1 });
    expect(countCronCalls(calls, "claimReminder")).toBe(1);
    expect(countCronCalls(calls, "sendMessage")).toBe(1);
  });

  test("does not send when the daily reminder claim is lost", async () => {
    const calls: CronCall[] = [];

    const result = await runRecurringReminders(
      recurringDeps(calls, { due: [dueReminder], claimReminder: false }),
      CRON_USER_ID,
      CRON_PHONE,
    );

    expect(result).toEqual({ reminders: 0 });
    expect(countCronCalls(calls, "claimReminder")).toBe(1);
    expect(countCronCalls(calls, "sendMessage")).toBe(0);
  });

  test("rethrows non-Error reminder send failures instead of swallowing them", async () => {
    const calls: CronCall[] = [];

    await expect(
      runRecurringReminders(
        recurringDeps(calls, { due: [dueReminder], sendThrows: "bad-reminder-send" }),
        CRON_USER_ID,
        CRON_PHONE,
      ),
    ).rejects.toBe("bad-reminder-send");
  });
});
