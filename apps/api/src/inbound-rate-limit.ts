import { createSlidingWindowRateLimiter } from "./rate-limit";

/**
 * Best-effort burst guard for the authenticated inbound path. Serverless instances don't share
 * memory, so this is per-warm-instance defense-in-depth: it blunts a flood that lands on one
 * instance and caps LLM-cost amplification if the URL token ever leaks.
 *
 * 60/min is far above one human's texting rate; a 429 is retryable, so a legitimate Sendblue
 * redelivery still gets through after the window and is deduped anyway.
 */
const INBOUND_BURST_MAX = 60;
const INBOUND_BURST_WINDOW_MS = 60_000;

export function createInboundBurstLimiter() {
  return createSlidingWindowRateLimiter({
    max: INBOUND_BURST_MAX,
    windowMs: INBOUND_BURST_WINDOW_MS,
  });
}
