import { errInfo, log } from "@repo/shared/log";
import { recurringReminderCopy } from "./cron-recurring-copy";
import type { CronDeps, RecurringReminderResult } from "./cron-types";

export type RecurringReminderDeps = Pick<
  CronDeps,
  "dueRecurringToday" | "claimReminder" | "composeProactive" | "sendMessage"
>;

export async function runRecurringReminders(
  deps: RecurringReminderDeps,
  userId: string,
  phone: string,
): Promise<RecurringReminderResult> {
  const { dueRecurringToday, claimReminder, composeProactive, sendMessage } = deps;
  let reminders = 0;

  for (const r of await dueRecurringToday(userId)) {
    try {
      if (!(await claimReminder(r.id, userId))) continue;
      const { fallback, brief } = recurringReminderCopy(r);
      const msg = await composeProactive(brief, fallback);
      await sendMessage(phone, msg);
      reminders++;
    } catch (err) {
      if (!(err instanceof Error)) throw err;
      const info = errInfo(err);
      log.error("cron.reminder.error", { id: r.id, ...info });
    }
  }

  return { reminders };
}
