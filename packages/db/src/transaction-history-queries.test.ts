import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
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

  test("duplicate detection stays backed by the normalized-note lookup index", () => {
    const schema = readFileSync(new URL("./schema.ts", import.meta.url), "utf8");
    const query = readFileSync(
      new URL("./transaction-history-queries.ts", import.meta.url),
      "utf8",
    );
    const migration = readFileSync(
      new URL("../migrations/0011_damp_luckman.sql", import.meta.url),
      "utf8",
    );

    expect(schema).toContain('index("tx_duplicate_lookup_idx").on(');
    expect(schema).toContain("lower(coalesce(trim(");
    expect(schema).toContain("t.note");
    expect(schema).toContain("t.seq.desc()");
    expect(query).toContain("lower(coalesce(trim(");
    expect(query).toContain("transactions.note");
    expect(query).toContain("transactions.seq");
    expect(migration).toContain('CREATE INDEX "tx_duplicate_lookup_idx"');
    expect(migration).toContain("lower(coalesce(trim(\"note\"), ''))");
  });
});
