import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { constantTimeEqual } from "./security";

describe("security utilities", () => {
  test("constantTimeEqual accepts exact string matches", () => {
    expect(constantTimeEqual("Bearer secret", "Bearer secret")).toBe(true);
  });

  test("constantTimeEqual rejects different length or same-length mismatches", () => {
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
  });

  test("constantTimeEqual scans mismatched lengths instead of returning before comparison", () => {
    const source = readFileSync(new URL("./security.ts", import.meta.url), "utf8");

    expect(source).not.toContain("a.length !== b.length");
    expect(source).toContain("Math.max");
  });
});
