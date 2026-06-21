import { env } from "@repo/shared/env";
import { errInfo, log } from "@repo/shared/log";
import type { Context } from "hono";
import { hasValidBearerToken } from "./cron-auth";
import { runDailyChecks } from "./cron-daily";

// Daily cron: budget nudges + recurring reminders + weekly recap + hygiene reapers.
// Vercel injects `Authorization: Bearer <CRON_SECRET>`.
export async function dailyCronRoute(c: Context): Promise<Response> {
  const auth = c.req.header("authorization");
  // Constant-time compare matches the webhook-token boundary, with no early-exit timing signal.
  if (!hasValidBearerToken(auth, env.CRON_SECRET)) return c.json({ ok: false }, 401);

  try {
    const result = await runDailyChecks();
    log.info("cron.done", { ...result });
    return c.json({ ok: true, ...result });
    // no-excuse-ok: catch
  } catch (err) {
    const info = errInfo(err, { stack: true });
    log.error("cron.error", info);
    return c.json({ ok: false }, 500);
  }
}
