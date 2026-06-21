import { describe, expect, test } from "bun:test";
import { renderRecap } from "./weekly-recap-renderer";

describe("weekly-recap-renderer boundary", () => {
  test("is not exported by the cron orchestration module", async () => {
    const cron = await import("./cron-weekly-summary");

    expect("renderRecap" in cron).toBe(false);
  });

  test("owns pure weekly recap text rendering", () => {
    const out = renderRecap(
      { income: 5_000_000, expense: 2_000_000, net: 3_000_000 },
      [{ category: "Food", total: 800_000 }],
      [],
      [{ category: "Food", total: 1_000_000 }],
      { today: "2026-06-11" },
    );

    expect(out).toContain("in: ₱50,000.00");
    expect(out).toContain("Food: ₱8,000.00 (↓20% vs last month)");
  });

  test("anchors goal pace to the supplied local today, not process time", () => {
    const out = renderRecap(
      { income: 0, expense: 0, net: 0 },
      [],
      [
        {
          name: "Trip",
          savedCentavos: 50_000,
          targetCentavos: 100_000,
          createdAt: new Date("2026-06-01T00:00:00Z"),
          targetDate: "2026-06-03",
        },
      ],
      [],
      { today: "2026-06-02" },
    );

    expect(out).toContain("Trip: ₱500.00 / ₱1,000.00 (50%). On track to hit Jun 3.");
  });
});
