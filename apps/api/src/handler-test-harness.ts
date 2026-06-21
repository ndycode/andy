import type { ClaimResult, FlushResult, WriteIntent } from "@repo/db";
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
