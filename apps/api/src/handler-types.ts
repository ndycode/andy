import type { runAgent } from "@repo/ai";
import type {
  budgetStatusesFor,
  claimSlot,
  flushWrites,
  learnHabit,
  resolveUserId,
} from "@repo/db";
import type { sendMessage, sendReaction, sendTyping } from "./sendblue-outbound";

export interface InboundDeps {
  claimSlot: typeof claimSlot;
  resolveUserId: typeof resolveUserId;
  runAgent: typeof runAgent;
  flushWrites: typeof flushWrites;
  budgetStatusesFor: typeof budgetStatusesFor;
  learnHabit: typeof learnHabit;
  sendMessage: typeof sendMessage;
  sendReaction: typeof sendReaction;
  sendTyping: typeof sendTyping;
}
