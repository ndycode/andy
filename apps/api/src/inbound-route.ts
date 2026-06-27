import { log } from "@repo/shared/log";
import type { Context } from "hono";
import { handleInbound } from "./handler";
import { createInboundBurstLimiter } from "./inbound-rate-limit";
import { isValidWebhookToken, parseInbound } from "./sendblue-inbound";

// Largest inbound webhook body we'll even parse. A real Sendblue inbound is a few hundred bytes; this
// rejects an oversized payload before any JSON parse / work, cheaply.
const MAX_BODY_BYTES = 16_384;

const inboundBurstLimiter = createInboundBurstLimiter();

function allowAuthedRequest(now = Date.now()): boolean {
  return inboundBurstLimiter.allow(now);
}

// Inbound iMessage webhook. Auth via self-minted ?t= URL token (Sendblue has no signing secret).
export async function sendblueWebhook(c: Context): Promise<Response> {
  // 1. Reject an over-large body by its DECLARED length first — cheapest possible rejection.
  const declaredLen = Number(c.req.header("content-length") ?? "0");
  if (Number.isFinite(declaredLen) && declaredLen > MAX_BODY_BYTES)
    return c.json({ ok: false }, 413);

  // 2. Authenticate the URL token BEFORE reading/parsing the body, so an unauthenticated request (a
  //    leaked-token probe, a scanner) does zero parse work.
  const token = c.req.query("t") ?? null;
  if (!isValidWebhookToken(token)) return c.json({ ok: false }, 401);

  // 3. Read the raw body and enforce the cap on the ACTUAL byte length too — don't solely trust the
  //    Content-Length header (a client can understate it). Then parse.
  const raw = await c.req.text();
  if (raw.length > MAX_BODY_BYTES) return c.json({ ok: false }, 413);
  let body: unknown;
  try {
    body = JSON.parse(raw);
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
