import { coerceCategory } from "@repo/shared/categories";
import { formatPHP, parseAmount } from "@repo/shared/money";
import type { ToolContext } from "./context";

type AddRecurringInput = {
  readonly label: string;
  readonly amount: string;
  readonly category: string;
  readonly kind?: "expense" | "income";
  readonly cadence: "weekly" | "monthly";
  readonly dayOfMonth?: number;
  readonly dayOfWeek?: number;
};

export function addRecurringBill(
  ctx: ToolContext,
  { label, amount, category, kind = "expense", cadence, dayOfMonth, dayOfWeek }: AddRecurringInput,
) {
  const r = parseAmount(amount);
  if (!r.ok) return { ok: false, error: r.reason };
  if (cadence === "monthly" && dayOfMonth === undefined) {
    return { ok: false, error: "a monthly reminder needs a day of month (1-31)" };
  }
  if (cadence === "weekly" && dayOfWeek === undefined) {
    return { ok: false, error: "a weekly reminder needs a day of week (0=Sun..6=Sat)" };
  }
  ctx.addWrite({
    type: "addRecurring",
    userId: ctx.userId,
    recurring: {
      label,
      kind,
      amountCentavos: r.centavos,
      category: coerceCategory(category),
      cadence,
      dayOfMonth: dayOfMonth ?? null,
      dayOfWeek: dayOfWeek ?? null,
    },
  });
  return { ok: true, label, amount: formatPHP(r.centavos), cadence };
}
