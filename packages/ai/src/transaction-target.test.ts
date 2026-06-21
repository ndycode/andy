import { describe, expect, test } from "bun:test";
import type { WriteIntent } from "@repo/db";
import { lastBufferedTransaction, turnLoggedTransaction } from "./transaction-target";

const userId = "user-1";

describe("transaction target replay", () => {
  test("projects the latest same-turn transaction through an edit", () => {
    const writes = [
      {
        type: "expense",
        userId,
        amountCentavos: 18_000,
        category: "Transport",
        note: "grab",
        localDate: "2026-06-11",
      },
      {
        type: "editLast",
        userId,
        targetSameTurn: true,
        patch: { amountCentavos: 20_000, category: "Food", note: "jollibee" },
      },
    ] satisfies WriteIntent[];

    expect(lastBufferedTransaction(writes)).toEqual({
      amountCentavos: 20_000,
      category: "Food",
      note: "jollibee",
      goalLinked: false,
    });
    expect(turnLoggedTransaction(writes)).toBe(true);
  });

  test("same-turn delete clears the target without hiding that the turn logged something", () => {
    const writes = [
      {
        type: "income",
        userId,
        amountCentavos: 250_000,
        category: "Income",
        note: "payment",
        localDate: "2026-06-11",
      },
      { type: "deleteLast", userId, targetSameTurn: true },
    ] satisfies WriteIntent[];

    expect(lastBufferedTransaction(writes)).toBeNull();
    expect(turnLoggedTransaction(writes)).toBe(true);
  });

  test("goal contributions replay as goal-linked Savings/Goals targets", () => {
    const writes = [
      {
        type: "goalContribution",
        userId,
        goalId: "goal-1",
        amountCentavos: 5_000,
        localDate: "2026-06-11",
      },
    ] satisfies WriteIntent[];

    expect(lastBufferedTransaction(writes)).toEqual({
      amountCentavos: 5_000,
      category: "Savings/Goals",
      note: null,
      goalLinked: true,
    });
    expect(turnLoggedTransaction(writes)).toBe(true);
  });
});
