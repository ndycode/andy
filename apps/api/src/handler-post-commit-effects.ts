import type { WriteIntent } from "@repo/db";
import type { InboundDeps } from "./handler-types";

export async function runPostCommitEffects({
  deps,
  phone,
  userId,
  writes,
  messageId,
}: {
  deps: Pick<InboundDeps, "learnHabit" | "sendReaction">;
  phone: string;
  userId: string;
  writes: WriteIntent[];
  messageId?: string;
}): Promise<void> {
  const habitWrites: Promise<unknown>[] = [];
  for (const w of writes) {
    if (w.type === "expense" && w.note)
      habitWrites.push(deps.learnHabit(userId, w.note, w.category));
  }
  if (habitWrites.length > 0) await Promise.allSettled(habitWrites);

  if (writes.length > 0 && messageId) await deps.sendReaction(phone, "love", messageId);
}
