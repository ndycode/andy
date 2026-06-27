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
  const habitSettled = habitWrites.length > 0 ? Promise.allSettled(habitWrites) : Promise.resolve();
  const reaction =
    writes.length > 0 && messageId
      ? deps.sendReaction(phone, "love", messageId).then(
          () => null,
          (err: unknown) => err,
        )
      : Promise.resolve(null);

  const [, reactionErr] = await Promise.all([habitSettled, reaction]);
  if (reactionErr !== null) throw reactionErr;
}
