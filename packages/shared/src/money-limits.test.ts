import { describe, expect, test } from "bun:test";
import * as money from "./money";
import { MAX_AGGREGATE_CENTAVOS, MAX_ENTRY_CENTAVOS } from "./money-limits";

describe("money-limits boundary", () => {
  test("owns app-level centavo caps outside the public money barrel", () => {
    expect(MAX_ENTRY_CENTAVOS).toBeGreaterThan(0);
    expect(MAX_AGGREGATE_CENTAVOS).toBeGreaterThan(MAX_ENTRY_CENTAVOS);
    expect("MAX_ENTRY_CENTAVOS" in money).toBe(false);
    expect("MAX_AGGREGATE_CENTAVOS" in money).toBe(false);
  });
});
