import { budgets } from "@repo/db/schema";
import { eq } from "drizzle-orm";
import type { ToolE2eStressHarness } from "./tool-e2e-stress-harness";
import { arrayValue, firstResult, stringValue } from "./tool-e2e-stress-results";

export async function runBudgetAnalyticsChecks(harness: ToolE2eStressHarness): Promise<void> {
  const { db, ok, turn, userId } = harness;

  console.log("\n-- budgets + analytics --");
  {
    const result = firstResult(
      await turn([{ tool: "setBudget", args: { category: "Food", monthlyLimit: "5k" } }]),
    );
    ok("setBudget echoes coerced category", stringValue(result, "category") === "Food");
    const [budget] = await db.select().from(budgets).where(eq(budgets.userId, userId));
    ok("setBudget persists Food 5k", budget?.monthlyLimitCentavos === 500_000);
  }
  {
    const result = firstResult(await turn([{ tool: "getBudgets", args: {} }]));
    ok(
      "getBudgets shows Food with spend",
      arrayValue(result, "budgets").some(
        (budget) =>
          typeof budget === "object" &&
          budget !== null &&
          "category" in budget &&
          budget.category === "Food",
      ),
    );
  }
  {
    const result = firstResult(
      await turn([{ tool: "getSpendingPace", args: { category: "Food" } }]),
    );
    ok("getSpendingPace returns a projection shape", result != null && typeof result === "object");
  }
  {
    const result = firstResult(
      await turn([{ tool: "compareSpending", args: { current: "2026-06", previous: "2026-05" } }]),
    );
    ok("compareSpending resolves two months", result != null && typeof result === "object");
  }
  {
    await turn([{ tool: "removeBudget", args: { category: "Food" } }]);
    const rows = await db.select().from(budgets).where(eq(budgets.userId, userId));
    ok("removeBudget deletes it", rows.length === 0);
  }
}
