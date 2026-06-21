import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { goalProgressMessage } from "./goal-progress-message";
import { goalProgressMessage as barrelGoalProgressMessage } from "./goals";

const base = {
  name: "Emergency Fund",
  targetCentavos: 2_000_000,
  createdAt: new Date("2026-05-01T00:00:00Z"),
  today: new Date("2026-06-11T00:00:00Z"),
  targetDate: new Date("2026-09-30T00:00:00Z"),
};

describe("goal-progress-message boundary", () => {
  test("owns human progress rendering behind the goals barrel", () => {
    expect(goalProgressMessage).toBe(barrelGoalProgressMessage);

    expect(goalProgressMessage({ ...base, savedCentavos: 400_000 })).toBe(
      "Emergency Fund: ₱4,000.00 / ₱20,000.00 (20%). Behind pace — save about ₱1,000.00/week to hit Sep 30.",
    );
    expect(goalProgressMessage({ ...base, savedCentavos: 800_000 })).toBe(
      "Emergency Fund: ₱8,000.00 / ₱20,000.00 (40%). On track to hit Sep 30.",
    );
  });

  test("renders no-deadline goals without invoking pace wording", () => {
    expect(goalProgressMessage({ ...base, savedCentavos: 800_000, targetDate: null })).toBe(
      "Emergency Fund: ₱8,000.00 / ₱20,000.00 (40%). No deadline set.",
    );
  });

  test("keeps goal progress rendering free of production type assertions", () => {
    const source = readFileSync(new URL("./goal-progress-message.ts", import.meta.url), "utf8");

    expect(source).not.toContain(" as Date");
    expect(source).not.toContain(" as number");
  });
});
