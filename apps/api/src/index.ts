import { errInfo, log } from "@repo/shared/log";
import { Hono } from "hono";
import { dailyCronRoute } from "./cron-route";
import { sendblueWebhook } from "./inbound-route";

const app = new Hono();

// Global error boundary: any uncaught throw in a route returns a clean 500 with a logged trace
// (structured, via the existing logger — Vercel's drain indexes it) instead of leaking a stack.
// Inbound orchestration self-handles its own errors; this is the backstop for everything else.
app.onError((err, c) => {
  log.error("request.error", {
    method: c.req.method,
    path: c.req.path,
    ...errInfo(err, { stack: true }),
  });
  return c.json({ ok: false }, 500);
});

app.get("/health", (c) => c.json({ status: "ok", service: "andy" }));

app.post("/webhooks/sendblue", sendblueWebhook);

app.get("/api/cron/daily", dailyCronRoute);

export default app;
