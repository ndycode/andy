import { buildBudgetTools } from "./budget-tools";
import type { ToolContext } from "./context";
import { buildEditTools } from "./edit-tools";
import { buildGoalTools } from "./goal-tools";
import type { LogActionDeps } from "./log-actions";
import { buildLogTools } from "./log-tools";
import { buildMemoryTools } from "./memory-tools";
import { buildReadTools } from "./read-tools";
import { buildRecurringTools } from "./recurring-tools";

export type FinanceToolDeps = {
  readonly log?: LogActionDeps;
};

/**
 * Build the finance tool map bound to a request context.
 * Write-tools buffer intents via ctx.addWrite (no DB connection held during the agent run).
 * Read-tools issue their own short reads.
 */
export function buildTools(ctx: ToolContext, deps: FinanceToolDeps = {}) {
  // ── logging ──────────────────────────────────────────────
  const logTools = buildLogTools(ctx, deps.log);

  // ── questions / reads ────────────────────────────────────
  const readTools = buildReadTools(ctx);

  // ── savings goals ────────────────────────────────────────
  const goalTools = buildGoalTools(ctx);

  // ── memory ───────────────────────────────────────────────
  const memoryTools = buildMemoryTools(ctx);

  // ── edit / delete ────────────────────────────────────────
  const editTools = buildEditTools(ctx);

  // ── recurring bills ──────────────────────────────────────
  const recurringTools = buildRecurringTools(ctx);

  // ── budgets ──────────────────────────────────────────────
  const budgetTools = buildBudgetTools(ctx);

  return {
    ...logTools,
    getSpending: readTools.getSpending,
    getPeriodSpending: readTools.getPeriodSpending,
    getOverview: readTools.getOverview,
    getCategoryBreakdown: readTools.getCategoryBreakdown,
    getRecent: readTools.getRecent,
    ...goalTools,
    ...memoryTools,
    ...editTools,
    insights: readTools.insights,
    compareSpending: readTools.compareSpending,
    searchHistory: readTools.searchHistory,
    getSpendingPace: readTools.getSpendingPace,
    ...recurringTools,
    ...budgetTools,
  };
}

export type FinanceTools = ReturnType<typeof buildTools>;
