import { describe, expect, test } from "bun:test";
import { coerceCategory } from "./category-coercion";

describe("category-coercion module boundary", () => {
  test("owns canonical and synonym coercion", () => {
    expect(coerceCategory("  transport ")).toBe("Transport");
    expect(coerceCategory("groceries")).toBe("Food");
    expect(coerceCategory("matcha")).toBe("Food");
    expect(coerceCategory("jollibee")).toBe("Food");
    expect(coerceCategory("netflix")).toBe("Bills");
    expect(coerceCategory("salary")).toBe("Income");
    expect(coerceCategory("xyzzy")).toBe("Other");
  });
});
