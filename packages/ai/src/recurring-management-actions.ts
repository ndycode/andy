import { type Category, coerceCategory } from "@repo/shared/categories";
import { formatPHP, parseAmount } from "@repo/shared/money";
import type { ToolContext } from "./context";
import { loadRecurringActionDeps, type RecurringLookupDeps } from "./recurring-action-deps";

type RecurringLabelInput = {
  readonly label: string;
};

type EditRecurringInput = RecurringLabelInput & {
  readonly amount?: string;
  readonly category?: string;
  readonly cadence?: "weekly" | "monthly";
  readonly dayOfMonth?: number;
  readonly dayOfWeek?: number;
};

type RecurringPatch = {
  amountCentavos?: number;
  category?: Category;
  cadence?: "weekly" | "monthly";
  dayOfMonth?: number | null;
  dayOfWeek?: number | null;
};

export async function removeRecurringBill(
  ctx: ToolContext,
  { label }: RecurringLabelInput,
  deps?: RecurringLookupDeps,
) {
  const actionDeps = deps ?? (await loadRecurringActionDeps());
  const hit = await actionDeps.findRecurringByLabel(ctx.userId, label);
  if (!hit) return { ok: false, error: `no recurring reminder matching "${label}".` };
  ctx.addWrite({ type: "removeRecurring", userId: ctx.userId, match: label });
  return { ok: true, removed: hit.label };
}

export async function editRecurringBill(
  ctx: ToolContext,
  { label, amount, category, cadence, dayOfMonth, dayOfWeek }: EditRecurringInput,
  deps?: RecurringLookupDeps,
) {
  const actionDeps = deps ?? (await loadRecurringActionDeps());
  const hit = await actionDeps.findRecurringByLabel(ctx.userId, label);
  if (!hit) return { ok: false, error: `no recurring reminder matching "${label}".` };
  const patch: RecurringPatch = {};
  if (amount !== undefined) {
    const r = parseAmount(amount);
    if (!r.ok) return { ok: false, error: r.reason };
    patch.amountCentavos = r.centavos;
  }
  if (category !== undefined) patch.category = coerceCategory(category);
  if (dayOfMonth !== undefined) patch.dayOfMonth = dayOfMonth;
  if (dayOfWeek !== undefined) patch.dayOfWeek = dayOfWeek;
  if (cadence !== undefined) {
    patch.cadence = cadence;
    if (cadence === "weekly") {
      if (dayOfWeek === undefined) {
        return { ok: false, error: "switching to weekly needs a day of week (0=Sun..6=Sat)" };
      }
      patch.dayOfMonth = null;
    } else {
      if (dayOfMonth === undefined) {
        return { ok: false, error: "switching to monthly needs a day of month (1-31)" };
      }
      patch.dayOfWeek = null;
    }
  }
  if (Object.keys(patch).length === 0) {
    return {
      ok: false,
      error: "no change specified — pass a new amount, category, cadence, or day",
    };
  }
  ctx.addWrite({ type: "editRecurring", userId: ctx.userId, match: label, patch });
  return {
    ok: true,
    label: hit.label,
    ...(patch.amountCentavos != null ? { amount: formatPHP(patch.amountCentavos) } : {}),
    ...(patch.category != null ? { category: patch.category } : {}),
    ...(patch.cadence ? { cadence: patch.cadence } : {}),
    ...(patch.dayOfMonth != null ? { dayOfMonth: patch.dayOfMonth } : {}),
    ...(patch.dayOfWeek != null ? { dayOfWeek: patch.dayOfWeek } : {}),
  };
}
