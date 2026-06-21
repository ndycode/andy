import { describe, expect, test } from "bun:test";
import { recentTurns } from "./conversation-queries";

describe("conversation queries module boundary", () => {
  test("exports the short-term conversation read entrypoint", () => {
    expect(typeof recentTurns).toBe("function");
  });
});
