import { claimSlot, flushWrites, getDb, resolveUserId, type WriteIntent } from "@repo/db";
import {
  budgets,
  habits,
  memories,
  messages,
  nudges,
  processedMessages,
  recurringItems,
  savingsGoals,
  transactions,
  users,
} from "@repo/db/schema";
import { eq, inArray } from "drizzle-orm";
import { runAgent } from "./src/agent";

const TODAY = "2026-06-16";

type SayResult = {
  readonly reply: string;
  readonly writes: readonly WriteIntent[];
};

type StressCounts = {
  readonly pass: number;
  readonly fail: number;
};

export type AgentLiveStressHarness = {
  readonly db: ReturnType<typeof getDb>;
  readonly userId: string;
  readonly say: (text: string) => Promise<SayResult>;
  readonly ok: (label: string, condition: boolean, detail?: string) => void;
  readonly counts: () => StressCounts;
  readonly latencyReport: () => string;
  readonly recordException: (error: unknown) => void;
  readonly cleanup: () => Promise<void>;
};

const userScopedTables = [
  ["transactions", transactions],
  ["savingsGoals", savingsGoals],
  ["budgets", budgets],
  ["memories", memories],
  ["habits", habits],
  ["recurringItems", recurringItems],
  ["messages", messages],
  ["nudges", nudges],
] as const;

export async function createAgentLiveStressHarness(): Promise<AgentLiveStressHarness> {
  const phone = `+0000AGENTLIVE${Date.now()}`;
  const run = `agentlive-${Date.now()}`;
  const msgIds: string[] = [];
  const db = getDb();
  const userId = await resolveUserId(phone);
  const slow: { readonly label: string; readonly ms: number }[] = [];
  let pass = 0;
  let fail = 0;
  let nextMessage = 0;

  const ok = (label: string, condition: boolean, detail = "") => {
    if (condition) {
      pass++;
      console.log(`  OK ${label}`);
      return;
    }
    fail++;
    console.log(`  FAIL ${label} ${detail}`);
  };

  const say = async (text: string): Promise<SayResult> => {
    const startedAt = Date.now();
    const { reply, writes } = await runAgent(text, {
      userId,
      timezone: "Asia/Manila",
      today: TODAY,
    });
    const ms = Date.now() - startedAt;
    slow.push({ label: text.slice(0, 40), ms });
    const id = `${run}-${nextMessage++}`;
    msgIds.push(id);
    await claimSlot(id);
    const flushed = await flushWrites(id, [
      ...writes,
      { type: "saveTurn", userId, role: "user", content: text },
      { type: "saveTurn", userId, role: "assistant", content: reply },
    ]);
    if (flushed !== "committed") throw new Error(`flush not committed: ${flushed}`);
    console.log(`    [${ms}ms] "${text}" -> ${writes.length}w :: ${reply.slice(0, 80)}`);
    return { reply, writes };
  };

  const latencyReport = () => {
    const avg = Math.round(
      slow.reduce((sum, sample) => sum + sample.ms, 0) / Math.max(1, slow.length),
    );
    const max = slow.slice().sort((left, right) => right.ms - left.ms)[0];
    return `latency: avg ${avg}ms, slowest ${max?.ms}ms ("${max?.label}")`;
  };

  const recordException = (error: unknown) => {
    fail++;
    console.error("\nTHREW:", error instanceof Error ? (error.stack ?? error.message) : error);
  };

  const cleanup = async () => {
    console.log("\ncleaning up throwaway user...");
    for (const [label, table] of userScopedTables) {
      await bestEffortCleanup(label, () => db.delete(table).where(eq(table.userId, userId)));
    }
    await bestEffortCleanup("users", () => db.delete(users).where(eq(users.id, userId)));
    if (msgIds.length > 0) {
      await bestEffortCleanup("processedMessages", () =>
        db.delete(processedMessages).where(inArray(processedMessages.messageId, msgIds)),
      );
    }
    console.log(`cleanup done (${msgIds.length} markers, user ${userId || "none"}).`);
  };

  return {
    db,
    userId,
    say,
    ok,
    counts: () => ({ pass, fail }),
    latencyReport,
    recordException,
    cleanup,
  };
}

async function bestEffortCleanup(label: string, operation: () => Promise<unknown>): Promise<void> {
  try {
    await operation();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`cleanup failed (${label}): ${detail}`);
  }
}
