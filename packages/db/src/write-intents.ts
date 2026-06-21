import type { Category } from "@repo/shared/categories";
import type { MemoryKind } from "./schema";

export interface RecurringInput {
  label: string;
  kind: "income" | "expense";
  amountCentavos: number;
  category: Category;
  cadence: "weekly" | "monthly";
  dayOfMonth?: number | null;
  dayOfWeek?: number | null;
}

/** A buffered write produced by the agent's tools (no DB connection held during the agent run). */
export type WriteIntent =
  | {
      type: "expense" | "income";
      userId: string;
      amountCentavos: number;
      category: Category;
      note?: string;
      localDate: string;
    }
  | {
      type: "goalContribution";
      userId: string;
      goalId: string;
      amountCentavos: number;
      localDate: string;
    }
  | {
      type: "createGoal";
      userId: string;
      name: string;
      targetCentavos: number;
      targetDate: string | null;
    }
  | { type: "setBudget"; userId: string; category: Category; monthlyLimitCentavos: number }
  | { type: "deleteLast"; userId: string; targetId?: string; targetSameTurn?: boolean }
  | {
      type: "editLast";
      userId: string;
      targetId?: string;
      targetSameTurn?: boolean;
      patch: { amountCentavos?: number; category?: Category; note?: string };
    }
  | { type: "saveMemory"; userId: string; content: string; kind?: MemoryKind }
  | { type: "forgetMemory"; userId: string; match: string }
  | {
      // Conversation turn (user/assistant text). Flushed INSIDE the marker txn so a turn can't be
      // silently lost: if the insert fails, the whole flush rolls back, the marker stays 'claimed',
      // and the redelivery retries — instead of the old post-commit allSettled path where a failed
      // turn insert was swallowed and the completed marker made the redelivery a no-op.
      type: "saveTurn";
      userId: string;
      role: "user" | "assistant";
      content: string;
    }
  | { type: "addRecurring"; userId: string; recurring: RecurringInput }
  | { type: "removeRecurring"; userId: string; match: string }
  | {
      type: "editRecurring";
      userId: string;
      match: string;
      patch: {
        amountCentavos?: number;
        category?: Category;
        cadence?: "weekly" | "monthly";
        dayOfMonth?: number | null;
        dayOfWeek?: number | null;
      };
    }
  | { type: "removeBudget"; userId: string; category: Category }
  | {
      type: "editGoal";
      userId: string;
      goalId: string;
      patch: { name?: string; targetCentavos?: number; targetDate?: string | null };
    }
  | { type: "deleteGoal"; userId: string; goalId: string };
