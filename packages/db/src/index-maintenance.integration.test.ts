import { expect, test } from "bun:test";
import {
  describeDbIntegration,
  expectDbRejection,
  requireRow,
  useDbIntegration,
} from "./db-integration-test-harness";

describeDbIntegration("db package root - migration and maintenance integration", () => {
  const h = useDbIntegration();

  test("createGoal is case-insensitively unique per user and duplicate flushes keep sibling writes", async () => {
    const q = h.db();
    const userId = await q.resolveUserId("+639171234567");

    await q.flushWrites("g1", [
      { type: "createGoal", userId, name: "Japan", targetCentavos: 100_000, targetDate: null },
    ]);
    await q.flushWrites("g2", [
      { type: "createGoal", userId, name: "japan", targetCentavos: 999_999, targetDate: null },
      { type: "expense", userId, amountCentavos: 5_000, category: "Food", localDate: "2026-06-11" },
    ]);

    const goals = await q.listGoals(userId);
    expect(goals.length).toBe(1);
    expect(goals[0]?.targetCentavos).toBe(100_000);
    expect(await q.sumByCategory(userId, "Food", new Date("2026-06-11T03:00:00Z"))).toBe(5_000);
  });

  test("addRecurring upserts on user and lower(label)", async () => {
    const q = h.db();
    const userId = await q.resolveUserId("+639171234567");

    await q.addRecurring(userId, {
      label: "Rent",
      kind: "expense",
      amountCentavos: 800_000,
      category: "Bills",
      cadence: "monthly",
      dayOfMonth: 1,
    });
    await q.addRecurring(userId, {
      label: "rent",
      kind: "expense",
      amountCentavos: 900_000,
      category: "Bills",
      cadence: "monthly",
      dayOfMonth: 1,
    });

    const items = await q.listRecurring(userId);
    expect(items.length).toBe(1);
    expect(items[0]?.amountCentavos).toBe(900_000);
  });

  test("flush-path addRecurring upserts without duplicating or aborting", async () => {
    const q = h.db();
    const userId = await q.resolveUserId("+639171234567");
    const addNetflix = (amountCentavos: number) =>
      ({
        type: "addRecurring",
        userId,
        recurring: {
          label: "Netflix",
          kind: "expense",
          amountCentavos,
          category: "Entertainment",
          cadence: "monthly",
          dayOfMonth: 15,
          dayOfWeek: null,
        },
      }) as const;

    await q.flushWrites("r1", [addNetflix(54_900)]);
    await q.flushWrites("r2", [addNetflix(64_900)]);

    const items = await q.listRecurring(userId);
    expect(items.length).toBe(1);
    expect(items[0]?.amountCentavos).toBe(64_900);
  });

  test("reapMessages keeps only the most recent turns per user", async () => {
    const q = h.db();
    const userId = await q.resolveUserId("+639171234567");

    for (let i = 0; i < 6; i++) {
      await q.flushWrites(`t${i}`, [{ type: "saveTurn", userId, role: "user", content: `m${i}` }]);
    }

    expect(await q.reapMessages(userId, 2)).toBe(4);
    expect((await q.recentTurns(userId, 50)).map((turn) => turn.content)).toEqual(["m4", "m5"]);
  });

  test("reconcileGoalBalances corrects drift and is idempotent", async () => {
    const q = h.db();
    const sql = h.sql();
    const userId = await q.resolveUserId("+639171234567");

    await q.flushWrites("c1", [
      { type: "createGoal", userId, name: "Laptop", targetCentavos: 5_000_000, targetDate: null },
    ]);
    const goalId = requireRow((await q.listGoals(userId))[0], "goal").id;
    await q.flushWrites("c2", [
      { type: "goalContribution", userId, goalId, amountCentavos: 1_000, localDate: "2026-06-11" },
    ]);
    await sql`update savings_goals set saved_centavos = 999999 where id = ${goalId}`;

    expect(await q.reconcileGoalBalances(userId)).toBe(1);
    expect((await q.listGoals(userId)).find((goal) => goal.id === goalId)?.savedCentavos).toBe(
      1_000,
    );
    expect(await q.reconcileGoalBalances(userId)).toBe(0);
  });

  test("goal saved_centavos CHECK rejects an over-withdrawal", async () => {
    const q = h.db();
    const sql = h.sql();
    const userId = await q.resolveUserId("+639171234567");
    const goalId = requireRow(
      (
        await sql<{ id: string }[]>`
          insert into savings_goals (user_id, name, target_centavos, saved_centavos)
          values (${userId}, 'Trip', 100000, 0) returning id`
      )[0],
      "goal",
    ).id;

    await expectDbRejection(async () => {
      await sql`update savings_goals set saved_centavos = -1 where id = ${goalId}`;
    });
  });

  test("amount upper-bound CHECK rejects an over-safe-integer write", async () => {
    const q = h.db();
    const sql = h.sql();
    const userId = await q.resolveUserId("+639171234567");

    await expectDbRejection(async () => {
      await sql`insert into transactions (user_id, kind, amount_centavos, category, local_date)
        values (${userId}, 'expense', 9007199254740992, 'Food', '2026-06-11')`;
    });
  });

  test("claimReminder atomically records once per day before send", async () => {
    const q = h.db();
    const userId = await q.resolveUserId("+639171234567");

    await q.addRecurring(userId, {
      label: "Rent",
      kind: "expense",
      amountCentavos: 800_000,
      category: "Bills",
      cadence: "monthly",
      dayOfMonth: 1,
    });
    const id = requireRow((await q.listRecurring(userId))[0], "recurring item").id;
    const at = new Date("2026-06-11T03:00:00Z");

    expect(await q.claimReminder(id, userId, at)).toBe(true);
    expect(await q.claimReminder(id, userId, at)).toBe(false);
    expect(await q.claimReminder(id, await q.resolveUserId("+639170000000"), at)).toBe(false);
    expect(await q.claimReminder(id, userId, new Date("2026-06-12T03:00:00Z"))).toBe(true);
  });

  test("findRecentDuplicate matches same day, kind, amount, and note only", async () => {
    const q = h.db();
    const userId = await q.resolveUserId("+639171234567");

    await q.flushWrites("dup1", [
      {
        type: "expense",
        userId,
        amountCentavos: 25_000,
        category: "Transport",
        note: "grab",
        localDate: "2026-06-14",
      },
    ]);

    expect(
      await q.findRecentDuplicate(userId, "expense", 25_000, "GRAB", "2026-06-14"),
    ).not.toBeNull();
    expect(await q.findRecentDuplicate(userId, "expense", 30_000, "grab", "2026-06-14")).toBeNull();
    expect(await q.findRecentDuplicate(userId, "expense", 25_000, "grab", "2026-06-13")).toBeNull();
    expect(await q.findRecentDuplicate(userId, "expense", 25_000, "taxi", "2026-06-14")).toBeNull();
    expect(await q.findRecentDuplicate(userId, "income", 25_000, "grab", "2026-06-14")).toBeNull();

    await q.flushWrites("dup2", [
      {
        type: "expense",
        userId,
        amountCentavos: 9_900,
        category: "Other",
        localDate: "2026-06-14",
      },
    ]);
    expect(
      await q.findRecentDuplicate(userId, "expense", 9_900, undefined, "2026-06-14"),
    ).not.toBeNull();
  });
});
