import type { ToolContext } from "./context";
import { buildGoalManagementTools } from "./goal-management-tools";
import { buildGoalReadTools } from "./goal-read-tools";
import { buildGoalWriteTools } from "./goal-write-tools";

export function buildGoalTools(ctx: ToolContext) {
  return {
    ...buildGoalWriteTools(ctx),
    ...buildGoalReadTools(ctx),
    ...buildGoalManagementTools(ctx),
  };
}
