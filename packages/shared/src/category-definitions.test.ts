import { describe, expect, test } from "bun:test";
import { CATEGORIES, isCategory } from "./category-definitions";

describe("category-definitions module boundary", () => {
  test("owns canonical category values and exact membership", () => {
    expect(CATEGORIES).toContain("Food");
    expect(CATEGORIES).toContain("Savings/Goals");
    expect(isCategory("Food")).toBe(true);
    expect(isCategory("food")).toBe(false);
  });
});
