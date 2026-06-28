import { buildBudgetTools } from "./budget-tools";
import type { ToolContext } from "./context";
import { buildEditTools } from "./edit-tools";
import { buildGoalManagementTools } from "./goal-management-tools";
import { buildGoalReadTools } from "./goal-read-tools";
import { buildGoalTools } from "./goal-tools";
import { buildGoalWriteTools } from "./goal-write-tools";
import type { LogActionDeps } from "./log-actions";
import { buildLogTools } from "./log-tools";
import { buildMemoryTools } from "./memory-tools";
import { buildBasicReadTools } from "./read-basic-tools";
import { buildHistoryReadTools } from "./read-history-tools";
import { buildInsightReadTools } from "./read-insight-tools";
import { buildPaceReadTools } from "./read-pace-tools";
import { buildReadTools } from "./read-tools";
import { buildRecurringReadTools } from "./recurring-read-tools";
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
export function buildTools(
  ctx: ToolContext,
  deps: FinanceToolDeps = {},
  profile: ToolProfile = "full",
): FinanceTools {
  switch (profile) {
    case "chat":
      return narrowTools({});
    case "logWrite":
      return narrowTools(buildLogTools(ctx, deps.log));
    case "logEdit":
      return narrowTools(buildEditToolProfile(ctx));
    case "log":
      return narrowTools(buildLogToolProfile(ctx, deps));
    case "readBasic":
      return narrowTools(buildBasicReadTools(ctx));
    case "readSearch":
      return narrowTools(buildHistoryReadTools(ctx));
    case "readPace":
      return narrowTools(buildPaceReadTools(ctx));
    case "readInsight":
      return narrowTools(buildInsightReadProfile(ctx));
    case "readCompare":
      return narrowTools(buildCompareReadProfile(ctx));
    case "read":
      return narrowTools(buildReadToolProfile(ctx));
    case "memoryRead":
      return narrowTools(buildMemoryReadProfile(ctx));
    case "memory":
      return narrowTools(buildMemoryTools(ctx));
    case "goalRead":
      return narrowTools(buildGoalReadTools(ctx));
    case "goalCreate":
      return narrowTools(buildGoalCreateProfile(ctx));
    case "goalContribute":
      return narrowTools(buildGoalContributeProfile(ctx));
    case "goalManage":
      return narrowTools(buildGoalManagementTools(ctx));
    case "goal":
      return narrowTools(buildGoalToolProfile(ctx));
    case "budgetRead":
      return narrowTools(buildBudgetReadProfile(ctx));
    case "budget":
      return narrowTools(buildBudgetTools(ctx));
    case "recurringRead":
      return narrowTools(buildRecurringReadTools(ctx));
    case "recurring":
      return narrowTools(buildRecurringTools(ctx));
    case "full":
      return buildFullTools(ctx, deps);
  }
}

export type FinanceTools = ReturnType<typeof buildFullTools>;

function buildLogToolProfile(ctx: ToolContext, deps: FinanceToolDeps) {
  return {
    ...buildLogTools(ctx, deps.log),
    ...buildEditToolProfile(ctx),
  };
}

function buildEditToolProfile(ctx: ToolContext) {
  const editTools = buildEditTools(ctx);

  return {
    editLast: editTools.editLast,
    deleteLast: editTools.deleteLast,
  };
}

function buildReadToolProfile(ctx: ToolContext) {
  const readTools = buildReadTools(ctx);

  return {
    getSpending: readTools.getSpending,
    getPeriodSpending: readTools.getPeriodSpending,
    getOverview: readTools.getOverview,
    getCategoryBreakdown: readTools.getCategoryBreakdown,
    getRecent: readTools.getRecent,
    insights: readTools.insights,
    compareSpending: readTools.compareSpending,
    searchHistory: readTools.searchHistory,
    getSpendingPace: readTools.getSpendingPace,
  };
}

function buildInsightReadProfile(ctx: ToolContext) {
  return { insights: buildInsightReadTools(ctx).insights };
}

function buildCompareReadProfile(ctx: ToolContext) {
  return { compareSpending: buildInsightReadTools(ctx).compareSpending };
}

function buildMemoryReadProfile(ctx: ToolContext) {
  return { listMemory: buildMemoryTools(ctx).listMemory };
}

function buildGoalToolProfile(ctx: ToolContext) {
  const editTools = buildEditTools(ctx);

  return {
    ...buildGoalTools(ctx),
    editLast: editTools.editLast,
    deleteLast: editTools.deleteLast,
  };
}

function buildGoalCreateProfile(ctx: ToolContext) {
  return { createGoal: buildGoalWriteTools(ctx).createGoal };
}

function buildGoalContributeProfile(ctx: ToolContext) {
  return { contributeToGoal: buildGoalWriteTools(ctx).contributeToGoal };
}

function buildBudgetReadProfile(ctx: ToolContext) {
  return { getBudgets: buildBudgetTools(ctx).getBudgets };
}

function buildFullTools(ctx: ToolContext, deps: FinanceToolDeps) {
  const readTools = buildReadTools(ctx);

  return {
    ...buildLogTools(ctx, deps.log),
    getSpending: readTools.getSpending,
    getPeriodSpending: readTools.getPeriodSpending,
    getOverview: readTools.getOverview,
    getCategoryBreakdown: readTools.getCategoryBreakdown,
    getRecent: readTools.getRecent,
    ...buildGoalTools(ctx),
    ...buildMemoryTools(ctx),
    ...buildEditTools(ctx),
    insights: readTools.insights,
    compareSpending: readTools.compareSpending,
    searchHistory: readTools.searchHistory,
    getSpendingPace: readTools.getSpendingPace,
    ...buildRecurringTools(ctx),
    ...buildBudgetTools(ctx),
  };
}

function narrowTools(tools: Partial<FinanceTools>): FinanceTools {
  return tools as FinanceTools;
}
