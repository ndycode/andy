import { describe, expect, test } from "bun:test";
import { formatPHP as barrelFormatPHP } from "./money";
import { formatPHP } from "./money-format";

describe("money-format boundary", () => {
  test("owns PHP centavo formatting behind the money barrel", () => {
    expect(formatPHP).toBe(barrelFormatPHP);
    expect(formatPHP(18_000)).toBe("₱180.00");
    expect(formatPHP(-18_000)).toBe("-₱180.00");
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
  ])("%d -> %s", (centavos, expected) => {
    expect(formatPHP(centavos)).toBe(expected);
  });

  test("throws on non-integer", () => {
    expect(() => formatPHP(180.5)).toThrow();
  });
});
