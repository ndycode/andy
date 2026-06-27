import { buildBudgetTools } from "./budget-tools";
import type { ToolContext } from "./context";
import { buildEditTools } from "./edit-tools";
import { buildGoalTools } from "./goal-tools";
import type { LogActionDeps } from "./log-actions";
import { buildLogTools } from "./log-tools";
import { buildMemoryTools } from "./memory-tools";
import { buildReadTools } from "./read-tools";
import { buildRecurringTools } from "./recurring-tools";
import type { ToolProfile } from "./tool-profile";

export type FinanceToolDeps = {
  readonly log?: LogActionDeps;
};

/**
 * Build the finance tool map bound to a request context.
 * Write-tools buffer intents via ctx.addWrite (no DB connection held during the agent run).
 * Read-tools issue their own short reads.
 */
const TOOL_PROFILE_KEYS: Record<ToolProfile, readonly string[] | null> = {
  chat: [],
  log: ["logExpense", "logIncome", "editLast", "deleteLast"],
  read: [
    "getSpending",
    "getPeriodSpending",
    "getOverview",
    "getCategoryBreakdown",
    "getRecent",
    "insights",
    "compareSpending",
    "searchHistory",
    "getSpendingPace",
  ],
  memory: ["remember", "forgetMemory", "listMemory"],
  goal: [
    "createGoal",
    "contributeToGoal",
    "getGoalStatus",
    "editGoal",
    "deleteGoal",
    "editLast",
    "deleteLast",
  ],
  budget: ["setBudget", "getBudgets", "removeBudget"],
  recurring: ["addRecurringBill", "listRecurringBills", "removeRecurringBill", "editRecurringBill"],
  full: null,
};

export function buildTools(
  ctx: ToolContext,
  deps: FinanceToolDeps = {},
  profile: ToolProfile = "full",
) {
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

  const tools = {
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
  return pickProfileTools(tools, profile);
}

export type FinanceTools = ReturnType<typeof buildTools>;

function pickProfileTools<T extends Record<string, unknown>>(tools: T, profile: ToolProfile): T {
  const keys = TOOL_PROFILE_KEYS[profile];
  if (keys === null) return tools;

  const selected: Partial<T> = {};
  for (const key of keys) {
    if (key in tools) selected[key as keyof T] = tools[key as keyof T];
  }
  return selected as T;
}
