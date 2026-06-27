import type { RecurringActionDeps } from "./recurring-action-deps";

export type RecurringActionCall =
  | { readonly fn: "listRecurring"; readonly userId: string }
  | { readonly fn: "findRecurringByLabel"; readonly userId: string; readonly label: string }
  | { readonly fn: "findRecurringMatches"; readonly userId: string; readonly label: string };

export type RecurringRow = Awaited<ReturnType<RecurringActionDeps["listRecurring"]>>[number];

export function recurringItem(overrides: Partial<RecurringRow> = {}): RecurringRow {
  return {
    id: "r1",
    userId: "user-1",
    label: "Netflix",
    kind: "expense",
    amountCentavos: 499_00,
    category: "Entertainment",
    cadence: "monthly",
    dayOfMonth: 5,
    dayOfWeek: null,
    lastRemindedDate: null,
    createdAt: new Date("2026-06-01T00:00:00Z"),
    updatedAt: new Date("2026-06-01T00:00:00Z"),
    ...overrides,
  };
}

/**
 * Inject recurring deps for the management actions. `matches` is the resolved candidate set the
 * actions branch on (mirrors goalActionDeps): [] = none, [one] = resolve, [many] = ambiguous.
 * Defaults to a single Netflix item. Pass null as shorthand for "no match".
 */
export function recurringActionDeps(
  calls: RecurringActionCall[] = [],
  matches: RecurringRow[] | null = [recurringItem()],
): RecurringActionDeps {
  const rows = matches ?? [];
  return {
    // listRecurring returns the FULL list (read actions enumerate everything); the management actions
    // resolve via findRecurringMatches below, which is what `matches` drives.
    listRecurring: async (userId) => {
      calls.push({ fn: "listRecurring", userId });
      return [
        recurringItem({ label: "Rent", amountCentavos: 800_000, category: "Bills", dayOfMonth: 1 }),
        recurringItem({
          id: "r2",
          label: "Allowance",
          kind: "income",
          amountCentavos: 50_000,
          category: "Income",
          cadence: "weekly",
          dayOfMonth: null,
          dayOfWeek: 5,
        }),
      ];
    },
    findRecurringByLabel: async (userId, label) => {
      calls.push({ fn: "findRecurringByLabel", userId, label });
      return rows[0] ?? null;
    },
    findRecurringMatches: async (userId, label) => {
      calls.push({ fn: "findRecurringMatches", userId, label });
      return rows;
    },
  };
}
