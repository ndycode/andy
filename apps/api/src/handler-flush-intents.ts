import type { WriteIntent } from "@repo/db";

export function buildFlushIntents({
  userId,
  inboundText,
  reply,
  writes,
}: {
  userId: string;
  inboundText: string;
  reply: string;
  writes: WriteIntent[];
}): WriteIntent[] {
  return [
    ...writes,
    { type: "saveTurn", userId, role: "user", content: inboundText },
    { type: "saveTurn", userId, role: "assistant", content: reply },
  ];
}
