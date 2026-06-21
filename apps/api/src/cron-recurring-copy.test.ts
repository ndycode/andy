import { describe, expect, test } from "bun:test";
import { recurringReminderCopy } from "./cron-recurring-copy";

describe("cron recurring copy builders", () => {
  test("builds expense reminder fallback and proactive brief", () => {
    expect(
      recurringReminderCopy({
        label: "Rent",
        kind: "expense",
        amountCentavos: 800_000,
      }),
    ).toEqual({
      fallback: "🔔 Rent (₱8,000.00) due today — want me to log it?",
      brief:
        'Remind the user that "Rent" (₱8,000.00) is due today. Offer to log it. Keep it light.',
    });
  });

  test("builds income reminder fallback and proactive brief", () => {
    expect(
      recurringReminderCopy({
        label: "Payday",
        kind: "income",
        amountCentavos: 2_500_000,
      }),
    ).toEqual({
      fallback: "🔔 Payday (₱25,000.00) expected today — want me to log it?",
      brief:
        'Remind the user that "Payday" (₱25,000.00) is expected today. Offer to log it. Keep it light.',
    });
  });
});
