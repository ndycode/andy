import { describe, expect, test } from "bun:test";
import {
  categoryAmountsThisMonth as rootCategoryAmountsThisMonth,
  getMonthOverview as rootGetMonthOverview,
  getSpendingByCategory as rootGetSpendingByCategory,
  sumByCategory as rootSumByCategory,
  sumSpendBetween as rootSumSpendBetween,
} from "./index";
import {
  categoryAmountsThisMonth,
  getMonthOverview,
  getSpendingByCategory,
  sumByCategory,
  sumSpendBetween,
} from "./transaction-aggregate-queries";

describe("transaction aggregate queries boundary", () => {
  test("owns month/range aggregate reads behind the package root", () => {
    expect(sumByCategory).toBe(rootSumByCategory);
    expect(sumSpendBetween).toBe(rootSumSpendBetween);
    expect(categoryAmountsThisMonth).toBe(rootCategoryAmountsThisMonth);
    expect(getMonthOverview).toBe(rootGetMonthOverview);
    expect(getSpendingByCategory).toBe(rootGetSpendingByCategory);
  });
});
