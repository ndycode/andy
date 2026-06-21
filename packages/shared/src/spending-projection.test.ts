import { describe, expect, test } from "bun:test";
import { projectMonthEnd, projectMonthEndRobust } from "./spending-projection";

describe("spending-projection module boundary", () => {
  test("owns linear and outlier-aware month-end projections", () => {
    const amounts = [50_000, 50_000, 50_000, 2_000_000];
    const linear = projectMonthEnd(2_150_000, 3, 30);
    const robust = projectMonthEndRobust(amounts, 3, 30);

    expect(linear).toBe(21_500_000);
    expect(robust).toBeLessThan(linear);
    expect(robust).toBeGreaterThanOrEqual(2_150_000);
  });

  test("linear projection extrapolates month-to-date spend", () => {
    expect(projectMonthEnd(60_000, 15, 30)).toBe(120_000);
    expect(projectMonthEnd(10_000, 1, 30)).toBe(300_000);
    expect(projectMonthEnd(90_000, 30, 30)).toBe(90_000);
    expect(projectMonthEnd(5000, 0, 30)).toBe(5000);
    expect(Number.isInteger(projectMonthEnd(100, 3, 30))).toBe(true);
  });

  test("robust projection falls back to linear when there is no stable outlier signal", () => {
    expect(projectMonthEndRobust([50_000, 50_000, 50_000], 3, 30)).toBe(
      projectMonthEnd(150_000, 3, 30),
    );
    expect(projectMonthEndRobust([50_000, 2_000_000], 2, 30)).toBe(
      projectMonthEnd(2_050_000, 2, 30),
    );
  });

  test("robust projection never drops below real spend", () => {
    expect(projectMonthEndRobust([10, 10, 10, 5_000_000], 28, 30)).toBeGreaterThanOrEqual(
      5_000_030,
    );
  });
});
