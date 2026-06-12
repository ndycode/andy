import { env } from "@repo/shared/env";
import { errInfo, log } from "@repo/shared/log";
import { Hono } from "hono";
import { runDailyChecks } from "./cron-daily";
import { handleInbound } from "./handler";
import { parseInbound } from "./sendblue";

const app = new Hono();

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
  if (auth !== `Bearer ${env.CRON_SECRET}`) return c.json({ ok: false }, 401);
  try {
    const result = await runDailyChecks();
    log.info("cron.done", result);
    return c.json({ ok: true, ...result });
  } catch (err) {
    log.error("cron.error", errInfo(err));
    return c.json({ ok: false }, 500);
  }
});

export default app;
