import type { runAgent } from "@repo/ai";
import type {
  budgetStatusesFor,
  claimSlot,
  findGoalByName,
  flushWrites,
  getMonthOverview,
  getSpendingByCategory,
  learnHabit,
  listGoals,
  resolveUserId,
} from "@repo/db";
import type { sendMessage, sendReaction, sendTyping } from "./sendblue-outbound";

export interface InboundDeps {
  claimSlot: typeof claimSlot;
  resolveUserId: typeof resolveUserId;
  runAgent: typeof runAgent;
  flushWrites: typeof flushWrites;
  budgetStatusesFor: typeof budgetStatusesFor;
  getMonthOverview: typeof getMonthOverview;
  getSpendingByCategory: typeof getSpendingByCategory;
  findGoalByName: typeof findGoalByName;
  listGoals: typeof listGoals;
  learnHabit: typeof learnHabit;
  sendMessage: typeof sendMessage;
  sendReaction: typeof sendReaction;
  sendTyping: typeof sendTyping;
}
