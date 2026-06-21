import { describe, expect, test } from "bun:test";
import { spendingDelta } from "./spending-comparison";

describe("spending-comparison module boundary", () => {
  test("owns period-over-period delta calculation", () => {
    expect(spendingDelta(120_000, 100_000)).toEqual({
      current: 120_000,
      previous: 100_000,
      delta: 20_000,
      pctChange: 20,
      direction: "up",
    });
    expect(spendingDelta(100_000, 1).pctChange).toBeNull();
  });
});
