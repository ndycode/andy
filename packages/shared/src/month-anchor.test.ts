import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { monthRange } from "./local-time";
import { monthAnchor, prevMonthAnchor } from "./month-anchor";

describe("month-anchor module boundary", () => {
  test("owns month query anchors", () => {
    const may = monthAnchor("2026-05");

    expect(may).not.toBeNull();
    if (may) expect(monthRange(may)).toEqual({ start: "2026-05-01", end: "2026-05-31" });
    expect(monthRange(prevMonthAnchor(new Date("2026-01-15T04:00:00Z")))).toEqual({
      start: "2025-12-01",
      end: "2025-12-31",
    });
  });

  test("keeps previous-month anchor parsing free of numeric assertions", () => {
    const source = readFileSync(new URL("./month-anchor.ts", import.meta.url), "utf8");

    expect(source).not.toContain("as number");
  });
});

describe("prevMonthAnchor", () => {
  test("June resolves to May", () => {
    expect(monthRange(prevMonthAnchor(new Date("2026-06-15T04:00:00Z")))).toEqual({
      start: "2026-05-01",
      end: "2026-05-31",
    });
  });

  test("January resolves to previous December", () => {
    expect(monthRange(prevMonthAnchor(new Date("2026-01-15T04:00:00Z")))).toEqual({
      start: "2025-12-01",
      end: "2025-12-31",
    });
  });

  test("respects Manila boundary at the start of January", () => {
    expect(monthRange(prevMonthAnchor(new Date("2025-12-31T16:00:00Z")))).toEqual({
      start: "2025-12-01",
      end: "2025-12-31",
    });
  });
});

describe("monthAnchor", () => {
  test("anchors mid-month so monthRange resolves to that exact month", () => {
    const anchor = monthAnchor("2026-05");

    expect(anchor).not.toBeNull();
    if (anchor) expect(monthRange(anchor)).toEqual({ start: "2026-05-01", end: "2026-05-31" });
  });

  test("February resolves to its real length", () => {
    const anchor = monthAnchor("2024-02");

    if (anchor) expect(monthRange(anchor)).toEqual({ start: "2024-02-01", end: "2024-02-29" });
  });

  test("rejects malformed or out-of-range input", () => {
    for (const bad of ["", "2026", "2026-13", "2026-00", "26-05", "2026/05"]) {
      expect(monthAnchor(bad)).toBeNull();
    }
  });
});
