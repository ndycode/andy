import { describe, expect, test } from "bun:test";
import type { WriteIntent } from "@repo/db";
import { budgetReaction } from "./handler-budget-reaction";

const FOOD_EXPENSE: WriteIntent = {
  type: "expense",
  userId: "user-1",
  amountCentavos: 100000,
  category: "Food",
  note: "lunch",
  localDate: "2026-06-11",
};

describe("budgetReaction", () => {
  test("returns joined lines for current-month expenses that cross a budget threshold", async () => {
    const line = await budgetReaction("user-1", [FOOD_EXPENSE], async (_userId, categories) => [
      { category: categories[0] ?? "Food", spent: 410000, limit: 500000 },
    ]);

    expect(line).toBe("that's 82% of your Food budget, ₱900.00 left for the month 👀");
  });

  test("stays quiet when the turn also edited/deleted (per-expense justLogged math would be wrong)", async () => {
    let queried = false;
    const line = await budgetReaction(
      "user-1",
      [
        FOOD_EXPENSE,
        {
          type: "editLast",
          userId: "user-1",
          targetSameTurn: true,
          patch: { amountCentavos: 5000 },
        },
      ],
      async () => {
        queried = true;
        return [{ category: "Food", spent: 410000, limit: 500000 }];
      },
    );
    expect(line).toBeNull();
    expect(queried).toBe(false);
  });

  test("ignores non-current-month expenses before querying budget status", async () => {
    let queried = false;

    const line = await budgetReaction(
      "user-1",
      [{ ...FOOD_EXPENSE, localDate: "2026-05-31" }],
      async () => {
        queried = true;
        return [];
      },
    );

    expect(line).toBeNull();
    expect(queried).toBe(false);
  });
});
