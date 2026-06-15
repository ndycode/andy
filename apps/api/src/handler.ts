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
 * Injectable collaborators for the handler — the DB/agent/messaging side effects. Production passes
 * nothing (DEFAULT_DEPS, the real imports); tests inject fakes so the three-phase ORCHESTRATION
 * (claim/skip/superseded branches, the post-flush send-failure boundary, the reaction append) can be
 * exercised deterministically without a live DB, a real LLM, the network, or process-global module
 * mocks. This is purely for testability — the production code path is unchanged.
 */
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

const DEFAULT_DEPS: InboundDeps = {
  claimSlot,
  resolveUserId,
  runAgent,
  flushWrites,
  budgetStatusesFor,
  learnHabit,
  sendMessage,
  sendReaction,
  sendTyping,
};

/**
 * Three-phase inbound handler (verification C1 — no DB connection held across the LLM run):
 *   0. allowlist gate (caller already token-checked)
 *   1. claim — atomic marker (closes the concurrent-redelivery double-log race)
 *   2. agent — buffers writes, no connection held (typing indicator fires here, post-claim)
 *   3. flush — short txn applies writes + completes marker, then reply (+ in-the-moment reaction)
 */
export async function handleInbound(
  phone: string,
  text: string,
  messageId?: string,
  deps: InboundDeps = DEFAULT_DEPS,
): Promise<void> {
  const {
    claimSlot,
    resolveUserId,
    runAgent,
    flushWrites,
    budgetStatusesFor,
    learnHabit,
    sendMessage,
    sendReaction,
    sendTyping,
  } = deps;
  if (!isAllowed(phone, env.ALLOWED_PHONE)) return; // AC10: drop unknown silently

  // Prefer the channel's stable id (Sendblue `message_handle`). If absent, synthesize a
  // content-hash key (phone+text+Manila-minute) so a redelivery still dedups instead of
  // double-logging unconditionally. Either way we hold a marker for the whole flow.
  const dedupId = messageId ?? contentDedupKey(phone, text);
  const corr = dedupId;

  // Phase 1 — atomic claim. "skip" = true duplicate or an in-flight sibling.
  const claim = await claimSlot(dedupId);
  if (claim === "skip") {
    log.info("inbound.skip", { corr });
    return;
  }

  // Typing indicator AFTER the claim — a duplicate redelivery (skip) returns above with no reply, so
  // firing typing before the claim showed a phantom "Andy is typing…" bubble that never resolved.
  // Fire-and-forget (self-catching); the very next thing we do is await the multi-second agent run.
  void sendTyping(phone);

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
    const flushed = await flushWrites(dedupId, flushIntents);

    // "superseded": a concurrent worker stole our slot under an infra stall and completed the marker
    // first, so flushWrites rolled our writes back. The winner owns the reply — we must NOT send one
    // (it would be a duplicate) and must NOT have applied writes (we didn't). Bail quietly.
    if (flushed === "superseded") {
      log.info("inbound.superseded", { corr });
      return;
    }

    // In-the-moment reaction (Wave 3): if a just-logged expense crossed a budget threshold,
    // append one Andy line to the SAME reply — zero extra messages, the data's already here.
    const reaction = await budgetReaction(userId, writes, budgetStatusesFor).catch(() => null);
    // The writes are already COMMITTED at this point. A send failure here must NOT fall into the
    // generic-failure catch below — that would tell the user "something went wrong" about data that
    // was actually saved, prompting a resend (the marker now dedups the data, but the reply is a lie).
    // Log it and move on; the turn is persisted, so the next message has full context regardless.
    try {
      await sendMessage(phone, reaction ? `${reply}\n\n${reaction}` : reply);
    } catch (sendErr) {
      log.error("inbound.reply_send_failed", { corr, ...errInfo(sendErr) });
    }

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
    // Only PRE-flush errors reach here (agent or flush threw): the marker stays 'claimed', so a
    // redelivery safely retries — nothing committed, nothing lost. The post-flush reply send catches
    // its own failure above, so a committed turn never produces this misleading failure reply.
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
  budgetStatusesForFn: typeof budgetStatusesFor,
): Promise<string | null> {
  const thisMonth = monthRange();
  const loggedByCategory = new Map<Category, number>();
  for (const w of writes) {
    if (w.type === "expense" && countsTowardBudgetReaction(w.localDate, thisMonth)) {
      loggedByCategory.set(w.category, (loggedByCategory.get(w.category) ?? 0) + w.amountCentavos);
    }
  }
  if (loggedByCategory.size === 0) return null;

  const statuses = await budgetStatusesForFn(userId, [...loggedByCategory.keys()]);
  const lines = budgetReactionLines(statuses, loggedByCategory);
  return lines.length > 0 ? lines.join("\n") : null;
}
