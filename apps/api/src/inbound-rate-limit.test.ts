import { describe, expect, test } from "bun:test";
import { createInboundBurstLimiter } from "./inbound-rate-limit";

describe("createInboundBurstLimiter", () => {
  test("allows up to the route burst limit in a window, then throttles", () => {
    const limiter = createInboundBurstLimiter();
    const t = 1_000_000;
    let allowed = 0;
    for (let i = 0; i < 60; i++) if (limiter.allow(t)) allowed++;
    expect(allowed).toBe(60);
    expect(limiter.allow(t)).toBe(false);
  });

  test("expires requests once the route burst window slides", () => {
    const limiter = createInboundBurstLimiter();
    const t0 = 2_000_000;
    for (let i = 0; i < 60; i++) limiter.allow(t0);
    expect(limiter.allow(t0)).toBe(false);
    expect(limiter.allow(t0 + 60_000)).toBe(true);
  });
});
