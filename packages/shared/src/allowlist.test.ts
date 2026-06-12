import { describe, expect, test } from "bun:test";
import { constantTimeEqual, isAllowed, normalizePhone } from "./allowlist";

describe("normalizePhone", () => {
  test.each([
    ["+639171234567", "+639171234567"],
    ["09171234567", "+09171234567"],
    ["+63 917 123 4567", "+639171234567"],
    ["+63-917-123-4567", "+639171234567"],
    ["", ""],
  ])("%s -> %s", (input, expected) => {
    expect(normalizePhone(input)).toBe(expected);
  });
});

describe("isAllowed (AC10)", () => {
  const allowed = "+639171234567";
  test("exact match", () => {
    expect(isAllowed("+639171234567", allowed)).toBe(true);
  });
  test("match despite formatting differences", () => {
    expect(isAllowed("+63 917 123 4567", allowed)).toBe(true);
  });
  test("unknown number rejected", () => {
    expect(isAllowed("+639179999999", allowed)).toBe(false);
  });
  test("empty inbound rejected", () => {
    expect(isAllowed("", allowed)).toBe(false);
  });
});

describe("constantTimeEqual", () => {
  test("equal strings", () => expect(constantTimeEqual("abc", "abc")).toBe(true));
  test("different length", () => expect(constantTimeEqual("abc", "abcd")).toBe(false));
  test("same length differ", () => expect(constantTimeEqual("abc", "abd")).toBe(false));
});
