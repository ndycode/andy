import { describe, expect, test } from "bun:test";
import { currentWeekStart, localDate, manilaHour, monthRange } from "./time";

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
    expect(manilaHour(new Date("2026-06-11T00:00:00Z"))).toBe(8);
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
