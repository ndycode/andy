import type { ClaimResult, FlushResult, GoalRow, WriteIntent } from "@repo/db";
import type { Category } from "@repo/shared/categories";
import type { InboundDeps } from "./handler";

export const PHONE = "+639171234567";

process.env.ALLOWED_PHONE = PHONE;

export const EXPENSE: WriteIntent = {
  type: "expense",
  userId: "user-1",
  amountCentavos: 18000,
  category: "Transport",
  note: "grab",
  localDate: "2026-06-11",
};

export const JAPAN_GOAL: GoalRow = {
  id: "goal-1",
  name: "Japan fund",
  targetCentavos: 2_000_000,
  savedCentavos: 0,
  createdAt: new Date("2026-06-11T00:00:00Z"),
  targetDate: "2026-12-31",
};

export type HandlerCall = {
  readonly fn: string;
  readonly args: readonly unknown[];
};

type HandlerDepsOverrides = Partial<{
  readonly claim: ClaimResult;
  readonly flush: FlushResult;
  readonly reply: string;
  readonly writes: WriteIntent[];
  readonly agentThrows: unknown;
  readonly sendThrows: unknown;
  readonly budgetStatusesThrows: unknown;
  readonly monthOverview: { income: number; expense: number; net: number };
  readonly spendingByCategory: { category: Category; total: number }[];
  readonly goals: GoalRow[];
}>;

export function handlerDeps(calls: HandlerCall[], over: HandlerDepsOverrides = {}): InboundDeps {
  const rec =
    (fn: string) =>
    (...args: unknown[]) => {
      calls.push({ fn, args });
    };
  return {
    claimSlot: async (...a) => {
      rec("claimSlot")(...a);
      return over.claim ?? "process";
    },
    resolveUserId: async (...a) => {
      rec("resolveUserId")(...a);
      return "user-1";
    },
    runAgent: async (...a) => {
      rec("runAgent")(...a);
      if (over.agentThrows) throw over.agentThrows;
      return { reply: over.reply ?? "logged ₱180 transport", writes: over.writes ?? [] };
    },
    flushWrites: async (...a) => {
      rec("flushWrites")(...a);
      return over.flush ?? "committed";
    },
    budgetStatusesFor: async (...a) => {
      rec("budgetStatusesFor")(...a);
      if (over.budgetStatusesThrows !== undefined) throw over.budgetStatusesThrows;
      return [];
    },
    getMonthOverview: async (...a) => {
      rec("getMonthOverview")(...a);
      return over.monthOverview ?? { income: 0, expense: 0, net: 0 };
    },
    getSpendingByCategory: async (...a) => {
      rec("getSpendingByCategory")(...a);
      return over.spendingByCategory ?? [];
    },
    findGoalByName: async (...a) => {
      rec("findGoalByName")(...a);
      const query = String(a[1] ?? "").toLowerCase();
      return (
        (over.goals ?? [JAPAN_GOAL]).find((goal) => goal.name.toLowerCase().includes(query)) ?? null
      );
    },
    listGoals: async (...a) => {
      rec("listGoals")(...a);
      return over.goals ?? [JAPAN_GOAL];
    },
    learnHabit: async (...a) => {
      rec("learnHabit")(...a);
    },
    sendMessage: async (...a) => {
      rec("sendMessage")(...a);
      if (over.sendThrows === true) throw new Error("network down");
      if (over.sendThrows !== undefined) throw over.sendThrows;
    },
    sendReaction: async (...a) => {
      rec("sendReaction")(...a);
    },
    sendTyping: async (...a) => {
      rec("sendTyping")(...a);
    },
  };
}

export const callNames = (calls: readonly HandlerCall[]) => calls.map((call) => call.fn);

export const callCount = (calls: readonly HandlerCall[], fn: string) =>
  calls.filter((call) => call.fn === fn).length;
