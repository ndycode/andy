import { runAgent } from "@repo/ai";
import {
  budgetStatusesFor,
  claimSlot,
  flushWrites,
  learnHabit,
  localDate,
  resolveUserId,
  saveTurn,
} from "@repo/db";
import { isAllowed } from "@repo/shared/allowlist";
import { budgetReactionLine } from "@repo/shared/budget";
import type { Category } from "@repo/shared/categories";
import { contentDedupKey } from "@repo/shared/dedup";
import { env } from "@repo/shared/env";
import { failureReply } from "@repo/shared/errors";
import { errInfo, log } from "@repo/shared/log";
import { sendMessage, sendReaction, sendTyping } from "./sendblue";

/**
 * Three-phase inbound handler (verification C1 — no DB connection held across the LLM run):
 *   0. allowlist gate (caller already token-checked) + sendTyping (no DB)
 *   1. claim — atomic marker (closes the concurrent-redelivery double-log race)
 *   2. agent — buffers writes, no connection held
 *   3. flush — short txn applies writes + completes marker, then reply (+ in-the-moment reaction)
 */
export async function handleInbound(
  phone: string,
  text: string,
  messageId?: string,
): Promise<void> {
  if (!isAllowed(phone, env.ALLOWED_PHONE)) return; // AC10: drop unknown silently

  // Prefer the channel's stable id (Sendblue `message_handle`). If absent, synthesize a
  // content-hash key (phone+text+Manila-minute) so a redelivery still dedups instead of
  // double-logging unconditionally. Either way we hold a marker for the whole flow.
  const dedupId = messageId ?? contentDedupKey(phone, text);
  const corr = dedupId;
  void sendTyping(phone);

  // Phase 1 — atomic claim. "skip" = true duplicate or an in-flight sibling.
  const claim = await claimSlot(dedupId);
  if (claim === "skip") {
    log.info("inbound.skip", { corr });
    return;
  }

  try {
    // Phase 2 — agent (no DB connection held). Loads recent turns for conversation flow.
    const userId = await resolveUserId(phone);
    const { reply, writes } = await runAgent(text, {
      userId,
      timezone: "Asia/Manila",
      today: localDate(),
    });

    // Phase 3 — flush writes + complete the dedup marker atomically.
    await flushWrites(dedupId, writes);

    // In-the-moment reaction (Wave 3): if a just-logged expense crossed a budget threshold,
    // append one Andy line to the SAME reply — zero extra messages, the data's already here.
    const reaction = await budgetReaction(userId, writes).catch(() => null);
    await sendMessage(phone, reaction ? `${reply}\n\n${reaction}` : reply);

    log.info("inbound.done", { corr, writes: writes.length, reacted: Boolean(reaction) });

    // Persist conversation turns + learn habits. MUST await — serverless freezes the
    // instance on return, so fire-and-forget writes get killed before they commit.
    const after: Promise<unknown>[] = [
      saveTurn(userId, "user", text),
      saveTurn(userId, "assistant", reply),
    ];
    for (const w of writes) {
      if (w.type === "expense" && w.note) after.push(learnHabit(userId, w.note, w.category));
    }
    await Promise.allSettled(after);

    // Tapback requires the real inbound Apple GUID (a synthesized dedup key won't work), so only
    // react when Sendblue actually gave us a message_handle. Best-effort, not state.
    if (writes.length > 0 && messageId) void sendReaction(phone, "love", messageId);
  } catch (err) {
    // Marker stays 'claimed' → a redelivery safely retries (not lost, not double-logged).
    log.error("inbound.error", { corr, ...errInfo(err) });
    await sendMessage(phone, failureReply(err)).catch(() => {});
  }
}

/**
 * One short budget line if a just-logged expense crossed its category threshold on THIS message.
 * priorSpent = current month-to-date spend minus what we just logged in that category, so the
 * line fires only on the crossing transaction (not on every later expense in the same category).
 */
async function budgetReaction(
  userId: string,
  writes: Awaited<ReturnType<typeof runAgent>>["writes"],
): Promise<string | null> {
  const loggedByCategory = new Map<Category, number>();
  for (const w of writes) {
    if (w.type === "expense") {
      loggedByCategory.set(w.category, (loggedByCategory.get(w.category) ?? 0) + w.amountCentavos);
    }
  }
  if (loggedByCategory.size === 0) return null;

  const statuses = await budgetStatusesFor(userId, [...loggedByCategory.keys()]);
  for (const s of statuses) {
    const justLogged = loggedByCategory.get(s.category) ?? 0;
    const line = budgetReactionLine(
      { category: s.category, limit: s.limit, spent: s.spent },
      s.spent - justLogged,
    );
    if (line) return line; // surface the first crossing; keep replies short
  }
  return null;
}
