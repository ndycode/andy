import { constantTimeEqual } from "@repo/shared/allowlist";
import { env } from "@repo/shared/env";
import { errInfo, log } from "@repo/shared/log";
import { Hono } from "hono";
import { runDailyChecks } from "./cron-daily";
import { handleInbound } from "./handler";
import { parseInbound } from "./sendblue";

const app = new Hono();

// Largest inbound webhook body we'll even parse. A real Sendblue inbound is a few hundred bytes; this
// rejects an oversized payload before any JSON parse / work, cheaply.
const MAX_BODY_BYTES = 16_384;

/**
 * Best-effort burst guard for the AUTHENTICATED inbound path. Serverless instances don't share
 * memory, so this is per-warm-instance defense-in-depth (not a global guarantee): it blunts a flood
 * that lands on one instance and — crucially — caps LLM-cost amplification if the URL token ever
 * leaks, since the gated phone number is attacker-suppliable in the body and is not itself a secret.
 * 60/min is far above one human's texting rate; a 429 is retryable, so a legitimate Sendblue
 * redelivery still gets through after the window (and is deduped anyway).
 */
const RL_MAX = 60;
const RL_WINDOW_MS = 60_000;
const rlHits: number[] = [];
function allowAuthedRequest(now = Date.now()): boolean {
  while (rlHits.length > 0 && now - (rlHits[0] as number) >= RL_WINDOW_MS) rlHits.shift();
  if (rlHits.length >= RL_MAX) return false;
  rlHits.push(now);
  return true;
}

// Global error boundary: any uncaught throw in a route returns a clean 500 with a logged trace
// (structured, via the existing logger — Vercel's drain indexes it) instead of leaking a stack.
// handleInbound already self-handles its own errors; this is the backstop for everything else.
app.onError((err, c) => {
  log.error("request.error", {
    method: c.req.method,
    path: c.req.path,
    ...errInfo(err, { stack: true }),
  });
  return c.json({ ok: false }, 500);
});

app.get("/health", (c) => c.json({ status: "ok", service: "andy" }));

// Inbound iMessage webhook. Auth via self-minted ?t= URL token (Sendblue has no signing secret).
app.post("/webhooks/sendblue", async (c) => {
  // Reject an oversized body before parsing anything.
  const len = Number(c.req.header("content-length") ?? "0");
  if (Number.isFinite(len) && len > MAX_BODY_BYTES) return c.json({ ok: false }, 413);

  const token = c.req.query("t") ?? null;
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  const msg = parseInbound(token, body);
  if (!msg) return c.json({ ok: false }, 401); // AC9: bad token or non-inbound → 401, no work

  // Burst guard on the authenticated path: cap how fast a caller can drive the (expensive) agent run.
  // 429 is retryable; a real redelivery still lands later and is deduped.
  if (!allowAuthedRequest()) {
    log.warn("inbound.rate_limited", { phone: msg.phone });
    return c.json({ ok: false }, 429);
  }

  // MUST await: on serverless the instance freezes on return, killing any unawaited work.
  await handleInbound(msg.phone, msg.text, msg.messageId);
  return c.json({ ok: true });
});

// Daily cron: budget nudges + recurring reminders + weekly recap + hygiene reapers (each self-gated).
// Vercel injects `Authorization: Bearer <CRON_SECRET>` (exact env name).
app.get("/api/cron/daily", async (c) => {
  const auth = c.req.header("authorization");
  // Constant-time compare (matches the webhook-token boundary) — no early-exit timing signal.
  if (!auth || !constantTimeEqual(auth, `Bearer ${env.CRON_SECRET}`))
    return c.json({ ok: false }, 401);
  try {
    const result = await runDailyChecks();
    log.info("cron.done", result);
    return c.json({ ok: true, ...result });
  } catch (err) {
    log.error("cron.error", errInfo(err, { stack: true }));
    return c.json({ ok: false }, 500);
  }
});

export default app;
