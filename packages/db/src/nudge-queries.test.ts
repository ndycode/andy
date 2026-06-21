import { describe, expect, test } from "bun:test";
import { reapNudges, recordNudge } from "./nudge-queries";

describe("nudge queries module boundary", () => {
  test("exports proactive nudge claim and hygiene entrypoints", () => {
    expect(typeof recordNudge).toBe("function");
    expect(typeof reapNudges).toBe("function");
  });
});
