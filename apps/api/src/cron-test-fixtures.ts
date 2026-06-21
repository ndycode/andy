import type { CronDeps, CronRunContext } from "./cron-types";

export const CRON_PHONE = "+639171234567";
export const CRON_USER_ID = "user-1";
export const CRON_NOW = new Date("2026-06-15T00:00:00+08:00");

export type CronGoalRow = Awaited<ReturnType<CronDeps["listGoals"]>>[number];
export type CronRecurringRow = Awaited<ReturnType<CronDeps["dueRecurringToday"]>>[number];

export function cronContext(overrides: Partial<CronRunContext> = {}): CronRunContext {
  return {
    userId: CRON_USER_ID,
    phone: CRON_PHONE,
    now: CRON_NOW,
    ...overrides,
  };
}

export function goalRow(overrides: Partial<CronGoalRow> = {}): CronGoalRow {
  return {
    id: "goal-1",
    name: "Trip",
    targetCentavos: 100000,
    savedCentavos: 0,
    createdAt: new Date("2020-01-01T00:00:00Z"),
    targetDate: "2020-02-01",
    ...overrides,
  };
}

export function recurringRow(overrides: Partial<CronRecurringRow> = {}): CronRecurringRow {
  return {
    id: "recurring-1",
    userId: CRON_USER_ID,
    label: "Rent",
    kind: "expense",
    amountCentavos: 800000,
    category: "Bills",
    cadence: "monthly",
    dayOfMonth: 5,
    dayOfWeek: null,
    lastRemindedDate: null,
    createdAt: new Date("2026-06-01T00:00:00Z"),
    updatedAt: new Date("2026-06-01T00:00:00Z"),
    ...overrides,
  };
}
