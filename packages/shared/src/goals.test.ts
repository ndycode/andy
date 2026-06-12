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
});
