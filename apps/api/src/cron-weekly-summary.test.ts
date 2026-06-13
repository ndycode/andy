import { describe, expect, test } from "bun:test";
import { renderRecap } from "./cron-weekly-summary";

describe("renderRecap", () => {
  const overview = { income: 5_000_000, expense: 2_000_000, net: 3_000_000 };
  const byCat = [
    { category: "Food", total: 800_000 },
    { category: "Transport", total: 400_000 },
  ];

  test("renders totals + category breakdown", () => {
    const out = renderRecap(overview, byCat, []);
    expect(out).toContain("in: ₱50,000.00");
    expect(out).toContain("Food: ₱8,000.00");
    expect(out).toContain("Transport: ₱4,000.00");
  });

  test("adds month-over-month trend when prior data is present (>=5% change)", () => {
    const prev = [
      { category: "Food", total: 1_000_000 }, // was 10k, now 8k → down 20%
      { category: "Transport", total: 200_000 }, // was 2k, now 4k → up 100%
    ];
    const out = renderRecap(overview, byCat, [], prev);
    expect(out).toContain("Food: ₱8,000.00 (↓20% vs last month)");
    expect(out).toContain("Transport: ₱4,000.00 (↑100% vs last month)");
  });

  test("omits trend for a sub-5% change or missing prior", () => {
    const prev = [{ category: "Food", total: 820_000 }]; // ~2.4% down → no trend
    const out = renderRecap(overview, byCat, [], prev);
    expect(out).toContain("Food: ₱8,000.00\n"); // no trend suffix
    expect(out).not.toContain("vs last month\n  Transport"); // Transport has no prior → no trend
  });

  test("net-negative warning line", () => {
    const out = renderRecap({ income: 1000, expense: 5000, net: -4000 }, [], []);
    expect(out).toContain("spending more than you've logged");
  });

  test("goals section uses goalProgressMessage", () => {
    const out = renderRecap(
      overview,
      [],
      [
        {
          name: "Laptop",
          savedCentavos: 500_000,
          targetCentavos: 2_000_000,
          createdAt: new Date("2026-05-01T00:00:00Z"),
          targetDate: null,
        },
      ],
    );
    expect(out).toContain("Laptop:");
    expect(out).toContain("₱5,000.00 / ₱20,000.00");
  });
});
