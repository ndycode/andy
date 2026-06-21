import type { Category } from "@repo/shared/categories";

export interface TransactionSummaryRow {
  kind: "income" | "expense";
  amountCentavos: number;
  category: Category;
  note: string | null;
  localDate: string;
}

export interface LastTransaction {
  id: string;
  kind: "income" | "expense";
  amountCentavos: number;
  category: Category;
  note: string | null;
  goalId: string | null;
}
