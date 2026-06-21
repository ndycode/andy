import { describe, expect, test } from "bun:test";
import { goalPaceNudgeCopy } from "./cron-goal-copy";

describe("cron goal copy builders", () => {
  test("builds goal-pace fallback and proactive brief from rendered progress", () => {
    const progress = "Trip: ₱0.00 / ₱1,000.00 (0%). Behind pace — save about ₱1,000.00/week.";

    expect(goalPaceNudgeCopy(progress)).toEqual({
      fallback: `🎯 ${progress}`,
      brief: `The user's savings goal is behind pace: "${progress}". Give a short, encouraging nudge to get back on track. Not preachy.`,
    });
  });
});
