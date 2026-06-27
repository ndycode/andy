import { describe, expect, test } from "bun:test";
import type { WriteIntent } from "@repo/db";
import { toolContext as ctx } from "./context-test-harness";
import { deleteLastTransaction, editLastTransaction } from "./edit-tool-actions";

describe("edit-tool-actions boundary", () => {
  test("deleteLastTransaction targets the latest same-turn transaction before history", () => {
    const c = ctx();
    c.addWrite({
      type: "expense",
      userId: "user-1",
      amountCentavos: 18_000,
      category: "Transport",
      note: "grab",
      localDate: "2026-06-11",
    });

    expect(deleteLastTransaction(c)).toEqual({
      ok: true,
      deleted: { amount: "₱180.00", category: "Transport", note: "grab" },
    });
    expect(c.peekWrites().at(-1)).toEqual({
      type: "deleteLast",
      userId: "user-1",
      targetSameTurn: true,
    } satisfies WriteIntent);
  });

  test("editLastTransaction preserves the Savings/Goals category for goal-linked contributions", () => {
    const c = ctx();
    c.addWrite({
      type: "goalContribution",
      userId: "user-1",
      goalId: "goal-1",
      amountCentavos: 50_000,
      localDate: "2026-06-11",
    });

    expect(editLastTransaction(c, { category: "Food" })).toEqual({
      ok: false,
      error:
        "that's a goal contribution — its category stays Savings/Goals. edit the amount instead.",
    });
    expect(c.peekWrites()).toHaveLength(1);
  });

  test("editLastTransaction never recategorizes an expense as Income", () => {
    const c = ctx();
    c.addWrite({
      type: "expense",
      userId: "user-1",
      amountCentavos: 18_000,
      category: "Transport",
      note: "grab",
      localDate: "2026-06-11",
    });
    // "salary"/"income" coerce to Income via coerceCategory; the expense edit path must NOT store an
    // expense under Income (it would corrupt every income/expense aggregate).
    const res = editLastTransaction(c, { category: "income" });
    expect(res.ok).toBe(true);
    const w = c.peekWrites().at(-1);
    expect(w?.type).toBe("editLast");
    if (w?.type === "editLast") expect(w.patch.category).not.toBe("Income");
  });

  test("editLastTransaction rejects a category change on an income transaction", () => {
    const c = ctx();
    c.addWrite({
      type: "income",
      userId: "user-1",
      amountCentavos: 2_500_000,
      category: "Income",
      note: "sweldo",
      localDate: "2026-06-11",
    });
    expect(editLastTransaction(c, { category: "Food" })).toEqual({
      ok: false,
      error: "that's income — it stays under Income. edit the amount instead.",
    });
    expect(c.peekWrites()).toHaveLength(1);
  });
});
