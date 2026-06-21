import { describe, expect, test } from "bun:test";
import { sumCentavos, toSafeCentavos } from "./centavos";
import { sumCentavos as barrelSumCentavos, toSafeCentavos as barrelToSafeCentavos } from "./money";
import { MAX_AGGREGATE_CENTAVOS } from "./money-limits";
import { parseAmount } from "./money-parse";

describe("centavos boundary", () => {
  test("owns exact centavo summing and DB aggregate coercion behind the money barrel", () => {
    expect(sumCentavos).toBe(barrelSumCentavos);
    expect(toSafeCentavos).toBe(barrelToSafeCentavos);
    expect(sumCentavos([18_000, 25_000, 1])).toBe(43_001);
    expect(toSafeCentavos("2500000")).toBe(2_500_000);
    expect(() => toSafeCentavos(MAX_AGGREGATE_CENTAVOS + 1)).toThrow(/safe cap/);
  });
});

describe("sumCentavos", () => {
  test("returns an exact integer total", () => {
    const values = [18000, 25000, 2_500_000, 1, 99];
    expect(sumCentavos(values)).toBe(2_543_100);
  });

  test("matches deterministic integer reduction", () => {
    for (let i = 0; i < 500; i++) {
      const values = Array.from(
        { length: 20 },
        (_, j) => (i * 104_729 + j * 15_485_863) % 1_000_000,
      );
      expect(sumCentavos(values)).toBe(values.reduce((total, value) => total + value, 0));
    }
  });

  test("sums parsed amounts without float drift", () => {
    const inputs = ["180", "25k", "1.5k", "180.50", "0.01"];
    const parsed = inputs.map((input) => {
      const result = parseAmount(input);
      if (!result.ok) throw new Error("setup");
      return result.centavos;
    });

    expect(sumCentavos(parsed)).toBe(2_686_051);
  });
});

describe("toSafeCentavos", () => {
  test("passes through a valid number or bigint string unchanged", () => {
    expect(toSafeCentavos(2_500_000)).toBe(2_500_000);
    expect(toSafeCentavos("2500000")).toBe(2_500_000);
    expect(toSafeCentavos(0)).toBe(0);
  });

  test("coerces empty aggregates to zero", () => {
    expect(toSafeCentavos(null)).toBe(0);
    expect(toSafeCentavos(undefined)).toBe(0);
  });

  test("throws above the aggregate cap rather than returning a quietly wrong total", () => {
    expect(() => toSafeCentavos(MAX_AGGREGATE_CENTAVOS + 1)).toThrow(/safe cap/);
    expect(() => toSafeCentavos(String(MAX_AGGREGATE_CENTAVOS + 1))).toThrow(/safe cap/);
  });

  test("throws on non-integer or non-finite values", () => {
    expect(() => toSafeCentavos(1.5)).toThrow();
    expect(() => toSafeCentavos("not a number")).toThrow();
  });
});
