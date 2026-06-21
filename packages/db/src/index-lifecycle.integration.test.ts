import { expect, test } from "bun:test";
import { describeDbIntegration, requireRow, useDbIntegration } from "./db-integration-test-harness";

const userScopedTables = [
  "transactions",
  "savings_goals",
  "budgets",
  "memories",
  "messages",
  "recurring_items",
  "nudges",
  "habits",
] as const;

describeDbIntegration("db package root - lifecycle integration", () => {
  const h = useDbIntegration();

  test("resolveUserId is race-safe for concurrent first messages", async () => {
    const q = h.db();
    const sql = h.sql();
    const [a, b] = await Promise.all([
      q.resolveUserId("+639171234567"),
      q.resolveUserId("+639171234567"),
    ]);

    expect(a).toBe(b);
    const [row] = await sql<{ n: number }[]>`select count(*)::int n from users`;
    expect(row?.n).toBe(1);
  });

  test("deleteUser cascades every user-scoped child table", async () => {
    const q = h.db();
    const sql = h.sql();
    const userId = await q.resolveUserId("+639171234567");

    await q.flushWrites("del1", [
      {
        type: "expense",
        userId,
        amountCentavos: 18_000,
        category: "Transport",
        note: "grab",
        localDate: "2026-06-11",
      },
      { type: "createGoal", userId, name: "Trip", targetCentavos: 100_000, targetDate: null },
      { type: "saveMemory", userId, content: "payday 15th", kind: "payday" },
      { type: "saveTurn", userId, role: "user", content: "hi" },
      { type: "setBudget", userId, category: "Food", monthlyLimitCentavos: 500_000 },
    ]);
    await q.addRecurring(userId, {
      label: "Rent",
      kind: "expense",
      amountCentavos: 800_000,
      category: "Bills",
      cadence: "monthly",
      dayOfMonth: 1,
    });
    await q.recordNudge(userId, "budget:Food");
    await q.learnHabit(userId, "grab", "Transport");

    expect(await q.deleteUser(userId)).toBe(true);
    for (const table of userScopedTables) {
      const [row] = await sql<{ n: number }[]>`
        select count(*)::int n from ${sql(table)} where user_id = ${userId}`;
      expect(row?.n).toBe(0);
    }
    const [user] = await sql<
      { n: number }[]
    >`select count(*)::int n from users where id = ${userId}`;
    expect(user?.n).toBe(0);
    expect(await q.deleteUser(userId)).toBe(false);
  });

  test("reapNudges and reapSummaryRuns drop only rows older than the keep window", async () => {
    const q = h.db();
    const userId = await q.resolveUserId("+639171234567");
    const old = new Date(Date.now() - 10 * 7 * 86_400_000);

    await q.recordNudge(userId, "budget:Food", old);
    await q.recordNudge(userId, "budget:Food", new Date());
    expect(await q.reapNudges(new Date(), 8)).toBe(1);
    await q.recordSummary(old);
    await q.recordSummary(new Date());
    expect(await q.reapSummaryRuns(new Date(), 8)).toBe(1);
  });

  test("dueRecurringToday self-heals a missed day and fires once per cycle", async () => {
    const q = h.db();
    const userId = await q.resolveUserId("+639171234567");

    await q.addRecurring(userId, {
      label: "Rent",
      kind: "expense",
      amountCentavos: 800_000,
      category: "Bills",
      cadence: "monthly",
      dayOfMonth: 5,
    });
    const id = requireRow((await q.listRecurring(userId))[0], "recurring item").id;
    const eighth = new Date("2026-06-08T03:00:00Z");

    expect((await q.dueRecurringToday(userId, new Date("2026-06-03T03:00:00Z"))).length).toBe(0);
    expect((await q.dueRecurringToday(userId, eighth)).length).toBe(1);
    expect(await q.claimReminder(id, userId, eighth)).toBe(true);
    expect((await q.dueRecurringToday(userId, eighth)).length).toBe(0);
  });

  test("editLast cannot move a goal contribution off Savings/Goals but can update amount", async () => {
    const q = h.db();
    const sql = h.sql();
    const userId = await q.resolveUserId("+639171234567");

    await q.flushWrites("ec1", [
      { type: "createGoal", userId, name: "Trip", targetCentavos: 100_000, targetDate: null },
    ]);
    const goalId = requireRow((await q.listGoals(userId))[0], "goal").id;
    await q.flushWrites("ec2", [
      { type: "goalContribution", userId, goalId, amountCentavos: 5_000, localDate: "2026-06-11" },
    ]);
    const tx = requireRow(
      (
        await sql<{ id: string }[]>`
          select id from transactions where user_id = ${userId} order by seq desc limit 1`
      )[0],
      "transaction",
    );

    await q.flushWrites("ec3", [
      {
        type: "editLast",
        userId,
        targetId: tx.id,
        patch: { category: "Food", amountCentavos: 6_000 },
      },
    ]);

    const after = requireRow(
      (
        await sql<{ category: string; goal_id: string | null; amount_centavos: number }[]>`
          select category, goal_id, amount_centavos from transactions where id = ${tx.id}`
      )[0],
      "edited transaction",
    );
    expect(after.category).toBe("Savings/Goals");
    expect(after.goal_id).toBe(goalId);
    expect(Number(after.amount_centavos)).toBe(6_000);
    expect((await q.listGoals(userId)).find((goal) => goal.id === goalId)?.savedCentavos).toBe(
      6_000,
    );
  });
});
