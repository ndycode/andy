import { describe, expect, test } from "bun:test";
import { shouldWarnPace, spendingPace } from "./spending-pace";

describe("spending-pace module boundary", () => {
  test("owns budget pace verdicts and proactive warning gates", () => {
    const over = spendingPace(300_000, 15, 30, 500_000);
    const near = spendingPace(420_000, 15, 30, 500_000);

    expect(over).toMatchObject({ projected: 600_000, willExceed: true, projectedOver: 100_000 });
    expect(shouldWarnPace(over, 15)).toBe(true);
    expect(shouldWarnPace(near, 15)).toBe(false);
  });
});
