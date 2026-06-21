import { describe, expect, test } from "bun:test";
import { validateCalendarDate, validateLogDate } from "./date-validation";

describe("date-validation module boundary", () => {
  test("owns log-date and calendar-date input validation", () => {
    const now = new Date("2026-06-11T03:00:00Z");

    expect(validateLogDate("2026-06-11", now)).toEqual({ ok: true, date: "2026-06-11" });
    expect(validateLogDate("2026-06-12", now).ok).toBe(false);
    expect(validateCalendarDate("2030-12-25")).toEqual({ ok: true, date: "2030-12-25" });
    expect(validateCalendarDate("2030-02-30").ok).toBe(false);
  });
});

describe("validateLogDate", () => {
  const now = new Date("2026-06-11T03:00:00Z");

  test("accepts today", () => {
    expect(validateLogDate("2026-06-11", now)).toEqual({ ok: true, date: "2026-06-11" });
  });

  test("accepts a recent past date", () => {
    expect(validateLogDate("2026-05-30", now)).toEqual({ ok: true, date: "2026-05-30" });
  });

  test("rejects a future date", () => {
    expect(validateLogDate("2026-06-12", now).ok).toBe(false);
  });

  test("rejects a non-calendar date", () => {
    expect(validateLogDate("2026-02-30", now).ok).toBe(false);
  });

  test("rejects malformed input", () => {
    for (const bad of ["", "yesterday", "2026/06/11", "06-11-2026", "2026-6-1", "2026-13-01"]) {
      expect(validateLogDate(bad, now).ok).toBe(false);
    }
  });

  test("rejects an absurdly old year", () => {
    expect(validateLogDate("2019-01-01", now).ok).toBe(false);
  });

  test("future check respects Manila day boundary, not UTC", () => {
    const justBeforeMidnight = new Date("2026-06-11T15:59:00Z");

    expect(validateLogDate("2026-06-11", justBeforeMidnight).ok).toBe(true);
    expect(validateLogDate("2026-06-12", justBeforeMidnight).ok).toBe(false);
  });
});

describe("validateCalendarDate", () => {
  test("accepts a future date", () => {
    expect(validateCalendarDate("2030-12-25")).toEqual({ ok: true, date: "2030-12-25" });
  });

  test("accepts a past date", () => {
    expect(validateCalendarDate("2020-01-01")).toEqual({ ok: true, date: "2020-01-01" });
  });

  test("rejects non-calendar, natural language, and malformed input", () => {
    for (const bad of ["2026-02-30", "december", "2026-13-01", "2026/12/25", ""]) {
      expect(validateCalendarDate(bad).ok).toBe(false);
    }
  });
});
