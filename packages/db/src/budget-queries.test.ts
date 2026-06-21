import { describe, expect, test } from "bun:test";
import { budgetStatuses, budgetStatusesFor } from "./budget-queries";

describe("budget queries module boundary", () => {
  test("exports the budget read entrypoints", () => {
    expect(typeof budgetStatuses).toBe("function");
    expect(typeof budgetStatusesFor).toBe("function");
  });
});
