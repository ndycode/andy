type DbModule = typeof import("@repo/db");

export interface RecurringReadDeps {
  listRecurring: DbModule["listRecurring"];
}

export interface RecurringLookupDeps {
  findRecurringByLabel: DbModule["findRecurringByLabel"];
}

export interface RecurringMatchDeps {
  findRecurringMatches: DbModule["findRecurringMatches"];
}

export type RecurringActionDeps = RecurringReadDeps & RecurringLookupDeps & RecurringMatchDeps;

export async function loadRecurringActionDeps(): Promise<RecurringActionDeps> {
  const db = await import("@repo/db");
  return {
    listRecurring: db.listRecurring,
    findRecurringByLabel: db.findRecurringByLabel,
    findRecurringMatches: db.findRecurringMatches,
  };
}
