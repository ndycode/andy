export const READ_TOOL_NAMES = [
  "getSpending",
  "getPeriodSpending",
  "getOverview",
  "getCategoryBreakdown",
  "getRecent",
  "getGoalStatus",
  "insights",
  "listRecurringBills",
  "listMemory",
  "getBudgets",
  "compareSpending",
  "searchHistory",
  "getSpendingPace",
] as const;

const READ_TOOLS = new Set<string>(READ_TOOL_NAMES);

export function isReadToolName(toolName: string): boolean {
  return READ_TOOLS.has(toolName);
}
