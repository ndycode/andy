import type { DB } from "@repo/db";
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

type ToolE2eStressCleanupOptions = {
  readonly db: DB;
  readonly userId: string;
  readonly messageIds: readonly string[];
};

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

export async function cleanupToolE2eStressUser({
  db,
  userId,
  messageIds,
}: ToolE2eStressCleanupOptions): Promise<void> {
  console.log("\ncleaning up throwaway user...");
  for (const table of userScopedTables) {
    await ignoreCleanupFailure(() => db.delete(table).where(eq(table.userId, userId)));
  }
  await ignoreCleanupFailure(() => db.delete(users).where(eq(users.id, userId)));
  if (messageIds.length > 0) {
    await ignoreCleanupFailure(() =>
      db.delete(processedMessages).where(inArray(processedMessages.messageId, messageIds)),
    );
  }
  console.log(`cleanup done (${messageIds.length} markers, user ${userId}).`);
}

async function ignoreCleanupFailure(operation: () => Promise<unknown>): Promise<void> {
  try {
    await operation();
  } catch (error) {
    if (error instanceof Error) return;
    throw error;
  }
}
