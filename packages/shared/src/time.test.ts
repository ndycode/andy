import { describe, expect, test } from "bun:test";
import {
  currentWeekStart,
  daysInLocalMonth,
  localDate,
  localDayOfMonth,
  localDayOfWeek,
  localHour,
  MANILA_OFFSET_MS,
  monthAnchor,
  monthRange,
  prevMonthAnchor,
  validateCalendarDate,
  validateLogDate,
} from "./time";

describe("configurable offset (timezone abstraction)", () => {
  const instant = new Date("2026-06-11T17:00:00Z"); // 01:00 next day at +8, still 17:00 same day at +0

  test("default offset matches Manila (UTC+8)", () => {
    expect(localDate(instant)).toBe("2026-06-12");
    expect(localDate(instant, MANILA_OFFSET_MS)).toBe("2026-06-12");
  });
  test("UTC offset (0) yields a different local date for the same instant", () => {
    expect(localDate(instant, 0)).toBe("2026-06-11");
  });
  test("offset threads through monthRange / day-of-month consistently", () => {
    // 2026-05-31T20:00Z = Jun 1 04:00 at +8 (June) but still May 31 at +0 (May).
    const edge = new Date("2026-05-31T20:00:00Z");
    expect(monthRange(edge, MANILA_OFFSET_MS).start).toBe("2026-06-01");
    expect(monthRange(edge, 0).start).toBe("2026-05-01");
    expect(localDayOfMonth(edge, 0)).toBe(31);
    expect(localDayOfMonth(edge, MANILA_OFFSET_MS)).toBe(1);
  });
});

describe("localDate (Asia/Manila, UTC+8)", () => {
  test("UTC evening crosses into next Manila day", () => {
    // 2026-06-11T17:00Z = 2026-06-12T01:00 Manila
    expect(localDate(new Date("2026-06-11T17:00:00Z"))).toBe("2026-06-12");
  });
  test("UTC morning is same Manila day", () => {
    expect(localDate(new Date("2026-06-11T03:00:00Z"))).toBe("2026-06-11");
  });
  test("just before Manila midnight (15:59Z) still previous day", () => {
    // 15:59Z = 23:59 Manila
    expect(localDate(new Date("2026-06-11T15:59:00Z"))).toBe("2026-06-11");
  });
  test("at Manila midnight (16:00Z) rolls to next day", () => {
    expect(localDate(new Date("2026-06-11T16:00:00Z"))).toBe("2026-06-12");
  });
});

describe("AC6 — UTC cron hour 0 maps into the 08:00 Manila hour", () => {
  test('schedule "0 0 * * *" fires at 08:00 Manila', () => {
    expect(localHour(new Date("2026-06-11T00:00:00Z"))).toBe(8);
  });
});

describe("currentWeekStart (Manila Monday)", () => {
  test("Thursday resolves to that week's Monday", () => {
    // 2026-06-11 is a Thursday
    expect(currentWeekStart(new Date("2026-06-11T03:00:00Z"))).toBe("2026-06-08");
  });
  test("Monday resolves to itself", () => {
    expect(currentWeekStart(new Date("2026-06-08T03:00:00Z"))).toBe("2026-06-08");
  });
  test("Sunday resolves to the preceding Monday", () => {
    // 2026-06-14 is a Sunday
    expect(currentWeekStart(new Date("2026-06-14T03:00:00Z"))).toBe("2026-06-08");
  });
  test("week boundary respects Manila midnight, not UTC", () => {
    // 2026-06-14T15:59Z = Sun 23:59 Manila -> still week of Mon 06-08
    expect(currentWeekStart(new Date("2026-06-14T15:59:00Z"))).toBe("2026-06-08");
    // 2026-06-14T16:00Z = Mon 00:00 Manila -> new week 06-15
    expect(currentWeekStart(new Date("2026-06-14T16:00:00Z"))).toBe("2026-06-15");
  });
});

describe("monthRange (Manila)", () => {
  test("June 2026", () => {
    expect(monthRange(new Date("2026-06-11T03:00:00Z"))).toEqual({
      start: "2026-06-01",
      end: "2026-06-30",
    });
  });
  test("February 2026 (28 days)", () => {
    expect(monthRange(new Date("2026-02-15T03:00:00Z"))).toEqual({
      start: "2026-02-01",
      end: "2026-02-28",
    });
  });
});

describe("daysInLocalMonth", () => {
  test("February 2026 has 28 days", () => {
    expect(daysInLocalMonth(new Date("2026-02-15T03:00:00Z"))).toBe(28);
  });
  test("February 2024 (leap) has 29 days", () => {
    expect(daysInLocalMonth(new Date("2024-02-15T03:00:00Z"))).toBe(29);
  });
  test("April has 30, July has 31", () => {
    expect(daysInLocalMonth(new Date("2026-04-10T03:00:00Z"))).toBe(30);
    expect(daysInLocalMonth(new Date("2026-07-10T03:00:00Z"))).toBe(31);
  });
  test("respects Manila boundary (last UTC instant of Jan 31 is still Jan in Manila)", () => {
    // 2026-01-31T16:00Z = Feb 1 00:00 Manila → February
    expect(daysInLocalMonth(new Date("2026-01-31T16:00:00Z"))).toBe(28);
    // 2026-01-31T15:59Z = Jan 31 23:59 Manila → January
    expect(daysInLocalMonth(new Date("2026-01-31T15:59:00Z"))).toBe(31);
  });
});

describe("localDayOfMonth / localDayOfWeek", () => {
  test("day-of-month follows Manila midnight", () => {
    expect(localDayOfMonth(new Date("2026-06-11T15:59:00Z"))).toBe(11); // 23:59 Manila
    expect(localDayOfMonth(new Date("2026-06-11T16:00:00Z"))).toBe(12); // 00:00 Manila next day
  });
  test("day-of-week is 0=Sun..6=Sat in Manila", () => {
    // 2026-06-11 is a Thursday (4) in Manila daytime
    expect(localDayOfWeek(new Date("2026-06-11T03:00:00Z"))).toBe(4);
    // 2026-06-14T16:00Z = Mon 00:00 Manila → 1
    expect(localDayOfWeek(new Date("2026-06-14T16:00:00Z"))).toBe(1);
  });
});

describe("validateLogDate (backdated logging)", () => {
  const now = new Date("2026-06-11T03:00:00Z"); // 2026-06-11 Manila

  test("accepts today", () => {
    expect(validateLogDate("2026-06-11", now)).toEqual({ ok: true, date: "2026-06-11" });
  });
  test("accepts a recent past date", () => {
    expect(validateLogDate("2026-05-30", now)).toEqual({ ok: true, date: "2026-05-30" });
  });
  test("rejects a future date", () => {
    const r = validateLogDate("2026-06-12", now);
    expect(r.ok).toBe(false);
  });
  test("rejects a non-calendar date (Feb 30)", () => {
    const r = validateLogDate("2026-02-30", now);
    expect(r.ok).toBe(false);
  });
  test("rejects malformed input", () => {
    for (const bad of ["", "yesterday", "2026/06/11", "06-11-2026", "2026-6-1", "2026-13-01"]) {
      expect(validateLogDate(bad, now).ok).toBe(false);
    }
  });
  test("rejects an absurdly old year (likely typo)", () => {
    expect(validateLogDate("2019-01-01", now).ok).toBe(false);
  });
  test("future check respects Manila day boundary, not UTC", () => {
    // At 2026-06-11T15:59Z it's still 2026-06-11 in Manila, so that date is 'today' (allowed)
    // and 2026-06-12 is the future (rejected).
    const justBeforeMidnight = new Date("2026-06-11T15:59:00Z");
    expect(validateLogDate("2026-06-11", justBeforeMidnight).ok).toBe(true);
    expect(validateLogDate("2026-06-12", justBeforeMidnight).ok).toBe(false);
  });
});

describe("validateCalendarDate (goal deadlines, any direction)", () => {
  test("accepts a future date (deadlines can be ahead)", () => {
    expect(validateCalendarDate("2030-12-25")).toEqual({ ok: true, date: "2030-12-25" });
  });
  test("accepts a past date too", () => {
    expect(validateCalendarDate("2020-01-01")).toEqual({ ok: true, date: "2020-01-01" });
  });
  test("rejects non-calendar (Feb 30), natural language, and malformed input", () => {
    for (const bad of ["2026-02-30", "december", "2026-13-01", "2026/12/25", ""]) {
      expect(validateCalendarDate(bad).ok).toBe(false);
    }
  });
});

describe("prevMonthAnchor (compare-to-last-month default)", () => {
  test("June → May", () => {
    expect(monthRange(prevMonthAnchor(new Date("2026-06-15T04:00:00Z")))).toEqual({
      start: "2026-05-01",
      end: "2026-05-31",
    });
  });
  test("January → previous December (crosses the year boundary)", () => {
    expect(monthRange(prevMonthAnchor(new Date("2026-01-15T04:00:00Z")))).toEqual({
      start: "2025-12-01",
      end: "2025-12-31",
    });
  });
  test("respects Manila boundary: Jan-1 Manila midnight still resolves prev = December", () => {
    // 2025-12-31T16:00Z = 2026-01-01 00:00 Manila → current month Jan → prev Dec
    expect(monthRange(prevMonthAnchor(new Date("2025-12-31T16:00:00Z")))).toEqual({
      start: "2025-12-01",
      end: "2025-12-31",
    });
  });
});

describe("monthAnchor (historical month queries)", () => {
  test("anchors mid-month so monthRange resolves to that exact month", () => {
    const a = monthAnchor("2026-05");
    expect(a).not.toBeNull();
    if (a) expect(monthRange(a)).toEqual({ start: "2026-05-01", end: "2026-05-31" });
  });
  test("February resolves to its real length", () => {
    const a = monthAnchor("2024-02"); // leap
    if (a) expect(monthRange(a)).toEqual({ start: "2024-02-01", end: "2024-02-29" });
  });
  test("rejects malformed or out-of-range input", () => {
    for (const bad of ["", "2026", "2026-13", "2026-00", "26-05", "2026/05"]) {
      expect(monthAnchor(bad)).toBeNull();
    }
  });
});
