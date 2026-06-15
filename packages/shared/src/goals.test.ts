import { describe, expect, test } from "bun:test";
import { goalPace, goalProgressMessage } from "./goals";

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
    // createdAt at 23:30 UTC (a real instant = Manila next-day 07:30) is re-anchored to its Manila
    // calendar day before differencing, so saved 0.40 >= elapsed ~0.26 stays on track.
    expect(
      goalProgressMessage({
        ...base,
        createdAt: new Date("2026-05-01T23:30:00Z"),
        savedCentavos: 800_000,
      }),
    ).toBe("Emergency Fund: ₱8,000.00 / ₱20,000.00 (40%). On track to hit Sep 30.");
  });

  test("short-span goal created during Manila 00:00–07:59 is not off-by-one (regression for the createdAt skew)", () => {
    // createdAt UTC 2026-06-01T20:00Z == Manila 2026-06-02 04:00. A bare UTC-day floor would treat
    // it as Jun 1, inflating span to 11 and elapsed to 3 (0.273) — flipping a 25%-saved goal to
    // "Behind pace". Manila-anchored it's Jun 2: span 10, elapsed 2 (0.20), so 0.25 >= 0.20 is on track.
    const g = {
      name: "Trip",
      targetCentavos: 1_000_000,
      savedCentavos: 250_000,
      createdAt: new Date("2026-06-01T20:00:00Z"),
      today: new Date("2026-06-04T00:00:00Z"),
      targetDate: new Date("2026-06-12T00:00:00Z"),
    };
    expect(goalPace(g)).toMatchObject({ hasDeadline: true, onTrack: true, perWeekCentavos: null });
    expect(goalProgressMessage(g)).toContain("On track");
  });

  test("goalPace exposes a structured verdict (no string-matching needed downstream)", () => {
    const behind = goalPace({ ...base, savedCentavos: 400_000 });
    expect(behind).toMatchObject({ pct: 20, hasDeadline: true, onTrack: false });
    expect(behind.perWeekCentavos).toBeGreaterThan(0);

    const onTrack = goalPace({ ...base, savedCentavos: 800_000 });
    expect(onTrack).toMatchObject({
      pct: 40,
      hasDeadline: true,
      onTrack: true,
      perWeekCentavos: null,
    });

    const noDeadline = goalPace({ ...base, savedCentavos: 800_000, targetDate: null });
    expect(noDeadline).toMatchObject({ hasDeadline: false, onTrack: true });
  });
});
