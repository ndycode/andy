import { describe, expect, test } from "bun:test";
import { formatPHP, MAX_ENTRY_CENTAVOS, parseAmount, sumCentavos } from "./money";

describe("parseAmount", () => {
  const ok: [string, number][] = [
    ["180", 18000], // AC1
    ["25k", 2_500_000], // AC2
    ["25K", 2_500_000],
    ["1.5k", 150_000],
    ["180.50", 18050],
    ["2000", 200_000], // AC3 contribution
    ["₱180", 18000],
    ["1,250.75", 125_075],
    ["0.01", 1],
    ["1m", 100_000_000],
  ];
  for (const [input, centavos] of ok) {
    test(`"${input}" -> ${centavos}c`, () => {
      const r = parseAmount(input);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.centavos).toBe(centavos);
    });
  }

  const bad = ["", "   ", "abc", "-5", "0", "12.3.4", "k", "NaN", "1e9k"];
  for (const input of bad) {
    test(`rejects "${input}"`, () => {
      expect(parseAmount(input).ok).toBe(false);
    });
  }

  test("rejects over per-entry cap", () => {
    expect(parseAmount(String(MAX_ENTRY_CENTAVOS / 100 + 1)).ok).toBe(false);
  });

  test("never returns a non-integer centavo value", () => {
    for (let i = 0; i < 1000; i++) {
      const pesos = (Math.random() * 100000).toFixed(2);
      const r = parseAmount(pesos);
      if (r.ok) expect(Number.isInteger(r.centavos)).toBe(true);
    }
  });
});

describe("formatPHP", () => {
  test.each([
    [18000, "₱180.00"],
    [2_500_000, "₱25,000.00"],
    [800_000, "₱8,000.00"],
    [2_000_000, "₱20,000.00"],
    [1, "₱0.01"],
    [0, "₱0.00"],
  ])("%d -> %s", (c, expected) => {
    expect(formatPHP(c)).toBe(expected);
  });

  test("throws on non-integer", () => {
    expect(() => formatPHP(180.5)).toThrow();
  });
});

describe("sumCentavos (AC8 — no float drift)", () => {
  test("exact integer total", () => {
    const vals = [18000, 25000, 2_500_000, 1, 99];
    expect(sumCentavos(vals)).toBe(2_543_100);
  });

  test("property: sum equals naive reduce for random integer sets", () => {
    for (let i = 0; i < 500; i++) {
      const vals = Array.from({ length: 20 }, () => Math.floor(Math.random() * 1_000_000));
      expect(sumCentavos(vals)).toBe(vals.reduce((a, b) => a + b, 0));
    }
  });

  test("round-trip: parse many then sum is exact", () => {
    const inputs = ["180", "25k", "1.5k", "180.50", "0.01"];
    const parsed = inputs.map((i) => {
      const r = parseAmount(i);
      if (!r.ok) throw new Error("setup");
      return r.centavos;
    });
    // 18000 + 2_500_000 + 150_000 + 18050 + 1
    expect(sumCentavos(parsed)).toBe(2_686_051);
  });
});
