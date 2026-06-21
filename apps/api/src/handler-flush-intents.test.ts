import { describe, expect, test } from "bun:test";
import type { WriteIntent } from "@repo/db";
import { buildFlushIntents } from "./handler-flush-intents";

const EXPENSE: WriteIntent = {
  type: "expense",
  userId: "user-1",
  amountCentavos: 18000,
  category: "Transport",
  note: "grab",
  localDate: "2026-06-11",
};

describe("buildFlushIntents", () => {
  test("appends user and assistant turns after the agent writes", () => {
    const intents = buildFlushIntents({
      userId: "user-1",
      inboundText: "grab 180",
      reply: "logged",
      writes: [EXPENSE],
    });

    expect(intents).toEqual([
      EXPENSE,
      { type: "saveTurn", userId: "user-1", role: "user", content: "grab 180" },
      { type: "saveTurn", userId: "user-1", role: "assistant", content: "logged" },
    ]);
  });
});
