import type { ToolContext } from "./context";
import { buildRecurringManagementTools } from "./recurring-management-tools";
import { buildRecurringReadTools } from "./recurring-read-tools";
import { buildRecurringWriteTools } from "./recurring-write-tools";

export function buildRecurringTools(ctx: ToolContext) {
  return {
    ...buildRecurringWriteTools(ctx),
    ...buildRecurringReadTools(ctx),
    ...buildRecurringManagementTools(ctx),
  };
}
