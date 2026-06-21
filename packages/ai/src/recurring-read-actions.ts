import { formatPHP } from "@repo/shared/money";
import type { ToolContext } from "./context";
import { loadRecurringActionDeps, type RecurringReadDeps } from "./recurring-action-deps";

type ListRecurringInput = Record<string, never>;

export async function listRecurringBills(
  ctx: ToolContext,
  _input: ListRecurringInput = {},
  deps?: RecurringReadDeps,
) {
  const actionDeps = deps ?? (await loadRecurringActionDeps());
  const items = await actionDeps.listRecurring(ctx.userId);
  return {
    recurring: items.map((it) => ({
      label: it.label,
      amount: formatPHP(it.amountCentavos),
      category: it.category,
      cadence: it.cadence,
      when: it.cadence === "monthly" ? `day ${it.dayOfMonth}` : `dow ${it.dayOfWeek}`,
    })),
  };
}
