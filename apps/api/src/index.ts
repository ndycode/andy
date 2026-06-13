import { constantTimeEqual } from "@repo/shared/allowlist";
import { env } from "@repo/shared/env";
import { errInfo, log } from "@repo/shared/log";
import { Hono } from "hono";
import { runDailyChecks } from "./cron-daily";
import { handleInbound } from "./handler";
import { parseInbound } from "./sendblue";

const app = new Hono();

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
  const token = c.req.query("t") ?? null;
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  const msg = parseInbound(token, body);
  if (!msg) return c.json({ ok: false }, 401); // AC9: bad token or non-inbound → 401, no work
  // MUST await: on serverless the instance freezes on return, killing any unawaited work.
  await handleInbound(msg.phone, msg.text, msg.messageId);
  return c.json({ ok: true });
});

// Daily cron: budget nudges + recurring reminders + weekly recap (each self-gated).
// Vercel injects `Authorization: Bearer <CRON_SECRET>` (exact env name).
app.get("/api/cron/weekly-summary", async (c) => {
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
