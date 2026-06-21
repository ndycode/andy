import { describe, expect, test } from "bun:test";
import {
  findRecentDuplicate as rootFindRecentDuplicate,
  getLastTransaction as rootGetLastTransaction,
  getRecentTransactions as rootGetRecentTransactions,
  searchTransactions as rootSearchTransactions,
} from "./index";
import {
  findRecentDuplicate,
  getLastTransaction,
  getRecentTransactions,
  searchTransactions,
} from "./transaction-history-queries";

describe("transaction history queries boundary", () => {
  test("owns transaction history, duplicate, and search reads behind the package root", () => {
    expect(findRecentDuplicate).toBe(rootFindRecentDuplicate);
    expect(getRecentTransactions).toBe(rootGetRecentTransactions);
    expect(searchTransactions).toBe(rootSearchTransactions);
    expect(getLastTransaction).toBe(rootGetLastTransaction);
  });
});
