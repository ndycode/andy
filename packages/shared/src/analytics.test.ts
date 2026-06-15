import { describe, expect, test } from "bun:test";
import {
  projectMonthEnd,
  projectMonthEndRobust,
  shouldWarnPace,
  spendingDelta,
  spendingPace,
} from "./analytics";

describe("projectMonthEndRobust (outlier-aware)", () => {
  test("a day-3 big one-off is NOT extrapolated (the false-panic case)", () => {
    // day 3 of 30: three ₱500 food txns + one ₱20,000 one-off.
    // linear: 2,150,000 / 3 * 30 ≈ ₱215k panic.
    // robust: typical 150k/3*30 = 1.5M, + 2M outlier counted once = 3.5M ≈ ₱35k — far saner.
    const amounts = [50_000, 50_000, 50_000, 2_000_000]; // centavos
    const linear = projectMonthEnd(2_150_000, 3, 30);
    const robust = projectMonthEndRobust(amounts, 3, 30);
    expect(robust).toBeLessThan(linear); // key property: robust < naive linear
    expect(robust).toBeGreaterThanOrEqual(2_150_000); // never below reality
  });

  test("no outlier → identical to linear", () => {
    const amounts = [50_000, 50_000, 50_000];
    expect(projectMonthEndRobust(amounts, 3, 30)).toBe(projectMonthEnd(150_000, 3, 30));
  });

  test("fewer than 3 txns → falls back to linear (no stable median)", () => {
    const amounts = [50_000, 2_000_000];
    expect(projectMonthEndRobust(amounts, 2, 30)).toBe(projectMonthEnd(2_050_000, 2, 30));
  });

  test("projection never drops below what's already spent", () => {
    const amounts = [10, 10, 10, 5_000_000];
    expect(projectMonthEndRobust(amounts, 28, 30)).toBeGreaterThanOrEqual(5_000_030);
  });

  test("spendingPace with amounts uses the robust projection", () => {
    const amounts = [50_000, 50_000, 50_000, 2_000_000];
    const withAmounts = spendingPace(2_150_000, 3, 30, 300_000, amounts);
    const linear = spendingPace(2_150_000, 3, 30, 300_000);
    expect(withAmounts.projected).toBeLessThan(linear.projected);
  });
});

describe("spendingDelta", () => {
  test("up: current > previous, signed delta + rounded pct", () => {
    expect(spendingDelta(120_000, 100_000)).toEqual({
      current: 120_000,
      previous: 100_000,
      delta: 20_000,
      pctChange: 20,
      direction: "up",
    });
  });

  test("down: current < previous", () => {
    const r = spendingDelta(80_000, 100_000);
    expect(r.delta).toBe(-20_000);
    expect(r.pctChange).toBe(-20);
    expect(r.direction).toBe("down");
  });

  test("flat: equal totals", () => {
    expect(spendingDelta(50_000, 50_000)).toMatchObject({
      delta: 0,
      pctChange: 0,
      direction: "flat",
    });
  });

  test("no baseline: previous 0 → pctChange null (no divide-by-zero)", () => {
    const r = spendingDelta(30_000, 0);
    expect(r.pctChange).toBeNull();
    expect(r.direction).toBe("up");
  });

  test("both zero → flat, null pct", () => {
    expect(spendingDelta(0, 0)).toMatchObject({ delta: 0, pctChange: null, direction: "flat" });
  });

  test("sub-₱1 baseline → null pct (no absurd multi-million-percent), direction still meaningful", () => {
    // 1c baseline vs ₱1,000 would otherwise render +9,999,900%. Below the ₱1 floor we report null.
    const r = spendingDelta(100_000, 1);
    expect(r.pctChange).toBeNull();
    expect(r.direction).toBe("up");
    expect(r.delta).toBe(99_999);
  });

  test("a real ₱1+ baseline still produces a percent", () => {
    expect(spendingDelta(150, 100).pctChange).toBe(50);
  });
});

describe("projectMonthEnd (linear run-rate)", () => {
  test("half a 30-day month doubles to month end", () => {
    // 60,000 over 15 days → 4,000/day → 120,000 across 30
    expect(projectMonthEnd(60_000, 15, 30)).toBe(120_000);
  });

  test("day 1 extrapolates across the whole month", () => {
    expect(projectMonthEnd(10_000, 1, 30)).toBe(300_000);
  });

  test("last day equals spent so far", () => {
    expect(projectMonthEnd(90_000, 30, 30)).toBe(90_000);
  });

  test("guards dayOfMonth < 1 (returns spent as-is)", () => {
    expect(projectMonthEnd(5000, 0, 30)).toBe(5000);
  });

  test("rounds to integer centavos", () => {
    // 100 over 3 days → 33.33/day → 1000 across 30 (rounded)
    expect(Number.isInteger(projectMonthEnd(100, 3, 30))).toBe(true);
  });
});

describe("spendingPace (projection vs budget)", () => {
  test("flags a projected overshoot", () => {
    // 60k over 15/30 days → projected 120k vs 100k limit → over by 20k
    const v = spendingPace(60_000, 15, 30, 100_000);
    expect(v).toMatchObject({ projected: 120_000, willExceed: true, projectedOver: 20_000 });
  });

  test("within budget on pace → no exceed", () => {
    const v = spendingPace(30_000, 15, 30, 100_000); // projects 60k < 100k
    expect(v.willExceed).toBe(false);
    expect(v.projectedOver).toBe(0);
  });

  test("no budget set (limit 0) → never flags, limit normalized to 0", () => {
    const v = spendingPace(999_999, 15, 30, 0);
    expect(v.willExceed).toBe(false);
    expect(v.limit).toBe(0);
  });

  test("negative limit treated as no budget", () => {
    expect(spendingPace(50_000, 10, 30, -5).willExceed).toBe(false);
  });
});

describe("shouldWarnPace (proactive pace nudge gating)", () => {
  // Food budget 500k. Spent 250k by day 15 of 30 → projects 500k... bump to clearly-over below.
  const over = spendingPace(300_000, 15, 30, 500_000); // projects 600k, 20% over, spent 60% (<80%)

  test("fires when projection clears the budget by the margin and user is still under", () => {
    expect(over.projected).toBe(600_000);
    expect(shouldWarnPace(over, 15)).toBe(true);
  });

  test("silent before minDay (a day-1 splurge shouldn't extrapolate to panic)", () => {
    const v = spendingPace(40_000, 2, 30, 500_000); // projects 600k, but only day 2
    expect(shouldWarnPace(v, 2)).toBe(false);
  });

  test("silent when already at/over the near-budget threshold (current-state nudge owns it)", () => {
    const v = spendingPace(420_000, 15, 30, 500_000); // spent 84% ≥ 80%
    expect(shouldWarnPace(v, 15)).toBe(false);
  });

  test("silent when no budget set", () => {
    const v = spendingPace(300_000, 15, 30, 0);
    expect(shouldWarnPace(v, 15)).toBe(false);
  });

  test("silent when projection only barely exceeds (within the margin)", () => {
    // projects 520k vs 500k = 4% over, under the 10% margin
    const v = spendingPace(260_000, 15, 30, 500_000);
    expect(v.projected).toBe(520_000);
    expect(shouldWarnPace(v, 15)).toBe(false);
  });

  test("on-track-and-under stays silent", () => {
    const v = spendingPace(150_000, 15, 30, 500_000); // projects 300k, well under
    expect(shouldWarnPace(v, 15)).toBe(false);
  });
});
