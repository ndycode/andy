import { log } from "@repo/shared/log";
import type { Context } from "hono";
import { handleInbound } from "./handler";
import { createInboundBurstLimiter } from "./inbound-rate-limit";
import { parseInbound } from "./sendblue-inbound";

// Largest inbound webhook body we'll even parse. A real Sendblue inbound is a few hundred bytes; this
// rejects an oversized payload before any JSON parse / work, cheaply.
const MAX_BODY_BYTES = 16_384;

const inboundBurstLimiter = createInboundBurstLimiter();

function allowAuthedRequest(now = Date.now()): boolean {
  return inboundBurstLimiter.allow(now);
}

// Inbound iMessage webhook. Auth via self-minted ?t= URL token (Sendblue has no signing secret).
export async function sendblueWebhook(c: Context): Promise<Response> {
  // Reject an oversized body before parsing anything.
  const len = Number(c.req.header("content-length") ?? "0");
  if (Number.isFinite(len) && len > MAX_BODY_BYTES) return c.json({ ok: false }, 413);

  const token = c.req.query("t") ?? null;
  let body: unknown;
  try {
    body = await c.req.json();
  } catch (err) {
    if (!(err instanceof Error)) throw err;
    body = {};
  }
  const msg = parseInbound(token, body);
  if (!msg) return c.json({ ok: false }, 401); // AC9: bad token or non-inbound -> 401, no work

  // Burst guard on the authenticated path: cap how fast a caller can drive the expensive agent run.
  // 429 is retryable; a real redelivery still lands later and is deduped.
  if (!allowAuthedRequest()) {
    // No phone here: the rate-limited path is the one most likely to be hit by an attacker-supplied
    // body if the URL token leaks, so don't write a PII phone number to logs on it.
    log.warn("inbound.rate_limited", {});
    return c.json({ ok: false }, 429);
  }

  // MUST await: on serverless the instance freezes on return, killing any unawaited work.
  await handleInbound(msg.phone, msg.text, msg.messageId);
  return c.json({ ok: true });
}
