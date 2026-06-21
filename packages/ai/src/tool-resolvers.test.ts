import { describe, expect, test } from "bun:test";
import { resolveLogDate, resolveMonthAt } from "./tool-resolvers";

describe("tool date and month resolvers", () => {
  test("omitted log date resolves to the request-local today", () => {
    expect(resolveLogDate(undefined, "2026-06-11")).toEqual({
      ok: true,
      date: "2026-06-11",
    });
  });

  test("valid log date passes through and future dates become tool errors", () => {
    expect(resolveLogDate("2026-06-03", "2026-06-11")).toEqual({
      ok: true,
      date: "2026-06-03",
    });
    expect(resolveLogDate("2026-06-12", "2026-06-11")).toEqual({
      ok: false,
      error: "can't log a future date",
    });
  });

  test("valid month resolves to a stable anchor and malformed month falls back to current", () => {
    const resolved = resolveMonthAt("2026-05");

    expect(resolved.label).toBe("2026-05");
    expect(resolved.at?.toISOString()).toBe("2026-05-15T04:00:00.000Z");
    expect(resolveMonthAt("not-a-month")).toEqual({ at: undefined, label: null });
    expect(resolveMonthAt(undefined)).toEqual({ at: undefined, label: null });
  });
});
