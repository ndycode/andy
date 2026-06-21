import { describe, expect, test } from "bun:test";
import { budgetPaceNudgeCopy, budgetThresholdNudgeCopy } from "./cron-budget-copy";

describe("cron budget copy builders", () => {
  test("builds over-budget threshold fallback and proactive brief", () => {
    expect(
      budgetThresholdNudgeCopy({
        category: "Food",
        spent: 6_000_000,
        limit: 5_000_000,
      }),
    ).toEqual({
      fallback: "🚨 you're over your Food budget — ₱60,000.00 of ₱50,000.00 this month.",
      brief:
        "The user is OVER their Food budget this month: spent ₱60,000.00 of a ₱50,000.00 limit. Give a supportive heads-up, no shame.",
    });
  });

  test("builds near-budget threshold fallback and proactive brief", () => {
    expect(
      budgetThresholdNudgeCopy({
        category: "Food",
        spent: 4_100_000,
        limit: 5_000_000,
      }),
    ).toEqual({
      fallback: "👀 heads up: ₱41,000.00 of your ₱50,000.00 Food budget used.",
      brief:
        "The user is at 82% of their Food budget this month: ₱41,000.00 of ₱50,000.00. Gentle heads-up so they can ease off.",
    });
  });

  test("builds forward-looking pace fallback and proactive brief", () => {
    expect(
      budgetPaceNudgeCopy({
        category: "Food",
        spent: 3_000_000,
        limit: 5_000_000,
        projected: 6_250_000,
      }),
    ).toEqual({
      fallback:
        "📈 at this rate you're on track to spend about ₱62,500.00 on Food this month — over your ₱50,000.00 budget. worth easing off.",
      brief:
        "The user is only at 60% of their Food budget so far (₱30,000.00 of ₱50,000.00), but at the current daily pace they're projected to hit about ₱62,500.00 by month end — over budget. Give a light, forward-looking heads-up so they can adjust now. Not preachy.",
    });
  });
});
