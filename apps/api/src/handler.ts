import { runAgent } from "@repo/ai";
import {
  budgetStatusesFor,
  claimSlot,
  flushWrites,
  learnHabit,
  localDate,
  resolveUserId,
} from "@repo/db";
import { isAllowed } from "@repo/shared/allowlist";
import { budgetReactionLines, countsTowardBudgetReaction } from "@repo/shared/budget";
import type { Category } from "@repo/shared/categories";
import { contentDedupKey } from "@repo/shared/dedup";
import { env } from "@repo/shared/env";
import { failureReply } from "@repo/shared/errors";
import { errInfo, log } from "@repo/shared/log";
import { APP_TIMEZONE, monthRange } from "@repo/shared/time";
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
      timezone: APP_TIMEZONE,
      today: localDate(),
    });

    // Phase 3 — flush writes + complete the dedup marker atomically. The two conversation turns are
    // flushed in the SAME transaction (M1 fix): previously they ran post-commit via allSettled, so a
    // failed turn insert was silently swallowed while the completed marker turned the redelivery into
    // a no-op, permanently losing the turn. Now turn persistence is atomic with the marker — a failure
    // rolls the whole flush back, leaves the marker 'claimed', and the redelivery retries.
    const flushIntents: typeof writes = [
      ...writes,
      { type: "saveTurn", userId, role: "user", content: text },
      { type: "saveTurn", userId, role: "assistant", content: reply },
    ];
    await flushWrites(dedupId, flushIntents);

    // In-the-moment reaction (Wave 3): if a just-logged expense crossed a budget threshold,
    // append one Andy line to the SAME reply — zero extra messages, the data's already here.
    const reaction = await budgetReaction(userId, writes).catch(() => null);
    await sendMessage(phone, reaction ? `${reply}\n\n${reaction}` : reply);

    log.info("inbound.done", { corr, writes: writes.length, reacted: Boolean(reaction) });

    // Learn merchant→category habits. Best-effort (allSettled) and idempotent reinforcement, so —
    // unlike the conversation turns above — it's fine for this to run post-commit; a miss just means
    // one fewer reinforcement, not lost data. MUST await: serverless freezes the instance on return.
    const after: Promise<unknown>[] = [];
    for (const w of writes) {
      if (w.type === "expense" && w.note) after.push(learnHabit(userId, w.note, w.category));
    }
    if (after.length > 0) await Promise.allSettled(after);

    // Tapback requires the real inbound Apple GUID (a synthesized dedup key won't work), so only
    // react when Sendblue actually gave us a message_handle. Best-effort (self-catching), but MUST
    // be awaited: on serverless the instance can freeze on return and kill an unawaited POST.
    if (writes.length > 0 && messageId) await sendReaction(phone, "love", messageId);
  } catch (err) {
    // Marker stays 'claimed' → a redelivery safely retries (not lost, not double-logged).
    log.error("inbound.error", { corr, ...errInfo(err) });
    await sendMessage(phone, failureReply(err)).catch(() => {});
  }
}

/**
 * Budget heads-up line(s) for the categories a just-logged expense crossed a threshold in, on THIS
 * message. priorSpent = current month-to-date spend minus what we just logged in that category, so a
 * line fires only on the crossing transaction (not on every later expense in the same category).
 *
 * A single message can log into several categories ("lunch 300, grab 150, shopping 2k"), each of
 * which may cross its own threshold — surface ALL of them (one line each), not just the first, so no
 * relevant signal is silently dropped. Returns the joined block, or null if nothing crossed.
 *
 * Only current-month expenses count: budgetStatusesFor sums the current Manila month, so a
 * backdated expense (localDate in a past month) is NOT part of `spent` and must be excluded from
 * `justLogged` too — otherwise we'd subtract it from this month's total and compute a wrong (even
 * negative) priorSpent, firing a bogus alert.
 */
async function budgetReaction(
  userId: string,
  writes: Awaited<ReturnType<typeof runAgent>>["writes"],
): Promise<string | null> {
  const thisMonth = monthRange();
  const loggedByCategory = new Map<Category, number>();
  for (const w of writes) {
    if (w.type === "expense" && countsTowardBudgetReaction(w.localDate, thisMonth)) {
      loggedByCategory.set(w.category, (loggedByCategory.get(w.category) ?? 0) + w.amountCentavos);
    }
  }
  if (loggedByCategory.size === 0) return null;

  const statuses = await budgetStatusesFor(userId, [...loggedByCategory.keys()]);
  const lines = budgetReactionLines(statuses, loggedByCategory);
  return lines.length > 0 ? lines.join("\n") : null;
}
