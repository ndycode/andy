import type { Category } from "@repo/shared/categories";
import { coerceExpenseCategory } from "@repo/shared/categories";
import { formatPHP, parseAmount } from "@repo/shared/money";
import type { ToolContext } from "./context";
import { lastBufferedTransaction, turnLoggedTransaction } from "./transaction-target";

export function deleteLastTransaction(ctx: ToolContext) {
  const sameTurn = lastBufferedTransaction(ctx.peekWrites());
  if (sameTurn) {
    ctx.addWrite({ type: "deleteLast", userId: ctx.userId, targetSameTurn: true });
    return {
      ok: true,
      deleted: {
        amount: formatPHP(sameTurn.amountCentavos),
        category: sameTurn.category,
        note: sameTurn.note,
      },
    };
  }
  if (turnLoggedTransaction(ctx.peekWrites())) return { ok: false, error: "nothing to delete" };
  const last = ctx.lastTransaction;
  if (!last) return { ok: false, error: "nothing to delete" };
  ctx.addWrite({ type: "deleteLast", userId: ctx.userId, targetId: last.id });
  return {
    ok: true,
    deleted: {
      amount: formatPHP(last.amountCentavos),
      category: last.category,
      note: last.note,
    },
  };
}

export function editLastTransaction(
  ctx: ToolContext,
  {
    amount: amt,
    category,
    note,
  }: {
    amount?: string;
    category?: string;
    note?: string;
  },
) {
  const sameTurn = lastBufferedTransaction(ctx.peekWrites());
  const snapshot = turnLoggedTransaction(ctx.peekWrites()) ? null : ctx.lastTransaction;
  const target = sameTurn ?? snapshot;
  if (!target) return { ok: false, error: "nothing to edit" };

  const targetGoalLinked = sameTurn ? sameTurn.goalLinked : Boolean(snapshot?.goalId);
  const targetCategory = sameTurn ? sameTurn.category : target.category;
  const targetIsIncome = targetCategory === "Income";
  const patch: {
    amountCentavos?: number;
    category?: Category;
    note?: string;
  } = {};
  if (amt) {
    const r = parseAmount(amt);
    if (!r.ok) return { ok: false, error: r.reason };
    patch.amountCentavos = r.centavos;
  }
  if (category && targetGoalLinked) {
    return {
      ok: false,
      error:
        "that's a goal contribution — its category stays Savings/Goals. edit the amount instead.",
    };
  }
  if (category && targetIsIncome) {
    return {
      ok: false,
      error: "that's income — it stays under Income. edit the amount instead.",
    };
  }
  // Expense edits go through coerceExpenseCategory (not coerceCategory) so a recategorization can
  // never land on Income — an expense row stored under Income would corrupt every income/expense
  // aggregate. Consult the new note (or the existing one) to salvage a vague category.
  if (category) patch.category = coerceExpenseCategory(category, note ?? target.note);
  if (note !== undefined) patch.note = note;
  if (Object.keys(patch).length === 0) {
    return { ok: false, error: "no change specified — pass the new amount, category, or note" };
  }
  if (sameTurn) {
    ctx.addWrite({ type: "editLast", userId: ctx.userId, targetSameTurn: true, patch });
  } else if (snapshot) {
    ctx.addWrite({ type: "editLast", userId: ctx.userId, targetId: snapshot.id, patch });
  }
  return {
    ok: true,
    updated: {
      amount: formatPHP(patch.amountCentavos ?? target.amountCentavos),
      category: patch.category ?? target.category,
      note: patch.note ?? target.note,
    },
  };
}
