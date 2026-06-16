import { describe, expect, test } from "bun:test";
import {
  formatPHP,
  MAX_AGGREGATE_CENTAVOS,
  MAX_ENTRY_CENTAVOS,
  parseAmount,
  sumCentavos,
  toSafeCentavos,
} from "./money";

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

  test("rejects malformed/foreign digit grouping instead of silently mangling it", () => {
    for (const g of ["1,00,000", "1,2,3", "12,34", "1,23"]) {
      const r = parseAmount(g);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/grouping/);
    }
  });

  test("accepts valid thousands grouping", () => {
    expect(parseAmount("1,000")).toEqual({ ok: true, centavos: 100_000 });
    expect(parseAmount("1,234,567.89")).toEqual({ ok: true, centavos: 123_456_789 });
  });

  test("sub-centavo precision rounds half-up via integer math (no float drift)", () => {
    // 1.005 * 100 in float is 100.4999… → the old Math.round gave 100c; exact decimal gives 101c.
    expect(parseAmount("1.005")).toEqual({ ok: true, centavos: 101 });
    expect(parseAmount("0.005")).toEqual({ ok: true, centavos: 1 });
    expect(parseAmount("2.004")).toEqual({ ok: true, centavos: 200 });
  });

  test("sub-centavo below half rounds DOWN to 0 (leading-zero slice alignment)", () => {
    // Regression: stripping leading zeros before the positional keep/dropped slice misaligned the
    // round, turning 0.0005 (half a millipeso, < 0.5 centavo) into 1c instead of 0. parseAmount then
    // rejected it as non-positive — but the underlying round must floor these, not over-count.
    expect(parseAmount("0.0005")).toEqual({ ok: false, reason: "must be positive" }); // rounds to 0c
    expect(parseAmount("0.0049")).toEqual({ ok: false, reason: "must be positive" }); // 0.49c → 0c
    expect(parseAmount("0.0051")).toEqual({ ok: true, centavos: 1 }); // 0.51c → 1c (half-up boundary)
  });

  test("rejects over per-entry cap", () => {
    expect(parseAmount(String(MAX_ENTRY_CENTAVOS / 100 + 1)).ok).toBe(false);
  });

  test("normalizes a trailing dot (sentence punctuation): '150.' -> 15000c", () => {
    const r = parseAmount("150.");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.centavos).toBe(15000);
  });

  test("normalizes a bare leading dot: '.50' -> 50c", () => {
    const r = parseAmount(".50");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.centavos).toBe(50);
  });

  test("strips 'pesos'/'peso' word: 'pesos 150' -> 15000c", () => {
    const r = parseAmount("pesos 150");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.centavos).toBe(15000);
  });

  test("rejects a range with a clear, actionable reason", () => {
    for (const range of ["100-200", "100 to 200", "50–100"]) {
      const r = parseAmount(range);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/range/);
    }
  });

  test("still rejects word amounts and multi-dot junk", () => {
    expect(parseAmount("two hundred").ok).toBe(false);
    expect(parseAmount("12.3.4").ok).toBe(false);
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

describe("toSafeCentavos (DB aggregate → safe JS integer)", () => {
  test("passes through a valid number or bigint string unchanged", () => {
    expect(toSafeCentavos(2_500_000)).toBe(2_500_000);
    expect(toSafeCentavos("2500000")).toBe(2_500_000);
    expect(toSafeCentavos(0)).toBe(0);
  });

  test("null/undefined coerce to 0 (coalesced empty aggregate)", () => {
    expect(toSafeCentavos(null)).toBe(0);
    expect(toSafeCentavos(undefined)).toBe(0);
  });

  test("throws above the aggregate cap rather than returning a quietly-wrong total", () => {
    expect(() => toSafeCentavos(MAX_AGGREGATE_CENTAVOS + 1)).toThrow(/safe cap/);
    expect(() => toSafeCentavos(String(MAX_AGGREGATE_CENTAVOS + 1))).toThrow(/safe cap/);
  });

  test("throws on non-integer / non-finite", () => {
    expect(() => toSafeCentavos(1.5)).toThrow();
    expect(() => toSafeCentavos("not a number")).toThrow();
  });
});
