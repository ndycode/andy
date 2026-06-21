import type { WriteIntent } from "@repo/db";
import type { Category } from "@repo/shared/categories";

export type BufferedTransactionTarget = {
  amountCentavos: number;
  category: Category;
  note: string | null;
  goalLinked: boolean;
};

export function lastBufferedTransaction(
  writes: readonly WriteIntent[],
): BufferedTransactionTarget | null {
  let last: BufferedTransactionTarget | null = null;

  for (const w of writes) {
    if (w.type === "expense" || w.type === "income") {
      last = {
        amountCentavos: w.amountCentavos,
        category: w.category,
        note: w.note ?? null,
        goalLinked: false,
      };
    } else if (w.type === "goalContribution") {
      last = {
        amountCentavos: w.amountCentavos,
        category: "Savings/Goals",
        note: null,
        goalLinked: true,
      };
    } else if (w.type === "editLast" && w.targetSameTurn && last) {
      if (w.patch.amountCentavos != null) last.amountCentavos = w.patch.amountCentavos;
      if (w.patch.category != null) last.category = w.patch.category;
      if (w.patch.note !== undefined) last.note = w.patch.note;
    } else if (w.type === "deleteLast" && w.targetSameTurn) {
      last = null;
    }
  }

  return last;
}

export function turnLoggedTransaction(writes: readonly WriteIntent[]): boolean {
  return writes.some(
    (w) => w.type === "expense" || w.type === "income" || w.type === "goalContribution",
  );
}
