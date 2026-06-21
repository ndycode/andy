import { budgets, recurringItems } from "@repo/db/schema";
import { eq } from "drizzle-orm";
import type { AgentLiveStressHarness } from "./agent-live-stress-harness";

export async function runLiveBudgetRecurringChecks(harness: AgentLiveStressHarness): Promise<void> {
  const { db, ok, say, userId } = harness;

  console.log("\n== 8. budgets ==");
  {
    await say("set a food budget of 5k a month");
    const rows = await db.select().from(budgets).where(eq(budgets.userId, userId));
    ok(
      "sets a Food budget of 5k",
      rows.some((budget) => budget.monthlyLimitCentavos === 500_000),
      `budgets: ${rows.map((budget) => `${budget.category}:${budget.monthlyLimitCentavos}`)}`,
    );
  }

  console.log("\n== 9. recurring bills ==");
  {
    await say("I pay netflix 549 every month on the 5th");
    const rows = await db.select().from(recurringItems).where(eq(recurringItems.userId, userId));
    ok(
      "adds Netflix recurring bill",
      rows.some((recurring) => /netflix/i.test(recurring.label)),
      `recurring: ${rows.map((recurring) => recurring.label)}`,
    );
  }
}
