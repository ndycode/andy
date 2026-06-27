import { expect, test } from "bun:test";
import { describeDbIntegration, requireRow, useDbIntegration } from "./db-integration-test-harness";

/**
 * Integration coverage for the user-facing READ queries that were previously mocked at every
 * consumer and exercised nowhere against real SQL (audit M3): budgetStatuses (leftJoin + kind/month
 * filter), getInsights (case/whitespace-collapsed merchant leak), and learnHabit/topHabits
 * (confidence semantics). Gated behind TEST_DATABASE_URL; runs in CI against the service Postgres.
 */
describeDbIntegration("db read-query integration (budget status, insights, habits)", () => {
  const h = useDbIntegration();
  const AT = new Date("2026-06-15T03:00:00Z"); // Manila: mid-June 2026

  test("budgetStatuses reports month-to-date EXPENSE spend per budget (excludes income + other months)", async () => {
    const q = h.db();
    const userId = await q.resolveUserId("+639171234567");
    await q.flushWrites("b1", [
      { type: "setBudget", userId, category: "Food", monthlyLimitCentavos: 500_000 },
      {
        type: "expense",
        userId,
        amountCentavos: 100_000,
        category: "Food",
        note: "lunch",
        localDate: "2026-06-10",
      },
      {
        type: "expense",
        userId,
        amountCentavos: 50_000,
        category: "Food",
        note: "dinner",
        localDate: "2026-06-11",
      },
      // Income must NOT count toward an expense budget.
      {
        type: "income",
        userId,
        amountCentavos: 2_500_000,
        category: "Income",
        note: "sweldo",
        localDate: "2026-06-10",
      },
      // Prior-month expense must NOT count toward this month.
      {
        type: "expense",
        userId,
        amountCentavos: 999_999,
        category: "Food",
        note: "old",
        localDate: "2026-05-30",
      },
    ]);

    const statuses = await q.budgetStatuses(userId, AT);
    const food = requireRow(
      statuses.find((s) => s.category === "Food"),
      "Food budget status",
    );
    expect(food.limit).toBe(500_000);
    expect(food.spent).toBe(150_000);
  });

  test("budgetStatuses keeps a budget with zero spend (leftJoin, not innerJoin)", async () => {
    const q = h.db();
    const userId = await q.resolveUserId("+639171234567");
    await q.flushWrites("b2", [
      { type: "setBudget", userId, category: "Bills", monthlyLimitCentavos: 800_000 },
    ]);

    const statuses = await q.budgetStatuses(userId, AT);
    const bills = requireRow(
      statuses.find((s) => s.category === "Bills"),
      "Bills budget status",
    );
    expect(bills.limit).toBe(800_000);
    expect(bills.spent).toBe(0);
  });

  test("getInsights collapses case/whitespace note variants into ONE merchant leak", async () => {
    const q = h.db();
    const userId = await q.resolveUserId("+639171234567");
    await q.flushWrites("i1", [
      {
        type: "expense",
        userId,
        amountCentavos: 10_000,
        category: "Transport",
        note: "grab",
        localDate: "2026-06-11",
      },
      {
        type: "expense",
        userId,
        amountCentavos: 20_000,
        category: "Transport",
        note: "Grab",
        localDate: "2026-06-12",
      },
      {
        type: "expense",
        userId,
        amountCentavos: 30_000,
        category: "Transport",
        note: " grab ",
        localDate: "2026-06-13",
      },
      {
        type: "expense",
        userId,
        amountCentavos: 5_000,
        category: "Food",
        note: "jollibee",
        localDate: "2026-06-14",
      },
    ]);

    const insights = await q.getInsights(userId, AT);
    expect(insights.topLeak).not.toBeNull();
    // 10k + 20k + 30k collapsed across "grab"/"Grab"/" grab " — previously fragmented into 3 rows.
    expect(insights.topLeak?.centavos).toBe(60_000);
    expect(insights.topLeak?.note?.toLowerCase().trim()).toBe("grab");
  });

  test("learnHabit reinforces on repeat and RESETS confidence when the category flips", async () => {
    const q = h.db();
    const userId = await q.resolveUserId("+639171234567");

    await q.learnHabit(userId, "grab", "Transport");
    await q.learnHabit(userId, "grab", "Transport"); // count -> 2 (meets minCount)
    expect((await q.topHabits(userId, 30, 2)).find((x) => x.merchant === "grab")?.category).toBe(
      "Transport",
    );

    // Category flip resets count to 1, so it drops below minCount 2.
    await q.learnHabit(userId, "grab", "Food");
    expect((await q.topHabits(userId, 30, 2)).find((x) => x.merchant === "grab")).toBeUndefined();

    // Reinforce the new mapping back to count 2.
    await q.learnHabit(userId, "grab", "Food");
    expect((await q.topHabits(userId, 30, 2)).find((x) => x.merchant === "grab")?.category).toBe(
      "Food",
    );
  });
});
