import { describe, expect, test } from "bun:test";
import { applyTransactionWriteIntent } from "./transaction-write-applier";

describe("transaction write applier boundary", () => {
  test("exports the transaction and correction intent applier", () => {
    expect(typeof applyTransactionWriteIntent).toBe("function");
  });
});
