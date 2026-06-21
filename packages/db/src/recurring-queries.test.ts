import { describe, expect, test } from "bun:test";
import {
  addRecurring,
  claimReminder,
  dueRecurringToday,
  findRecurringByLabel,
  listRecurring,
} from "./recurring-queries";

describe("recurring queries module boundary", () => {
  test("exports the recurring item and reminder entrypoints", () => {
    expect(typeof addRecurring).toBe("function");
    expect(typeof listRecurring).toBe("function");
    expect(typeof findRecurringByLabel).toBe("function");
    expect(typeof dueRecurringToday).toBe("function");
    expect(typeof claimReminder).toBe("function");
  });
});
