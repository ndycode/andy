import { describe, expect, test } from "bun:test";
import {
  currentWeekStart,
  daysInLocalMonth,
  localDate,
  localDayOfMonth,
  localDayOfWeek,
  localHour,
  MANILA_OFFSET_MS,
  monthRange,
} from "./local-time";

describe("local-time module boundary", () => {
  test("owns fixed-offset Manila calendar helpers", () => {
    const edge = new Date("2026-06-14T16:00:00Z");

    expect(localDate(edge, MANILA_OFFSET_MS)).toBe("2026-06-15");
    expect(currentWeekStart(edge, MANILA_OFFSET_MS)).toBe("2026-06-15");
    expect(monthRange(edge, MANILA_OFFSET_MS)).toEqual({
      start: "2026-06-01",
      end: "2026-06-30",
    });
  });
});

describe("configurable offset", () => {
  const instant = new Date("2026-06-11T17:00:00Z");

  test("default offset matches Manila (UTC+8)", () => {
    expect(localDate(instant)).toBe("2026-06-12");
    expect(localDate(instant, MANILA_OFFSET_MS)).toBe("2026-06-12");
  });

  test("UTC offset yields a different local date for the same instant", () => {
    expect(localDate(instant, 0)).toBe("2026-06-11");
  });

  test("offset threads through month range and day-of-month consistently", () => {
    const edge = new Date("2026-05-31T20:00:00Z");

    expect(monthRange(edge, MANILA_OFFSET_MS).start).toBe("2026-06-01");
    expect(monthRange(edge, 0).start).toBe("2026-05-01");
    expect(localDayOfMonth(edge, 0)).toBe(31);
    expect(localDayOfMonth(edge, MANILA_OFFSET_MS)).toBe(1);
  });
});

describe("localDate", () => {
  test("UTC evening crosses into next Manila day", () => {
    expect(localDate(new Date("2026-06-11T17:00:00Z"))).toBe("2026-06-12");
  });

  test("UTC morning is same Manila day", () => {
    expect(localDate(new Date("2026-06-11T03:00:00Z"))).toBe("2026-06-11");
  });

  test("just before Manila midnight still resolves to previous day", () => {
    expect(localDate(new Date("2026-06-11T15:59:00Z"))).toBe("2026-06-11");
  });

  test("at Manila midnight rolls to next day", () => {
    expect(localDate(new Date("2026-06-11T16:00:00Z"))).toBe("2026-06-12");
  });
});

describe("localHour", () => {
  test('cron schedule "0 0 * * *" fires during the 08:00 Manila hour', () => {
    expect(localHour(new Date("2026-06-11T00:00:00Z"))).toBe(8);
  });
});

describe("currentWeekStart", () => {
  test("Thursday resolves to that week's Monday", () => {
    expect(currentWeekStart(new Date("2026-06-11T03:00:00Z"))).toBe("2026-06-08");
  });

  test("Monday resolves to itself", () => {
    expect(currentWeekStart(new Date("2026-06-08T03:00:00Z"))).toBe("2026-06-08");
  });

  test("Sunday resolves to the preceding Monday", () => {
    expect(currentWeekStart(new Date("2026-06-14T03:00:00Z"))).toBe("2026-06-08");
  });

  test("week boundary respects Manila midnight, not UTC", () => {
    expect(currentWeekStart(new Date("2026-06-14T15:59:00Z"))).toBe("2026-06-08");
    expect(currentWeekStart(new Date("2026-06-14T16:00:00Z"))).toBe("2026-06-15");
  });
});

describe("monthRange", () => {
  test("handles 30-day months", () => {
    expect(monthRange(new Date("2026-06-11T03:00:00Z"))).toEqual({
      start: "2026-06-01",
      end: "2026-06-30",
    });
  });

  test("handles February in non-leap years", () => {
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

  test("February 2024 has 29 days", () => {
    expect(daysInLocalMonth(new Date("2024-02-15T03:00:00Z"))).toBe(29);
  });

  test("April has 30 days and July has 31 days", () => {
    expect(daysInLocalMonth(new Date("2026-04-10T03:00:00Z"))).toBe(30);
    expect(daysInLocalMonth(new Date("2026-07-10T03:00:00Z"))).toBe(31);
  });

  test("respects Manila month boundaries", () => {
    expect(daysInLocalMonth(new Date("2026-01-31T16:00:00Z"))).toBe(28);
    expect(daysInLocalMonth(new Date("2026-01-31T15:59:00Z"))).toBe(31);
  });
});

describe("localDayOfMonth and localDayOfWeek", () => {
  test("day-of-month follows Manila midnight", () => {
    expect(localDayOfMonth(new Date("2026-06-11T15:59:00Z"))).toBe(11);
    expect(localDayOfMonth(new Date("2026-06-11T16:00:00Z"))).toBe(12);
  });

  test("day-of-week is 0 for Sunday through 6 for Saturday in Manila", () => {
    expect(localDayOfWeek(new Date("2026-06-11T03:00:00Z"))).toBe(4);
    expect(localDayOfWeek(new Date("2026-06-14T16:00:00Z"))).toBe(1);
  });
});
