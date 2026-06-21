import { describe, expect, test } from "bun:test";
import {
  addRecurringBill,
  editRecurringBill,
  listRecurringBills,
  removeRecurringBill,
} from "./recurring-actions";

describe("recurring actions boundary", () => {
  test("exports write, read, and management action entrypoints", () => {
    expect(addRecurringBill).toBeFunction();
    expect(listRecurringBills).toBeFunction();
    expect(removeRecurringBill).toBeFunction();
    expect(editRecurringBill).toBeFunction();
  });
});
