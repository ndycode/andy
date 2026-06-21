import { and, eq } from "drizzle-orm";
import type { BudgetGoalWriteIntent, FlushWriteTx } from "./flush-write-types";
import { NAME_MAX } from "./flush-write-types";
import { budgets, savingsGoals, transactions } from "./schema";

export async function applyBudgetGoalWriteIntent(
  tx: FlushWriteTx,
  w: BudgetGoalWriteIntent,
): Promise<void> {
  if (w.type === "createGoal") {
    await tx
      .insert(savingsGoals)
      .values({
        userId: w.userId,
        name: w.name.slice(0, NAME_MAX),
        targetCentavos: w.targetCentavos,
        targetDate: w.targetDate,
      })
      .onConflictDoNothing();
  } else if (w.type === "setBudget") {
    await tx
      .insert(budgets)
      .values({
        userId: w.userId,
        category: w.category,
        monthlyLimitCentavos: w.monthlyLimitCentavos,
      })
      .onConflictDoUpdate({
        target: [budgets.userId, budgets.category],
        set: { monthlyLimitCentavos: w.monthlyLimitCentavos, updatedAt: new Date() },
      });
  } else if (w.type === "removeBudget") {
    await tx
      .delete(budgets)
      .where(and(eq(budgets.userId, w.userId), eq(budgets.category, w.category)));
  } else if (w.type === "editGoal") {
    const set: Record<string, unknown> = {};
    if (w.patch.name != null) set.name = w.patch.name.slice(0, NAME_MAX);
    if (w.patch.targetCentavos != null) set.targetCentavos = w.patch.targetCentavos;
    if (w.patch.targetDate !== undefined) set.targetDate = w.patch.targetDate;
    if (Object.keys(set).length > 0) {
      set.updatedAt = new Date();
      await tx
        .update(savingsGoals)
        .set(set)
        .where(and(eq(savingsGoals.id, w.goalId), eq(savingsGoals.userId, w.userId)));
    }
  } else if (w.type === "deleteGoal") {
    await tx
      .update(transactions)
      .set({ goalId: null, updatedAt: new Date() })
      .where(and(eq(transactions.goalId, w.goalId), eq(transactions.userId, w.userId)));
    await tx
      .delete(savingsGoals)
      .where(and(eq(savingsGoals.id, w.goalId), eq(savingsGoals.userId, w.userId)));
  }
}
