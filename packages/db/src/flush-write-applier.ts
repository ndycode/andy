import { applyBudgetGoalWriteIntent } from "./budget-goal-write-applier";
import type { FlushWriteState, FlushWriteTx } from "./flush-write-types";
import { applyMemoryWriteIntent } from "./memory-write-applier";
import { applyRecurringWriteIntent } from "./recurring-write-applier";
import { applyTransactionWriteIntent } from "./transaction-write-applier";
import type { WriteIntent } from "./write-intents";

export type { FlushWriteState, FlushWriteTx } from "./flush-write-types";

export async function applyWriteIntent(
  tx: FlushWriteTx,
  w: WriteIntent,
  state: FlushWriteState,
): Promise<void> {
  switch (w.type) {
    case "expense":
    case "income":
    case "goalContribution":
    case "deleteLast":
    case "editLast":
      return applyTransactionWriteIntent(tx, w, state);
    case "saveMemory":
    case "saveTurn":
    case "forgetMemory":
      return applyMemoryWriteIntent(tx, w);
    case "addRecurring":
    case "removeRecurring":
    case "editRecurring":
      return applyRecurringWriteIntent(tx, w);
    case "createGoal":
    case "setBudget":
    case "removeBudget":
    case "editGoal":
    case "deleteGoal":
      return applyBudgetGoalWriteIntent(tx, w);
  }

  const _exhaustive: never = w;
  void _exhaustive;
}
