import { runAgent } from "@repo/ai";
import {
  budgetStatusesFor,
  claimSlot,
  findGoalByName,
  flushWrites,
  getMonthOverview,
  getSpendingByCategory,
  learnHabit,
  listGoals,
  resolveUserId,
} from "@repo/db";
import { isAllowed } from "@repo/shared/allowlist";
import { contentDedupKey } from "@repo/shared/dedup";
import { env } from "@repo/shared/env";
import { failureReply } from "@repo/shared/errors";
import { errInfo, log } from "@repo/shared/log";
import { APP_TIMEZONE, localDate } from "@repo/shared/time";
import { tryFastPath } from "./fast-path";
import { budgetReaction } from "./handler-budget-reaction";
import { buildFlushIntents } from "./handler-flush-intents";
import { runPostCommitEffects } from "./handler-post-commit-effects";
import type { InboundDeps } from "./handler-types";
import { sendMessage, sendReaction, sendTyping } from "./sendblue-outbound";

export type { InboundDeps } from "./handler-types";

const DEFAULT_DEPS: InboundDeps = {
  claimSlot,
  resolveUserId,
  runAgent,
  flushWrites,
  budgetStatusesFor,
  getMonthOverview,
  getSpendingByCategory,
  findGoalByName,
  listGoals,
  learnHabit,
  sendMessage,
  sendReaction,
  sendTyping,
};

/**
 * Three-phase inbound handler (verification C1 — no DB connection held across the LLM run):
 *   0. allowlist gate (caller already token-checked)
 *   1. claim — atomic marker (closes the concurrent-redelivery double-log race)
 *   2. fast-path or agent — buffers writes, no connection held
 *   3. flush — short txn applies writes + completes marker, then reply (+ in-the-moment reaction)
 */
export async function handleInbound(
  phone: string,
  text: string,
  messageId?: string,
  deps: InboundDeps = DEFAULT_DEPS,
): Promise<void> {
  const { claimSlot, resolveUserId, runAgent, flushWrites, budgetStatusesFor, sendMessage } = deps;
  if (!isAllowed(phone, env.ALLOWED_PHONE)) {
    // Drop unknown senders silently to the user, but LOG it (PII-free — no phone number): a
    // misconfigured ALLOWED_PHONE would otherwise be an invisible total outage (every message dropped
    // with zero signal). This is the one log that turns that into a detectable event.
    log.warn("inbound.not_allowed", {});
    return;
  }

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

  try {
    // Phase 2 — fast-path or agent (no DB connection held). The fast-path keeps common demo/logging
    // messages off the free-model retry loop, which is often the slowest and least reliable hop.
    const userId = await resolveUserId(phone);
    const today = localDate();
    const fast = await tryFastPath(text, { userId, today }, deps);
    const { reply, writes } =
      fast ??
      (await runAgent(
        text,
        {
          userId,
          timezone: APP_TIMEZONE,
          today,
        },
        undefined,
        12_000,
      ));

    // Phase 3 — flush writes + complete the dedup marker atomically. The two conversation turns are
    // flushed in the SAME transaction (M1 fix): previously they ran post-commit via allSettled, so a
    // failed turn insert was silently swallowed while the completed marker turned the redelivery into
    // a no-op, permanently losing the turn. Now turn persistence is atomic with the marker — a failure
    // rolls the whole flush back, leaves the marker 'claimed', and the redelivery retries.
    const flushIntents = buildFlushIntents({ userId, inboundText: text, reply, writes });
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
    let reaction: string | null = null;
    try {
      reaction = await budgetReaction(userId, writes, budgetStatusesFor);
    } catch (reactionErr) {
      if (!(reactionErr instanceof Error)) throw reactionErr;
      const reactionInfo = errInfo(reactionErr);
      log.error("inbound.budget_reaction_failed", { corr, ...reactionInfo });
    }
    // The writes are already COMMITTED at this point. A send failure here must NOT fall into the
    // generic-failure catch below — that would tell the user "something went wrong" about data that
    // was actually saved, prompting a resend (the marker now dedups the data, but the reply is a lie).
    // Log it and move on; the turn is persisted, so the next message has full context regardless.
    try {
      await sendMessage(phone, reaction ? `${reply}\n\n${reaction}` : reply);
    } catch (sendErr) {
      if (!(sendErr instanceof Error)) throw sendErr;
      const info = errInfo(sendErr);
      log.error("inbound.reply_send_failed", { corr, ...info });
    }

    log.info("inbound.done", { corr, writes: writes.length, reacted: Boolean(reaction) });

    // Post-commit effects (habit learning + tapback) are best-effort and run AFTER the commit + reply.
    // Self-catch so a failure here never falls into the pre-flush catch below — that would send the
    // user a "something went wrong" message about data that was actually saved and acknowledged.
    try {
      await runPostCommitEffects({ deps, phone, userId, writes, messageId });
    } catch (postErr) {
      if (!(postErr instanceof Error)) throw postErr;
      log.error("inbound.post_commit_failed", { corr, ...errInfo(postErr) });
    }
  } catch (err) {
    // Only PRE-flush errors reach here (agent or flush threw): the marker stays 'claimed', so a
    // redelivery safely retries — nothing committed, nothing lost. The post-flush reply send and the
    // post-commit effects each catch their own failure above, so a committed turn never produces this
    // misleading failure reply.
    if (!(err instanceof Error)) throw err;
    const info = errInfo(err);
    log.error("inbound.error", { corr, ...info });
    try {
      await sendMessage(phone, failureReply(err));
    } catch (sendErr) {
      if (!(sendErr instanceof Error)) throw sendErr;
      const sendInfo = errInfo(sendErr);
      log.error("inbound.failure_reply_send_failed", { corr, ...sendInfo });
    }
  }
}
