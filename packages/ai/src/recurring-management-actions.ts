import { type Category, coerceCategory } from "@repo/shared/categories";
import { formatPHP, parseAmount } from "@repo/shared/money";
import type { ToolContext } from "./context";
import { loadRecurringActionDeps, type RecurringMatchDeps } from "./recurring-action-deps";

/** Shared resolver: returns the single matched bill, or an error result to return verbatim. */
async function resolveOneRecurring(
  deps: RecurringMatchDeps,
  userId: string,
  label: string,
): Promise<{ ok: true; item: { id: string; label: string } } | { ok: false; error: string }> {
  const matches = await deps.findRecurringMatches(userId, label);
  if (matches.length === 0)
    return { ok: false, error: `no recurring reminder matching "${label}".` };
  if (matches.length > 1) {
    return {
      ok: false,
      error: `which one? ${matches.map((m) => `"${m.label}"`).join(", ")} — say the exact label.`,
    };
  }
  const [item] = matches;
  if (!item) return { ok: false, error: `no recurring reminder matching "${label}".` };
  return { ok: true, item };
}

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
  deps?: RecurringMatchDeps,
) {
  const actionDeps = deps ?? (await loadRecurringActionDeps());
  const resolved = await resolveOneRecurring(actionDeps, ctx.userId, label);
  if (!resolved.ok) return resolved;
  // Buffer the RESOLVED exact label so flush-time re-resolution is an exact (deterministic) match.
  ctx.addWrite({ type: "removeRecurring", userId: ctx.userId, match: resolved.item.label });
  return { ok: true, removed: resolved.item.label };
}

export async function editRecurringBill(
  ctx: ToolContext,
  { label, amount, category, cadence, dayOfMonth, dayOfWeek }: EditRecurringInput,
  deps?: RecurringMatchDeps,
) {
  const actionDeps = deps ?? (await loadRecurringActionDeps());
  const resolved = await resolveOneRecurring(actionDeps, ctx.userId, label);
  if (!resolved.ok) return resolved;
  const hit = resolved.item;
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
  ctx.addWrite({ type: "editRecurring", userId: ctx.userId, match: hit.label, patch });
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
