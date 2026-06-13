import { describe, expect, test } from "bun:test";
import { goalProgressMessage } from "./goals";

// Plan §5 shared constants
const base = {
  name: "Emergency Fund",
  targetCentavos: 2_000_000,
  createdAt: new Date("2026-05-01T00:00:00Z"),
  today: new Date("2026-06-11T00:00:00Z"),
  targetDate: new Date("2026-09-30T00:00:00Z"),
};

describe("AC5 goal pace — exact plan fixtures", () => {
  test("Behind pace (saved 0.20 < elapsed 0.27)", () => {
    expect(goalProgressMessage({ ...base, savedCentavos: 400_000 })).toBe(
      "Emergency Fund: ₱4,000.00 / ₱20,000.00 (20%). Behind pace — save about ₱1,000.00/week to hit Sep 30.",
    );
  });

  test("On track (saved 0.40 >= elapsed 0.27)", () => {
    expect(goalProgressMessage({ ...base, savedCentavos: 800_000 })).toBe(
      "Emergency Fund: ₱8,000.00 / ₱20,000.00 (40%). On track to hit Sep 30.",
    );
  });

  test("AC3 contribution snapshot (8k/20k progress line)", () => {
    const msg = goalProgressMessage({ ...base, savedCentavos: 800_000 });
    expect(msg).toContain("₱8,000.00 / ₱20,000.00");
  });

  test("no targetDate -> no deadline", () => {
    expect(goalProgressMessage({ ...base, savedCentavos: 800_000, targetDate: null })).toBe(
      "Emergency Fund: ₱8,000.00 / ₱20,000.00 (40%). No deadline set.",
    );
  });

  test("deadline on/before creation day → on-track only when fully funded", () => {
    // targetDate == createdAt: zero/negative span. Underfunded must NOT report "on track".
    const sameDay = {
      ...base,
      createdAt: new Date("2026-06-11T15:00:00Z"),
      targetDate: new Date("2026-06-11T00:00:00Z"),
      today: new Date("2026-06-11T00:00:00Z"),
    };
    expect(goalProgressMessage({ ...sameDay, savedCentavos: 400_000 })).toContain("Behind pace");
    expect(goalProgressMessage({ ...sameDay, savedCentavos: 2_000_000 })).toContain("On track");
  });

  test("createdAt as a real timestamptz instant doesn't skew the day-based pace", () => {
    // createdAt at 23:00 UTC (a real instant) vs date-midnight today/target must compare by calendar
    // day — saved 0.40 >= elapsed 0.27 stays on track, not flipped by the ~1-day instant offset.
    expect(
      goalProgressMessage({
        ...base,
        createdAt: new Date("2026-05-01T23:30:00Z"),
        savedCentavos: 800_000,
      }),
    ).toBe("Emergency Fund: ₱8,000.00 / ₱20,000.00 (40%). On track to hit Sep 30.");
  });
});
