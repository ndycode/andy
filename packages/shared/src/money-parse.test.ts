import { describe, expect, test } from "bun:test";
import { parseAmount as barrelParseAmount } from "./money";
import { MAX_ENTRY_CENTAVOS } from "./money-limits";
import { parseAmount } from "./money-parse";

describe("money-parse boundary", () => {
  test("owns human amount parsing behind the money barrel", () => {
    expect(parseAmount).toBe(barrelParseAmount);
    expect(parseAmount("1.005")).toEqual({ ok: true, centavos: 101 });
    expect(parseAmount("100-200")).toEqual({
      ok: false,
      reason: "looks like a range — send one amount",
    });
  });
});

describe("parseAmount", () => {
  const ok: [string, number][] = [
    ["180", 18000],
    ["25k", 2_500_000],
    ["25K", 2_500_000],
    ["1.5k", 150_000],
    ["180.50", 18050],
    ["2000", 200_000],
    ["₱180", 18000],
    ["1,250.75", 125_075],
    ["0.01", 1],
    ["1m", 100_000_000],
  ];

  for (const [input, centavos] of ok) {
    test(`"${input}" -> ${centavos}c`, () => {
      const result = parseAmount(input);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.centavos).toBe(centavos);
    });
  }

  const bad = ["", "   ", "abc", "-5", "0", "12.3.4", "k", "NaN", "1e9k"];

  for (const input of bad) {
    test(`rejects "${input}"`, () => {
      expect(parseAmount(input).ok).toBe(false);
    });
  }

  test("rejects malformed or foreign digit grouping instead of silently mangling it", () => {
    for (const grouped of ["1,00,000", "1,2,3", "12,34", "1,23"]) {
      const result = parseAmount(grouped);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/grouping/);
    }
  });

  test("accepts valid thousands grouping", () => {
    expect(parseAmount("1,000")).toEqual({ ok: true, centavos: 100_000 });
    expect(parseAmount("1,234,567.89")).toEqual({ ok: true, centavos: 123_456_789 });
  });

  test("sub-centavo precision rounds half-up via integer math", () => {
    expect(parseAmount("1.005")).toEqual({ ok: true, centavos: 101 });
    expect(parseAmount("0.005")).toEqual({ ok: true, centavos: 1 });
    expect(parseAmount("2.004")).toEqual({ ok: true, centavos: 200 });
  });

  test("sub-centavo below half rounds down to zero", () => {
    expect(parseAmount("0.0005")).toEqual({ ok: false, reason: "must be positive" });
    expect(parseAmount("0.0049")).toEqual({ ok: false, reason: "must be positive" });
    expect(parseAmount("0.0051")).toEqual({ ok: true, centavos: 1 });
  });

  test("rejects over per-entry cap", () => {
    expect(parseAmount(String(MAX_ENTRY_CENTAVOS / 100 + 1)).ok).toBe(false);
  });

  test("normalizes trailing sentence punctuation", () => {
    const result = parseAmount("150.");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.centavos).toBe(15000);
  });

  test("normalizes a bare leading decimal point", () => {
    const result = parseAmount(".50");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.centavos).toBe(50);
  });

  test("strips peso words", () => {
    const result = parseAmount("pesos 150");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.centavos).toBe(15000);
  });

  test("rejects a range with a clear actionable reason", () => {
    // Includes ₱-prefixed / spaced forms — the range check runs AFTER currency+space stripping so the
    // symbols and spaces between the numbers and the dash don't hide the range.
    for (const range of [
      "100-200",
      "100 to 200",
      "50–100",
      "₱100–₱200",
      "₱100 – ₱200",
      "₱50 to ₱100",
    ]) {
      const result = parseAmount(range);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/range/);
    }
  });

  test("still rejects word amounts and multi-dot junk", () => {
    expect(parseAmount("two hundred").ok).toBe(false);
    expect(parseAmount("12.3.4").ok).toBe(false);
  });

  test("never returns a non-integer centavo value", () => {
    for (let i = 0; i < 1000; i++) {
      const pesos = (((i * 104_729 + 37) % 10_000_000) / 100).toFixed(2);
      const result = parseAmount(pesos);
      if (result.ok) expect(Number.isInteger(result.centavos)).toBe(true);
    }
  });
});
