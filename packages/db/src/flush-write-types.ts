import type { DB } from "./client";
import type { WriteIntent } from "./write-intents";

export type FlushWriteTx = Parameters<Parameters<DB["transaction"]>[0]>[0];

export interface FlushWriteState {
  lastInsertedTxId: string | null;
}

export const NOTE_MAX = 500;
export const NAME_MAX = 100;
export const LABEL_MAX = 100;

export type TransactionWriteIntent = Extract<
  WriteIntent,
  { type: "expense" | "income" | "goalContribution" | "deleteLast" | "editLast" }
>;

export type MemoryWriteIntent = Extract<
  WriteIntent,
  { type: "saveMemory" | "saveTurn" | "forgetMemory" }
>;

export type RecurringWriteIntent = Extract<
  WriteIntent,
  { type: "addRecurring" | "removeRecurring" | "editRecurring" }
>;

export type BudgetGoalWriteIntent = Extract<
  WriteIntent,
  { type: "createGoal" | "setBudget" | "removeBudget" | "editGoal" | "deleteGoal" }
>;
