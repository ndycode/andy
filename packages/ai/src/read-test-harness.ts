import type { Category } from "@repo/shared/categories";
import type { BasicReadDeps } from "./read-basic-actions";
import type { HistoryReadDeps } from "./read-history-actions";

type MonthOverviewRow = Awaited<ReturnType<BasicReadDeps["getMonthOverview"]>>;
type RecentTransactionRows = Awaited<ReturnType<BasicReadDeps["getRecentTransactions"]>>;
type CategorySpendRows = Awaited<ReturnType<BasicReadDeps["getSpendingByCategory"]>>;
type HistorySearchOptions = Parameters<HistoryReadDeps["searchTransactions"]>[1];
type HistoryRows = Awaited<ReturnType<HistoryReadDeps["searchTransactions"]>>;

type BasicReadDepsOptions = {
  readonly monthOverview?: MonthOverviewRow;
  readonly recentTransactions?: RecentTransactionRows;
  readonly spendingByCategory?: CategorySpendRows;
  readonly sumByCategoryCentavos?: number;
  readonly sumSpendBetweenCentavos?: number;
};

type HistoryReadDepsOptions = {
  readonly transactions?: HistoryRows;
};

export type ReadActionCall =
  | { readonly fn: "getMonthOverview"; readonly userId: string; readonly date: string | undefined }
  | {
      readonly fn: "getRecentTransactions";
      readonly userId: string;
      readonly limit: number | undefined;
    }
  | {
      readonly fn: "getSpendingByCategory";
      readonly userId: string;
      readonly date: string | undefined;
    }
  | {
      readonly fn: "sumByCategory";
      readonly userId: string;
      readonly category: Category;
      readonly date: string | undefined;
    }
  | {
      readonly fn: "sumSpendBetween";
      readonly userId: string;
      readonly start: string;
      readonly end: string;
      readonly category: Category | undefined;
    }
  | {
      readonly fn: "searchTransactions";
      readonly userId: string;
      readonly opts: HistorySearchOptions;
    };

export function basicReadDeps(
  calls: ReadActionCall[] = [],
  options: BasicReadDepsOptions = {},
): BasicReadDeps {
  return {
    getMonthOverview: async (userId, at) => {
      calls.push({ fn: "getMonthOverview", userId, date: localDate(at) });
      return options.monthOverview ?? { income: 500_000, expense: 175_000, net: 325_000 };
    },
    getRecentTransactions: async (userId, limit) => {
      calls.push({ fn: "getRecentTransactions", userId, limit });
      return (
        options.recentTransactions ?? [
          {
            kind: "expense",
            amountCentavos: 18_000,
            category: "Food",
            note: "lunch",
            localDate: "2026-06-10",
          },
        ]
      );
    },
    getSpendingByCategory: async (userId, at) => {
      calls.push({ fn: "getSpendingByCategory", userId, date: localDate(at) });
      return (
        options.spendingByCategory ?? [
          { category: "Food", total: 80_000 },
          { category: "Transport", total: 45_000 },
        ]
      );
    },
    sumByCategory: async (userId, category, at) => {
      calls.push({ fn: "sumByCategory", userId, category, date: localDate(at) });
      return options.sumByCategoryCentavos ?? 80_000;
    },
    sumSpendBetween: async (userId, start, end, category) => {
      calls.push({ fn: "sumSpendBetween", userId, start, end, category });
      return options.sumSpendBetweenCentavos ?? 125_000;
    },
  };
}

export function historyReadDeps(
  calls: ReadActionCall[] = [],
  options: HistoryReadDepsOptions = {},
): HistoryReadDeps {
  return {
    searchTransactions: async (userId, opts) => {
      calls.push({ fn: "searchTransactions", userId, opts });
      return (
        options.transactions ?? [
          {
            kind: "expense",
            amountCentavos: 150_000,
            category: "Transport",
            note: "grab",
            localDate: "2026-06-09",
          },
        ]
      );
    },
  };
}

function localDate(at: Date | undefined): string | undefined {
  return at?.toISOString().slice(0, 10);
}
