import { describe, expect, test } from "bun:test";
import { goalPace } from "./goal-pace";
import { goalPace as barrelGoalPace } from "./goals";

const base = {
  name: "Emergency Fund",
  targetCentavos: 2_000_000,
  createdAt: new Date("2026-05-01T00:00:00Z"),
  today: new Date("2026-06-11T00:00:00Z"),
  targetDate: new Date("2026-09-30T00:00:00Z"),
};

describe("goal-pace boundary", () => {
  test("owns structured savings-goal pace verdicts behind the goals barrel", () => {
    expect(goalPace).toBe(barrelGoalPace);

    expect(goalPace({ ...base, savedCentavos: 400_000 })).toMatchObject({
      pct: 20,
      hasDeadline: true,
      onTrack: false,
    });
    expect(goalPace({ ...base, savedCentavos: 800_000 })).toMatchObject({
      pct: 40,
      hasDeadline: true,
      onTrack: true,
      perWeekCentavos: null,
    });
  });

  test("anchors createdAt to Manila calendar days before pace math", () => {
    const g = {
      name: "Trip",
      targetCentavos: 1_000_000,
      savedCentavos: 250_000,
      createdAt: new Date("2026-06-01T20:00:00Z"),
      today: new Date("2026-06-04T00:00:00Z"),
      targetDate: new Date("2026-06-12T00:00:00Z"),
    };

    expect(goalPace(g)).toMatchObject({ hasDeadline: true, onTrack: true });
  });
});
