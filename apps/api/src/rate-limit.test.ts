import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createSlidingWindowRateLimiter } from "./rate-limit";

describe("createSlidingWindowRateLimiter", () => {
  test("keeps the sliding-window implementation free of numeric assertions", () => {
    const source = readFileSync(new URL("./rate-limit.ts", import.meta.url), "utf8");

    expect(source).not.toContain("as number");
  });

  test("allows a fixed number of hits inside a sliding window", () => {
    const limiter = createSlidingWindowRateLimiter({ max: 3, windowMs: 1_000 });

    expect(limiter.allow(10_000)).toBe(true);
    expect(limiter.allow(10_000)).toBe(true);
    expect(limiter.allow(10_000)).toBe(true);
    expect(limiter.allow(10_000)).toBe(false);
  });

  test("expires hits at the window boundary and supports deterministic reset", () => {
    const limiter = createSlidingWindowRateLimiter({ max: 2, windowMs: 1_000 });

    expect(limiter.allow(20_000)).toBe(true);
    expect(limiter.allow(20_999)).toBe(true);
    expect(limiter.allow(20_999)).toBe(false);
    expect(limiter.allow(21_000)).toBe(true);

    limiter.reset();
    expect(limiter.allow(21_000)).toBe(true);
    expect(limiter.allow(21_000)).toBe(true);
    expect(limiter.allow(21_000)).toBe(false);
  });
});
