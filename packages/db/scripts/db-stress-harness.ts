import { eq, inArray } from "drizzle-orm";
import { type DB, flushWrites, getDb, resolveUserId, type WriteIntent } from "../src/index";
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
} from "../src/schema";

type StressCounts = {
  readonly pass: number;
  readonly fail: number;
};

export type DbStressHarness = {
  readonly db: DB;
  readonly phone: string;
  readonly userId: string;
  readonly nextMessageId: () => string;
  readonly flush: (messageId: string, intents: readonly WriteIntent[]) => Promise<void>;
  readonly ok: (label: string, condition: boolean, detail?: string) => void;
  readonly counts: () => StressCounts;
  readonly exitCode: () => number;
  readonly recordException: (error: Error) => void;
  readonly cleanup: () => Promise<void>;
};

class DbStressError extends Error {
  constructor(label: string) {
    super(`db stress invariant failed: ${label}`);
    this.name = "DbStressError";
  }
}

const userScopedTables = [
  transactions,
  savingsGoals,
  budgets,
  memories,
  habits,
  recurringItems,
  messages,
  nudges,
] as const;

export async function createDbStressHarness(): Promise<DbStressHarness> {
  const phone = `+0000STRESS${Date.now()}`;
  const run = `stress-${Date.now()}`;
  const msgIds: string[] = [];
  const db = getDb();
  const userId = await resolveUserId(phone);
  let pass = 0;
  let fail = 0;
  let nextMessage = 0;

  const nextMessageId = () => {
    const id = `${run}-${nextMessage++}`;
    msgIds.push(id);
    return id;
  };

  const ok = (label: string, condition: boolean, detail = "") => {
    if (condition) {
      pass++;
      console.log(`  PASS ${label}`);
      return;
    }
    fail++;
    console.log(`  FAIL ${label} ${detail}`);
  };

  const flush = async (messageId: string, intents: readonly WriteIntent[]) => {
    const result = await flushWrites(messageId, [...intents]);
    if (result !== "committed") throw new DbStressError(`flush not committed: ${result}`);
  };

  const recordException = (error: Error) => {
    fail++;
    console.error("\nTHREW:", error.stack ?? error.message);
  };

  const cleanup = async () => {
    console.log("\ncleaning up throwaway user...");
    for (const table of userScopedTables) {
      await ignoreCleanupFailure(() => db.delete(table).where(eq(table.userId, userId)));
    }
    await ignoreCleanupFailure(() => db.delete(users).where(eq(users.id, userId)));
    if (msgIds.length > 0) {
      await ignoreCleanupFailure(() =>
        db.delete(processedMessages).where(inArray(processedMessages.messageId, msgIds)),
      );
    }
    console.log(`cleanup done (${msgIds.length} markers, user ${userId}).`);
  };

  return {
    db,
    phone,
    userId,
    nextMessageId,
    flush,
    ok,
    counts: () => ({ pass, fail }),
    exitCode: () => (fail > 0 ? 1 : 0),
    recordException,
    cleanup,
  };
}

async function ignoreCleanupFailure(operation: () => Promise<unknown>): Promise<void> {
  try {
    await operation();
  } catch (error) {
    if (error instanceof Error) return;
    throw error;
  }
}

export function requireValue<T>(value: T | null | undefined, label: string): T {
  if (value == null) throw new DbStressError(label);
  return value;
}

export async function operationRejected(operation: () => Promise<unknown>): Promise<boolean> {
  try {
    await operation();
    return false;
  } catch (error) {
    if (error instanceof Error) return true;
    throw error;
  }
}
